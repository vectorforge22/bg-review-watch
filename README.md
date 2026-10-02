# Background Review & Completion Watch

Current version: **0.3.0**. See [CHANGELOG.md](CHANGELOG.md) for release history.

A [Hermes Desktop](https://hermes-agent.nousresearch.com) plugin that makes the
**background self-improvement review visible**: a status-bar chip that shows
whether a review is running, when the last one finished (and what it produced),
and a **fill bar counting down the turns until the next nudge fires**.
It also watches the foreground/review boundary introduced to keep a local
single-inference slot from starting review work before the reply is terminal.

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
| **Compacting (v0.2.0+)** | `● compacting · 4m 12s` (pulsing accent dot) while a batch context compaction runs; then `● compact done 3m ago` / `● compact failed 2m ago` for 10 min. Tooltip: committed reduction (`168 → 77 messages`) or failure class (`stall_interrupted`, `explicit_interrupt`, …), plus the last micro-compact pass when Stage A runs. Hidden entirely otherwise. |
| **Ticker recovery (v0.3.0+)** | `● reply guard recovered · 3s ago` for 10 min when bounded foreground cleanup detects a stuck usage ticker. The completed reply continues; the tooltip points to the captured stack in `agent.log`. Hidden on healthy runs. |
| **Ordering violation (v0.3.0+)** | `● review overlap · 3s ago` if review startup predates the foreground `message.complete` event. This is a diagnostic failure signal, not a normal running state. |

Hover for details: last result, next-nudge countdown for both memory
(default 10 turns) and skill (default 15 turns) nudges.

## How it detects (no Python backend, no gateway restart)

Read-only, renderer-only:

- **Live completion** — `host.onEvent('review.summary')` (seconds before the log line).
- **Turn ticks** — `host.onEvent('message.start')` advances the countdown.
- **Foreground completion** — paired `message.start` / `message.complete`
  events define the delivery window. A review start inside that window is
  reported as an ordering violation.
- **Bounded-cleanup recovery** — polls the core diagnostic marker
  `usage ticker stop timed out`; the core log carries the blocked thread stack.
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

~3 REST calls per 20 s while idle (server-side filtered tails), 1 s timer for
the elapsed-time tick while a review runs, plus three event listeners. No sockets,
no Python, no state written.

## Files

- `plugin.js` — the whole plugin (single ESM file, loaded uncompiled)
- `test-plugin.mjs` — dependency-free loader/registration smoke test
- `VERSION` — authoritative machine-readable plugin version
- `CHANGELOG.md` — release history reconstructed from Git commits

## Validate

```powershell
node --check plugin.js
node --experimental-vm-modules test-plugin.mjs
```

## Notes / limitations

- Countdown assumes user-driven turns (a nudge fires after N user turns since
  the last review); it is an estimate, not the harness's internal counter.
- Log markers were verified against the 2026-09 build
  (`agent/background_review.py`, `logs/agent.log`). If a Hermes build renames
  the `thread=bg-review` markers, the poll degrades to "idle" (fail-open) —
  the live `review.summary` path keeps working.
- Compaction markers verified 2026-09-27 against
  `agent/conversation_compression.py` (started/done/attempt-telemetry) and
  `agent/turn_finalizer.py` (Micro-compaction), plus 13 historical telemetry
  lines in `agent.log`. "Running" = latest `context compression started:`
  newer than the latest terminal line (`done:` or telemetry JSON, which
  covers both committed and aborted attempts).
- The review replays the conversation on the main local model, so "running"
  also means the local model is busy — this plugin does not throttle the
  review; the harness knobs (`auxiliary.background_review.*`, nudge
  intervals) do.
- The v0.3.0 completion guard is observational. Correctness remains in Hermes core;
  disabling this plugin does not disable the delivery barrier or bounded ticker
  shutdown.

## License

MIT
