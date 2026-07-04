# vite-plugin-vue-pulse

A **dev-only Vite plugin** that visualizes the causal relationships between Vue
reactives (`ref` / `reactive` / `computed` / `watch` / `watchEffect` + the
component **render effect**) as a graph, and **lights it up as changes propagate
at runtime** — nodes glow when they fire and pulses travel along the edges from
dependency to dependent.

Two layers, one graph:

| layer | what it gives you | where |
|-------|-------------------|-------|
| **static** | the *map*: which reactive monitors which, from source alone | `src/static/analyze.ts` (our analyzer; oxc-based) |
| **runtime** | the *traffic*: which change actually fired which effect, live | `src/reactivity-graph/` (tracer + render tracker + overlay) |

Both emit the **same node/edge schema** (`src/reactivity-graph/types.ts`) with the
**same deterministic node id per declaration** (`Comp::label`), so they dedup to
one node each — the static graph is drawn first (dashed) and the very same node
glows when runtime confirms it. One declaration → one id → one node, whichever
side sees it first (no label-matching reconciliation, no duplicates).

## Install & use

```bash
npm i -D vite-plugin-vue-pulse
```

```js
// vite.config.ts
import reactivityGraph from 'vite-plugin-vue-pulse'
export default {
  plugins: [
    vue(),                                   // must come before…
    reactivityGraph({ include: ['src/**/*.vue'] }),
  ],
}
```

```ts
// main.ts — one line adds render-effect / component tracking
import { reactivityGraphPlugin } from 'vite-plugin-vue-pulse/runtime'
createApp(App).use(reactivityGraphPlugin).mount('#app')
```

The panel auto-mounts bottom-right in dev. You **write plain Vue** — the plugin's
build-time transform rewrites `ref/reactive/computed/watch/…` into traced
equivalents automatically (no `tracedRef`, no mixin, no source changes). It is
`apply: 'serve'` — dev-server only, never part of a production build.

## What's monitored

| element | status | notes |
|---|---|---|
| `ref` `shallowRef` `reactive` `shallowReactive` | ✅ | writes intercepted (incl. **nested `a.b.c=…`, array `push/splice`, `Map`/`Set` `set/add/delete`**) |
| `computed` (get / get+set) | ✅ | setter writes → write-edges |
| `readonly` `shallowReadonly` | ✅ | read-only state |
| `watch` `watchEffect` `watchPostEffect` `watchSyncEffect` | ✅ | source = read deps; callback/body writes = write-edges |
| `toRef` / `toRefs` | ✅ | `toRef` → node + keyed `source → toRef` edge; `toRefs` deps attribute to the source key |
| **component render effect** | ✅ | `app.use(reactivityGraphPlugin)` → a `component` node per instance via `renderTracked`/`renderTriggered`. **Template-only state now glows.** |
| **props (parent → child)** | ✅ | `<Comp>▸props` node + `parent → child` and `parent → props → render` edges |
| **`provide` / `inject`** | ✅ | DI edge `providedReactive → <Consumer>` (via the transformed `provide`/`inject`) |
| `defineModel` | ◐ | static: a `ref` node; runtime: flows through the props node |
| `customRef` | ◐ | node + writes work; Vue hides its `onTrack` target, so *incoming* read-edges can't be attributed |
| **external reactives** (Pinia state, VueUse refs, `useRoute()`) | ✅ | auto-registered as `⟨ext⟩` nodes by object identity — no need to transform `node_modules` |

Read edges (`dep → effect`) are gray; writes made inside a watch callback /
computed setter / effect body (`effect → reactive`) are amber, so two-way
bindings show up as real loops.

**Circular reactivity** is handled: two-way `watch` sync converges (no runaway),
and the propagation ripple has a visited-guard so cyclic chains don't hang.

**Lifecycle:** node identity is component-scoped (`Comp::count`), so two
components that both declare `count` stay distinct; nodes are removed on
`onScopeDispose` / component unmount, so long-running SPAs don't leak the graph.

## Static analysis (the "map")

The static analyzer:

- splits the SFC into `<script>` / `<template>` with `@vizejs/native`'s `parseSfc`
  (a fast Rust SFC parser — the ONLY thing the vize dependency is used for);
- parses the `<script>` to an AST with `oxc-parser`;
- walks it to collect reactive bindings and wire the dependency edges — computed
  getters / watch sources / watchEffect bodies (reads), watch-callback assignments
  (writes), and template expressions → the component node.

The edge-building logic is entirely in this plugin. (`parseSfc` is easily
swappable for `@vue/compiler-sfc` if you'd rather not pull a native dependency.)

```bash
npm run analyze                          # {nodes,edges} JSON + Mermaid for playground/src/App.vue
npx vue-pulse-analyze Foo.vue …   # same, on any SFC(s)
```

## How it works

**Runtime.** The build-time transform rewrites reactivity calls to traced
wrappers. Each wrapper tags the underlying reactive with a stable id and attaches
`onTrack`/`onTrigger`. `onTrack` reports exactly which dependency an effect read
(→ `dep → effect`); `onTrigger` reports which effect re-ran, and `graph.onTrigger`
/ `cascadeFrom` drive a staggered BFS ripple outward from the mutation origin. The
render effect (which the transform can't reach — Vue synthesizes it) is captured
separately via the `renderTracked`/`renderTriggered` hooks installed by
`reactivityGraphPlugin`. `onTrack`/`onTrigger`/`renderTracked` are dev-only in Vue.

**Static.** `parseSfc` → `<script setup>`(+`<script>`) + template → oxc AST → two
passes (collect reactive bindings; wire `dep → effect` edges for each computed
getter / watch source / watchEffect body / template expression), plus write-edges
from assignments, mutating-method calls, and computed setters.

## Build / test

```bash
npm run build   # tsc -> dist/ (.js + .d.ts)   — the published artifact
npm test        # builds, then runs 11 suites (incl. a real Vite dev-server e2e over the playground)
npm run dev     # builds the plugin, then runs the playground/ sample app (panel auto-mounts)
```

The **`playground/`** directory is a separate sample Vue app that consumes this
plugin **by package name** (workspace-linked), i.e. exactly how an installing
project would — it's both the live demo and the target of the e2e integration test.

Package exports: `.` (the Vite plugin), `./runtime` (browser runtime:
`tracedRef`, `mountPanel`, `loadStaticGraph`, `reactivityGraphPlugin`), `./static`
(the analyzer). `vue` and `vite` are peer dependencies.

## Tests

- `tracer` / `computed_setter` / `scale_cycle` / `external` — runtime edge discovery, write-edges, 82-node stress + circular reactivity, external auto-register (vs real `@vue/reactivity`).
- `deep_writes` — nested / array / `Map`/`Set` write capture + `toRef` linkage (vs real Vue).
- `component_render` — render-effect tracking, component-scoped identity (no cross-component collision), unmount teardown (real client mount).
- `cross_component` — parent→child + props flow + provide/inject DI edges (real client mount).
- `static` — the analyzer recovers the demo's causal + template edges from source.
- `transform` — the build-time codemod turns plain Vue into a live graph.
- `plugin` / `e2e_vite` — the Vite plugin's virtual modules + auto-inject, and a **real dev-server end-to-end** run (plugin-vue ordering, decoupled virtual-runtime injection).

## Files

```
src/vite-plugin.ts                 dev plugin: virtual static graph + virtual runtime + auto-inject
src/reactivity-graph/
  types.ts         shared node/edge schema (single source of truth)
  graph.ts         node/edge store + cascade + teardown (removeNode/refcount)
  tracer.ts        traced ref/reactive/computed/watch/toRef/provide/inject wrappers
  component-plugin.ts   app.use plugin: render-effect (renderTracked/Triggered) tracking
  component-scope.ts    component-node identity, props node, provide/inject registry
  overlay.ts       canvas force-graph: glow + pulses (pauses when collapsed/hidden)
  index.ts         mountPanel(), loadStaticGraph(), re-exports (the ./runtime entry)
src/static/
  analyze.ts       static analyzer (parseSfc splits the SFC, oxc parses, we build the edges)
  transform.ts     build-time codemod: ref/reactive/... -> traced (oxc-based)
  cli.ts           CLI -> JSON + Mermaid
playground/        sample Vue app consuming the plugin by name (demo + e2e target)
```

## Scope / honesty

- Runtime tracer, render tracker, static analyzer and Vite plugin are implemented
  and tested here; the package builds clean (`tsc`) and all 11 suites pass,
  including a real Vite dev-server e2e.
- The plugin is dev-server-only (`apply: 'serve'`); it is intentionally absent
  from `vite build`.
- The runtime only guards the propagation ripple against looping (visited-guard);
  it does not detect/report cycles. A DFS cycle-detector exists as a test fixture
  (`scale_cycle`).
- The static analyzer depends on two native packages, both Node-side only (the
  browser runtime bundle imports neither): `oxc-parser` (parses the script), and
  `@vizejs/native` — used solely for `parseSfc` to split the SFC.
