// Verify the Vite plugin without booting a dev server: drive its hooks directly.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import reactivityGraph from '../dist/vite-plugin.js';

// analyze the playground (the sample consumer app) as a real project root
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'playground');
let pass = 0, fail = 0;
const ok = (c, m) => (c ? (pass++, console.log('  ✓', m)) : (fail++, console.error('  ✗', m)));

const plugin = reactivityGraph({ include: ['src/**/*.vue'], autoInject: true });
plugin.configResolved({ root });

// resolveId + load => virtual static graph module
const rid = plugin.resolveId('virtual:vue-pulse/static');
ok(rid === '\0virtual:vue-pulse/static', 'resolveId returns resolved virtual id');

const loaded = plugin.load(rid);
ok(/export const staticGraph =/.test(loaded), 'load() emits staticGraph export');
const json = JSON.parse(loaded.match(/staticGraph = (\{.*\});/s)[1]);
console.log('  static nodes:', json.nodes.map((n) => n.label).join(', '));
ok(json.nodes.length >= 10, `static graph has nodes (${json.nodes.length})`);
// node ids are the deterministic `<Comp>::<label>` identity (same as runtime) so they dedup
ok(json.edges.some((e) => e.from === 'App::first' && e.to === 'App::fullName'), 'edge first->fullName present (deterministic scoped ids)');

// transform() injects the panel into the entry
const out = plugin.transform('createApp()', root + '/src/main.ts');
ok(out && /mountPanel/.test(out.code) && /loadStaticGraph/.test(out.code), 'transform injects panel into main.ts');
const skip = plugin.transform('x', root + '/src/App.vue');
ok(!skip, 'transform skips non-entry files');

console.log(`\n${fail === 0 ? 'ALL PASS' : 'FAILURES'}: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
