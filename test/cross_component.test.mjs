// Cross-component flow with components as a BOUNDARY: the child's props
// declaration is a real node (`Child::props`, from defineProps), inject is a
// declaration with a DI edge from the provided node, and NO component/render
// nodes exist — against a real client mount (happy-dom).
import { Window } from 'happy-dom';

const win = new Window();
globalThis.window = win;
globalThis.document = win.document;
for (const k of ['Node', 'Element', 'HTMLElement', 'SVGElement', 'Text', 'Comment']) {
  try { globalThis[k] = win[k]; } catch { /* read-only global — skip */ }
}

const { createApp, h, nextTick } = await import('vue');
const { graph } = await import('../dist/reactivity-graph/graph.js');
const { tracedRef, tracedProvide, tracedInject } = await import('../dist/reactivity-graph/tracer.js');
const { reactivityGraphPlugin } = await import('../dist/reactivity-graph/component-plugin.js');

let pass = 0, fail = 0;
const ok = (c, m) => (c ? (pass++, console.log('  ✓', m)) : (fail++, console.error('  ✗', m)));
const L = (id) => graph.nodes.get(id)?.label;
const edge = (from, to) => [...graph.edges.values()].some((e) => L(e.from) === from && L(e.to) === to);

const Child = {
  name: 'Child',
  props: { label: { type: String, default: '' } },
  setup(props) { return () => h('span', props.label); },
};
const Consumer = {
  name: 'Consumer',
  // label first — the build-time transform prepends the assigned variable name
  setup() { const t = tracedInject('t', 'theme'); return () => h('em', t.value); },
};
let themeRef; // kept so we can mutate it and watch the boundaries flash
const Root = {
  name: 'Root',
  setup() {
    themeRef = tracedRef('dark', 'theme');
    tracedProvide('theme', themeRef);
    return () => h('div', [h(Child, { label: themeRef.value }), h(Consumer)]);
  },
};

const container = document.createElement('div');
const app = createApp(Root);
app.use(reactivityGraphPlugin);
app.mount(container);
await nextTick();

console.log('[nodes]', [...graph.nodes.values()].map((n) => `${n.id}(${n.kind}${n.template ? ',tpl' : ''})`).join(', '));
console.log('[edges]', [...graph.edges.values()].map((e) => `${L(e.from)}->${L(e.to)}`).join(', '));

console.log('[component = boundary]');
ok(![...graph.nodes.values()].some((n) => n.kind === 'component'), 'NO component/render nodes (components are boundaries)');
ok([...graph.nodes.values()].every((n) => !String(n.label).startsWith('⟨ext⟩')), 'the props object did NOT leak in as an external node');

console.log('[props declaration]');
const props = graph.nodes.get('Child::props');
ok(!!props && props.label === 'props' && props.kind === 'reactive', 'child props declaration node Child::props');
ok(props?.scope === 'Child', 'props node lives in the Child boundary');
ok(props?.template === true, 'props read by the child template → render-dep flag');

console.log('[provide/inject DI]');
const injected = graph.nodes.get('Consumer::t');
ok(!!injected && injected.kind === 'ref' && injected.scope === 'Consumer', 'inject is a declaration: Consumer::t node');
ok(edge('theme', 't'), 'DI edge: provided theme -> injected t');
ok(graph.nodes.get('Root::theme')?.template === true, 'theme read in Root render → render-dep flag');

console.log('[boundary flash]');
const flashes = [];
const unsub = graph.subscribe((e) => { if (e.type === 'boundary') flashes.push(e.scope); });
themeRef.value = 'light'; // Root re-renders (and pushes a new prop into Child)
await nextTick();
unsub();
ok(flashes.includes('Root'), `re-render flashes the Root boundary (got: ${flashes.join(',') || 'none'})`);

console.log('[teardown]');
app.unmount();
await nextTick();
ok(!graph.nodes.get('Child::props'), 'Child::props removed on unmount');
ok(!graph.nodes.get('Consumer::t'), 'Consumer::t removed on unmount');
ok(!graph.nodes.get('Root::theme'), 'Root::theme removed on unmount');

console.log(`\n${fail === 0 ? 'ALL PASS' : 'FAILURES'}: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
