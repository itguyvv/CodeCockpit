# Releasing CodeCockpit

This is the maintainer's runbook for cutting a release. Releases are **tag-driven**: pushing a `v<version>` tag makes CI build every platform and attach the artifacts to a **draft** release; you review the draft on GitHub and click *Publish* to make it public.

> All pushes (branches and tags) and any release action on GitHub must be **user-initiated** — the maintainer's machine reaches GitHub only through the v2rayN proxy, and publishing is a manual decision, never an automated one.

## 1. What CI produces

Workflow: [.github/workflows/ci.yml](../.github/workflows/ci.yml). A tag push (`refs/tags/v*`) runs three jobs in sequence:

1. **verify** (ubuntu) — `npm ci`, typecheck, compile. Gate for everything else.
2. **package** — one build leg per matrix entry below.
3. **release** — collects all artifacts, generates `SHA256SUMS`, attaches everything to a **draft** GitHub release.

| Artifact | Built on | Notes |
| --- | --- | --- |
| `CodeCockpit-<v>-win-x64.zip` | windows-latest | Portable folder zip, produced by `scripts/rename-dist.cjs` |
| `CodeCockpit-<v>-win-arm64.zip` | windows-latest | Cross-arch: the win32-arm64 node-pty prebuild is force-installed before packaging |
| `CodeCockpit-<v>-mac-arm64.zip` | ubuntu-latest | Unsigned; darwin-arm64 node-pty prebuild force-installed. Built on Linux because the GitHub macOS runner pool is unreliable (jobs queue until cancelled) |
| `CodeCockpit-<v>-mac-x64.zip` | ubuntu-latest | Unsigned; cross-arch: both darwin node-pty prebuilds are force-installed |
| `CodeCockpit-<v>-linux-x86_64.AppImage` | ubuntu-latest | |
| `CodeCockpit-<v>-linux-x86_64.deb` | ubuntu-latest | |
| `CodeCockpit-<v>-linux-x86_64.rpm` | ubuntu-latest | |
| `CodeCockpit-<v>-linux-arm64.AppImage` | ubuntu-24.04-arm | Native arm64 runner |
| `CodeCockpit-<v>-linux-arm64.deb` | ubuntu-24.04-arm | |
| `CodeCockpit-<v>-linux-arm64.rpm` | ubuntu-24.04-arm | |
| `SHA256SUMS` | release job | Checksums for all ten files above |

That is **11 files** per release. Each smoke-test step unpacks its artifacts and asserts the correct `@lydell/node-pty-*` prebuild is present inside `app.asar.unpacked` — a leg fails loudly rather than shipping a build whose terminal cannot spawn.

Deliberately **not** shipped, and why:

- **snap / flatpak** — their sandboxing breaks spawning arbitrary CLI processes (the app's whole purpose). Users on those stores can use the AppImage/deb/rpm instead.
- **linux arm32 / FreeBSD** — no Electron or node-pty prebuilds exist for them.
- **dmg** — the app is unsigned, so a dmg has the same Gatekeeper friction as the zip while doubling macOS storage and CI time. Revisit if the app ever gets signed/notarized.

On a tag push CI also syncs `package.json`'s version to the tag (`v1.2.3` → `1.2.3`) before packaging, so artifact filenames carry the tag's version even if the checked-in `package.json` was not bumped yet.

## 2. Standard release procedure

Prerequisites: `main` is green, working tree clean, all 10 locales in sync (`npm run typecheck` passes), version decision made.

### Pre-flight checklist (every release)

Work through this list before tagging. Items marked *(web)* can only be done on github.com; the rest happen locally.

**Docs**

- [ ] `CHANGELOG.md`: move the *Unreleased* entries under the new version heading with today's date; keep an empty *Unreleased* section on top for the next cycle.
- [ ] `README.md` + `README.zh-CN.md`: new features are reflected in the feature list, the roadmap milestone is checked off, and both languages stay in sync.
- [ ] `package.json`: `version` bumped; `description` still accurate (mentions both engines).
- [ ] Screenshots: if the UI changed visibly, regenerate `docs/screenshots/{en,zh}/*.png` (keep the filenames — the READMEs reference them).

**Build**

- [ ] `npm run typecheck` passes (also proves all 10 locales are key-complete).
- [ ] `npm run dist` builds; the packaged exe was smoke-tested (create a session, run a prompt, rename, open Settings).
- [ ] After any new dependency: verify the renderer CSP (`src/renderer/index.html`) still allows everything in dev and in the packaged build.

**Repo metadata — re-verify *(web)*: https://github.com/ITGuyVV/CodeCockpit/settings**

- [ ] Repo **description** still mentions both engines and still fits the feature set.
- [ ] **Topics** still cover the stack: `claude-code`, `opencode`, `ai-agents`, `electron`, `terminal`, `developer-tools`, `pty`, `xterm`, `cross-platform`.
- [ ] **Website** field points at the right page (currently the Releases page).
- [ ] **Social preview** still current — `docs/social-card.png` is the source image.
- [ ] Community files render correctly: SECURITY.md, CODE_OF_CONDUCT.md, issue forms, PR template.

1. **Bump the version** (optional but recommended — keeps the repo truthful):

   ```bash
   npm version 1.2.3 --no-git-tag-version
   git commit -am "chore: release 1.2.3"
   ```

   CI re-syncs the version on tag anyway, so this step only affects what a source checkout reports.

2. **Tag and push** (user-initiated):

   ```bash
   git tag v1.2.3
   git push origin main v1.2.3
   ```

3. **Watch CI**. Get the run for the tag:

   ```bash
   TOKEN=$(printf "protocol=https\nhost=github.com\n\n" | git credential fill | grep '^password=' | cut -d= -f2)
   curl -s -x socks5h://127.0.0.1:10808 -H "Authorization: Bearer $TOKEN" \
     "https://api.github.com/repos/itguyvv/CodeCockpit/actions/runs?per_page=5" | \
     node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{for(const r of JSON.parse(d).workflow_runs)console.log(r.id,r.head_branch,r.status,r.conclusion)})"
   ```

   (`gh` CLI is not installed; use token-authenticated REST via the v2rayN SOCKS proxy. The token comes from the Windows credential store — unauthenticated calls hit the 60/h rate limit.)

4. **Handle flaky legs.** electron-builder downloads its tooling from GitHub releases mid-build and occasionally gets 504s. The Package step already retries 3 times; if a leg still fails:

   ```bash
   curl -s -x socks5h://127.0.0.1:10808 -X POST -H "Authorization: Bearer $TOKEN" \
     "https://api.github.com/repos/itguyvv/CodeCockpit/actions/runs/<run-id>/rerun-failed-jobs"
   ```

   Rerunning failed jobs preserves the successful legs' artifacts. If a rerun is impossible (e.g. the run was cancelled), fall back to the overwrite flow in §3.

5. **Review the draft.** The release job creates a draft with the 11 files and auto-generated release notes. Check: all 11 assets present, SHA256SUMS matches a spot-checked download, notes reference the right tag.

6. **Publish.** Click *Publish* on the draft release page — or via REST:

   ```bash
   RELEASE_ID=$(curl -s -x socks5h://127.0.0.1:10808 -H "Authorization: Bearer $TOKEN" \
     "https://api.github.com/repos/itguyvv/CodeCockpit/releases" | \
     node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{const r=JSON.parse(d).find(x=>x.draft);console.log(r.id)})")
   curl -s -x socks5h://127.0.0.1:10808 -X PATCH -H "Authorization: Bearer $TOKEN" \
     -H "Content-Type: application/json" -d '{"draft": false}' \
     "https://api.github.com/repos/itguyvv/CodeCockpit/releases/$RELEASE_ID"
   ```

   Publishing is the point of no return — watchers get notified and the release becomes public. Never publish a draft without eyeballing the assets first.

## 3. Overwriting a release (wrong build, missing assets, bad tag)

The tag decides what CI builds, and CI uses **the workflow file at the tag** — fixes pushed to `main` afterwards do not affect an existing tag. To rebuild a version with current code:

```bash
git push origin :refs/tags/v1.1.1   # delete remote tag (draft release survives)
git tag -f v1.1.1                   # re-point local tag at the new HEAD
git push origin v1.1.1              # re-trigger CI
```

The new run overwrites the draft's files in place. This is also the escape hatch when a workflow fix must be included mid-release: commit the fix, then re-point the tag.

## 4. Local sanity checks before tagging

```bash
npm run typecheck        # also proves all 10 locales are key-complete
npm run dist             # Windows package; run the packaged exe and smoke-test a PTY session
npm run dist:linux -- --x64   # optional cross-check; CI is authoritative for other platforms
```

`npm run dist` needs Node ≥ 22 first on PATH (an old system Node breaks rolldown/tsc). On the maintainer machine: `PATH="/d/DevHome/eclipse-jee-2025/.node/node-v22.13.1-win-x64:$PATH" npm run dist`, and close any running packaged exe first (EBUSY).

## 5. Post-release

- Check the GitHub release page renders: notes, asset count (11), checksums line in the body.
- Verify the repo badges update on both READMEs: CI green, release badge shows the new version.
- Re-verify the repo metadata checklist from §2 (description / topics / website / social preview) once the release is public.
- If the release adds user-facing strings that were translated in the same cycle, no further action is needed — locales ship inside the artifacts.
- Watch for issues tagged `macos` / `linux` in the first days after a multi-platform release; the unverified-at-release-time risks are listed in the port plan and the README's feedback invitation.
