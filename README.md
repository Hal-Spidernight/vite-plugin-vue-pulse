# Vue reactivity graph — static map + live propagation

A devtool that visualizes the causal relationships between Vue reactives
(`ref` / `reactive` / `computed` / `watch` / `watchEffect`) as a graph, and
**lights it up as changes propagate at runtime** — nodes glow when they fire and
pulses travel along the edges from dependency to dependent.

Two layers, one graph:

| layer | what it gives you | where |
|-------|-------------------|-------|
| **static** | the *map*: which reactive monitors which, from source alone | `vize_croquis` extension (Rust) + `src/static/analyze.mjs` (TS mirror) |
| **runtime** | the *traffic*: which change actually fired which effect, live | `src/reactivity-graph/` (tracer + overlay) |

The two share one node/edge schema and reconcile **by label**, so the static
graph is drawn first (dashed) and the same nodes glow when runtime confirms
them.

## Try it in 10 seconds (no build)

Open **`standalone-demo.html`** in a browser. It loads Vue from a CDN, wires a
small reactive graph, and shows the live glowing graph. Click the buttons and
watch propagation flow: `first → fullName → greeting → titleEffect`, etc.

## Run the real Vite integration

```bash
npm install
npm run dev      # open the app; the panel auto-mounts bottom-right (dev only)
```

`vite-plugin-reactivity-graph` does three things in dev:

1. **Build-time transform** — rewrites `ref/reactive/computed/watch/watchEffect/…`
   into their traced equivalents automatically. **You write plain Vue** — no
   `tracedRef`, no mixin, no code changes. Labels are inferred from the variable
   name (or source line for anonymous watchers).

   ```js
   // you write this…                    …the plugin compiles this:
   const count = ref(0)          →  const count = __RG.tracedRef(0, "count")
   const dbl = computed(...)      →  const dbl = __RG.tracedComputed(..., "dbl")
   watch(dbl, cb)                 →  __RG.tracedWatch(dbl, cb, {}, "watch@L12")
   ```

2. **Static analysis** over your `.vue` files, exposed as
   `virtual:reactivity-graph/static` (the "map").

3. **Auto-injects** the panel.

Edges are discovered automatically via Vue's `onTrack` / `onTrigger` debugger
hooks — you never declare them. Reads become `dep → effect` (gray) edges; writes
made inside a watch callback / computed setter become `effect → reactive` (amber)
edges, so two-way bindings show up as real loops.

### What's monitored

| element | as | notes |
|---|---|---|
| `ref` `shallowRef` `reactive` `shallowReactive` | node | writes intercepted via proxy |
| `computed` (get / get+set) | node | setter writes → write-edges |
| `readonly` `shallowReadonly` | node | read-only state |
| `customRef` | node | ⚠ Vue doesn't expose its onTrack target — incoming edges can't be attributed |
| `watch` `watchEffect` `watchPostEffect` `watchSyncEffect` | node | source = read deps; callback/body writes = write-edges |
| `toRef` / `toRefs` | — | reads attribute to the source reactive + key |
| **external reactives** (Pinia state, VueUse refs, `useRoute()`) | node `⟨ext⟩` | auto-registered by object identity the moment they're read inside instrumented code — **no need to transform `node_modules`** |

Circular reactivity is handled: two-way `watch` sync converges (no runaway) and
cyclic `computed` chains are detected (`find_cycle`) and don't hang the ripple
(visited-guard).

## Static analysis only (the "map")

```bash
npm run analyze          # prints {nodes,edges} JSON + a Mermaid diagram for src/App.vue
node src/static/cli.mjs  path/to/Component.vue ...
```

## How it works

**Runtime.** Each traced wrapper tags the underlying reactive object with a
stable id and attaches `onTrack`/`onTrigger`. `onTrack` reports exactly which
dependency an effect read (→ edge `dep → effect`). `onTrigger` reports which
effect just re-ran; Vue includes the source object for direct reads but not for
cascades through intermediate computeds — so the store reconstructs the full
cascade from the recently-glowed upstream nodes (`graph.onEffectFired`). This
was validated empirically (see `test/`), not assumed.

**Static.** Two passes over the `<script setup>` AST: (1) collect reactive
bindings, (2) for each `computed` getter / `watch` source / `watchEffect` body,
collect the reactive identifiers read inside and emit `dep → effect` edges
(`state.count` → keyed edge). Same algorithm in Rust (OXC, for `vize_croquis`)
and TS (Babel, runnable here).

## croquis integration (Rust)

The static half is designed to slot into `vize_croquis` — see
`croquis-rust/README.md`. It fills the empty builder behind
`effect_graph.rs`/issue #695 and reuses its `find_cycle()` to flag cyclic
computed chains. That Rust file is a reference implementation to compile in the
vize workspace (no Rust toolchain in the authoring env); its behavior is mirror-
tested by `src/static/analyze.mjs`.

## Tests

```bash
npm test    # tracer.test.mjs (runtime, vs real Vue) + static.test.mjs + plugin.test.mjs
```

- `tracer.test.mjs` — edge discovery + multi-level cascade propagation against real `@vue/reactivity`.
- `static.test.mjs` — the analyzer recovers the demo's causal edges from source.
- `plugin.test.mjs` — the Vite plugin's virtual module + auto-inject.
- `scale_cycle.test.mjs` — 86-node stress + circular reactivity (two-way sync, cyclic computed).
- `computed_setter.test.mjs` — write-edges from watch callbacks + computed setters.
- `external.test.mjs` — auto-registration of untraced (Pinia/VueUse-style) reactives.
- `transform.test.mjs` — the build-time codemod turns plain Vue into a full live graph.

## Files

```
standalone-demo.html                 open-in-browser instant demo
src/reactivity-graph/
  graph.js       node/edge store + cascade reconstruction
  tracer.js      traced ref/reactive/computed/watch/watchEffect wrappers
  overlay.js     canvas force-graph: glow + pulses
  index.js       mountPanel(), loadStaticGraph(), re-exports
src/static/
  analyze.mjs    static analyzer (TS mirror of the croquis pass)
  transform.mjs  build-time codemod: ref/reactive/... -> traced (zero source change)
  cli.mjs        CLI -> JSON + Mermaid
vite-plugin-reactivity-graph.mjs     dev plugin: virtual static graph + auto-inject
src/App.vue, src/main.ts             demo app
croquis-rust/
  effect_graph_builder.rs            the vize_croquis extension (Rust)
  README.md                          how to wire it in
test/                                automated verification
```

## Scope / honesty

- Runtime tracer + static analyzer + Vite plugin are **implemented and tested**
  here; the project builds (`vite build` clean).
- The Rust croquis extension is written to compile against the vize workspace
  but was **not** `cargo build`-verified in the authoring environment; treat the
  TS analyzer as its executable spec.
- `onTrack`/`onTrigger` are dev-only in Vue (stripped in production) — exactly
  right for a devtool.
