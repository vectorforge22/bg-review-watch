# Background Runner Watch

A [Hermes Desktop](https://hermes-agent.nousresearch.com) plugin that makes the
**background self-improvement review visible**: a status-bar chip that shows
whether a review is running, when the last one finished (and what it produced),
and a **fill bar counting down the turns until the next nudge fires**.

Motivation: the background review is a silent daemon thread — the only gateway
event is the completion summary, which can arrive hours after it started.
Before this plugin, a multi-hour local-model review was a surprise: no
indicator, no way to know it was eating the main inference slot.

## What it shows

Status bar, right cluster:

| State | Chip |
|---|---|
| Idle | `● review idle` + fill bar `Nt` — turns since last review / nudge interval (bar fills as the next nudge approaches) |
| Running | `● review running · 2m 14s` (pulsing accent dot, live elapsed time) |
| Just finished | `● review done 3s ago` — tooltip carries the summary text (e.g. "Skill 'x' created · …") |

Hover for details: last result, next-nudge countdown for both memory
(default 10 turns) and skill (default 15 turns) nudges.

## How it detects (no Python backend, no gateway restart)

Read-only, renderer-only:

- **Live completion** — `host.onEvent('review.summary')` (seconds before the log line).
- **Turn ticks** — `host.onEvent('message.start')` advances the countdown.
- **Running state** — 20 s poll of `host.logs({ file:'agent', search:'bg-review' })`:
  spawn marker `OpenAI client created … thread=bg-review:<pid>` vs completion
  `Background review complete: … result=skill|none` / `Background memory/skill
  review failed`. `running ⇔ latest spawn ts > latest completion ts` (at most
  one review runs at a time; a new turn supersedes an in-flight one, and
  superseded runs still log a completion line).
- **Intervals** — `host.request('config.get')`, best-effort with 10/15 defaults.

The spawn-marker anchor (`OpenAI client created`) is load-bearing: the
`retired`/`closed` teardown lines also carry `thread=bg-review:<pid>` and
arrive *after* the completion line — a bare `thread=bg-review:(\d+)` match
would flip the chip to "running" forever. Verified against 17 historical runs.

## Install

Disk plugin (no build step): copy this folder to
`$HERMES_HOME/desktop-plugins/bg-review-watch/` — the app hot-reloads within
seconds. Enable in **Capabilities → Plugins** (on by default).

Or via install link: `hermes://plugin/install?repo=<owner>/bg-review-watch&enable=1`

## Cost

~2 REST calls per 20 s while idle (server-side filtered tails), 1 s timer for
the elapsed-time tick while a review runs, plus two event listeners. No sockets,
no Python, no state written.

## Files

- `plugin.js` — the whole plugin (single ESM file, loaded uncompiled)

## Notes / limitations

- Countdown assumes user-driven turns (a nudge fires after N user turns since
  the last review); it is an estimate, not the harness's internal counter.
- Log markers were verified against the 2026-09 build
  (`agent/background_review.py`, `logs/agent.log`). If a Hermes build renames
  the `thread=bg-review` markers, the poll degrades to "idle" (fail-open) —
  the live `review.summary` path keeps working.
- The review replays the conversation on the main local model, so "running"
  also means the local model is busy — this plugin does not throttle the
  review; the harness knobs (`auxiliary.background_review.*`, nudge
  intervals) do.

## License

MIT
