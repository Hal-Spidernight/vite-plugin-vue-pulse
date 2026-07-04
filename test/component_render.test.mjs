// Render-effect tracking with components as a BOUNDARY (not a node): template
// reads flag the declaration (`template: true`), a re-render flashes the
// component's boundary, and scoped identity + unmount teardown still hold —
// against a real client mount. Uses happy-dom so Vue's runtime-dom sets up a
// genuine render effect (which is what fires renderTracked/renderTriggered —
// SSR does not).
import { Window } from 'happy-dom';

const win = new Window();
globalThis.window = win;
globalThis.document = win.document;
for (const k of ['Node', 'Element', 'HTMLElement', 'SVGElement', 'Text', 'Comment']) {
  try { globalThis[k] = win[k]; } catch { /* read-only global — skip */ }
}

// import AFTER globals exist so vue/runtime-dom captures the fake document
const { createApp, h, nextTick } = await import('vue');
const { graph } = await import('../dist/reactivity-graph/graph.js');
const { tracedRef, tracedComputed } = await import('../dist/reactivity-graph/tracer.js');
const { reactivityGraphPlugin } = await import('../dist/reactivity-graph/component-plugin.js');

let pass = 0, fail = 0;
const ok = (c, m) => (c ? (pass++, console.log('  ✓', m)) : (fail++, console.error('  ✗', m)));
const nodesByLabel = (l) => [...graph.nodes.values()].filter((n) => n.label === l);
const readEdge = (fromLabel, toLabel) => [...graph.edges.values()].some((e) =>
  e.kind === 'read' && graph.nodes.get(e.from)?.label === fromLabel && graph.nodes.get(e.to)?.label === toLabel);

// CompA: render reads a computed (dbl) which reads count
const CompA = {
  name: 'CompA',
  setup() { const count = tracedRef(1, 'count'); const dbl = tracedComputed(() => count.value * 2, 'dbl'); return () => h('div', dbl.value); },
};
// CompB: a ref used ONLY in the template (the case that never glowed before)
let bCount; // kept so we can mutate it and force a re-render
const CompB = {
  name: 'CompB',
  setup() { bCount = tracedRef(100, 'count'); return () => h('span', bCount.value); },
};
const Root = { name: 'Root', setup() { return () => h('div', [h(CompA), h(CompB)]); } };

const container = document.createElement('div');
const app = createApp(Root);
app.use(reactivityGraphPlugin);
app.mount(container);

await nextTick();

console.log('[nodes]', [...graph.nodes.values()].map((n) => `${n.id}(${n.kind}${n.template ? ',tpl' : ''})`).join(', '));

console.log('[component = boundary, not a node]');
ok(![...graph.nodes.values()].some((n) => n.kind === 'component'), 'NO component nodes exist (nodes are declarations only)');
const compBCount = graph.nodes.get('CompB::count');
ok(!!compBCount && compBCount.scope === 'CompB', 'CompB::count carries its boundary scope');
ok(compBCount?.template === true, 'template-only ref is flagged as a render dep (template: true)');
ok(graph.nodes.get('CompA::dbl')?.template === true, 'computed read by CompA template is flagged too');
ok(readEdge('count', 'dbl'), 'count -> dbl (computed dep discovered under a component)');

console.log('[scoped identity — no cross-component collision]');
const counts = nodesByLabel('count');
ok(counts.length === 2, `two distinct "count" nodes, one per component (got ${counts.length})`);
ok(new Set(counts.map((n) => n.id)).size === 2, 'the two "count" refs did NOT merge into one node');

console.log('[boundary flash on re-render]');
const flashes = [];
const unsub = graph.subscribe((e) => { if (e.type === 'boundary') flashes.push(e.scope); });
bCount.value = 200;
await nextTick();
unsub();
ok(flashes.includes('CompB'), `re-render flashes the CompB boundary (got: ${flashes.join(',') || 'none'})`);

console.log('[unmount teardown]');
const before = graph.nodes.size;
app.unmount();
await nextTick();
console.log('  nodes:', before, '->', graph.nodes.size);
ok(nodesByLabel('count').length === 0, 'per-component refs removed on unmount (no leak)');
ok(![...graph.nodes.values()].some((n) => n.scope === 'CompA' || n.scope === 'CompB'), 'no CompA/CompB-scoped nodes remain → their boundaries are gone');
ok(graph.nodes.size < before, 'graph shrank after unmount');

console.log(`\n${fail === 0 ? 'ALL PASS' : 'FAILURES'}: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
