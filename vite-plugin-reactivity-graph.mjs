// @ts-check
/**
 * vite-plugin-reactivity-graph
 *
 * Dev-only Vite plugin. Two jobs:
 *   1. Runs the static analyzer over your .vue files and exposes the resulting
 *      "map" as a virtual module `virtual:reactivity-graph/static`.
 *   2. (optional) Auto-injects the devtool panel so you don't have to wire it
 *      up in main.ts.
 *
 * Usage (vite.config):
 *   import reactivityGraph from './vite-plugin-reactivity-graph.mjs'
 *   export default { plugins: [vue(), reactivityGraph({ include: ['src/*.vue'] })] }
 */
import fs from 'node:fs';
import path from 'node:path';
import { analyzeSfc } from './src/static/analyze.mjs';
import { transformReactivity } from './src/static/transform.mjs';

const VIRTUAL = 'virtual:reactivity-graph/static';
const RESOLVED = '\0' + VIRTUAL;

/**
 * @param {{ include?: string[], autoInject?: boolean, autoTransform?: boolean }} [options]
 */
export default function reactivityGraph(options = {}) {
  const include = options.include || ['src/**/*.vue'];
  const autoInject = options.autoInject !== false;
  const autoTransform = options.autoTransform !== false; // rewrite ref/reactive/... -> traced at build time
  const HELPERS = '/src/reactivity-graph/index.js';
  let root = process.cwd();

  function buildStaticGraph() {
    const files = collect(root, include);
    const nodes = new Map();
    const edges = new Map();
    for (const f of files) {
      try {
        const g = analyzeSfc(fs.readFileSync(f, 'utf8'), path.basename(f));
        for (const n of g.nodes) nodes.set(n.id, n);
        for (const e of g.edges) edges.set(`${e.from}->${e.to}#${e.key || ''}`, e);
      } catch (err) {
        console.warn('[reactivity-graph] failed to analyze', f, err.message);
      }
    }
    return { nodes: [...nodes.values()], edges: [...edges.values()] };
  }

  return {
    name: 'vite-plugin-reactivity-graph',
    apply: 'serve',
    configResolved(cfg) { root = cfg.root; },
    resolveId(id) { if (id === VIRTUAL) return RESOLVED; },
    load(id) {
      if (id !== RESOLVED) return;
      const graph = buildStaticGraph();
      return `export const staticGraph = ${JSON.stringify(graph)};\nexport default staticGraph;`;
    },
    transform(code, id) {
      if (/node_modules/.test(id)) return;
      if (id.includes('/reactivity-graph/')) return; // never instrument the tool itself
      let out = code;

      // 1. build-time rewrite: ref/reactive/computed/watch/... -> traced (zero source change)
      if (autoTransform && /\.(vue|jsx?|tsx?)($|\?)/.test(id) && /from\s*['"](vue|@vue\/reactivity)['"]/.test(code)) {
        const r = transformReactivity(code, id, { importPath: HELPERS });
        if (r.changed) out = r.code;
      }

      // 2. auto-inject the panel into the app entry
      if (autoInject && /\/(main|index)\.(t|j)s($|\?)/.test(id)) {
        out += `
;import { mountPanel, loadStaticGraph } from '${HELPERS}';
;import { staticGraph as __rg_static } from '${VIRTUAL}';
;if (typeof window !== 'undefined' && !window.__rg_mounted) {
  window.__rg_mounted = true;
  loadStaticGraph(__rg_static);
  requestAnimationFrame(() => mountPanel({ title: 'static map + live traffic' }));
}
`;
      }

      return out === code ? undefined : { code: out, map: null };
    },
  };
}

// Very small glob: supports recursive "src/(**)/x.vue" and flat "src/x.vue".
function collect(root, patterns) {
  /** @type {string[]} */
  const out = [];
  for (const pat of patterns) {
    const recursive = pat.includes('**');
    const baseDir = path.join(root, pat.split('*')[0]);
    const ext = path.extname(pat) || '.vue';
    walkDir(baseDir, recursive, ext, out);
  }
  return [...new Set(out)];
}

function walkDir(dir, recursive, ext, out) {
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) { if (recursive) walkDir(full, recursive, ext, out); }
    else if (full.endsWith(ext)) out.push(full);
  }
}
