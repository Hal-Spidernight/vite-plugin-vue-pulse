import { describe, it, expect } from 'vitest';
// Stress + circular-reactivity checks for the tracer.
import { ref, computed, nextTick } from 'vue';
import { graph } from '../dist/reactivity-graph/graph.js';
import { tracedRef, tracedComputed, tracedWatch, tracedWatchEffect } from '../dist/reactivity-graph/tracer.js';

const ok = (c, m) => expect(c, m).toBeTruthy();
describe('scale_cycle', () => {
it('handles scale stress and circular reactivity in the tracer', async () => {
const idOf = (l) => [...graph.nodes.values()].find((n) => n.label === l)?.id;
const lbl = (id) => graph.nodes.get(id)?.label;
const hasEdge = (fromLabel, toLabel) => [...graph.edges.values()].some((e) => lbl(e.from) === fromLabel && lbl(e.to) === toLabel);

// deterministic cascade for assertions
graph.cascadeFrom = ((orig) => function (o, x = {}) {
  return orig.call(this, o, { ...x, step: 0, travel: 0, schedule: (fn) => fn() });
})(graph.cascadeFrom);

/* =========================================================== A. SCALE ===== */
// 40 refs feeding 40 computeds, then a rollup computed + a watchEffect over all.
const N = 40;
const bases = [];
const derived = [];
for (let i = 0; i < N; i++) bases.push(tracedRef(i, `b${i}`));
for (let i = 0; i < N; i++) derived.push(tracedComputed(() => bases[i].value * 2 + (i > 0 ? derived[i - 1].value : 0), `d${i}`));
const grandTotal = tracedComputed(() => derived.reduce((s, d) => s + d.value, 0), 'grandTotal');
let effectRuns = 0;
tracedWatchEffect(() => { void grandTotal.value; effectRuns++; }, 'rollupEffect');

async function scale() {
  await nextTick();
  void grandTotal.value; // prime
  const labels = new Set([...graph.nodes.values()].map((n) => n.label));
  console.log(`\n[A. scale] total nodes=${graph.nodes.size} edges=${graph.edges.size}`);
  const scaleNodes = [...Array(N).keys()].flatMap((i) => [`b${i}`, `d${i}`]).concat(['grandTotal', 'rollupEffect']);
  ok(scaleNodes.every((l) => labels.has(l)), `all ${N * 2 + 2} scale nodes registered`);
  // each d[i] reads b[i] and d[i-1]; grandTotal reads all 40 derived
  ok(hasEdge('b0','d0'), 'b0 -> d0');
  ok(hasEdge('d0','d1'), 'd0 -> d1 (chained computed)');
  ok([...graph.edges.values()].filter((e) => e.to === idOf('grandTotal')).length === N, `grandTotal has ${N} incoming edges`);

  // mutate a base deep in the chain; ripple must reach grandTotal + effect
  const pulses = [];
  const un = graph.subscribe((e) => { if (e.type === 'pulse') pulses.push(`${lbl(e.from)}->${lbl(e.to)}`); });
  bases[5].value = 999;
  await nextTick();
  un();
  console.log(`  mutate b5 -> ${pulses.length} pulses; chain tail reached grandTotal: ${pulses.some((p) => p.endsWith('->grandTotal'))}`);
  ok(pulses.some((p) => p === 'b5->d5'), 'ripple starts b5 -> d5');
  ok(pulses.some((p) => p.endsWith('->grandTotal')), 'ripple reaches grandTotal (deep propagation)');
  ok(pulses.some((p) => p === 'grandTotal->rollupEffect'), 'ripple reaches the watchEffect sink');
}

/* ================================================ B. CYCLIC WATCH SYNC ===== */
// celsius <-> fahrenheit two-way binding (a legit real-world "cycle").
const celsius = tracedRef(0, 'celsius');
const fahren = tracedRef(32, 'fahrenheit');
let c2f = 0, f2c = 0;
tracedWatch(celsius, (v) => { c2f++; fahren.value = v * 9 / 5 + 32; }, {}, 'c2f');
tracedWatch(fahren, (v) => { f2c++; celsius.value = (v - 32) * 5 / 9; }, {}, 'f2c');

async function cyclicWatch() {
  await nextTick();
  console.log('\n[B. cyclic watch sync celsius<->fahrenheit]');
  ok(hasEdge('celsius','c2f'), 'celsius -> c2f');
  ok(hasEdge('fahrenheit','f2c'), 'fahrenheit -> f2c');
  const t0 = Date.now();
  celsius.value = 100; // should settle (round-trip converges, Vue skips no-op sets)
  await nextTick();
  await nextTick();
  const took = Date.now() - t0;
  console.log(`  after set celsius=100: fahrenheit=${fahren.value}, c2f runs=${c2f}, f2c runs=${f2c}, settled in ${took}ms`);
  ok(Math.abs(fahren.value - 212) < 1e-9, 'two-way sync produced fahrenheit=212 (converged, no infinite loop)');
  ok(c2f < 5 && f2c < 5, 'watch callbacks did not run away');
  // the WRITE side is now captured -> the loop is complete
  ok(hasEdge('c2f', 'fahrenheit'), 'c2f -> fahrenheit (write edge)');
  ok(hasEdge('f2c', 'celsius'), 'f2c -> celsius (write edge)');
  const writeEdges = [...graph.edges.values()].filter((e) => e.kind === 'write').map((e) => `${lbl(e.from)}->${lbl(e.to)}`);
  console.log('  write edges:', writeEdges.join(', '));
  ok(!!detectCycle(graph), 'full loop celsius->c2f->fahrenheit->f2c->celsius now forms a detectable cycle');
}

/* ===================================================== C. CYCLIC COMPUTED == */
// True computed cycle a -> b -> a. We build the edges and confirm the cascade
// TERMINATES (visited guard) and that the graph is flagged as cyclic.
function cyclicComputed() {
  console.log('\n[C. cyclic computed a<->b]');
  // build edges directly (simulating what discovery would emit for a cycle)
  graph.addNode('cycA', 'cycA', 'computed', 'runtime');
  graph.addNode('cycB', 'cycB', 'computed', 'runtime');
  graph.addEdge('cycA', 'cycB', undefined, 'runtime');
  graph.addEdge('cycB', 'cycA', undefined, 'runtime');

  const pulses = [];
  const un = graph.subscribe((e) => { if (e.type === 'pulse') pulses.push(`${e.from}->${e.to}`); });
  let looped = false;
  const timer = setTimeout(() => { looped = true; }, 0); // if it hung we'd never get here
  graph.cascadeFrom('cycA'); // must NOT infinite-loop
  clearTimeout(timer);
  un();
  console.log(`  cascadeFrom(cycA) pulses: ${pulses.join(', ')}`);
  ok(pulses.length <= 2, `cascade terminates on cycle (${pulses.length} pulses, no infinite loop)`);

  // static cycle detection (mirror of the Rust EffectGraph.find_cycle)
  const cycle = detectCycle(graph);
  console.log('  detected cycle:', cycle ? cycle.join(' -> ') : 'none');
  ok(!!cycle, 'cycle detected (would be reported as a reactive-loop warning)');
}

// tiny DFS cycle detector over the graph edges (same idea as effect_graph.rs)
function detectCycle(g) {
  const adj = new Map();
  for (const e of g.edges.values()) { if (!adj.has(e.from)) adj.set(e.from, []); adj.get(e.from).push(e.to); }
  const onStack = new Set(), seen = new Set();
  const stack = [];
  function dfs(n) {
    seen.add(n); onStack.add(n); stack.push(n);
    for (const m of adj.get(n) || []) {
      if (onStack.has(m)) return [...stack.slice(stack.indexOf(m)), m].map(lbl);
      if (!seen.has(m)) { const r = dfs(m); if (r) return r; }
    }
    onStack.delete(n); stack.pop(); return null;
  }
  for (const n of adj.keys()) if (!seen.has(n)) { const r = dfs(n); if (r) return r; }
  return null;
}

async function main() {
  await scale();
  await cyclicWatch();
  cyclicComputed();
}
await main();
});
});
