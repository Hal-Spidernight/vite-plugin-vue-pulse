# HANDOFF — Vue reactivity graph devtool

Continuation notes for picking this up in Claude Code.

## What this is
A dev-only **Vite plugin** (`vite-plugin-reactivity-graph`) that visualizes causal
relationships between Vue reactives (ref/reactive/computed/watch/watchEffect + the
component **render effect**) and lights the graph up as changes propagate at
runtime. Two layers on one graph model: **static** ("map", from source via real
croquis) + **runtime** ("traffic", live), reconciled by component-scoped label.

## Status — done & verified (11 suites, all green; `tsc` build clean)
- **Full TypeScript**, builds to `dist/` (.js + .d.ts). Publishable `package.json`
  (`exports`: `.` / `./runtime` / `./static`; peerDeps vue+vite). Tests import `dist`.
- **Decoupled**: the plugin injects `virtual:reactivity-graph/runtime` (re-exports
  the packaged runtime), never a consumer `/src/...` path. `enforce:'post'`,
  broadened entry regex, HMR-invalidated static module. Verified by `e2e_vite`
  (real dev server + plugin-vue ordering).
- **Static analysis uses the REAL croquis/vize toolchain** — `@vizejs/native`
  `parseSfc` + `oxc-parser` for the script/template expressions. Babel and
  @vue/compiler-sfc were removed. The effect-graph EDGE builder is the only
  bespoke layer (the croquis #695 gap). `croquis-rust/effect_graph_builder.rs` is
  the Rust reference for upstreaming it.
- **Render effect / components** (`component-plugin.ts` via renderTracked/Triggered,
  `app.use`): template-only state now glows; component nodes; parent→child + props
  edges; provide/inject DI edges (`tracedProvide`/`tracedInject`).
- **Deep write capture**: nested `a.b.c=…`, array `push/splice`, `Map`/`Set`
  `set/add/delete` → write-edges (reads stay intact — verified against Vue 3.5.39).
- **toRef/toRefs**: real node + keyed `source→toRef` edge.
- **Correctness fixes** (from the review): component-scoped node identity
  (`Comp::count`) so same-named refs across components don't merge; `graph.removeNode`
  + refcount + `onScopeDispose` teardown (no SPA leak); `reset()` clears labelIndex;
  overlay pauses when collapsed / tab hidden.
- **Template deps** static: `dep → <Component>` edges from `<template>` reads.

## Decisions locked in
- Delivery: distributable **TypeScript Vite plugin** (`tsc` → dist), runtime shipped
  in-package and injected via a virtual module.
- Static: **use real croquis (`vize`) + oxc**, not a JS clone. Effect-graph builder
  stays ours (croquis doesn't expose one — #695).
- watch/watchEffect stay **nodes** + write-edges; reactive granularity **object-level**
  node + keyed edges; global capture via **build-time transform** + the render plugin
  (the render effect is the one thing the transform can't reach).

## Next steps (optional)
1. Upstream `effect_graph_builder.rs` into `vize_croquis` so the static graph comes
   straight from croquis (then `analyze.ts` becomes a thin adapter). Reuse its
   `find_cycle` to surface cyclic-computed warnings.
2. Cross-file props/provide-inject static edges via `vize_croquis_cf`'s DependencyGraph.
3. Pinia/VueUse first-class labeling (state=reactive, getters=computed, actions=writes)
   instead of generic `⟨ext⟩` nodes.
4. `@vue/devtools-api` inspector/timeline; Barnes-Hut for very large graphs.

## Run
```
npm install
npm run build      # tsc -> dist
npm test           # build + 11 suites (incl. real Vite e2e)
npm run dev        # demo; panel auto-mounts (dev only)
npm run analyze    # static graph JSON + Mermaid for src/App.vue
```

## Gotchas
- Vue debugger hooks (onTrack/onTrigger/renderTracked/renderTriggered) are DEV-ONLY.
- The plugin is `apply:'serve'` — absent from `vite build` by design.
- Static analysis pulls native deps (`@vizejs/native`, `oxc-parser`); Node-side only.
- `customRef` can't attribute incoming edges (Vue hides the target).
- Deep-write capture only records edges while inside a traced effect (Vue's own
  sync-tracking boundary; post-`await` writes aren't attributed).
