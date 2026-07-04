# croquis effect-graph builder (static half)

> **Status:** the JS side no longer *clones* croquis. `src/static/analyze.ts` now
> consumes the **real** `vize` toolchain — `@vizejs/native` `parseSfc` for SFC
> splitting and `oxc-parser` (croquis's own oxc) for the script/template AST — and
> only adds the effect-graph *edge* builder on top. This Rust file is the reference
> for upstreaming that same builder into `vize_croquis` itself (issue #695), so the
> static graph can eventually come straight from croquis with no JS layer at all.

This is the `vize_croquis` extension that produces the static reactivity graph —
the "map" that the runtime overlay lights up. It fills the empty slot left by
`crates/vize_croquis/src/effect_graph.rs` (issue #695), which today ships only
the `EffectGraph` model + `find_cycle` but has **no builder** wiring real
`computed` / `watch` / `watchEffect` sources into edges.

## What it does

Two passes over the `<script setup>` OXC program:

1. **Collect reactive bindings** — every `const x = ref()/reactive()/computed()`
   (and the devtool's `tracedRef/...` wrappers) becomes a node.
2. **Wire effect edges** — for each `computed` getter, `watch` source, and
   `watchEffect` body, walk the expression and emit `dependency -> dependent`
   edges. `state.count` inside a `reactive` gets a keyed edge (`key: "count"`).

Output is `ReactivityGraphExport { nodes, edges }`, serialized with serde to the
**exact same JSON shape** the runtime tracer emits
(`../src/reactivity-graph/graph.js` → `toJSON()`), so the static map and live
traffic reconcile by label.

It also converts to the existing `EffectGraph` (`to_effect_graph()`) so you get
`find_cycle()` for free — cyclic computed chains (`a → b → a`) that lock Vue's
update loop.

## Install into the workspace

```
cp effect_graph_builder.rs  <vize>/crates/vize_croquis/src/effect_graph_builder.rs
```

Then in `crates/vize_croquis/src/lib.rs`:

```rust
mod effect_graph_builder;
pub use effect_graph_builder::{EffectGraphBuilder, ReactivityGraphExport, NodeKind};
```

Usage (after parsing a script setup program with the existing OXC pipeline):

```rust
let export = EffectGraphBuilder::new().build(&program);
let json = serde_json::to_string(&export)?;      // feed the visualizer
if let Some(cycle) = export.to_effect_graph().find_cycle() {
    // report reactive loop as a Patina warning
}
```

Cross-file: merge each SFC's `export` and bridge `provide`/`inject` pairs using
`vize_croquis_cf`'s `DependencyGraph` `ProvideInject` edges — connect the
provided ref's node in file A to the injected node in file B.

## Status / caveat

This is a **reference implementation written to compile against the workspace**,
not verified with `cargo build` in the authoring environment (no Rust toolchain
there). The two-pass structure, the reuse of `ReactiveKind` and `EffectGraph`,
and the serde output shape are the stable parts. OXC AST accessor spellings
(field vs. method names) drift across oxc versions — the accessors are isolated
at the bottom of the file (`as_var_decl`, `declarator_name`, `call_callee_name`,
…) so any drift is a localized fix, not a rewrite.

The logic is **behaviorally mirrored and fully tested** in
`../src/static/analyze.mjs` (run `npm test`), which implements the identical
two-pass algorithm over the Babel AST and is verified to recover the demo's
causal edges. Use that as the executable spec while wiring the Rust version.
