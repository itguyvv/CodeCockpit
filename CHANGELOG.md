# Changelog

All notable changes to CodeCockpit are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
