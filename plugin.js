// bg-review-watch — status chip + nudge countdown for Hermes background self-improvement runs,
// plus a compaction chip that surfaces context compression (batch + micro) on the local model.
//
// Disk plugin (loaded uncompiled): only @hermes/plugin-sdk / react / react/jsx-runtime resolve.
//
// What it shows (status bar, right cluster):
//   review chip (always):
//     idle    → "review idle"   + fill bar: turns since last review / nudge interval
//     running → "review running · 2m 14s" (pulsing dot, accent color)
//     just done → "review done 3s ago" + the summary text in the tooltip
//   compaction chip (only while compacting or within 10 min of a finish):
//     running → "compacting · 4m 12s" (pulsing dot, accent color)
//     just done → "compact done 3m ago" / "compact failed 2m ago" (reduction or failure in tooltip)
//
// Data sources (all read-only, no Python backend, no gateway restart):
//   - host.onEvent('review.summary')        → live review completion + summary text
//   - host.onEvent('message.start')         → turn ticks for the review countdown
//   - host.logs({ file:'agent', search:… }) → markers, 20s poll:
//       'bg-review'            → review start/complete markers
//       'context compression'  → batch compaction started/done/attempt-telemetry markers
//       'Micro-compaction'     → per-turn micro-compact pass results
//   - host.request('config.get')            → nudge intervals (best-effort, defaults 10/15)
//
// Detection model: at most one background review runs at a time (a new turn supersedes an
// in-flight one, and superseded runs still log a `complete` line). So:
//   review running  <=>  latest "thread=bg-review:<pid>" start ts  >  latest complete/failed ts
//
// Compaction runs one at a time too (the compressor serializes attempts on the session).
// A batch attempt logs `context compression started:` at attempt start and exactly one
// terminal line at attempt end: `context compression done:` (committed) and/or the
// `context compression attempt telemetry:` JSON line (covers both committed and aborted,
// carries failure_class + total_duration_ms). So:
//   compaction running <=> latest start ts > latest terminal (done/telemetry) ts
//
// agent.log markers (verified 2026-09-27 against agent/conversation_compression.py:4011/4223/1498,
// agent/turn_finalizer.py:302/304, and 10 historical attempts in agent.log 09-20..09-26):
//   start:   "<ts> INFO agent.conversation_compression: context compression started: session=… messages=N tokens=~… model=… focus=…"
//   done:    "<ts> INFO … context compression done: session=… messages=A->B rough_tokens=~… awaiting_real_usage=true"
//   terminal:"<ts> INFO … context compression attempt telemetry: {"…","commit_status":"committed|aborted","failure_class":"stall_interrupted|…","total_duration_ms":…,…}"
//   micro ok:   "<ts> INFO agent.turn_finalizer: Micro-compaction: A -> B messages"
//   micro fail: "<ts> WARNING agent.turn_finalizer: Micro-compaction failed: <err>"

import { host, STATUSBAR_AREAS, Tip } from '@hermes/plugin-sdk'
import { jsx, jsxs } from 'react/jsx-runtime'
import { useSyncExternalStore, useState, useEffect } from 'react'

const POLL_MS = 20000 // log poll cadence (idle cost is a few tiny server-side-filtered REST calls)
const RECENT_DONE_MS = 600000 // keep the "done Xs ago" label for 10 min, then plain idle
const RECENT_COMP_MS = 600000 // keep the compaction chip 10 min after a finish

const RE_START = /(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}),\d+.*OpenAI client created.*thread=bg-review:(\d+)/
const RE_DONE = /(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}),\d+.*(Background review complete|Background memory\/skill review failed)(?:.*result=(\w+))?/
const RE_TURN = /(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}),\d+.*Turn ended/

const RE_COMP_START = /(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}),\d+.*context compression started: session=(\S+) messages=(\d+) tokens=~?([\d,]+)/
const RE_COMP_DONE = /(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}),\d+.*context compression done: session=(\S+) messages=(\d+)->(\d+)/
const RE_COMP_TEL = /(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}),\d+.*context compression attempt telemetry: (.*)$/
const RE_MICRO_OK = /(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}),\d+.*Micro-compaction: (\d+) -> (\d+) messages/
const RE_MICRO_FAIL = /(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}),\d+.*Micro-compaction failed: (.+)/

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
function fmtTokens(n) {
  if (n == null) return '?'
  if (n >= 1000) return `${Math.round(n / 1000)}K`
  return String(n)
}

// ── plugin-global state (shared by the chips; module-scoped = survives chip re-mounts) ──
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
  compact: {
    mode: 'idle', // 'idle' | 'running'
    startedAt: null,
    startTokens: null,
    endedAt: null,
    committed: null, // true = committed, false = aborted, null = unknown
    failure: null,
    doneFrom: null,
    doneTo: null,
    lastMicroAt: null,
    microDetail: null,
    lastPoll: 0,
  },
}
let subs = new Set()
function set(patch) {
  state = { ...state, ...patch }
  subs.forEach((f) => f())
}
function setCompact(patch) {
  state = { ...state, compact: { ...state.compact, ...patch } }
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

// Telemetry JSON fields (keys are sorted in the log line; match by key, not position)
function parseCompactionTelemetry(json) {
  const cs = /"commit_status"\s*:\s*"(\w+)"/.exec(json)
  if (!cs) return null
  const fc = /"failure_class"\s*:\s*"(\w+)"/.exec(json)
  const dm = /"total_duration_ms"\s*:\s*(\d+)/.exec(json)
  return {
    committed: cs[1] === 'committed',
    failure: cs[1] === 'aborted' ? (fc ? fc[1] : null) : null,
    durationMs: dm ? +dm[1] : null,
  }
}

function collectCompactionMarkers(lines) {
  let start = null
  let startTokens = null
  let telTs = null
  let tel = null // { committed, failure, durationMs } of the newest telemetry line
  let doneTs = null
  let doneFrom = null
  let doneTo = null
  for (const text of lines.map(lineText)) {
    let m = RE_COMP_DONE.exec(text)
    if (m) {
      const t = ts(m[1])
      if (t && (doneTs == null || t > doneTs)) { doneTs = t; doneFrom = +m[3]; doneTo = +m[4] }
      continue
    }
    m = RE_COMP_TEL.exec(text)
    if (m) {
      const t = ts(m[1])
      const parsed = parseCompactionTelemetry(m[2] || '')
      if (t && parsed && (telTs == null || t > telTs)) { telTs = t; tel = parsed }
      continue
    }
    m = RE_COMP_START.exec(text)
    if (m) {
      const t = ts(m[1])
      if (t && (start == null || t > start)) { start = t; startTokens = m[4] ? +m[4].replace(/,/g, '') : null }
    }
  }
  const endTs = Math.max(telTs || 0, doneTs || 0) || null
  return { start, startTokens, end: endTs, tel, doneFrom, doneTo }
}

function collectMicroMarkers(lines) {
  let at = null
  let detail = null
  for (const text of lines.map(lineText)) {
    let m = RE_MICRO_OK.exec(text)
    if (m) {
      const t = ts(m[1])
      if (t && (at == null || t > at)) { at = t; detail = `${m[2]} → ${m[3]} msgs` }
      continue
    }
    m = RE_MICRO_FAIL.exec(text)
    if (m) {
      const t = ts(m[1])
      if (t && (at == null || t > at)) { at = t; detail = `failed: ${m[2].slice(0, 80)}` }
    }
  }
  return { at, detail }
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

async function reconcileCompaction() {
  const now = Date.now()
  if (now - state.compact.lastPoll < 5000) return
  state.compact.lastPoll = now
  try {
    // 3000-line window: a batch compaction can run 20+ min, and the log keeps
    // accumulating unrelated lines while it runs — the start line must stay in view.
    const c = await host.logs({ file: 'agent', lines: 3000, search: 'context compression' })
    const clines = (c && (c.lines || c.data || c.logs)) || []
    const { start, startTokens, end, tel, doneFrom, doneTo } = collectCompactionMarkers(clines)

    const running = start != null && (end == null || start > end)

    // newest terminal wins: telemetry covers both committed and aborted
    let endedAt = null
    let committed = null
    let failure = null
    if (end != null) {
      endedAt = end
      if (tel) { committed = tel.committed; failure = tel.failure }
      else committed = true // only a `done` line (committed path) was in the window
    }

    const mc = await host.logs({ file: 'agent', lines: 500, search: 'Micro-compaction' })
    const mlines = (mc && (mc.lines || mc.data || mc.logs)) || []
    const micro = collectMicroMarkers(mlines)

    setCompact({
      mode: running ? 'running' : 'idle',
      startedAt: running ? (state.compact.startedAt || start) : null,
      startTokens: running ? (state.compact.startTokens || startTokens) : null,
      endedAt,
      committed,
      failure,
      doneFrom,
      doneTo,
      lastMicroAt: micro.at,
      microDetail: micro.detail,
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
    reconcileCompaction()
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
    const poll = setInterval(() => { reconcile(); reconcileCompaction() }, POLL_MS)
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

// Compaction chip: visible only while a batch compaction is running or within
// RECENT_COMP_MS of its end. Renders null otherwise (no idle noise).
function CompactionChip() {
  const s = useWatch()
  const now = useNow()
  const c = s.compact

  const recentEnd = c.endedAt != null && now - c.endedAt < RECENT_COMP_MS
  if (c.mode !== 'running' && !recentEnd) return null

  let dotColor = 'var(--ui-accent)'
  let label
  let detail

  if (c.mode === 'running') {
    label = `compacting · ${ago(now - c.startedAt)}`
    detail = `Batch context compaction in progress — the local model is summarizing the session middle (started at ~${fmtTokens(c.startTokens)} tokens).\n` +
      'First measured run (197K-token session) committed in ~4 min. The single inference slot is busy until it commits, so queued messages will wait.\n' +
      'Nothing is lost: a checkpoint is archived first, and the transcript stays searchable via session_search.'
  } else if (c.committed === false) {
    label = `compact failed ${ago(now - c.endedAt)} ago`
    detail = `Compaction was aborted (${c.failure || 'unknown failure'}) — the session was left unchanged and will retry on the next compaction trigger.`
  } else {
    label = `compact done ${ago(now - c.endedAt)} ago`
    detail = (c.doneFrom != null
      ? `Compaction committed: ${c.doneFrom} → ${c.doneTo} messages.`
      : 'Compaction committed.')
  }
  if (c.lastMicroAt != null && c.microDetail) {
    detail += `\nLast micro-compact pass: ${ago(now - c.lastMicroAt)} ago (${c.microDetail})`
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
        color: dotColor,
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
            animation: c.mode === 'running' ? 'bgrw-pulse 1.2s ease-in-out infinite' : 'none',
          },
        }),
        jsx('span', { children: label }),
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
    ctx.register({
      id: 'chip-compact',
      area: STATUSBAR_AREAS.right,
      order: 141,
      render: () => jsx(CompactionChip, {}),
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
