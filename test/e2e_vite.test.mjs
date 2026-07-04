// End-to-end Vite integration (the coverage the review flagged as missing):
// boot a REAL dev server with @vitejs/plugin-vue + our plugin, and drive
// transformRequest so plugin ordering (enforce:'post'), the build-time transform
// on a real .vue sub-request, the virtual runtime/static modules, and auto-inject
// are all exercised through Vite — not just the transform fn on hand-fed JS.
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { createServer } from 'vite';
import vue from '@vitejs/plugin-vue';
import reactivityGraph from '../dist/vite-plugin.js';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

let pass = 0, fail = 0;
const ok = (c, m) => (c ? (pass++, console.log('  ✓', m)) : (fail++, console.error('  ✗', m)));

const server = await createServer({
  configFile: false,
  root: projectRoot,
  logLevel: 'silent',
  server: { middlewareMode: true },
  plugins: [vue(), reactivityGraph({ include: ['src/**/*.vue'], autoInject: true })],
});

try {
  // 1. A real .vue goes through plugin-vue, then our transform rewrites ref/... -> traced
  const app = await server.transformRequest('/src/App.vue');
  ok(!!app && /tracedRef|tracedReactive|tracedComputed/.test(app.code), 'App.vue: ref/reactive/computed rewritten to traced through Vite');
  ok(!!app && /virtual:reactivity-graph\/runtime/.test(app.code), 'App.vue: traced helpers imported from the virtual runtime (not a /src path)');
  ok(!!app && !/['"]\/src\/reactivity-graph\//.test(app.code), 'App.vue: no consumer-tree /src import injected (decoupled)');

  // 2. The entry gets the panel auto-injected
  const main = await server.transformRequest('/src/main.ts');
  ok(!!main && /mountPanel/.test(main.code) && /loadStaticGraph/.test(main.code), 'main.ts: panel auto-injected');

  // 3. The virtual runtime module resolves and re-exports the packaged runtime
  const rt = await server.transformRequest('virtual:reactivity-graph/runtime');
  ok(!!rt && /export\s*\*\s*from/.test(rt.code), 'virtual runtime module resolves to a re-export of the packaged runtime');

  // 4. The virtual static map resolves and contains the analyzed graph
  const stat = await server.transformRequest('virtual:reactivity-graph/static');
  ok(!!stat && /staticGraph/.test(stat.code) && /first/.test(stat.code), 'virtual static map resolves with analyzed nodes');
} finally {
  // fire-and-forget: server.close() can hang in middlewareMode; process.exit below
  // tears everything down deterministically.
  server.close().catch(() => {});
}

console.log(`\n${fail === 0 ? 'ALL PASS' : 'FAILURES'}: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
