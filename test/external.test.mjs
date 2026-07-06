import { describe, it, expect } from 'vitest';
import { ref, reactive, nextTick } from 'vue';
import { graph } from '../dist/reactivity-graph/graph.js';
import { tracedComputed, tracedWatchPostEffect, tracedWatchSyncEffect } from '../dist/reactivity-graph/tracer.js';
const ok = (c, m) => expect(c, m).toBeTruthy();
describe('external', () => {
  it('untraced external reactives auto-register as external nodes', async () => {
const lbl=id=>graph.nodes.get(id)?.label;
// UNTRACED external reactives (simulating Pinia/VueUse/library state)
const libRef = ref(10);            // not created via tracedRef
const libState = reactive({ q: 1 });
const derived = tracedComputed(()=> libRef.value + libState.q, 'derived');
tracedWatchPostEffect(()=>{ void derived.value; }, 'postFx');
tracedWatchSyncEffect(()=>{ void libState.q; }, 'syncFx');
await nextTick(); void derived.value;
const edges=[...graph.edges.values()].map(e=>`${lbl(e.from)}->${lbl(e.to)}`);
console.log('[external auto-register]'); console.log('  nodes:', [...graph.nodes.values()].map(n=>n.label).join(', '));
console.log('  edges:', edges.join(', '));
ok([...graph.nodes.values()].some(n=>n.label.includes('ext')&&n.kind==='ref'), 'untraced libRef registered as external ref node');
ok([...graph.nodes.values()].some(n=>n.label.includes('ext')&&n.kind==='reactive'), 'untraced libState registered as external reactive node');
ok(edges.some(e=>e.startsWith('⟨ext⟩ ref')&&e.endsWith('->derived')), 'external ref -> derived edge');
ok([...graph.nodes.values()].some(n=>n.label==='postFx'&&n.kind==='watchEffect'), 'watchPostEffect node');
ok([...graph.nodes.values()].some(n=>n.label==='syncFx'&&n.kind==='watchEffect'), 'watchSyncEffect node');
  });
});
