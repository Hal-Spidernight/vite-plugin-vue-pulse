import { ref, reactive, nextTick } from 'vue';
import { graph } from '../src/reactivity-graph/graph.js';
import { tracedComputed, tracedWatchPostEffect, tracedWatchSyncEffect } from '../src/reactivity-graph/tracer.js';
let pass=0,fail=0; const ok=(c,m)=>c?(pass++,console.log('  ✓',m)):(fail++,console.error('  ✗',m));
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
console.log(`\n${fail===0?'ALL PASS':'FAIL'}: ${pass}/${pass+fail}`); process.exit(fail?1:0);
