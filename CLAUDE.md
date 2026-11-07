# CodeCockpit — Project Rules

These rules are hard requirements for every code change in this repository.

## 1. English-only source code

- All identifiers, comments, commit messages, and documentation must be written in **English**.
- **No Chinese (or any other natural language) anywhere in the source** — with one exception: the translation dictionaries under `src/locales/` (`zh-CN.ts`, `zh-TW.ts`) contain Chinese *by design* because they are the translations themselves.
- All user-facing text lives exclusively in `src/locales/` as translation keys. Never hard-code UI strings in components or the main process.

## 2. Complete translations on every change

- Whenever a UI string is added or changed, **every locale file must be updated in the same change**: `en.ts`, `zh-CN.ts`, `zh-TW.ts`, `ja.ts`, `ko.ts`, `de.ts`, `fr.ts`, `es.ts`, `pt-BR.ts`, `ru.ts` — all 10, no exceptions.
- `en.ts` is the source of truth. It exports `TranslationKey` / `Translation`; every other locale is typed `Record<TranslationKey, string>`, so a missing key is a **compile error**.
- Never ship a locale with a missing key, an English fallback in a non-English file, or a stale reference (old product name, old exe name, old paths).
- The brand name `CodeCockpit` and the exe name `CodeCockpit.exe` stay identical in every language (brand names are not translated).

## 3. Verify before calling it done

```bash
npm run typecheck   # must pass — this also proves all 10 locales are key-complete
```

- After string/comment work, grep for CJK characters outside `src/locales/` — the result must be empty:
  ```
  grep -rP '[\x{4e00}-\x{9fff}]' src scripts --include='*' (excluding src/locales)
  ```
- After any packaging change, rebuild with `npm run dist` (see Build notes below).

## Build notes

- Use the portable Node 22 at `D:\DevHome\eclipse-jee-2025\.node\node-v22.13.1-win-x64` — the system Node 16 breaks rolldown and tsc.
  `PATH="/d/DevHome/eclipse-jee-2025/.node/node-v22.13.1-win-x64:$PATH" npm run dist`
- Close any running packaged exe before building (EBUSY).
- `npm run dist` produces `dist/CodeCockpit/` (fixed folder name for overwrite upgrades) and `dist/CodeCockpit-<version>-win-x64.zip`.
