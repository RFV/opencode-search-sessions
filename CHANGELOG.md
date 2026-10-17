# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and this project uses
[Semantic Versioning](https://semver.org/).

## [0.1.1] - 2026-10-17

### Fixed

- Published the first live npm release. `0.1.0` was held in npm's staged-publishing flow; `0.1.1` is the installable release.

## [0.1.0] - 2026-10-17

### Added

- Incremental SQLite FTS5 index of OpenCode session content.
- Session-level, message-level, and part-level change detection.
- Live indexing from OpenCode durable events, with startup and reconnect catch-up.
- TUI command `Ctrl+X F`, `/search-sessions`, and `/find`.
- Grouped session results with snippets, hit counts, project labels, and timestamps.
- Queued prompt indexing and cancellation cleanup.
- Optional tool input/output, shell, reasoning, system, and subagent indexing.
- Command-palette actions for index stats, sync, and rebuild.
- Unit tests for extraction, FTS search, incremental updates, queued prompts, and subagents.
