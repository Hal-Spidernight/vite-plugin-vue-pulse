// Cross-component edges (#2/#3/#4): parent->child + props flow, and
// provide/inject DI edges — against a real client mount (happy-dom).
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
const hasNode = (l) => [...graph.nodes.values()].some((n) => n.label === l);
const edge = (from, to) => [...graph.edges.values()].some((e) => L(e.from) === from && L(e.to) === to);

const Child = {
  name: 'Child',
  props: { label: { type: String, default: '' } },
  setup(props) { return () => h('span', props.label); },
};
const Consumer = {
  name: 'Consumer',
  setup() { const t = tracedInject('theme'); return () => h('em', t.value); },
};
const Root = {
  name: 'Root',
  setup() {
    const theme = tracedRef('dark', 'theme');
    tracedProvide('theme', theme);
    return () => h('div', [h(Child, { label: theme.value }), h(Consumer)]);
  },
};

const container = document.createElement('div');
const app = createApp(Root);
app.use(reactivityGraphPlugin);
app.mount(container);
await nextTick();

console.log('[nodes]', [...graph.nodes.values()].map((n) => `${n.label}(${n.kind})`).join(', '));
console.log('[edges]', [...graph.edges.values()].map((e) => `${L(e.from)}->${L(e.to)}`).join(', '));

console.log('[component tree + props]');
ok(hasNode('<Root>') && hasNode('<Child>') && hasNode('<Consumer>'), 'render nodes for Root/Child/Consumer');
ok(edge('<Root>', '<Child>'), 'parent -> child structural edge (Root -> Child)');
ok(hasNode('<Child>▸props'), 'props node <Child>▸props created');
ok(edge('<Root>', '<Child>▸props'), 'parent feeds child props (Root -> <Child>▸props)');
ok(edge('<Child>▸props', '<Child>'), 'props feed child render (<Child>▸props -> <Child>)');

console.log('[provide/inject DI]');
ok(edge('theme', '<Consumer>'), 'DI edge: provided theme -> <Consumer> (inject)');
ok(edge('theme', '<Root>'), 'theme read in Root render (theme -> <Root>)');

console.log('[teardown]');
app.unmount();
await nextTick();
ok(!hasNode('<Child>') && !hasNode('<Child>▸props'), 'child + props nodes removed on unmount');

console.log(`\n${fail === 0 ? 'ALL PASS' : 'FAILURES'}: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
