// TEMP repro (deleted after run) — lifecycle checks against dist/
import { Window } from 'happy-dom';
const win = new Window();
globalThis.window = win;
globalThis.document = win.document;
for (const k of ['Node', 'Element', 'HTMLElement', 'SVGElement', 'Text', 'Comment']) {
  try { globalThis[k] = win[k]; } catch { /* skip */ }
}

const { createApp, h, nextTick, ref } = await import('vue');
const { graph } = await import('../dist/reactivity-graph/graph.js');
const { loadStaticGraph } = await import('../dist/reactivity-graph/index.js');
const { tracedRef, tracedProvide, tracedInject } = await import('../dist/reactivity-graph/tracer.js');
const { reactivityGraphPlugin } = await import('../dist/reactivity-graph/component-plugin.js');

console.log('=== A: props refcount across 2 instances of the same component ===');
const Child = {
  name: 'Child',
  props: { msg: { type: String, default: '' } },
  setup(props) { const local = tracedRef(0, 'local'); return () => h('span', props.msg + local.value); },
};
const showA = ref(true), showB = ref(true);
const Root = {
  name: 'Root',
  setup() { return () => h('div', [showA.value ? h(Child, { msg: 'a' }) : null, showB.value ? h(Child, { msg: 'b' }) : null]); },
};
const app = createApp(Root);
app.use(reactivityGraphPlugin);
app.mount(document.createElement('div'));
await nextTick();
console.log('refs(Child::props)=', graph.refs.get('Child::props'), 'refs(Child::local)=', graph.refs.get('Child::local'));
showA.value = false; await nextTick();
console.log('after unmount#1: props?', !!graph.nodes.get('Child::props'), 'local?', !!graph.nodes.get('Child::local'),
  'refs=', graph.refs.get('Child::props'), graph.refs.get('Child::local'));
showB.value = false; await nextTick();
console.log('after unmount#2: props?', !!graph.nodes.get('Child::props'), 'local?', !!graph.nodes.get('Child::local'));
app.unmount(); await nextTick();

console.log('\n=== B: static loaded BEFORE mount w/ template flag; unmount -> survives as map ===');
graph.reset();
loadStaticGraph({ nodes: [{ id: 'C2::x', label: 'x', kind: 'ref', origin: 'static', template: true }], edges: [] });
const C2 = { name: 'C2', setup() { const x = tracedRef(1, 'x'); return () => h('i', x.value); } };
const app2 = createApp(C2); app2.use(reactivityGraphPlugin);
app2.mount(document.createElement('div'));
await nextTick();
const n2 = graph.nodes.get('C2::x');
console.log('mounted: origin=', n2?.origin, 'template=', n2?.template, 'refs=', graph.refs.get('C2::x'));
app2.unmount(); await nextTick();
console.log('after unmount: node?', !!graph.nodes.get('C2::x'), 'origin=', graph.nodes.get('C2::x')?.origin);

console.log('\n=== C: edge origin does NOT flip static->runtime (node does) ===');
graph.reset();
graph.addNode('N1', 'n1', 'ref', 'static');
graph.addNode('N1', 'n1', 'ref', 'runtime');
console.log('node origin after runtime confirm:', graph.nodes.get('N1').origin);
graph.addEdge('N1', 'N2', undefined, 'static', 'read');
const e = graph.addEdge('N1', 'N2', undefined, 'runtime', 'read');
console.log('edge origin after runtime rediscovery:', e.origin);

console.log('\n=== D: providedNodes staleness (dangling DI edge from removed provider) ===');
graph.reset();
const P = { name: 'P', setup() { const theme = tracedRef('d', 'theme'); tracedProvide('k', theme); return () => h('i'); } };
const app3 = createApp(P); app3.use(reactivityGraphPlugin);
app3.mount(document.createElement('div')); await nextTick();
app3.unmount(); await nextTick();
console.log('provider node gone?', !graph.nodes.get('P::theme'));
const C = { name: 'C', setup() { const t = tracedInject('t', 'k', 'fallback'); return () => h('i', String(t)); } };
const app4 = createApp(C); app4.use(reactivityGraphPlugin);
app4.mount(document.createElement('div')); await nextTick();
const dangling = [...graph.edges.values()].filter((ed) => !graph.nodes.has(ed.from));
console.log('dangling edges (from-node missing):', dangling.map((d) => `${d.from}->${d.to}`));
app4.unmount();
