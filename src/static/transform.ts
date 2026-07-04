/**
 * Build-time reactivity transform.
 *
 * Rewrites Vue reactivity calls into their *traced* equivalents at compile time,
 * so you get the full dependency graph with ZERO source changes — no manual
 * `tracedRef`, no mixin. Labels are inferred from the assigned variable name (or
 * a source position for anonymous watch/watchEffect).
 *
 *   const count = ref(0)            ->  const count = __RG.tracedRef(0, "count")
 *   const dbl = computed(() => ...)  ->  const dbl = __RG.tracedComputed(() => ..., "dbl")
 *   watch(src, cb)                   ->  __RG.tracedWatch(src, cb, {}, "watch@L12")
 *   watchEffect(fn)                  ->  __RG.tracedWatchEffect(fn, "watchEffect@L14")
 *
 * Parsed with the real oxc (`oxc-parser`, the same engine croquis is built on) —
 * not a Babel reimplementation. Only identifiers actually imported from
 * 'vue' / '@vue/reactivity' are touched, so unrelated locals named `ref` are safe.
 * oxc spans are UTF-16 offsets, so string slicing stays correct with non-ASCII source.
 */
import { parseSync } from 'oxc-parser';

type AnyNode = any;

/** canonical factory -> traced helper name */
const TRACED: Record<string, string> = {
  ref: 'tracedRef', shallowRef: 'tracedShallowRef',
  reactive: 'tracedReactive', shallowReactive: 'tracedReactive',
  readonly: 'tracedReadonly', shallowReadonly: 'tracedShallowReadonly',
  computed: 'tracedComputed', customRef: 'tracedCustomRef',
  toRef: 'tracedToRef', toRefs: 'tracedToRefs',
  provide: 'tracedProvide', inject: 'tracedInject',
  watch: 'tracedWatch', watchEffect: 'tracedWatchEffect',
  watchPostEffect: 'tracedWatchPostEffect', watchSyncEffect: 'tracedWatchSyncEffect',
};
const REFLIKE = new Set(['ref', 'shallowRef', 'reactive', 'shallowReactive', 'readonly', 'shallowReadonly', 'computed', 'customRef', 'toRef', 'toRefs']);
const WATCHEFFECTS = new Set(['watchEffect', 'watchPostEffect', 'watchSyncEffect']);
const SOURCES = new Set(['vue', '@vue/reactivity']);

export interface TransformResult { code: string; changed: boolean }

export function transformReactivity(code: string, _filename = 'anon.js', opts: { importPath?: string } = {}): TransformResult {
  const importPath = opts.importPath || 'virtual:reactivity-graph/runtime';
  let program: AnyNode;
  try {
    const r = parseSync('module.tsx', code, { sourceType: 'module', lang: 'tsx' });
    program = typeof (r as any).program === 'string' ? JSON.parse((r as any).program) : (r as any).program;
  } catch {
    return { code, changed: false };
  }

  // 1. Which local names are Vue reactivity factories?
  const factories = new Map<string, string>(); // localName -> canonical
  for (const stmt of program.body as AnyNode[]) {
    if (stmt.type !== 'ImportDeclaration' || !SOURCES.has(stmt.source.value)) continue;
    for (const spec of stmt.specifiers || []) {
      if (spec.type === 'ImportSpecifier' && spec.imported.type === 'Identifier') {
        const canonical = spec.imported.name;
        if (TRACED[canonical]) factories.set(spec.local.name, canonical);
      }
    }
  }
  if (factories.size === 0) return { code, changed: false };

  // 2. Collect edits (rename callee + insert label arg).
  const edits: Array<{ start: number; end: number; text: string }> = [];
  walk(program, (node: AnyNode, parent: AnyNode) => {
    if (node.type !== 'CallExpression' || node.callee.type !== 'Identifier') return;
    const canonical = factories.get(node.callee.name);
    if (!canonical) return;

    const label = inferLabel(node, parent, canonical, code);
    const q = JSON.stringify(label);

    edits.push({ start: node.callee.start, end: node.callee.end, text: `__RG.${TRACED[canonical]}` });

    const args = node.arguments;
    if (REFLIKE.has(canonical)) {
      if (args.length) edits.push({ start: args[args.length - 1].end, end: args[args.length - 1].end, text: `, ${q}` });
      else edits.push({ start: node.end - 1, end: node.end - 1, text: `undefined, ${q}` });
    } else if (WATCHEFFECTS.has(canonical)) {
      if (args.length) edits.push({ start: args[0].end, end: args[0].end, text: `, ${q}` });
    } else if (canonical === 'watch') {
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

function inferLabel(node: AnyNode, parent: AnyNode, canonical: string, code: string): string {
  if (parent && parent.type === 'VariableDeclarator' && parent.init === node && parent.id.type === 'Identifier') {
    return parent.id.name;
  }
  if (parent && parent.type === 'Property' && parent.value === node && parent.key && parent.key.type === 'Identifier') {
    return parent.key.name;
  }
  return `${canonical}@L${lineOf(code, node.start)}`;
}

function lineOf(code: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index && i < code.length; i++) if (code[i] === '\n') line++;
  return line;
}

/** Depth-first walk with parent, skipping position/comment fields. */
function walk(node: AnyNode, fn: (n: AnyNode, parent: AnyNode) => void, parent: AnyNode = null): void {
  if (!node || typeof node.type !== 'string') return;
  fn(node, parent);
  for (const key of Object.keys(node)) {
    if (key === 'loc' || key === 'start' || key === 'end' || key === 'range' || key === 'leadingComments' || key === 'trailingComments') continue;
    const child = (node as AnyNode)[key];
    if (Array.isArray(child)) {
      for (const c of child) if (c && typeof c.type === 'string') walk(c, fn, node);
    } else if (child && typeof child.type === 'string') {
      walk(child, fn, node);
    }
  }
}
