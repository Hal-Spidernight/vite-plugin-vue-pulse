// toRefs granularity: a plain `reactive` stays ONE object-level node (keyed edges),
// but the refs a `toRefs` destructure produces each get their OWN node (Comp::key)
// + a keyed source->key edge — and that runtime node-ification RECONCILES with the
// static analyzer's per-binding nodes (one node each, not duplicates).
import { Window } from 'happy-dom';

const win = new Window();
globalThis.window = win;
globalThis.document = win.document;
for (const k of ['Node', 'Element', 'HTMLElement', 'SVGElement', 'Text', 'Comment']) {
  try { globalThis[k] = win[k]; } catch { /* read-only global */ }
}

const { createApp, h, nextTick } = await import('vue');
const { graph } = await import('../dist/reactivity-graph/graph.js');
const { loadStaticGraph } = await import('../dist/reactivity-graph/index.js');
const { tracedReactive, tracedToRefs, tracedComputed } = await import('../dist/reactivity-graph/tracer.js');
const { reactivityGraphPlugin } = await import('../dist/reactivity-graph/component-plugin.js');
const { analyzeSfc } = await import('../dist/static/analyze.js');

let pass = 0, fail = 0;
const ok = (c, m) => (c ? (pass++, console.log('  ✓', m)) : (fail++, console.error('  ✗', m)));
const byLabel = (l) => [...graph.nodes.values()].filter((n) => n.label === l);
const idsOf = () => [...graph.nodes.values()].map((n) => n.id).sort();
const hasEdge = (from, to, key) => [...graph.edges.values()].some((e) => e.from === from && e.to === to && (key === undefined || e.key === key));

const sfc = `<script setup>
import { reactive, toRefs, computed } from 'vue';
const cart = reactive({ apples: 1, pears: 2 });
const { apples, pears } = toRefs(cart);
const sum = computed(() => apples.value + pears.value);
</script>
<template><div>{{ sum }}</div></template>`;

const App = {
  name: 'App',
  setup() {
    const cart = tracedReactive({ apples: 1, pears: 2 }, 'cart');
    const { apples, pears } = tracedToRefs(cart, 'unused');
    const sum = tracedComputed(() => apples.value + pears.value, 'sum');
    return () => h('div', String(sum.value));
  },
};
const app = createApp(App);
app.use(reactivityGraphPlugin);
app.mount(document.createElement('div'));
await nextTick();
loadStaticGraph(analyzeSfc(sfc, 'App.vue'));

console.log('[nodes]', [...graph.nodes.values()].map((n) => `${n.id}(${n.kind})`).join(', '));

// reactive stays ONE object-level node
ok(byLabel('cart').length === 1 && byLabel('cart')[0].kind === 'reactive', 'reactive `cart` is ONE object-level node');

// each destructured ref is its OWN node, scoped to the component boundary
ok(byLabel('apples').length === 1 && byLabel('apples')[0].kind === 'ref', 'toRefs → individual `apples` ref node');
ok(byLabel('pears').length === 1 && byLabel('pears')[0].kind === 'ref', 'toRefs → individual `pears` ref node');
ok(byLabel('apples')[0].scope === 'App' && byLabel('pears')[0].scope === 'App', 'destructured ref nodes carry the App boundary scope');

// keyed derivation edge source -> ref (the linkage toRefs promises)
ok(hasEdge('App::cart', 'App::apples', 'apples'), 'keyed edge cart --apples--> apples');
ok(hasEdge('App::cart', 'App::pears', 'pears'), 'keyed edge cart --pears--> pears');

// static + runtime RECONCILE: exactly one node per id (no static/runtime duplicate)
const ids = idsOf();
const dupes = ids.filter((id, i) => ids.indexOf(id) !== i);
ok(dupes.length === 0, `no duplicate nodes — static+runtime reconcile (dupes: ${JSON.stringify(dupes)})`);
ok(byLabel('apples')[0].origin === 'runtime', 'apples node reconciled: static confirmed by runtime');

// the destructured ref nodes are distinct ids from the reactive object node
ok(graph.nodes.has('App::cart') && graph.nodes.has('App::apples') && graph.nodes.has('App::pears'),
  'cart / apples / pears are three distinct nodes');

console.log(`\n${fail === 0 ? 'ALL PASS' : 'FAILURES'}: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
