import { describe, it, expect } from 'vitest';
// Deep write capture (#5) + toRef linkage (#6), verified against real Vue.
//   - array mutation through a ref:      list.value.push(x)        -> write-edge
//   - collection mutation:               map.set(k,v) / set.add(x) -> write-edge
//   - nested reactive property write:    state.nested.field = y    -> write-edge
//   - toRef(source,key):                 source -> toRef (keyed read-edge)
// Also asserts reads through the wrapped value still work (Map.get, arr.map),
// i.e. the deep-write proxy does not break Vue's own tracking/semantics.
import { nextTick } from 'vue';
import { graph } from '../dist/reactivity-graph/graph.js';
import {
  tracedRef, tracedReactive, tracedWatch, tracedWatchEffect, tracedToRef,
} from '../dist/reactivity-graph/tracer.js';

const ok = (c, m) => expect(c, m).toBeTruthy();
describe('deep_writes', () => {
it('captures deep write-edges and toRef linkage against real Vue', async () => {
const lbl = (id) => graph.nodes.get(id)?.label;
const writeEdge = (f, t) => [...graph.edges.values()].some((e) => e.kind === 'write' && lbl(e.from) === f && lbl(e.to) === t);
const readEdge = (f, t, k) => [...graph.edges.values()].some((e) => e.kind === 'read' && lbl(e.from) === f && lbl(e.to) === t && (k === undefined || e.key === k));

// state under test
const list = tracedRef([], 'list');
const bag = tracedReactive(new Map(), 'bag');
const tags = tracedReactive(new Set(), 'tags');
const state = tracedReactive({ nested: { field: 0 } }, 'state');

// an effect whose body READS the wrapped values (so read semantics are exercised)
// and whose callback MUTATES them through references (so write-edges are captured)
const trigger = tracedRef(0, 'trigger');
let readBack = null;
tracedWatch(trigger, () => {
  list.value.push(trigger.value);          // array method mutation via ref
  bag.set('k' + trigger.value, trigger.value); // Map.set mutation
  tags.add(trigger.value);                 // Set.add mutation
  state.nested.field = trigger.value;      // nested property write
  // reads through the wrapped values must still work:
  readBack = { size: bag.size, has: bag.has('k' + trigger.value), mapped: list.value.map((x) => x) };
}, {}, 'mutator');

// toRef derivation
const nickname = tracedToRef(state, 'name', 'nickname');
tracedWatchEffect(() => { void nickname.value; }, 'nameWatch');

async function main() {
  await nextTick();
  trigger.value = 7;
  await nextTick();

  console.log('[write edges]', [...graph.edges.values()].filter((e) => e.kind === 'write').map((e) => `${lbl(e.from)}->${lbl(e.to)}#${e.key ?? ''}`).join(', '));
  ok(writeEdge('mutator', 'list'), 'array push through ref -> write-edge (mutator -> list)');
  ok(writeEdge('mutator', 'bag'), 'Map.set -> write-edge (mutator -> bag)');
  ok(writeEdge('mutator', 'tags'), 'Set.add -> write-edge (mutator -> tags)');
  ok(writeEdge('mutator', 'state'), 'nested property write -> write-edge (mutator -> state)');

  console.log('[read semantics preserved]', JSON.stringify(readBack));
  ok(readBack && readBack.size === 1, 'Map.size read through wrapped value works');
  ok(readBack && readBack.has === true, 'Map.has read through wrapped value works');
  ok(readBack && Array.isArray(readBack.mapped) && readBack.mapped[0] === 7, 'Array.map read through wrapped value works');

  // real Vue reactivity still fired (a plain effect re-runs on the deep mutation)
  ok(state.nested.field === 7, 'nested write actually landed (Vue reactivity intact)');
  ok([...bag.keys()].length === 1 && bag.get('k7') === 7, 'Map mutation actually landed');

  console.log('[toRef linkage]');
  ok(readEdge('state', 'nickname', 'name'), 'toRef: state -> nickname (keyed "name" read-edge)');
}
await main();
});
});
