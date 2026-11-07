# Contributing to CodeCockpit

Thank you for considering a contribution! Issues, bug reports, translations, and pull requests are all welcome.

## Getting started

Requirements:

- Node.js ≥ 20 (LTS recommended)
- Windows 10 (1809+) or Windows 11
- Git Bash (needed by the Claude Code CLI on Windows)

```bash
git clone <your fork>
cd CodeCockpit
npm install
npm run dev        # run the app in dev mode
npm run typecheck  # must pass before any PR
npm run build      # compile without packaging
npm run dist       # full package: dist/CodeCockpit/ + versioned zip
```

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

- **Language of the codebase is English.** All identifiers, comments, commit messages, and UI strings in source must be English. User-facing strings live exclusively in `src/locales/` — never hard-code UI text in components or the main process.
- **TypeScript strict.** `npm run typecheck` must pass.
- **i18n keys**: add new keys to `en.ts` first, then to all other locales — the `Translation` type makes a missing key a compile error, so `npm run typecheck` catches incomplete translations.
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
