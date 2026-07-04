# HANDOFF — Vue reactivity graph devtool

Continuation notes for picking this up in Claude Code.

## What this is
A devtool that visualizes causal relationships between Vue reactives
(ref/reactive/computed/watch/watchEffect) and lights the graph up as changes
propagate at runtime — nodes glow, pulses travel dependency → dependent.
Two layers on one graph model: **static** ("map", from source) + **runtime**
("traffic", live), reconciled by label.

## Status — done & verified
- **Runtime tracer** (`src/reactivity-graph/tracer.js`): traced wrappers; edges
  auto-discovered via Vue `onTrack`/`onTrigger`. Verified against real
  `@vue/reactivity`.
- **Cascade propagation** (`graph.js` `cascadeFrom`): BFS ripple from the
  mutation origin, staggered glow+pulse, visited-guard (no infinite loop on
  cycles), debounced.
- **Read vs write edges**: reads = dep→effect (gray); writes = effect→reactive
  (amber), captured from watch callbacks (arg 2) + computed setters via a
  write-intercepting Proxy + `currentEffect` stack.
- **Expanded coverage**: ref/shallowRef/reactive/shallowReactive/readonly/
  shallowReadonly/customRef/computed(get,set)/watch/watchEffect/watchPostEffect/
  watchSyncEffect. `customRef` incoming-edges are a known gap (Vue hides its
  onTrack target).
- **External auto-register**: untraced reactives (Pinia/VueUse/`useRoute()`) get
  `⟨ext⟩` nodes by object identity the moment they're read inside instrumented
  code — no need to transform `node_modules`.
- **Build-time transform** (`src/static/transform.mjs`): rewrites plain
  `ref/reactive/computed/watch/...` → traced at compile time. **Zero source
  change, no mixin.** Wired into `vite-plugin-reactivity-graph.mjs`. `App.vue` is
  plain Vue and is fully captured through the transform.
- **Static analyzer** (`src/static/analyze.mjs`) + **Rust croquis extension**
  (`croquis-rust/`, reference impl, not cargo-built here).
- **Standalone demo** (`standalone-demo.html`): open in a browser, no build.
- **Tests**: `npm test` runs 7 suites (73 checks), all green. `npx vite build` clean.

## Decisions locked in
- Delivery target: **Vue DevTools plugin** via `@vue/devtools-api`.
- watch/watchEffect stay as **nodes**, plus **write-edges** (not modeled as edges).
- reactive granularity: **object-level** node + keyed edges (not per-key).
- Global capture: **build-time transform** (mixin/`renderTracked` rejected —
  verified renderTracked only sees the render effect's direct deps).

## Next steps (recommended order)
1. **Component boundaries + provide/inject** (highest value for the stated goal):
   make each component a node (render effect as consumer), wrap `provide`/`inject`
   for DI edges, props for parent→child edges. Group nodes into per-component
   subgraphs.
2. **`@vue/devtools-api` plugin**: custom Inspector (nodes grouped by
   component/store, deps/dependents in state panel) + Timeline (propagation
   events). NB: the devtools panel can't host the force-graph canvas — plan a
   detached window for the visual graph.
3. **Pinia plugin**: store state = reactive nodes, getters = computed, actions =
   write effects.

## Run
```
npm install
npm run dev        # panel auto-mounts bottom-right (dev only)
npm test           # 7 suites
npm run analyze    # static graph JSON + Mermaid for src/App.vue
# or just open standalone-demo.html in a browser
```

## Gotchas
- Vue debugger hooks (`onTrack`/`onTrigger`) are DEV-ONLY (stripped in prod) — the
  standalone imports the **dev** browser build (`vue.esm-browser.js`, not `.prod.js`).
- The plugin is `apply: 'serve'` (dev only) by design.
- `customRef` can't attribute incoming edges (Vue hides the target).
- Anonymous watch/watchEffect labels are line-based, so static vs runtime nodes
  for them may not reconcile 1:1 (named state reconciles fine).
