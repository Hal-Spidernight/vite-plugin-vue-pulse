// Headless verification of the runtime tracer against real Vue reactivity.
// Vue's reactivity core runs fine in Node (no DOM needed), so we can assert
// that edges are discovered and propagation pulses fire — without a browser.
import { nextTick } from 'vue';
import { graph } from '../dist/reactivity-graph/graph.js';
import {
  tracedRef, tracedReactive, tracedComputed, tracedWatch, tracedWatchEffect,
} from '../dist/reactivity-graph/tracer.js';

let pass = 0, fail = 0;
const ok = (c, m) => (c ? (pass++, console.log('  ✓', m)) : (fail++, console.error('  ✗', m)));

/** collect graph events */
const glows = [];
const pulses = [];
graph.subscribe((e) => {
  if (e.type === 'glow') glows.push(e.nodeId);
  if (e.type === 'pulse') pulses.push(`${e.from}->${e.to}`);
});

// --- build a causal chain ------------------------------------------------
// first, last -> full(computed) -> greeting(computed) -> watchEffect(log)
// count -> doubled(computed) -> watch
const first = tracedRef('Ada', 'first');
const last = tracedRef('Lovelace', 'last');
const count = tracedRef(1, 'count');
const state = tracedReactive({ n: 10 }, 'state');

const full = tracedComputed(() => `${first.value} ${last.value}`, 'full');
const greeting = tracedComputed(() => `Hi, ${full.value}!`, 'greeting');
const doubled = tracedComputed(() => count.value * 2, 'doubled');

const logs = [];
tracedWatchEffect(() => { logs.push(`${greeting.value} n=${state.n}`); }, 'logEffect');
tracedWatch(doubled, (v) => { logs.push(`doubled=${v}`); }, {}, 'doubledWatch');

console.log('\n[nodes discovered]');
ok(graph.nodes.size === 9, `9 nodes registered (got ${graph.nodes.size})`);

async function main() {
  await nextTick();
  console.log('\n[edges discovered via onTrack]');
  const edgeKeys = [...graph.edges.values()].map((e) => {
    const f = graph.nodes.get(e.from)?.label, t = graph.nodes.get(e.to)?.label;
    return `${f}->${t}`;
  });
  console.log('  ', edgeKeys.join(', '));
  const has = (f, t) => edgeKeys.includes(`${f}->${t}`);
  ok(has('first', 'full'), 'first -> full');
  ok(has('last', 'full'), 'last -> full');
  ok(has('full', 'greeting'), 'full -> greeting');
  ok(has('greeting', 'logEffect'), 'greeting -> logEffect');
  ok(has('state', 'logEffect'), 'state -> logEffect (reactive object)');
  ok(has('count', 'doubled'), 'count -> doubled');
  ok(has('doubled', 'doubledWatch'), 'doubled -> doubledWatch');

  // Use a synchronous scheduler so the timed cascade resolves deterministically.
  graph.cascadeFrom = ((orig) => function (originId, opts = {}) {
    return orig.call(this, originId, { ...opts, step: 0, travel: 0, schedule: (fn) => fn() });
  })(graph.cascadeFrom);

  const pl = (f, t) => pulses.includes(`${f}->${t}`);
  const idOf = (label) => [...graph.nodes.values()].find((n) => n.label === label)?.id;
  const lbl = (id) => graph.nodes.get(id)?.label;

  // --- propagation: mutate count -> ripple count -> doubled -> doubledWatch
  glows.length = 0; pulses.length = 0;
  count.value = 5;
  await nextTick();
  console.log('\n[cascade: count.value = 5]');
  console.log('   glows:', glows.map(lbl).join(' → '));
  console.log('   pulses:', pulses.map((p) => p.split('->').map(lbl).join('->')).join(', '));
  ok(glows[0] === idOf('count'), 'origin (count) glows first');
  ok(pl(idOf('count'), idOf('doubled')), 'pulse count -> doubled');
  ok(pl(idOf('doubled'), idOf('doubledWatch')), 'pulse doubled -> doubledWatch (cascade level 2)');

  // --- 3-deep computed chain: first -> full -> greeting -> logEffect
  glows.length = 0; pulses.length = 0;
  first.value = 'Grace';
  await nextTick();
  console.log('\n[cascade: first.value = "Grace"]');
  console.log('   glows:', glows.map(lbl).join(' → '));
  console.log('   pulses:', pulses.map((p) => p.split('->').map(lbl).join('->')).join(', '));
  ok(glows[0] === idOf('first'), 'origin (first) glows first');
  ok(pl(idOf('first'), idOf('full')), 'pulse first -> full');
  ok(pl(idOf('full'), idOf('greeting')), 'pulse full -> greeting (cascade)');
  ok(pl(idOf('greeting'), idOf('logEffect')), 'pulse greeting -> logEffect (cascade)');
  // `last` did NOT change, so it must not be part of the ripple
  ok(!pl(idOf('last'), idOf('full')), 'unchanged dep (last) does not pulse');
  // whole downstream chain lit up
  ok(['first', 'full', 'greeting', 'logEffect'].every((n) => glows.includes(idOf(n))), 'entire downstream chain glows');

  console.log(`\n${fail === 0 ? 'ALL PASS' : 'FAILURES'}: ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
}
main();
