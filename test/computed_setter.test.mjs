import { describe, it, expect } from 'vitest';
// Write-edges from watch callbacks (arg 2) and computed setters.
import { nextTick } from 'vue';
import { graph } from '../dist/reactivity-graph/graph.js';
import { tracedRef, tracedComputed, tracedWatch } from '../dist/reactivity-graph/tracer.js';

const ok = (c, m) => expect(c, m).toBeTruthy();
describe('computed_setter', () => {
it('captures write-edges from computed setters and watch callbacks', async () => {
const lbl = (id) => graph.nodes.get(id)?.label;
const hasEdge = (f, t, k) => [...graph.edges.values()].some((e) => lbl(e.from) === f && lbl(e.to) === t && (!k || e.kind === k));

// --- writable computed: getter reads, setter writes -----------------------
const first = tracedRef('Ada', 'first');
const last = tracedRef('Lovelace', 'last');
const fullName = tracedComputed({
  get: () => `${first.value} ${last.value}`,
  set: (v) => { const [f, l] = v.split(' '); first.value = f; last.value = l; },
}, 'fullName');

// --- watch whose callback (arg 2) writes another reactive -----------------
const source = tracedRef(1, 'source');
const mirror = tracedRef(0, 'mirror');
tracedWatch(source, (v) => { mirror.value = v * 10; }, {}, 'mirrorWatch');

async function main() {
  await nextTick();
  void fullName.value; // prime getter reads

  console.log('[read edges]');
  ok(hasEdge('first', 'fullName', 'read'), 'first -> fullName (read, getter)');
  ok(hasEdge('last', 'fullName', 'read'), 'last -> fullName (read, getter)');
  ok(hasEdge('source', 'mirrorWatch', 'read'), 'source -> mirrorWatch (read, watch source)');

  fullName.value = 'Grace Hopper'; // trigger computed setter
  source.value = 5;               // trigger watch callback write
  await nextTick();

  console.log('[write edges]');
  console.log('  ', [...graph.edges.values()].filter((e) => e.kind === 'write').map((e) => `${lbl(e.from)}->${lbl(e.to)}`).join(', '));
  ok(hasEdge('fullName', 'first', 'write'), 'fullName -> first (write, computed setter)');
  ok(hasEdge('fullName', 'last', 'write'), 'fullName -> last (write, computed setter)');
  ok(hasEdge('mirrorWatch', 'mirror', 'write'), 'mirrorWatch -> mirror (write, watch callback / arg 2)');
}
await main();
});
});
