# Contributing to CodeCockpit

Thank you for considering a contribution! Issues, bug reports, translations, and pull requests are all welcome.

## Getting started

Requirements:

- Node.js ≥ 20 (LTS recommended)
- Any of the three supported platforms: Windows 10 (1809+)/11, macOS 12+, or a modern glibc Linux
- Git Bash (only needed on Windows, by the Claude Code CLI)

```bash
git clone <your fork>
cd CodeCockpit
npm install
npm run dev        # run the app in dev mode
npm run typecheck  # must pass before any PR
npm run build      # compile without packaging
npm run dist       # Windows full package: dist/CodeCockpit/ + versioned zip
```

Packaging for the other platforms (or cross-checking a change locally):

```bash
npm run dist:mac    # unsigned mac zips (x64 + arm64)
npm run dist:linux  # linux AppImage (add --x64 / --arm64 per target)
```

CI builds all artifacts on pushes to `main` (see `.github/workflows/ci.yml`). Releases are tag-driven: pushing a `v<version>` tag (e.g. `git tag v1.1.1 && git push origin v1.1.1`) makes CI build every platform, sync the package version to the tag, and attach the artifacts to a **draft** release — the maintainer reviews it on GitHub and clicks *Publish* to make it public. Deleting the tag and pushing it again rebuilds and overwrites the draft.

> Note: `npm run typecheck` runs `node node_modules/typescript/lib/tsc.js -b`. On some systems `npx tsc -b` fails with `ERR_UNKNOWN_FILE_EXTENSION` when an older Node is first on PATH — the script form avoids that.

## Project layout

```
src/
  main/       Electron main process (PTY sessions, IPC, session services)
  preload/    Context bridge (typed API exposed to the renderer)
  renderer/   React UI (xterm terminals, sidebar, dashboards, modals)
  locales/    Translation dictionaries (en.ts is the source of truth)
scripts/      Build/post-build helpers
```

## Conventions

These are hard rules — see [CLAUDE.md](CLAUDE.md) for the authoritative version.

- **English-only source.** All identifiers, comments, commit messages, and docs are English. No Chinese (or any other natural language) anywhere in `src/` or `scripts/` except the translation dictionaries themselves (`src/locales/zh-CN.ts`, `src/locales/zh-TW.ts`). User-facing text lives exclusively in `src/locales/` — never hard-code UI strings in components or the main process.
- **Complete translations on every change.** Adding or changing any UI string requires updating **all 10 locale files in the same PR**: `en`, `zh-CN`, `zh-TW`, `ja`, `ko`, `de`, `fr`, `es`, `pt-BR`, `ru`. The `Translation` type makes a missing key a compile error, so `npm run typecheck` proves completeness. Never leave a stale product name, exe name, or path in any locale — the brand `CodeCockpit` stays identical in every language.
- **TypeScript strict.** `npm run typecheck` must pass.
- Keep PRs focused: one bug fix or one feature per PR.

## Commit messages

Use concise, imperative English subjects (`fix: ...`, `feat: ...`, `docs: ...`, `i18n: ...`, `build: ...`), e.g.:

```
feat: add session dashboard context-usage bar
fix: clipboard image detection in packaged builds
i18n: add Korean translation
```

## Adding a translation

CodeCockpit uses a shared, type-safe dictionary consumed by both the renderer and the main process. To add a language (example: Italiano `it`):

1. Create `src/locales/it.ts`:

   ```ts
   import type { Translation } from './en'

   const it: Translation = {
     'app.name': 'CodeCockpit',
     // ...translate every key; your editor lists missing keys from the type
   }
   export default it
   ```

2. Register it in `src/locales/index.ts`:

   - import `it` and add it to the `locales` registry,
   - add `'it'` to the `LocaleCode` union / registry type,
   - add `{ code: 'it', label: 'Italiano' }` to `LOCALE_LIST` (label in the language itself).

3. Run `npm run typecheck` — the `Translation` type guarantees you did not miss any key.

4. Open a PR titled `i18n: add Italian translation`.

That's it — the Settings language picker, native dialogs, and notifications pick the new locale up automatically.

## Reporting bugs

Please include:

- OS version and whether the app is a dev build or the packaged zip,
- Claude Code CLI version (`claude --version`),
- steps to reproduce and what you expected vs. saw,
- `codecockpit-renderer.log` from your temp directory if it is a UI/renderer issue.

## License

By contributing you agree that your contributions are licensed under the [MIT License](LICENSE).
