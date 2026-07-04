// @ts-check
/**
 * Build-time reactivity transform.
 *
 * Rewrites Vue reactivity calls into their *traced* equivalents at compile time,
 * so you get the full dependency graph with ZERO source changes — no manual
 * `tracedRef`, no mixin. Labels are inferred from the assigned variable name (or
 * a source position for anonymous watch/watchEffect).
 *
 *   const count = ref(0)                 ->  const count = __RG.tracedRef(0, "count")
 *   const dbl = computed(() => ...)      ->  const dbl = __RG.tracedComputed(() => ..., "dbl")
 *   watch(src, cb)                       ->  __RG.tracedWatch(src, cb, {}, "watch@L12")
 *   watchEffect(fn)                      ->  __RG.tracedWatchEffect(fn, "watchEffect@L14")
 *
 * Only identifiers actually imported from 'vue' / '@vue/reactivity' are touched,
 * so unrelated locals named `ref` are safe.
 */
import { parse as babelParse } from '@babel/parser';

/** canonical factory -> traced helper name */
const TRACED = {
  ref: 'tracedRef', shallowRef: 'tracedShallowRef',
  reactive: 'tracedReactive', shallowReactive: 'tracedReactive',
  readonly: 'tracedReadonly', shallowReadonly: 'tracedShallowReadonly',
  computed: 'tracedComputed', customRef: 'tracedCustomRef',
  watch: 'tracedWatch', watchEffect: 'tracedWatchEffect',
  watchPostEffect: 'tracedWatchPostEffect', watchSyncEffect: 'tracedWatchSyncEffect',
};
const REFLIKE = new Set(['ref', 'shallowRef', 'reactive', 'shallowReactive', 'readonly', 'shallowReadonly', 'computed', 'customRef']);
const WATCHEFFECTS = new Set(['watchEffect', 'watchPostEffect', 'watchSyncEffect']);
const SOURCES = new Set(['vue', '@vue/reactivity']);

/**
 * @param {string} code
 * @param {string} filename
 * @param {{ importPath?: string }} [opts]
 * @returns {{ code: string, changed: boolean }}
 */
export function transformReactivity(code, filename = 'anon.js', opts = {}) {
  const importPath = opts.importPath || '/src/reactivity-graph/index.js';
  let ast;
  try {
    ast = babelParse(code, { sourceType: 'module', plugins: ['typescript', 'jsx', 'topLevelAwait', 'importAssertions'] });
  } catch {
    return { code, changed: false };
  }

  // 1. Which local names are Vue reactivity factories?
  /** @type {Map<string,string>} localName -> canonical */
  const factories = new Map();
  for (const stmt of ast.program.body) {
    if (stmt.type !== 'ImportDeclaration' || !SOURCES.has(stmt.source.value)) continue;
    for (const spec of stmt.specifiers) {
      if (spec.type === 'ImportSpecifier' && spec.imported.type === 'Identifier') {
        const canonical = spec.imported.name;
        if (TRACED[canonical]) factories.set(spec.local.name, canonical);
      }
    }
  }
  if (factories.size === 0) return { code, changed: false };

  // 2. Collect edits (rename callee + insert label arg).
  /** @type {Array<{start:number,end:number,text:string}>} */
  const edits = [];
  walk(ast.program, (node, parent) => {
    if (node.type !== 'CallExpression' || node.callee.type !== 'Identifier') return;
    const canonical = factories.get(node.callee.name);
    if (!canonical) return;

    const label = inferLabel(node, parent, canonical, code);
    const q = JSON.stringify(label);

    // rename callee -> __RG.tracedXxx
    edits.push({ start: node.callee.start, end: node.callee.end, text: `__RG.${TRACED[canonical]}` });

    // insert the label argument in the position matching the traced signature
    const args = node.arguments;
    if (REFLIKE.has(canonical)) {
      if (args.length) edits.push({ start: args[args.length - 1].end, end: args[args.length - 1].end, text: `, ${q}` });
      else edits.push({ start: node.end - 1, end: node.end - 1, text: `undefined, ${q}` });
    } else if (WATCHEFFECTS.has(canonical)) {
      // tracedWatchEffect(fn, label, options)
      if (args.length) edits.push({ start: args[0].end, end: args[0].end, text: `, ${q}` });
    } else if (canonical === 'watch') {
      // tracedWatch(source, cb, options, label)
      if (args.length >= 3) edits.push({ start: args[args.length - 1].end, end: args[args.length - 1].end, text: `, ${q}` });
      else if (args.length === 2) edits.push({ start: args[1].end, end: args[1].end, text: `, {}, ${q}` });
    }
  });

  if (edits.length === 0) return { code, changed: false };

  // 3. Apply edits right-to-left, then prepend the traced-helper import.
  edits.sort((a, b) => b.start - a.start);
  let out = code;
  for (const e of edits) out = out.slice(0, e.start) + e.text + out.slice(e.end);
  out = `import * as __RG from ${JSON.stringify(importPath)};\n` + out;
  return { code: out, changed: true };
}

function inferLabel(node, parent, canonical, code) {
  if (parent && parent.type === 'VariableDeclarator' && parent.init === node && parent.id.type === 'Identifier') {
    return parent.id.name;
  }
  if (parent && parent.type === 'Property' && parent.value === node && parent.key && parent.key.type === 'Identifier') {
    return parent.key.name;
  }
  const line = lineOf(code, node.start);
  return `${canonical}@L${line}`;
}

function lineOf(code, index) {
  let line = 1;
  for (let i = 0; i < index && i < code.length; i++) if (code[i] === '\n') line++;
  return line;
}

/** Depth-first walk with parent, skipping position/comment fields. */
function walk(node, fn, parent = null) {
  if (!node || typeof node.type !== 'string') return;
  fn(node, parent);
  for (const key of Object.keys(node)) {
    if (key === 'loc' || key === 'start' || key === 'end' || key === 'leadingComments' || key === 'trailingComments' || key === 'range') continue;
    const child = node[key];
    if (Array.isArray(child)) {
      for (const c of child) if (c && typeof c.type === 'string') walk(c, fn, node);
    } else if (child && typeof child.type === 'string') {
      walk(child, fn, node);
    }
  }
}
