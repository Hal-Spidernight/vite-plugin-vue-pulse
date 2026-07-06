import { describe, it, expect } from 'vitest';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { nextTick } from 'vue';
import { transformReactivity } from '../dist/static/transform.js';
import { graph } from '../dist/reactivity-graph/graph.js';

// Portable paths (no hardcoded absolutes): resolve relative to this test file.
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const helpersPath = path.join(projectRoot, 'dist/reactivity-graph/index.js');
const transformedPath = path.join(projectRoot, 'test', '_transformed.mjs');

// A plain component script — NO traced wrappers, NO mixin. Just normal Vue.
const src = `
import { ref, reactive, computed, watch, watchEffect } from 'vue';
const first = ref('Ada');
const last = ref('Lovelace');
const cart = reactive({ apples: 1, price: 100 });
const fullName = computed(() => first.value + ' ' + last.value);
const total = computed(() => cart.apples * cart.price);
const mirror = ref('');
watch(fullName, (v) => { mirror.value = v; });
watchEffect(() => { void total.value; });
export { first, last, cart, fullName, total, mirror };
`;

const { code, changed } = transformReactivity(src, 'Demo.vue', { importPath: helpersPath });
console.log('[transform output]\n' + code.split('\n').map(l => '  ' + l).join('\n'));

const ok = (c, m) => expect(c, m).toBeTruthy();
describe('transform', () => {
  it('transforms plain Vue reactivity into traced wrappers and builds the graph', async () => {
ok(changed, 'transform reported changes');
ok(code.includes('__RG.tracedRef(\'Ada\', "first")') || code.includes('__RG.tracedRef("Ada", "first")') || /__RG\.tracedRef\('Ada', "first"\)/.test(code), 'ref -> tracedRef with inferred label "first"');
ok(/__RG\.tracedComputed\(.*, "fullName"\)/.test(code), 'computed -> tracedComputed label "fullName"');
ok(/__RG\.tracedWatch\(fullName, .*, \{\}, "watch#\d+"\)/.test(code), 'watch -> tracedWatch with padded options + order-index label');
ok(/__RG\.tracedWatchEffect\(.*, "watchEffect#\d+"\)/.test(code), 'watchEffect -> tracedWatchEffect with order-index label');

// Now RUN the transformed code and confirm the graph actually builds.
writeFileSync(transformedPath, code);
const mod = await import(transformedPath);
await nextTick();
mod.first.value = 'Grace';
await nextTick();

const L = (id) => graph.nodes.get(id)?.label;
const edges = [...graph.edges.values()].map((e) => `${L(e.from)}->${L(e.to)}`);
console.log('\n[graph built from transformed code]');
console.log('  nodes:', [...graph.nodes.values()].map((n) => `${n.label}(${n.kind})`).join(', '));
console.log('  edges:', edges.join(', '));
const has = (f, t) => edges.includes(`${f}->${t}`);
ok(has('first', 'fullName'), 'first -> fullName (from transformed plain code)');
ok(has('last', 'fullName'), 'last -> fullName');
ok(has('cart', 'total'), 'cart -> total');
ok(edges.some((e) => e.startsWith('fullName->watch#')), 'fullName -> watch (source dep)');
ok([...graph.edges.values()].some((e) => e.kind === 'write' && L(e.from).startsWith('watch#') && L(e.to) === 'mirror'), 'watch callback write: watch -> mirror');

  });
});
