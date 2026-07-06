<!--
============================================================================
  vite-plugin-vue-pulse — Release Notes Template (OPTIONAL highlights layer)
============================================================================
  You usually DON'T need this. The changelog, version bump, tag, npm publish
  and the GitHub Release are all generated from Conventional Commits by
  changelogen — see RELEASING.md. For routine releases the auto-generated
  CHANGELOG.md section is enough.

  Use this template ONLY for a big release where you want a human narrative on
  top of the generated list: a "what this release is about" summary, a demo
  GIF/screenshot of the graph, or migration notes. Paste the filled template
  ABOVE the auto-generated section in the GitHub Release (or in CHANGELOG.md).

  Section headings mirror changelogen's, so the hand-written part blends into
  the generated part:
    feat -> 🚀 Enhancements   fix -> 🩹 Fixes   perf -> 🔥 Performance
    breaking -> 💥 Breaking changes            chore/etc -> 🏡 Chore

  Delete any section with no entries — don't ship empty headings.
============================================================================
-->

# v<X.Y.Z> — <one-line theme of the release>

<!-- 1–3 sentences: what this release is about and who should care. -->

> Dev-only Vite plugin that visualizes Vue reactivity as a live dependency graph.

<!-- Optional but great for a visual devtool: drop a GIF/screenshot of the graph.
![demo](<url-or-relative-path>) -->

---

## 🚀 Enhancements

- <Add … — short user-facing description>

## 🩹 Fixes

- <Fix … — what was broken, now fixed>

## 🔥 Performance

- <Speed up / reduce … >

## 💥 Breaking changes

- <What changed, and what a user must do to migrate.>
  <!-- Include a before/after config/API snippet when the shape changes. -->

---

## 📦 Install / Upgrade

Dev-only devtool — always install as a **devDependency** (`-D`).

```bash
# pnpm (recommended)
pnpm add -D vite-plugin-vue-pulse@<X.Y.Z>

# npm
npm install -D vite-plugin-vue-pulse@<X.Y.Z>

# yarn
yarn add -D vite-plugin-vue-pulse@<X.Y.Z>
```

<!-- Include the config block only on a release that changes setup / adds an
     entry point. Otherwise delete it. -->
```ts
// vite.config.ts
import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import vuePulse from 'vite-plugin-vue-pulse'

export default defineConfig({
  plugins: [vue(), vuePulse()], // dev-only; a no-op in production builds
})
```

## 🔗 Links

- **Full changelog:** https://github.com/Hal-Spidernight/vite-plugin-vue-pulse/compare/v<PREV>...v<X.Y.Z>
- **npm:** https://www.npmjs.com/package/vite-plugin-vue-pulse/v/<X.Y.Z>

<!-- Optional extras:

## ⚠️ Known issues
- <thing that doesn't work yet + tracking issue link>

## ❤️ Contributors
- @<contributor> for <what>   (changelogen also auto-lists these)
-->
