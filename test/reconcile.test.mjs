// Regression: static "map" + runtime "traffic" must RECONCILE into one node each,
// not duplicate. Reproduces the reported bug (3 refs + 1 anonymous watch showed as
// 8 nodes incl. 2 watch nodes) by loading the static graph and then running the
// traced wrappers inside a mounted component named "App".
import { describe, it, expect } from 'vitest';
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
const { tracedRef, tracedWatch } = await import('../dist/reactivity-graph/tracer.js');
const { reactivityGraphPlugin } = await import('../dist/reactivity-graph/component-plugin.js');
const { analyzeSfc } = await import('../dist/static/analyze.js');

const ok = (c, m) => expect(c, m).toBeTruthy();
describe('reconcile', () => {
it('reconciles static map and runtime traffic into one node each', async () => {
const byLabel = (l) => [...graph.nodes.values()].filter((n) => n.label === l);

// the user's exact case, as an SFC
const sfc = `<script setup>
import { ref, watch } from 'vue';
const hoge = ref('');
const hoge2 = ref('');
const hoge3 = ref('');
watch(hoge, () => { hoge3.value = 'hello!'; });
</script>
<template><div>{{ hoge }}{{ hoge2 }}{{ hoge3 }}</div></template>`;

// The REAL auto-inject order that broke: the app MOUNTS FIRST (the user's
// `createApp(App).mount()` runs before the appended `loadStaticGraph`). With
// deterministic ids this must still reconcile to one node each, regardless of order.
const App = {
  name: 'App',
  setup() {
    const hoge = tracedRef('', 'hoge');
    const hoge2 = tracedRef('', 'hoge2');
    const hoge3 = tracedRef('', 'hoge3');
    tracedWatch(hoge, () => { hoge3.value = 'hello!'; }, {}, 'watch#1');
    return () => h('div', [hoge.value, hoge2.value, hoge3.value].join(''));
  },
};
const app = createApp(App);
app.use(reactivityGraphPlugin);
app.mount(document.createElement('div'));
await nextTick();

// 2. NOW load the static map (as the appended inject does, AFTER mount)
loadStaticGraph(analyzeSfc(sfc, 'App.vue'));

console.log('[after runtime] nodes:', [...graph.nodes.values()].map((n) => `${n.label}(${n.kind})`).join(', '));

// EACH reactive/effect reconciles to exactly ONE node (no static+runtime duplicate)
ok(byLabel('hoge').length === 1, `single "hoge" node (got ${byLabel('hoge').length})`);
ok(byLabel('hoge2').length === 1, `single "hoge2" node (got ${byLabel('hoge2').length})`);
ok(byLabel('hoge3').length === 1, `single "hoge3" node (got ${byLabel('hoge3').length})`);
const watches = [...graph.nodes.values()].filter((n) => n.kind === 'watch');
ok(watches.length === 1, `exactly ONE watch node (got ${watches.length}) — the reported bug`);
ok(![...graph.nodes.values()].some((n) => n.kind === 'component'), 'no component nodes — component is a boundary, not a node');

// the reconciled node is marked runtime-confirmed (origin flipped static->runtime)
ok(byLabel('hoge')[0]?.origin === 'runtime', 'hoge reconciled: static node confirmed by runtime');
ok(byLabel('hoge')[0]?.scope === 'App', 'reconciled node carries the App boundary scope');
// the static template flag lands on the SAME node the runtime created (merged, not duplicated)
ok(byLabel('hoge')[0]?.template === true, 'static template read flagged onto the runtime node');
});
});
