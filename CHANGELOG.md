# Changelog

All notable changes to this plugin are documented here.

The project uses [Semantic Versioning](https://semver.org/). The first two
versions below are reconstructed from the repository history; version 0.3.0 is
the first release to carry an explicit `VERSION` file.

## [0.3.0] - 2026-10-02

### Added

- Observe `message.start` and `message.complete` as the foreground reply
  boundary, and surface a `review overlap` diagnostic if a background review
  starts before foreground completion.
- Surface `usage ticker stop timed out` recovery markers for ten minutes so a
  completed reply does not silently hide a stuck ticker cleanup.
- Add a dependency-free loader and registration smoke test covering all three
  status-bar contributions and their event wiring.

### Changed

- Rename the displayed plugin from **Background Runner Watch** to
  **Background Review & Completion Watch** to reflect the wider scope.
- Preserve log timestamp milliseconds when comparing review lifecycle events,
  reducing false ordering results for events within the same second.

## [0.2.0] - 2026-09-27

### Added

- Add the compaction status chip for running, completed, and failed batch
  context compression attempts.
- Show committed message reduction, failure class, and the latest
  micro-compaction result in the tooltip.

### Changed

- Correct the compaction timing guidance using measured local-model runtime.

## [0.1.0] - 2026-09-24

### Added

- Initial Hermes Desktop disk plugin.
- Add the background-review status chip with running elapsed time and recent
  completion summary.
- Add the turn-based memory and skill nudge countdown bar.
- Detect review lifecycle through live events and filtered `agent.log` polls.

[0.3.0]: https://github.com/vectorforge22/bg-review-watch/compare/eb49f35...v0.3.0
[0.2.0]: https://github.com/vectorforge22/bg-review-watch/compare/7a222e1...eb49f35
[0.1.0]: https://github.com/vectorforge22/bg-review-watch/commit/7a222e12df8d2e71d2e9860df851753b967e5e28
