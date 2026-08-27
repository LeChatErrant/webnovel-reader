# Webnovel Reader

A private, offline EPUB reader (PWA). Static Vite build; everything runs
on-device (books, covers, progress live in IndexedDB). See [README.md](README.md)
for the feature/layout overview.

## Deploying

Deploys happen by pushing to `main`: the
[Deploy to GitHub Pages workflow](.github/workflows/deploy.yml) builds `dist/`
and publishes it to <https://lechaterrant.github.io/webnovel-reader/>. The
maintainer deploys **only through Claude**, so when asked to "deploy" (also
"ship it", "push it live", "release"), follow this exactly:

1. **Bump the version first.** Increment `package.json` + `package-lock.json`:
   ```bash
   npm version patch --no-git-tag-version
   ```
   Default to **patch**. Use `minor` / `major` only if the user says so
   (e.g. "deploy a minor release"). This number is baked into the build via
   `__APP_VERSION__` in [vite.config.js](vite.config.js) and shown in the app's
   Library footer, so **every deploy must carry a new version** — never deploy
   without bumping.
2. **Commit** the bump together with whatever change is being shipped. If a
   feature/fix is pending, fold the bump into that commit; if nothing else is
   pending, commit it alone as `chore(release): v<new>`.
3. **Stage only source files.** The repo root holds untracked design archives
   (`*.zip`, `design_handoff_*/`) — never commit those, and never `git add -A`
   blindly. `dist/` is gitignored; never commit build output.
4. **Push to `main`** to trigger the deploy, then **watch the run** to success:
   ```bash
   gh run watch "$(gh run list --workflow=deploy.yml -L1 --json databaseId -q '.[0].databaseId')" --exit-status
   ```
5. **Report back as feedback**: old → new version and the run result, e.g.
   *"Deployed v0.1.1 (was 0.1.0) — GitHub Pages run succeeded."*

The live footer reads `<package.json version> · <UTC build time>`, so bumping
`package.json` is what makes each deployed build distinguishable and traceable
(the version in a bug report maps back to the commit that set it via `git log`).
