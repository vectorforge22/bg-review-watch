// bg-review-watch — status chip + nudge countdown for Hermes background self-improvement runs.
//
// Disk plugin (loaded uncompiled): only @hermes/plugin-sdk / react / react/jsx-runtime resolve.
//
// What it shows (status bar, right cluster):
//   idle    → "review idle"   + fill bar: turns since last review / nudge interval
//   running → "review running · 2m 14s" (pulsing dot, accent color)
//   just done → "review done 3s ago" + the summary text in the tooltip
//
// Data sources (all read-only, no Python backend, no gateway restart):
//   - host.onEvent('review.summary')       → live completion + summary text
//   - host.onEvent('message.start')        → turn ticks for the countdown
//   - host.logs({ file:'agent', search:… }) → start/complete markers, 20s poll
//   - host.request('config.get')           → nudge intervals (best-effort, defaults 10/15)
//
// Detection model: at most one background review runs at a time (a new turn supersedes an
// in-flight one, and superseded runs still log a `complete` line). So:
//   running  <=>  latest "thread=bg-review:<pid>" start ts  >  latest complete/failed ts
//
// agent.log markers (verified 2026-09-23 against 17 historical runs):
//   start:  "<ts> INFO run_agent: OpenAI client created … thread=bg-review:<pid> …"  (spawn only —
//           the retired/closed teardown lines ALSO carry thread=bg-review:<pid> and arrive after
//           done, so the "OpenAI client created" anchor is load-bearing: without it, start > done)
//   done:   "<ts> INFO […] agent.background_review: Background review complete: thread=bg-review calls=… result=skill|none"
//   fail:   "<ts> WARNING […] agent.background_review: Background memory/skill review failed: …"

import { host, STATUSBAR_AREAS, Tip } from '@hermes/plugin-sdk'
import { jsx, jsxs } from 'react/jsx-runtime'
import { useSyncExternalStore, useState, useEffect } from 'react'

const POLL_MS = 20000 // log poll cadence (idle cost is one tiny server-side-filtered REST call)
const RECENT_DONE_MS = 600000 // keep the "done Xs ago" label for 10 min, then plain idle

const RE_START = /(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}),\d+.*OpenAI client created.*thread=bg-review:(\d+)/
const RE_DONE = /(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}),\d+.*(Background review complete|Background memory\/skill review failed)(?:.*result=(\w+))?/
const RE_TURN = /(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}),\d+.*Turn ended/

function lineText(l) {
  return typeof l === 'string' ? l : (l && (l.line || l.message || l.text)) || ''
}
function ts(s) {
  const d = new Date(s.replace(' ', 'T')) // agent.log timestamps are local time
  return isNaN(d) ? null : d.getTime()
}
function ago(ms) {
  if (ms == null) return '…'
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ${s % 60}s`
  return `${Math.floor(m / 60)}h ${m % 60}m`
}

// ── plugin-global state (shared by the chip; module-scoped = survives chip re-mounts) ──
let state = {
  mode: 'idle', // 'idle' | 'running'
  startedAt: null,
  doneAt: null,
  doneResult: null,
  doneSummary: null,
  turnsSince: 0,
  memInterval: 10,
  skillInterval: 15,
  lastPoll: 0,
}
let subs = new Set()
function set(patch) {
  state = { ...state, ...patch }
  subs.forEach((f) => f())
}

function collectReviewMarkers(lines) {
  let start = null
  let done = null
  let result = null
  for (const text of lines.map(lineText)) {
    let m = RE_DONE.exec(text)
    if (m) {
      const t = ts(m[1])
      if (t && (done == null || t > done)) { done = t; result = m[3] != null ? m[3] : null }
      continue
    }
    m = RE_START.exec(text)
    if (m) {
      const t = ts(m[1])
      if (t && (start == null || t > start)) start = t
    }
  }
  return { start, done, result }
}

async function reconcile() {
  const now = Date.now()
  if (now - state.lastPoll < 5000) return // debounce overlapping calls
  state.lastPoll = now
  try {
    const rev = await host.logs({ file: 'agent', lines: 200, search: 'bg-review' })
    const lines = (rev && (rev.lines || rev.data || rev.logs)) || []
    const { start, done, result } = collectReviewMarkers(lines)

    // turns since the last completion (only needed when idle)
    let turns = state.turnsSince
    if (done != null) {
      const tr = await host.logs({ file: 'agent', lines: 5000, search: 'Turn ended' })
      const tlines = ((tr && (tr.lines || tr.data || tr.logs)) || []).map(lineText)
      turns = tlines.filter((t) => {
        const m = RE_TURN.exec(t)
        return m && ts(m[1]) > done
      }).length
    }

    const running = start != null && (done == null || start > done)
    set({
      mode: running ? 'running' : 'idle',
      startedAt: running ? (state.startedAt || start) : null,
      doneAt: done,
      doneResult: done != null && result != null ? result : state.doneResult,
      turnsSince: running ? 0 : turns,
    })
  } catch {
    /* fail-open: keep last state on a REST blip */
  }
}

function loadIntervals() {
  host.request('config.get', {})
    .then((cfg) => {
      const raw = JSON.stringify(cfg || {})
      const mem = raw.match(/"nudge_interval"\s*:\s*(\d+)/)
      const skill = raw.match(/"creation_nudge_interval"\s*:\s*(\d+)/)
      set({
        memInterval: mem ? Math.max(1, +mem[1]) : 10,
        skillInterval: skill ? Math.max(1, +skill[1]) : 15,
      })
    })
    .catch(() => {}) // defaults stand
}

let wiring = null
function ensureWired() {
  if (wiring) return
  wiring = (function wire() {
    loadIntervals()
    reconcile()
    const offs = [
      host.onEvent('message.start', () => {
        if (state.mode !== 'running') set({ turnsSince: state.turnsSince + 1 })
      }),
      host.onEvent('review.summary', (ev) => {
        const text = (ev && (ev.text || (ev.data && ev.data.text))) || ''
        const m = /result=(\w+)/.exec(text)
        set({
          mode: 'idle',
          startedAt: null,
          doneAt: Date.now(),
          doneResult: m ? m[1] : null,
          doneSummary: text,
          turnsSince: 0,
        })
      }),
    ]
    const poll = setInterval(reconcile, POLL_MS)
    return () => {
      clearInterval(poll)
      offs.forEach((off) => off && off())
      wiring = null
    }
  })()
}

function useWatch() {
  ensureWired()
  return useSyncExternalStore(
    (cb) => { subs.add(cb); return () => subs.delete(cb) },
    () => state,
    () => state,
  )
}

function useNow(intervalMs = 1000) {
  const [v, setV] = useState(Date.now())
  useEffect(() => {
    const t = setInterval(() => setV(Date.now()), intervalMs)
    return () => clearInterval(t)
  }, [intervalMs])
  return v
}

function FillBar({ frac, width = 44 }) {
  const f = Math.max(0, Math.min(1, frac || 0))
  return jsx('span', {
    'aria-hidden': true,
    style: {
      display: 'inline-block',
      width: `${width}px`,
      height: '4px',
      borderRadius: '2px',
      background: 'var(--ui-stroke-secondary)',
      overflow: 'hidden',
      verticalAlign: 'middle',
    },
    children: jsx('span', {
      style: {
        display: 'block',
        height: '100%',
        width: `${(f * 100).toFixed(1)}%`,
        background: 'var(--ui-accent)',
        borderRadius: '2px',
        transition: 'width 400ms ease',
      },
    }),
  })
}

function Chip() {
  const s = useWatch()
  const now = useNow()

  const memLeft = Math.max(0, s.memInterval - s.turnsSince)
  const barFrac = s.turnsSince / s.memInterval

  let dotColor = 'var(--ui-text-quaternary)'
  let textColor = 'var(--ui-text-tertiary)'
  let label
  let detail

  if (s.mode === 'running') {
    dotColor = 'var(--ui-accent)'
    textColor = 'var(--ui-accent)'
    label = `review running · ${ago(now - s.startedAt)}`
    detail = 'Background self-improvement review is in progress. It replays the recent conversation on the local model and may update memory/skills. The bar shows the nudge countdown for the next run.'
  } else if (s.doneAt != null && now - s.doneAt < RECENT_DONE_MS) {
    label = `review done ${ago(now - s.doneAt)} ago`
    detail = (s.doneSummary || `Last background review finished (result: ${s.doneResult || 'none'}).`) +
      `\nNext nudge in ${memLeft} turns — memory ${s.turnsSince}/${s.memInterval}, skill ${s.turnsSince}/${s.skillInterval}`
  } else {
    label = 'review idle'
    detail = `No background review running. Next nudge in ${memLeft} turns — memory ${s.turnsSince}/${s.memInterval}, skill ${s.turnsSince}/${s.skillInterval}`
  }

  return jsxs(Tip, {
    label: detail,
    children: jsxs('span', {
      style: {
        display: 'inline-flex',
        alignItems: 'center',
        gap: '5px',
        height: '100%',
        padding: '0 6px',
        fontSize: '0.6875rem',
        color: textColor,
        whiteSpace: 'nowrap',
      },
      children: [
        jsx('span', {
          style: {
            width: '6px',
            height: '6px',
            borderRadius: '50%',
            background: dotColor,
            display: 'inline-block',
            animation: s.mode === 'running' ? 'bgrw-pulse 1.2s ease-in-out infinite' : 'none',
          },
        }),
        jsx('span', { children: label }),
        s.mode === 'idle' ? jsxs('span', {
          style: { display: 'inline-flex', alignItems: 'center', gap: '4px' },
          children: [
            jsx(FillBar, { frac: barFrac }),
            jsx('span', { style: { color: 'var(--ui-text-quaternary)' }, children: `${memLeft}t` }),
          ],
        }) : null,
      ],
    }),
  })
}

export default {
  id: 'bg-review-watch',
  name: 'Background Runner Watch',
  defaultEnabled: true,
  register(ctx) {
    ensureWired()
    const wiringTeardown = wiring // module-scoped; survives chip remounts
    ctx.register({
      id: 'chip',
      area: STATUSBAR_AREAS.right,
      order: 140,
      render: () => jsx(Chip, {}),
    })
    // pulse keyframe (cosmetic; scoped to this plugin's lifetime)
    let styleEl = null
    try {
      styleEl = document.createElement('style')
      styleEl.textContent = '@keyframes bgrw-pulse { 0%,100% { opacity: 1; } 50% { opacity: 0.35; } }'
      document.head.appendChild(styleEl)
    } catch {
      /* no DOM — skip */
    }
    ctx.onDispose(() => {
      if (wiringTeardown) wiringTeardown()
      if (styleEl && styleEl.remove) styleEl.remove()
    })
  },
}
