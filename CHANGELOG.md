# Changelog

All notable changes to CodeCockpit are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.6.3] - 2026-11-23

### Fixed

- **Codex sessions in the packaged app rendered without colors.** An app launched from Explorer carries no `TERM` variable, and codex gates its palette on it — without `TERM` it fell back to basic 16-color / unstyled text, so sessions that are richly colored in `cmd` came out washed out (verified: identical spawn with `TERM=xterm-256color` restores the full 256-color output). Session spawns now default `TERM=xterm-256color` when the environment has none, matching what the PTY already declares; an explicit `TERM` set by the user still wins.

## [1.6.2] - 2026-11-23

### Fixed

- **Codex sessions inserted a right-click paste twice.** Before pasting, the terminal forwarded the right-button press/release mouse reports to the TUI, and codex's composer — which batches bracketed pastes on a timer — committed the paste a second time when a mouse report raced it (verified by replaying the exact input stream: one write, two insertions). The app consumes right-clicks itself, so right-button reports are no longer forwarded at all, and any other mouse report is suppressed for a short window spanning a right-click paste's commit. Claude Code and openCode sessions are unaffected — they receive no mouse reports to begin with.

## [1.6.1] - 2026-11-22

### Fixed

- **Sessions created or attached from the phone never opened on the desktop.** The adoption put them in the sidebar, but the focus event raced the list update (stale closure) and only ever tried to attach an existing terminal — none existed for a session this window had never opened. The focus handler now reads a latest-ref and builds the terminal slot on demand, so the desktop really jumps to the session.

### Changed

- CJK text in the session terminal now falls back to Microsoft YaHei UI instead of Chromium's per-locale default (SimSun on zh-CN Windows), so Chinese no longer renders in a serif-ish fallback; machines without the named fonts fall through to the system monospace as before.
- The 150 ms duplicate-paste guard now covers every paste path (Ctrl+V, Shift+Ctrl+V, right-click) instead of only Shift+Ctrl+V: an identical paste twice within 150 ms can only be a double-dispatched event, never a human action, and is now inserted once.

## [1.6.0] - 2026-11-22

### Fixed

- **The phone's session list disagreed with the desktop sidebar.** Remote clients were served the raw session registry (including stale exited sessions the workbench had already cleaned up). The remote list now mirrors the desktop workbench's own list, with a safety union against live processes so a lagging workbench can't hide a running session.
- **Sessions created or resumed from the phone never appeared on the desktop.** The desktop renderer now adopts a `pty:created` broadcast (fired for both local and remote creates) into its workspace list and focuses the session, and `session_created` carries a summary so the phone renders it immediately too.
- **The first message sent to a freshly created or resumed session was silently lost.** When the CLI had not rendered its first frame yet, the write went straight into the PTY and was swallowed by the TUI. Remote input is now queued per session (8 KB cap) and flushed in order once the CLI produces output, with an 8-second safety flush; input to a dead session returns an error instead of vanishing. Requires CodeCockpit Remote v0.4.0+.

## [1.5.0] - 2026-11-21

### Added

- **IPv6 direct connection** — second method card in Settings → Remote access: lists the desktop's public IPv6 addresses with copy buttons and a green/red availability chip (red = this network has no public IPv6, with guidance). No new protocol — the phone dials the same TLS WebSocket endpoint over IPv6, so it works from another network whenever both ends have IPv6 and the router passes it through.
- **Remote session management from the phone** — the remote protocol gains create / kill / rename / history / delete-history requests: a paired phone can start a session in a chosen folder (nonexistent paths are rejected instead of silently falling back), stop it, rename it, and browse or resume the desktop's native session history (up to 100 sessions per engine, grouped by project in the app). The session list is broadcast on every change — including PTY exit — so both ends stay in sync. Requires CodeCockpit Remote v0.3.0+ on the phone.
- **Tool output in the phone chat** — tool results are captured for all three engines (Claude Code by tool-use id, Codex by call id, OpenCode from part state) and attached to the matching message (capped at 4000 characters), so the phone shows what each command actually produced.
- Plan/todo updates (TodoWrite, TaskCreate/TaskUpdate, update_plan) are tracked and surfaced in the phone's status line and plan cards.

### Changed

- Connection methods in Settings → Remote access are presented as plain info cards.
- Session record sniffers now poll indefinitely (600 ms for the first 120 s, then every 5 s) instead of stopping, so tool results produced later in a session still reach the phone.

### Fixed

- **Phone connections died after exactly 30 seconds.** A failed auth attempt closed the socket while the phone was already re-authenticating with its secret: the closing handshake stalled and the server dropped the connection (code 1006) before the re-pairing could complete. Failed auths now keep the socket open, so an expired device token re-pairs on the same connection.
- **The IME candidate window jumped while output streamed.** xterm's composition helper re-anchored the hidden input to the cursor cell on every render; during an active IME composition the repositioning is now frozen, so the candidate window stays put even while a session's spinner redraws.
- Input from the phone that ends with Enter now submits reliably (Ink-based TUIs treated a trailing carriage return inside a large write as a literal newline); renaming a session is immediately visible to the phone; sessions left over from a previous app start report as exited instead of running.
- The desktop follows the phone's session selection — attaching from the phone also focuses that session in the desktop workbench.

### Removed

- **Any network (link mode)** — the WebRTC/numeric-ID connection path (signaling relay, hidden bridge window, link status chip and its settings) is gone. Rationale: with both ends behind carrier-grade NAT, pure-STUN hole punching is unreliable, and free TURN relays are unreachable from mainland China networks — so the mode could not deliver dependable connectivity without a paid or self-hosted data relay. Remote access now has direct methods only: *Same network* (LAN / Tailscale) and *IPv6 direct*. The last complete implementation ships in release v1.4.0 (also archived in the project's backup documentation). Removing the hidden bridge window also eliminates the close-then-lingering-process bug.

## [1.4.0] - 2026-11-19

### Added

- **Remote access (M1, desktop side)** — an optional, built-in WebSocket server (Settings → Remote access, off by default) so a phone client can watch session progress and send prompts over the network. Self-signed TLS with a fingerprint to compare on first connect; pairing by a copyable secret that mints a per-device token for reconnects (secrets and tokens stored hashed; failed-auth rate limiting; max 4 clients). The phone gets the session list, a live chat-style conversation stream (user / assistant / tool messages, upserted in place as they stream) for all three engines, telemetry snapshots, and can submit input and switch permission modes. Protocol documented in `docs/REMOTE_PROTOCOL.md` as the implementation contract for the upcoming CodeCockpit Remote Android app.
- **Any network (link mode)** — optional second connection path for remote access, replacing the UPnP variant: the desktop displays an 8-digit device ID, and the phone connects from anywhere by entering just that ID and the pairing secret — no VPN, no port forwarding. A lightweight signaling relay (Cloudflare Workers, deployable separately) introduces the peers; the actual traffic flows over a WebRTC DataChannel with hole punching and TURN fallback, carrying the exact same authenticated JSON protocol. The pairing secret is never sent to the relay (only a derived registration key), the relay cannot enumerate devices, and per-ID rate limits plus an anti-hijack registration hash protect the ID space. Connection modes in Settings are now *Same network* (direct reach, e.g. Tailscale) and *Any network* (link mode).
- Link-mode status chip in Settings: the any-network card shows at a glance whether the signaling relay is online, connecting, or offline — with the failure reason (network unreachable / rate limited / ID claimed) and the next automatic retry countdown.

### Changed

- The signaling server override was removed from the settings UI; self-hosted relays can still set `remoteLinkServer` in `settings.json`.

### Fixed

- Packaged builds crashed on launch because the `stun` dependency bundles its internals behind nested `node_modules` that the asar packing strips out. Replaced with a small built-in RFC 5389 STUN client (also accepts RFC 3489 replies), dropping the dependency.
- A port conflict on the remote access server crashed with a native "A JavaScript error occurred" dialog. The conflict now surfaces as an in-app toast, and when the port is held by a leftover copy of CodeCockpit itself, a dialog offers to end that process and retry (verified by PID + executable path, user-confirmed).
- Link signaling survived neither handshake black-holes (the upgrade could hang forever) nor the relay's per-IP registration rate limit (retrying every 30 s burned the 3-per-10-minutes budget and locked the desktop out). The upgrade now times out after 10 s, rate-limited retries back off 3 minutes honoring `Retry-After`, and exponential retries are capped at 2 minutes with jitter.
- The 任意网络 (any-network) card did not react to clicks in packaged builds: the preload bridge was missing the link-mode IPC wrappers that the renderer called.
- IME: composition anchoring, voice-input double commit, and premature dictation commits are fixed; interim dictation text is held until recognition finalizes.

## [1.3.2] - 2026-11-12

### Added

- One-click "remove all" for the active-sessions list — after a confirmation, stops and removes every session in the window at once; history is untouched and each session can be resumed later.

### Fixed

- Windows: clicking a completion notification now opens the app and switches to that session. The AppUserModelID was never set, so toast click activation never reached the app; clicking now also dismisses the toast immediately.
- Windows: the page no longer jumps sideways while typing with an IME when the composition reaches the screen's right edge — Chromium's focus handling could programmatically scroll the document; the app root now clips overflow so there is nothing to scroll.

## [1.3.1] - 2026-11-11

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
