# Releasing

Releases are driven by [**changelogen**](https://github.com/unjs/changelogen)
(a devDependency). It reads [Conventional Commits](https://www.conventionalcommits.org)
since the last git tag, then in one command: bumps `package.json`, prepends
`CHANGELOG.md`, creates the `release: vX.Y.Z` commit + `vX.Y.Z` tag, pushes, and
publishes to npm. No CI is required — everything runs locally.

This replaces the old manual `npm version … && npm publish && git push --follow-tags`.

## TL;DR

```bash
pnpm changelog        # preview the notes + computed bump — writes nothing
pnpm release          # routine release  (0.x: patch bump, e.g. 0.2.3 -> 0.2.4)
pnpm release:minor    # feature release  (0.x: 0.2.x -> 0.3.0)
pnpm release:1.0      # graduate to stable 1.0.0 (one-time)
pnpm gh:release       # (optional) create/sync the GitHub Release from CHANGELOG.md
```

## Before you release — checklist

- [ ] On the **`main`** branch (`pnpm publish` and `git push` refuse otherwise).
- [ ] Working tree is **clean** — `git status` shows nothing. changelogen only
      stages `package.json` + `CHANGELOG.md`; any other dirty file makes
      `pnpm publish`'s clean-tree check fail.
- [ ] Up to date with the remote (`git pull`).
- [ ] `pnpm test` is green (the release scripts run it first and abort on failure,
      *before* any bump/tag/push).
- [ ] Logged in to npm (`npm whoami`).

## Version bump — the pre-1.0 rule (important)

While the version is `0.x`, changelogen **downgrades** the semver step by one
level. This is intentional but the opposite of `npm version`, so use the mapping:

| Intent | Command | Flag under the hood | `0.2.3` becomes |
| --- | --- | --- | --- |
| Bug-fix / routine | `pnpm release` | auto-detected | `0.2.4` |
| Feature batch | `pnpm release:minor` | `--major` (downgraded to *minor*) | **`0.3.0`** |
| Graduate to stable | `pnpm release:1.0` | `-r 1.0.0` (exact) | `1.0.0` |

Why `release:minor` uses `--major`: on a `0.x` version changelogen maps
`major → minor` and `minor → patch`. So to move the middle digit (`0.2.x → 0.3.0`)
you must pass `--major`; a bare `--minor` would only produce `0.2.4`. Once the
package is `>= 1.0.0`, this downgrade stops and the flags mean what they say.

> The 4 currently-unreleased `feat:` commits (recording mode, prod no-op, layout,
> toRefs node-ification) are a feature batch → the next release is **`pnpm release:minor` → v0.3.0**.

## How commits become changelog sections

changelogen groups commits by their Conventional-Commit type. Types not listed
below are hidden from the changelog.

| Prefix | Section | Bump (≥1.0) |
| --- | --- | --- |
| `feat:` | 🚀 Enhancements | minor |
| `fix:` | 🩹 Fixes | patch |
| `perf:` | 🔥 Performance | patch |
| `refactor:` | 💅 Refactors | patch |
| `docs:` | 📖 Documentation | patch |
| `build:` | 📦 Build | patch |
| `types:` | 🌊 Types | patch |
| `chore:` | 🏡 Chore | — |
| `test:` | ✅ Tests | — |
| `style:` | 🎨 Styles | — |
| `ci:` | 🤖 CI | — |
| `feat!:` / `BREAKING CHANGE:` | (breaking) | major (0.x → minor) |

Keep writing clean Conventional Commits and the changelog stays accurate for free.
The release commit message is kept as `release: vX.Y.Z` via the `changelog.templates.commitMessage`
field in `package.json`.

## GitHub Releases (optional)

`changelogen gh release` parses `CHANGELOG.md` and creates/updates the matching
GitHub Release. It needs a token — either run `gh auth login` once, or set
`GITHUB_TOKEN` / `GH_TOKEN`. Without one it just opens a browser to create it manually.

```bash
pnpm gh:release
```

## Known caveats for this repo

- **`origin` remote name mismatch.** `git remote get-url origin` currently points at
  `github.com/Hal-Spidernight/reactivity-graph-demo.git`, while `package.json`
  `repository` (used for changelog links and `gh release`) points at
  `…/vite-plugin-vue-pulse.git`. Pushes work today only via GitHub's rename
  redirect. To make both agree, run once:
  ```bash
  git remote set-url origin https://github.com/Hal-Spidernight/vite-plugin-vue-pulse.git
  ```
- **Tests run twice per release** — once by the leading `pnpm test` (fail-fast,
  before any mutation) and once by the `prepublishOnly` hook during `pnpm publish`.
  Harmless, just slower; the leading run is what protects you from a bad tag.
- **First `CHANGELOG.md` was back-filled** from the `v0.1.0…v0.2.3` tags. Going
  forward each `changelogen --release` only prepends the newest section.

## Hand-curated release highlights (optional)

For big releases you may want a narrative on top of the auto-generated list — a
"what this release is about" summary, screenshots/GIFs of the graph, migration
notes. Use [`RELEASE_NOTES_TEMPLATE.md`](./RELEASE_NOTES_TEMPLATE.md) for that and
paste it above the generated section in the GitHub Release. For routine releases,
the auto changelog is enough.
