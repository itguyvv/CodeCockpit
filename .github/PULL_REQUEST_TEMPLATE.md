<!-- Thank you for contributing! Keep PRs focused — one feature or one fix per PR. -->

## Summary

<!-- What does this PR change, and why? -->

## Checklist

- [ ] `npm run typecheck` passes (this also proves all 10 locale files are key-complete)
- [ ] Any new or changed UI string exists in **all 10** files in `src/locales/`, with `en.ts` as the source of truth
- [ ] No natural-language strings outside `src/locales/`
- [ ] For behavior changes: `npm run dist` succeeds and the packaged app was smoke-tested
- [ ] Docs updated if needed (README / README.zh-CN / CHANGELOG *Unreleased* section)
