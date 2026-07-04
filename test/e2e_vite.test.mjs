// End-to-end integration over the PLAYGROUND (a separate sample Vue project that
// consumes the plugin BY PACKAGE NAME via its own vite.config.ts, workspace-linked
// — exactly like an installing project). Boots a real Vite dev server with the
// playground's real config and drives transformRequest, so plugin ordering
// (enforce:'post'), the build-time transform on real .vue files, decoupled
// virtual-runtime injection, and auto-inject are all exercised through Vite.
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { createServer } from 'vite';

const playground = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'playground');

let pass = 0, fail = 0;
const ok = (c, m) => (c ? (pass++, console.log('  ✓', m)) : (fail++, console.error('  ✗', m)));

const server = await createServer({
  configFile: path.join(playground, 'vite.config.ts'), // loads the plugin BY NAME
  root: playground,
  logLevel: 'silent',
  server: { middlewareMode: true },
});

try {
  // 1. the parent SFC goes through plugin-vue, then our transform rewrites ref/... -> traced
  const app = await server.transformRequest('/src/App.vue');
  ok(!!app && /tracedRef|tracedReactive|tracedComputed/.test(app.code), 'App.vue: ref/reactive/computed rewritten to traced through Vite');
  ok(!!app && /virtual:vue-pulse\/runtime/.test(app.code), 'App.vue: traced helpers imported from the virtual runtime');
  ok(!!app && !/['"]\/src\/reactivity-graph\//.test(app.code), 'App.vue: no consumer-tree /src import injected (decoupled)');

  // 2. the child SFC is instrumented too
  const child = await server.transformRequest('/src/Counter.vue');
  ok(!!child && /tracedRef|tracedComputed/.test(child.code), 'Counter.vue (child): also instrumented');

  // 3. the entry gets the panel auto-injected
  const main = await server.transformRequest('/src/main.ts');
  ok(!!main && /mountPanel/.test(main.code) && /loadStaticGraph/.test(main.code), 'main.ts: panel auto-injected');

  // 4. virtual runtime resolves & re-exports the packaged runtime
  const rt = await server.transformRequest('virtual:vue-pulse/runtime');
  ok(!!rt && /export\s*\*\s*from/.test(rt.code), 'virtual runtime resolves to a re-export of the packaged runtime');

  // 5. virtual static map resolves with the analyzed graph (App + Counter)
  const stat = await server.transformRequest('virtual:vue-pulse/static');
  ok(!!stat && /staticGraph/.test(stat.code) && /first/.test(stat.code), 'virtual static map resolves with analyzed nodes');
} finally {
  server.close().catch(() => {}); // can hang in middlewareMode; process.exit tears down
}

console.log(`\n${fail === 0 ? 'ALL PASS' : 'FAILURES'}: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
