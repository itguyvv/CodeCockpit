# Changelog

All notable changes to CodeCockpit are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Fixed

- macOS/Linux: sessions spawned from a GUI launch (Finder/Dock) inherited the minimal launchd environment, so CLI logins that live in the shell profile (API keys, proxies, PATH additions) were invisible — Claude Code showed "Not logged in" while the same CLI worked in a terminal. Sessions now start through the user's login + interactive shell (`$SHELL -l -i -c 'exec <cli>'`), matching the terminal environment; the CLI still owns the PTY via `exec`.

## [1.3.0] - 2026-11-10

### Added

- **Codex engine** — OpenAI's Codex CLI joins Claude Code and openCode as a third fully supported backend. Sessions live in their own sidebar tab; history is read from `~/.codex/sessions` with thread titles; resuming reconnects the full context; all four permission modes map onto codex's sandbox/approval flags; the session dashboard aggregates tokens, cost, turns, and tool calls live from the rollout log; the rule editor gains the global `~/.codex/AGENTS.md` scope; image paste follows the path-insertion behavior. Codex stays out of the API-provider relay system (its relay configuration is a TOML file, not environment variables).
- Terminal search — `Ctrl+F` (`Cmd+F` on macOS) in any session opens a find bar with match highlighting and a match counter.
- Update check — the app queries GitHub Releases once at startup and shows a quiet toast when a newer version is out. The check can be disabled and triggered manually from Settings → About, which also shows the current update status.

### Changed

- Sessions now spawn with UTF-8 defaults (`PYTHONUTF8=1`, `LANG=en_US.UTF-8`), so tool output containing non-ASCII text — most visibly Python programs printing to a pipe — no longer renders as mojibake.
- Codex sessions derive their busy/processing state from the rollout's `task_started`/`task_complete` events instead of terminal output, so scrolling the full-screen TUI no longer flips an idle session to "working".

### Fixed

- Codex sessions in the "Accept edits" mode failed to start: the flag codex 0.167 removed (`--full-auto`) was still being passed; the supported `--approve-for-me` is used instead.
- The Codex session tailer no longer rescans the whole sessions directory every second; rollout files vanish-concurrently are tolerated.
- All app JSON state (settings, session list, custom titles, ordering) is written atomically, so an interrupted write can no longer truncate the files.
- The background-task badge no longer counts shells from historical launches replayed on resume — only processes that are actually still running.

## [1.2.0] - 2026-11-09

### Added

- **Project aliases** — give any directory a display name in the sidebar; the original path stays visible next to it.
- **Pinned projects** — pin frequently used directories from the sidebar context menu and jump straight to their recent sessions from the new-session dialog.
- **Rule file editor** — edit global and per-project `CLAUDE.md` (Claude Code) / `AGENTS.md` (openCode) in-app, with live Markdown preview, synchronized scrolling, and a maximize toggle.
- **Completion notifications (opt-in)** — get a desktop notification when the AI finishes a request; clicking it switches to that session's terminal. Off by default — enable in Settings → General.

### Fixed

- Switching sessions no longer flips idle sessions to a phantom "Working" status; the indicator reflects real AI activity only.
- Renaming a running Claude Code / openCode session now persists correctly (internal ids were written as title keys).

## [1.1.1] - 2026-11-09

### Added

- **macOS and Linux builds** — Apple Silicon + Intel mac zips, Linux AppImage / deb / rpm (x64 + arm64), plus a Windows ARM64 zip; all produced by the release CI.
- Cross-platform CLI discovery, path handling, fonts, and Cmd shortcuts.
- Settings → **About** tab with the app version.
- OpenCode 1.18 (SQLite session storage) support; only the newest storage generation per install is listed.
- Image paste into openCode sessions via the async clipboard API, with a platform-aware clipboard fallback.
- Background-shell detection — terminal links open in the system browser while a background process runs.
- Release runbook (`docs/RELEASING.md`) documenting the full artifact matrix.

### Changed

- Release CI hardened: cross-arch node-pty prebuilds, retries against transient download failures, draft-release publication from version tags.

## [1.1.0] - 2026-11-07

### Added

- Internationalization across the whole app — 10 languages out of the box: English, 简体中文, 繁體中文, 日本語, 한국어, Deutsch, Français, Español, Português (Brasil), Русский. Selectable in Settings; the main process (dialogs, notifications, terminal banners) follows the same locale.
- Language picker in the Settings center; the choice persists in the app settings.
- History groups now collapse by default with a one-click "expand all / collapse all" toggle; searching automatically expands matching groups.
- App version shown in the status bar.
- Post-build packaging pipeline: fixed-name portable folder `dist/CodeCockpit/` (overwrite-friendly upgrades) plus a versioned distributable `CodeCockpit-<version>-win-x64.zip` generated on every `npm run dist`.
- Clipboard image detection in packaged builds (image paste forwarded to the Claude CLI as Alt+V).
- Right-click in the terminal: copy selection, or paste text/image depending on clipboard contents.
- Drag & drop: drop files to insert quoted paths; drop text to paste it.
- `data-dir.txt` pointer file to relocate the portable data directory across upgrades.

### Changed

- All UI strings and terminal banners fully localized; English is the development language of the codebase.
- History list parses and displays native Claude Code sessions directly from `~/.claude/projects`.

### Fixed

- Crash in packaged builds when right-clicking the terminal (`clipboard.availableFormats` unavailable in Electron 45 sandboxed builds).

## [1.0.0] - 2026-10

### Added

- M1: PTY terminal core (ConPTY via node-pty) with unlimited parallel Claude Code sessions in xterm.js.
- M2: Session center — history grouped by project, rename, delete with confirmation, drag to reorder, workspace persistence with one-click `--resume`.
- M3: jsonl mirror pipeline — exact token/cache/cost accounting, tool-call stats, and turn timing parsed from Claude Code session logs.
- M4: Per-session dashboard — context usage, output speed, tool usage mix.
- M5: Settings center — default mode/model, relocatable data directory, zip export/import migration, MCP server overview.
- M6: Native completion notifications; Windows packaging via electron-builder.
- Permission mode switching (default / acceptEdits / plan / bypassPermissions) without losing session context; change-directory-and-resume.
