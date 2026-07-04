/**
 * vite-plugin-vue-pulse
 *
 * Dev-only Vite plugin. Three jobs:
 *   1. Build-time transform: rewrites `ref`/`reactive`/`computed`/`watch`/… into
 *      their traced equivalents so the devtool discovers every node + edge with
 *      ZERO source change.
 *   2. Static analysis over your `.vue` files, exposed as the virtual module
 *      `virtual:vue-pulse/static` (the "map").
 *   3. Auto-injects the devtool panel into the app entry.
 *
 * Decoupling: the runtime is shipped INSIDE this package and exposed as the
 * virtual module `virtual:vue-pulse/runtime` (resolved to the packaged
 * file), so nothing is injected that points at the consuming project's file tree.
 *
 * Usage (vite.config):
 *   import reactivityGraph from 'vite-plugin-vue-pulse'
 *   export default { plugins: [vue(), reactivityGraph({ include: ['src/**\/*.vue'] })] }
 *
 * For component/render-effect tracking, also add in your entry:
 *   import { reactivityGraphPlugin } from 'vite-plugin-vue-pulse/runtime'
 *   app.use(reactivityGraphPlugin)
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Plugin } from 'vite';
import { analyzeSfc, mergeStaticGraphs } from './static/analyze.js';
import type { StaticAnalysis } from './static/analyze.js';
import { transformReactivity } from './static/transform.js';

const VIRTUAL_STATIC = 'virtual:vue-pulse/static';
const RESOLVED_STATIC = '\0' + VIRTUAL_STATIC;
const VIRTUAL_RUNTIME = 'virtual:vue-pulse/runtime';
const RESOLVED_RUNTIME = '\0' + VIRTUAL_RUNTIME;

export interface ReactivityGraphOptions {
  /** glob-ish patterns for the .vue files to statically analyze */
  include?: string[];
  /** auto-inject the devtool panel into the app entry (default true) */
  autoInject?: boolean;
  /** rewrite ref/reactive/… -> traced at build time (default true) */
  autoTransform?: boolean;
  /** which module ids count as the app entry for auto-inject */
  entryPattern?: RegExp;
}

/** Absolute path to the packaged runtime entry (dist in a build, src in dev). */
function runtimeEntry(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = ['./reactivity-graph/index.js', './reactivity-graph/index.ts'].map((p) => path.resolve(here, p));
  const resolved = candidates.find((p) => fs.existsSync(p)) || candidates[0];
  // forward slashes so the re-export id resolves on Windows too
  return resolved.replace(/\\/g, '/');
}

export default function reactivityGraph(options: ReactivityGraphOptions = {}): Plugin {
  const include = options.include || ['src/**/*.vue'];
  const autoInject = options.autoInject !== false;
  const autoTransform = options.autoTransform !== false;
  // main/index/app/entry/bootstrap with .{c,m,}{j,t}s — broadened from the old
  // /main|index/.{t,j}s so custom & .mjs/.mts entries also get the panel.
  const entryPattern = options.entryPattern || /\/(?:main|index|app|entry|entry-client|bootstrap)\.(?:[cm]?[jt]s)(?:$|\?)/;
  let root = process.cwd();

  function buildStaticGraph() {
    const files = collect(root, include);
    const graphs: StaticAnalysis[] = [];
    for (const f of files) {
      try {
        graphs.push(analyzeSfc(fs.readFileSync(f, 'utf8'), path.basename(f)));
      } catch (err: any) {
        console.warn('[reactivity-graph] failed to analyze', f, err?.message);
      }
    }
    // dedup by id + resolve cross-file provide/inject pairs into DI edges
    return mergeStaticGraphs(graphs);
  }

  return {
    name: 'vite-plugin-vue-pulse',
    apply: 'serve',
    // run AFTER @vitejs/plugin-vue so we transform the already-extracted <script>
    enforce: 'post',
    // The runtime (graph store + tracer + panel) is a process-wide singleton
    // (`export const graph = new ReactivityGraph()`). The build-time transform and
    // the auto-injected panel reach it via `virtual:vue-pulse/runtime` (the raw
    // packaged file). But a consumer following the README ALSO imports from the
    // bare `vite-plugin-vue-pulse/runtime` subpath (`app.use(reactivityGraphPlugin)`).
    // When the package is a normal node_modules install, Vite's dep optimizer
    // pre-bundles that bare subpath into a SEPARATE module with its OWN
    // `new ReactivityGraph()` — so render-effect tracking (boundary flash + template
    // rings + render cascade) would fire on a second, unrendered graph and vanish
    // silently. Excluding the package from pre-bundling makes the bare subpath
    // resolve to the same raw file as the virtual module → one shared singleton.
    config() {
      return { optimizeDeps: { exclude: ['vite-plugin-vue-pulse', 'vite-plugin-vue-pulse/runtime'] } };
    },
    configResolved(cfg) { root = cfg.root; },
    resolveId(id) {
      if (id === VIRTUAL_STATIC) return RESOLVED_STATIC;
      if (id === VIRTUAL_RUNTIME) return RESOLVED_RUNTIME;
      return undefined;
    },
    load(id) {
      if (id === RESOLVED_STATIC) {
        const graph = buildStaticGraph();
        return `export const staticGraph = ${JSON.stringify(graph)};\nexport default staticGraph;`;
      }
      if (id === RESOLVED_RUNTIME) {
        // re-export the packaged runtime so injected consumer code never points at
        // the consuming project's own file tree.
        return `export * from ${JSON.stringify(runtimeEntry())};`;
      }
      return undefined;
    },
    handleHotUpdate(ctx) {
      // keep the static "map" fresh when a .vue changes
      if (/\.vue$/.test(ctx.file)) {
        const mod = ctx.server.moduleGraph.getModuleById(RESOLVED_STATIC);
        if (mod) ctx.server.moduleGraph.invalidateModule(mod);
      }
      return undefined;
    },
    transform(code, id) {
      if (/node_modules/.test(id)) return;
      if (id.includes('/reactivity-graph/') || id.includes('virtual:vue-pulse')) return; // never instrument the tool itself
      let out = code;

      // 1. build-time rewrite: ref/reactive/computed/watch/... -> traced
      if (autoTransform && /\.(vue|jsx?|tsx?)($|\?)/.test(id) && /from\s*['"](vue|@vue\/reactivity)['"]/.test(code)) {
        const r = transformReactivity(code, id, { importPath: VIRTUAL_RUNTIME });
        if (r.changed) out = r.code;
      }

      // 2. auto-inject the panel into the app entry
      if (autoInject && entryPattern.test(id)) {
        out += `
;import { mountPanel, loadStaticGraph } from '${VIRTUAL_RUNTIME}';
;import { staticGraph as __rg_static } from '${VIRTUAL_STATIC}';
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
// NOTE: this is intentionally minimal (one `**` before a filename, in one base
// dir). For monorepo/brace patterns, pass explicit dirs or swap in a real glob.
function collect(root: string, patterns: string[]): string[] {
  const out: string[] = [];
  for (const pat of patterns) {
    const recursive = pat.includes('**');
    const baseDir = path.join(root, pat.split('*')[0]);
    const ext = path.extname(pat) || '.vue';
    walkDir(baseDir, recursive, ext, out);
  }
  return [...new Set(out)];
}

function walkDir(dir: string, recursive: boolean, ext: string, out: string[]): void {
  let entries: fs.Dirent[] = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) { if (recursive) walkDir(full, recursive, ext, out); }
    else if (full.endsWith(ext)) out.push(full);
  }
}
