<div align="center">

<img src="resources/icon.png" width="120" alt="CodeCockpit logo" />

# CodeCockpit

**A desktop cockpit for your AI coding agents.**

Run, observe, and manage multiple AI coding CLI sessions (Claude Code & OpenCode today, more coming) from one native window — real PTY terminals, exact token/cost accounting, and full session history.

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
![Platform](https://img.shields.io/badge/platform-Windows%2010%20%2F%2011-blue)
![Electron](https://img.shields.io/badge/Electron-45-47848F)
![Node](https://img.shields.io/badge/node-%E2%89%A520-339933)

English | [简体中文](README.zh-CN.md)

</div>

---

## Why CodeCockpit?

Driving several AI coding agents means juggling raw terminal windows, losing track of which session burns how many tokens, and re-reading history files by hand. CodeCockpit puts everything in one cockpit:

- One window, many live agent terminals — each a real PTY, not a text dump.
- Per-session telemetry parsed directly from the engines' own session records: model, tokens in/out, cache traffic, estimated cost, tool-call breakdown, pure AI time.
- History and workspace state survive restarts; resume any past session with one click.
- Bring your own API relay — provider profiles route any session through a custom endpoint (cc-switch style).

## Features

- **Two engines, one cockpit** — Claude Code and OpenCode side by side, each with its own history center; engines you don't use can be disabled in Settings.
- **Real PTY terminals** — every session runs in an independent ConPTY process, fully rendered by xterm.js with selection, copy/paste, drag & drop of file paths, and unlimited parallel sessions.
- **Exact session telemetry** — parses each engine's own session records (Claude jsonl / OpenCode storage): model, input/output tokens, cache read/write, estimated cost, turns, tool-call ranking, and pure AI working time.
- **Session dashboard** — a live bottom bar per session: context usage, output speed, and the tool-usage mix at a glance.
- **History center** — all native sessions per engine, grouped by project, with rename, delete (with confirmation), drag to reorder, search, and record sizes. Groups collapse by default with one-click expand-all.
- **Workspace persistence** — the active session list is fully restored on startup; exiting processes come back with a single click via resume.
- **API provider profiles** — cc-switch style: multiple provider profiles per engine with base URL + API key, one-click connectivity test, model mapping (route main/haiku/sonnet/opus tiers onto any model), and per-session env injection or global config rewrite (a `.bak` backup is written first).
- **Permission mode switching** — default / acceptEdits / plan / bypassPermissions switched live without losing context; bypass mode asks twice.
- **Change directory, keep context** — moved a project to a new path? Switch cwd and resume the same session in place.
- **Completion notifications** — native OS notifications when the agent finishes while the window is in the background; click to jump back.
- **Exit confirmation** — closing the window with sessions running asks first (optional "don't ask again"), so a stray click never kills your agents.
- **Settings center** — tabbed: defaults (mode/model, terminal scrollback), engine toggles, provider profiles, and quick access to Claude config + MCP server overview; relocatable data directory with zip export/import.
- **10 languages** — English, 简体中文, 繁體中文, 日本語, 한국어, Deutsch, Français, Español, Português (Brasil), Русский. Switch any time in Settings.

## Requirements

- **OS**: Windows 10 (1809+) or Windows 11
- **Node.js** ≥ 20 (only for building from source; the packaged app needs nothing)
- At least one of:
  - [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code) — Git Bash is required by the CLI on Windows; CodeCockpit auto-detects common install paths
  - [OpenCode CLI](https://opencode.ai) — install via `npm i -g opencode-ai` or its installer

## Development

```bash
npm install
npm run dev
```

CodeCockpit auto-locates the `claude` CLI (PATH, WinGet links, npm global), the `opencode` CLI, and Git Bash at startup.

Useful scripts:

```bash
npm run dev         # dev server + electron
npm run typecheck   # tsc project references build
npm run build       # compile main/preload/renderer to out/
npm run dist        # build + package a portable dir + versioned zip into dist/
```

The `dist` step produces:

- `dist/CodeCockpit/` — fixed-name portable folder (overwrite this folder to upgrade; `data/` inside is preserved)
- `dist/CodeCockpit-<version>-win-x64.zip` — the distributable you share with others

## Where data lives

- **App data** (session list, custom names, ordering, provider profiles, settings): `data/` next to the executable in portable mode, or the path configured in `data-dir.txt`. Change or migrate it from Settings → export/import a zip.
- **Chat history**: written by the engines themselves — `~/.claude/projects/<encoded-project>/<sessionId>.jsonl` for Claude Code, OpenCode's own storage under `~/.local/share/opencode` (Windows: `%USERPROFILE%\.local\share\opencode`). CodeCockpit only reads these files — it never rewrites your transcripts.

> **Note on API keys**: provider profiles are stored in plain text inside the app data directory (like the CLIs' own config files). Anything you paste into Settings stays on your machine. Per-session injection keeps keys out of project files.

## Internationalization

CodeCockpit ships 10 languages out of the box and uses a type-safe shared dictionary for both the renderer and the main process (menus, dialogs, notifications). Adding a language is a two-file PR — see [CONTRIBUTING.md](CONTRIBUTING.md#adding-a-translation).

| Language | Code | Language | Code |
| --- | --- | --- | --- |
| English | `en` | Deutsch | `de` |
| 简体中文 | `zh-CN` | Français | `fr` |
| 繁體中文 | `zh-TW` | Español | `es` |
| 日本語 | `ja` | Português (Brasil) | `pt-BR` |
| 한국어 | `ko` | Русский | `ru` |

## Roadmap

- [x] M1 — PTY terminal core + multi-session
- [x] M2 — Session center (history / rename / delete / reorder / persistence)
- [x] M3 — jsonl mirror pipeline (exact token / cost / tool telemetry)
- [x] M4 — Session dashboard
- [x] M5 — Settings center + data migration + MCP overview
- [x] M6 — Completion notifications + packaging
- [x] M7 — Internationalization (10 languages)
- [x] M8 — OpenCode as a second engine (spawn, telemetry, history, resume)
- [x] M9 — API provider profiles (connectivity test, model mapping, global apply)
- [ ] Codex CLI as a third engine
- [ ] macOS / Linux builds

## Contributing

Issues and pull requests are welcome — especially translations and engine adapters. See [CONTRIBUTING.md](CONTRIBUTING.md) for the build setup and conventions.

## Author

Created and maintained by **[ITGuyVV](https://github.com/ITGuyVV)**.

## License

[MIT](LICENSE) © CodeCockpit Contributors
