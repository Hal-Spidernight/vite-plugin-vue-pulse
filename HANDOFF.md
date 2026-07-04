# HANDOFF — Vue reactivity graph devtool

Continuation notes for picking this up in Claude Code.

## What this is
A dev-only **Vite plugin** (`vite-plugin-vue-pulse`) that visualizes causal
relationships between Vue reactives (ref/reactive/computed/watch/watchEffect + the
component **render effect**) and lights the graph up as changes propagate at
runtime. Two layers on one graph model: **static** ("map", from source) +
**runtime** ("traffic", live). Both address a node by the SAME deterministic id
(`Comp::label`), so one declaration = one node (dedup by id, order-independent).

## Status — done & verified (11 suites, all green; `tsc` build clean)
- **Full TypeScript**, builds to `dist/` (.js + .d.ts). Publishable `package.json`
  (`exports`: `.` / `./runtime` / `./static`; peerDeps vue+vite). Tests import `dist`.
- **Decoupled**: the plugin injects `virtual:vue-pulse/runtime` (re-exports
  the packaged runtime), never a consumer `/src/...` path. `enforce:'post'`,
  broadened entry regex, HMR-invalidated static module. Verified by `e2e_vite`
  (real dev server + plugin-vue ordering).
- **Static analysis** (`src/static/analyze.ts`): splits the SFC with
  `@vizejs/native`'s `parseSfc` (the ONLY use of vize), parses the `<script>` with
  `oxc-parser`, and builds the dependency edges itself — computed getters / watch
  sources / watchEffect bodies (reads), watch-callback assignments (writes), and
  template expressions → the component node. Babel and @vue/compiler-sfc removed.
  `parseSfc` is swappable for `@vue/compiler-sfc`; vize is not otherwise involved.
  - NB: an experiment to push the edge-building UPSTREAM into vize_croquis (a Rust
    `effect_graph_builder` + an `analyzeReactivity` napi) was prototyped locally in
    `~/Documents/workspace-hal/vue2-vize/vize` (uncommitted) — but it is NOT part
    of this plugin. vize issue #695 (cycle detection) is already CLOSED, so any such
    contribution would need a fresh Issue + maintainer buy-in first, and it's
    largely our own convenience — treat the local prototype as throwaway.
- **`playground/`** is a separate sample Vue app (workspace member) that consumes
  the plugin **by package name**; it's the live demo and the e2e integration
  target. (The old `standalone-demo.html` and the `croquis-rust/` Rust clone were
  removed — recoverable via git if needed.)
- **Render effect / components** (`component-plugin.ts` via renderTracked/Triggered,
  `app.use`): template-only state now glows; component nodes; parent→child + props
  edges; provide/inject DI edges (`tracedProvide`/`tracedInject`).
- **Deep write capture**: nested `a.b.c=…`, array `push/splice`, `Map`/`Set`
  `set/add/delete` → write-edges (reads stay intact — verified against Vue 3.5.39).
- **toRef/toRefs**: real node + keyed `source→toRef` edge.
- **Node identity = deterministic id per declaration** (`Comp::label`, `component::Comp`,
  anonymous effects `Comp::watch#N` by source order). BOTH the static analyzer and
  the runtime tracer produce that exact id, so `graph.addNode` dedups by id → ONE
  node per declaration, order-independent. There is NO label-matching reconciliation
  and NO `labelIndex`/`claimId` (removed) — this is what guarantees no duplicates
  (the earlier reconcile-by-label approach broke when static loaded after mount).
  Same-named refs across components stay distinct via the `Comp::` scope.
- Teardown: `graph.removeNode` + refcount + `onScopeDispose` (no SPA leak); overlay
  pauses when collapsed / tab hidden.
- **Template deps** static: `dep → <Component>` edges from `<template>` reads.

## Decisions locked in
- Delivery: distributable **TypeScript Vite plugin** (`tsc` → dist), runtime shipped
  in-package and injected via a virtual module.
- Static: split the SFC with vize `parseSfc`, parse with `oxc`, build the edges
  ourselves. (vize is used only as the SFC parser; the graph logic is ours.)
- watch/watchEffect stay **nodes** + write-edges; reactive granularity **object-level**
  node + keyed edges; global capture via **build-time transform** + the render plugin
  (the render effect is the one thing the transform can't reach).

## Next steps (optional)
1. Cross-file props / provide-inject static edges.
2. Pinia/VueUse first-class labeling (state=reactive, getters=computed, actions=writes)
   instead of generic `⟨ext⟩` nodes.
3. `@vue/devtools-api` inspector/timeline; Barnes-Hut for very large graphs.

## Run
```
npm install
npm run build      # tsc -> dist
npm test           # build + 11 suites (incl. real Vite e2e over the playground)
npm run dev        # build + run playground/ sample app (panel auto-mounts)
npm run analyze    # static graph JSON + Mermaid for playground/src/App.vue
```

## Gotchas
- Vue debugger hooks (onTrack/onTrigger/renderTracked/renderTriggered) are DEV-ONLY.
- The plugin is `apply:'serve'` — absent from `vite build` by design.
- The static analyzer pulls two native deps, Node-side only: `oxc-parser` and
  `@vizejs/native` (used solely for `parseSfc`).
- `customRef` can't attribute incoming edges (Vue hides the target).
- Deep-write capture only records edges while inside a traced effect (Vue's own
  sync-tracking boundary; post-`await` writes aren't attributed).
