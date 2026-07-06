// Verify the static analyzer recovers the same causal edges the runtime tracer
// discovers — from source alone, without running the app.
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { analyzeSfc } from '../dist/static/analyze.js';

const __dir = path.dirname(fileURLToPath(import.meta.url));
const src = fs.readFileSync(path.join(__dir, '../playground/src/App.vue'), 'utf8');
const g = analyzeSfc(src, 'App.vue');

const ok = (c, m) => expect(c, m).toBeTruthy();
describe('static', () => {
  it('static analyzer recovers the same causal edges as the runtime tracer', async () => {

const labelOf = (id) => g.nodes.find((n) => n.id === id)?.label;
const edgeLabels = g.edges.map((e) => `${labelOf(e.from)}->${labelOf(e.to)}`);
console.log('[static nodes]', g.nodes.map((n) => `${n.label}(${n.kind})`).join(', '));
console.log('[static edges]', edgeLabels.join(', '));

const has = (f, t) => edgeLabels.includes(`${f}->${t}`);
// This SFC is now PLAIN Vue (no traced wrappers) — the analyzer recovers the
// graph from raw ref/reactive/computed/watch/watchEffect.
const edgeToKind = (fromLabel, toKind) => g.edges.some((e) => labelOf(e.from) === fromLabel && g.nodes.find((n) => n.id === e.to)?.kind === toKind);
const writeTo = (toLabel) => g.edges.some((e) => e.kind === 'write' && labelOf(e.to) === toLabel);

ok(g.nodes.some((n) => n.label === 'first' && n.kind === 'ref'), 'first is a ref node');
ok(g.nodes.some((n) => n.label === 'cart' && n.kind === 'reactive'), 'cart is a reactive node');
ok(g.nodes.some((n) => n.label === 'fullName' && n.kind === 'computed'), 'fullName is a computed node');
ok(has('first', 'fullName'), 'first -> fullName');
ok(has('last', 'fullName'), 'last -> fullName');
ok(has('fullName', 'greeting'), 'fullName -> greeting');
ok(has('count', 'doubled'), 'count -> doubled');
ok(has('cart', 'total'), 'cart -> total (reactive member reads)');
ok(g.edges.some((e) => labelOf(e.from) === 'cart' && e.key === 'apples'), 'cart edge carries key "apples"');
// watch source dependency -> a watch node (label is line-based for plain code)
ok(edgeToKind('doubled', 'watch'), 'doubled -> <watch node>');
// watchEffect deps -> a watchEffect node
ok(edgeToKind('greeting', 'watchEffect'), 'greeting -> <watchEffect node>');
// two-way sync writes captured as write-edges (watch callback / arg 2)
ok(writeTo('fahrenheit'), 'watch callback write -> fahrenheit (write edge)');
ok(writeTo('celsius'), 'watch callback write -> celsius (write edge)');
// components are a BOUNDARY, not a node: template reads flag the declaration
// (template: true) and props bindings edge into the CHILD's props declaration.
const tpl = (l) => g.nodes.find((n) => n.label === l)?.template === true;
ok(!g.nodes.some((n) => n.kind === 'component'), 'no component nodes (component = boundary)');
ok(tpl('fullName'), 'template read flags fullName as a render dep');
ok(tpl('count'), 'template read flags count');
ok(tpl('cart'), 'template read flags cart (keyed member read)');
ok(g.nodes.find((n) => n.label === 'first')?.scope === 'App', 'nodes carry their boundary scope (App)');
// cross-boundary props flow between REAL declarations: <Counter :label="greeting">
ok(g.nodes.some((n) => n.id === 'Counter::props' && n.label === 'props'), 'child props declaration node Counter::props (from the parent template)');
ok(g.edges.some((e) => e.from === 'App::greeting' && e.to === 'Counter::props' && e.key === 'label'), 'greeting -> Counter::props (:label binding, cross-boundary)');

  });
});
