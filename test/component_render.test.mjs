// Component render-effect tracking (#1) + scoped identity (multi-component
// label-collision fix) + unmount teardown (#7), against a real client mount.
// Uses happy-dom so Vue's runtime-dom sets up a genuine render effect (which is
// what fires renderTracked/renderTriggered — SSR does not).
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
const hasNode = (l) => nodesByLabel(l).length > 0;
const readEdge = (fromLabel, toLabel) => [...graph.edges.values()].some((e) =>
  e.kind === 'read' && graph.nodes.get(e.from)?.label === fromLabel && graph.nodes.get(e.to)?.label === toLabel);

// CompA: render reads a computed (dbl) which reads count
const CompA = {
  name: 'CompA',
  setup() { const count = tracedRef(1, 'count'); const dbl = tracedComputed(() => count.value * 2, 'dbl'); return () => h('div', dbl.value); },
};
// CompB: a ref used ONLY in the template (the case that never glowed before)
const CompB = {
  name: 'CompB',
  setup() { const count = tracedRef(100, 'count'); return () => h('span', count.value); },
};
const Root = { name: 'Root', setup() { return () => h('div', [h(CompA), h(CompB)]); } };

const container = document.createElement('div');
const app = createApp(Root);
app.use(reactivityGraphPlugin);
app.mount(container);

await nextTick();

console.log('[nodes]', [...graph.nodes.values()].map((n) => `${n.label}(${n.kind})`).join(', '));

console.log('[render effect tracked]');
ok(hasNode('<CompA>'), 'component node <CompA> created (render effect)');
ok(hasNode('<CompB>'), 'component node <CompB> created (render effect)');
ok(readEdge('count', '<CompB>'), 'template-only ref count -> <CompB> (would never glow before)');
ok(readEdge('dbl', '<CompA>'), 'computed dbl -> <CompA> render');
ok(readEdge('count', 'dbl'), 'count -> dbl (computed dep discovered under a component)');

console.log('[scoped identity — no cross-component collision]');
const counts = nodesByLabel('count');
ok(counts.length === 2, `two distinct "count" nodes, one per component (got ${counts.length})`);
ok(new Set(counts.map((n) => n.id)).size === 2, 'the two "count" refs did NOT merge into one node');

console.log('[unmount teardown]');
const before = graph.nodes.size;
app.unmount();
await nextTick();
console.log('  nodes:', before, '->', graph.nodes.size);
ok(!hasNode('<CompA>') && !hasNode('<CompB>'), 'component nodes removed on unmount');
ok(nodesByLabel('count').length === 0, 'per-component refs removed on unmount (no leak)');
ok(graph.nodes.size < before, 'graph shrank after unmount');

console.log(`\n${fail === 0 ? 'ALL PASS' : 'FAILURES'}: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
