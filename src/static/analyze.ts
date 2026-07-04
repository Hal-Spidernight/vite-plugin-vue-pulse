/**
 * Static reactivity analyzer — built on the REAL croquis / vize toolchain, not a
 * reimplementation.
 *
 *   - SFC splitting:      `vize` (@vizejs/native) `parseSfc`  ← real croquis
 *   - script JS/TS AST:   `oxc-parser` `parseSync`            ← the same oxc croquis is built on
 *   - template deps:      croquis `parseTemplate` gives the tag tree but its napi
 *                         AST collapses nested children to counts, so template
 *                         binding-expressions are located from the template text
 *                         and parsed with the SAME oxc.
 *
 * The only bespoke layer is the effect-graph EDGE builder — i.e. which computed /
 * watch / watchEffect / template reads which reactive. That is exactly the piece
 * croquis does not expose (its `effect_graph.rs` has the model + `find_cycle` but
 * no builder — issue #695); everything upstream of it is the real croquis/oxc.
 *
 * Emits the SAME node/edge shape the runtime tracer uses (see
 * `../reactivity-graph/types.ts`), so the static "map" and the live "traffic"
 * overlay onto one graph, reconciled by label.
 */
import { parseSync } from 'oxc-parser';
import * as vize from '@vizejs/native';
import type { NodeKind, EdgeKind, ReactivityGraphExport } from '../reactivity-graph/types.js';

const parseSfc = (vize as any).parseSfc;

type AnyNode = any;
interface Binding { id: string; kind: string }
interface Read { label: string; key?: string }

// Recognises both the real Vue factories (what croquis targets in production
// code) and this devtool's traced wrappers (what the demo uses).
const REACTIVE_FACTORY: Record<string, string> = {
  ref: 'ref', shallowRef: 'ref', toRef: 'ref', customRef: 'ref',
  reactive: 'reactive', shallowReactive: 'reactive',
  computed: 'computed',
  // compiler macros (no import): defineModel() is a writable ref backed by a prop
  defineModel: 'ref',
  tracedRef: 'ref', tracedShallowRef: 'ref', tracedReactive: 'reactive', tracedComputed: 'computed',
  tracedToRef: 'ref', tracedCustomRef: 'ref',
};
/** factories whose result is an object of refs to destructure (const {a,b} = f(src)) */
const DESTRUCTURE_FACTORY = new Set(['toRefs', 'storeToRefs', 'tracedToRefs', 'defineProps']);
const COMPUTED_NAMES = new Set(['computed', 'tracedComputed']);
const WATCH_NAMES = new Set(['watch', 'tracedWatch']);
const WATCHEFFECT_NAMES = new Set(['watchEffect', 'tracedWatchEffect', 'watchPostEffect', 'tracedWatchPostEffect', 'watchSyncEffect', 'tracedWatchSyncEffect']);
/** array/collection mutating methods -> a write to the receiver binding */
const MUTATING_METHODS = new Set(['push', 'pop', 'shift', 'unshift', 'splice', 'sort', 'reverse', 'fill', 'copyWithin', 'set', 'add', 'delete', 'clear']);

/** Parse JS/TS to an ESTree program with the real oxc (croquis's parser). */
function parseModule(code: string): AnyNode {
  const r = parseSync('module.ts', code, { sourceType: 'module', lang: 'ts' });
  const program: any = (r as any).program;
  return typeof program === 'string' ? JSON.parse(program) : program;
}

export function analyzeSfc(source: string, filename = 'Anon.vue'): ReactivityGraphExport {
  const desc: AnyNode = parseSfc(source, { filename });
  // Analyze BOTH <script setup> and a plain <script> (defineOptions/name pattern).
  const parts = [desc?.scriptSetup?.content, desc?.script?.content].filter(Boolean) as string[];
  const script = parts.join('\n');
  const componentLabel = `<${String(filename).split('/').pop()!.replace(/\.\w+$/, '')}>`;

  // Prefer the REAL croquis effect-graph builder when the installed
  // @vizejs/native exposes it (analyzeReactivity, added upstream for issue #695):
  // nodes + edges come straight from croquis, and this file is just the adapter.
  // Falls back to the local oxc analyzer when the napi isn't available yet.
  const analyzeReactivity = (vize as any).analyzeReactivity;
  if (typeof analyzeReactivity === 'function') {
    try {
      return adaptCroquisGraph(analyzeReactivity(script), { template: desc?.template?.content, componentLabel });
    } catch { /* fall through to the local analyzer */ }
  }
  return analyzeScript(script, { template: desc?.template?.content, componentLabel });
}

/**
 * Adapt croquis' `analyzeReactivity` output ({nodes,edges,cycle}) to our graph
 * schema. Croquis authoritatively classifies the nodes and wires script edges;
 * template→component edges are added here (croquis' builder is script-only).
 */
function adaptCroquisGraph(g: any, opts: AnalyzeOptions = {}): ReactivityGraphExport {
  const nodeId = (label: string) => `static:${label}`;
  const nodes: Array<{ id: string; label: string; kind: NodeKind; origin: 'static' }> = [];
  const seenNode = new Set<string>();
  const bindings = new Map<string, Binding>();
  for (const n of g.nodes || []) {
    if (seenNode.has(n.id ?? n.label)) continue;
    seenNode.add(n.id ?? n.label);
    nodes.push({ id: nodeId(n.label), label: n.label, kind: n.kind as NodeKind, origin: 'static' });
    bindings.set(n.label, { id: nodeId(n.label), kind: n.kind });
  }
  const edges = new Map<string, { from: string; to: string; key?: string; origin: 'static'; kind: EdgeKind }>();
  const addEdge = (from: string, toId: string, key: string | undefined, kind: EdgeKind) => {
    if (from === toId) return;
    const k = `${from}->${toId}${key ? '#' + key : ''}#${kind}`;
    if (!edges.has(k)) edges.set(k, { from, to: toId, key, origin: 'static', kind });
  };
  for (const e of g.edges || []) addEdge(nodeId(e.from), nodeId(e.to), undefined, (e.kind || 'read') as EdgeKind);

  // template deps -> component render node (same oxc pass as the fallback path)
  if (opts.template) {
    const compLabel = opts.componentLabel || '<Component>';
    let created = false;
    for (const expr of templateExpressions(opts.template)) {
      let sub: AnyNode;
      try { sub = parseModule(`(${expr});`); } catch { continue; }
      for (const dep of readsIn(sub, bindings)) {
        if (!created) { nodes.push({ id: nodeId(compLabel), label: compLabel, kind: 'component', origin: 'static' }); created = true; }
        addEdge(nodeId(dep.label), nodeId(compLabel), dep.key, 'read');
      }
    }
  }
  return { nodes, edges: [...edges.values()] };
}

export interface AnalyzeOptions {
  /** raw <template> content — reads inside it become `dep -> <Component>` edges */
  template?: string;
  /** label for the component render node (defaults to a generic name) */
  componentLabel?: string;
}

export function analyzeScript(code: string, opts: AnalyzeOptions = {}): ReactivityGraphExport {
  const ast = code.trim() ? parseModule(code) : { body: [] };

  const bindings = new Map<string, Binding>();
  const nodes: Array<{ id: string; label: string; kind: NodeKind; origin: 'static' }> = [];
  const edges = new Map<string, { from: string; to: string; key?: string; origin: 'static'; kind: EdgeKind }>();
  let anon = 0;

  const nodeId = (label: string) => `static:${label}`;
  const addNode = (label: string, kind: string): string => {
    if (!nodes.find((n) => n.id === nodeId(label))) {
      nodes.push({ id: nodeId(label), label, kind: kind as NodeKind, origin: 'static' });
    }
    return nodeId(label);
  };
  const addEdge = (fromLabel: string, toId: string, key: string | undefined, kind: EdgeKind = 'read') => {
    const from = nodeId(fromLabel);
    if (from === toId) return;
    const k = `${from}->${toId}${key ? '#' + key : ''}#${kind}`;
    if (!edges.has(k)) edges.set(k, { from, to: toId, key, origin: 'static', kind });
  };

  // ---- pass 1: collect reactive bindings from top-level declarations -----
  for (const stmt of ast.body as AnyNode[]) {
    const decl = stmt.type === 'VariableDeclaration' ? stmt
      : stmt.type === 'ExportNamedDeclaration' && stmt.declaration?.type === 'VariableDeclaration' ? stmt.declaration
      : null;
    if (!decl) continue;
    for (const d of decl.declarations) {
      if (d.init?.type !== 'CallExpression') continue;
      const callee = calleeName(d.init.callee);

      // destructured refs: const { a, b } = toRefs(src) / storeToRefs / defineProps
      if (d.id.type === 'ObjectPattern' && callee && DESTRUCTURE_FACTORY.has(callee)) {
        const srcArg = d.init.arguments[0];
        const srcName = srcArg && srcArg.type === 'Identifier' ? srcArg.name : null;
        for (const prop of d.id.properties) {
          if (prop.type !== 'Property' || prop.key.type !== 'Identifier') continue;
          const local = prop.value.type === 'Identifier' ? prop.value.name : prop.key.name;
          const id = addNode(local, 'ref');
          bindings.set(local, { id, kind: 'ref' });
          if (srcName) addEdge(srcName, id, prop.key.name); // source.key -> destructured ref
        }
        continue;
      }

      if (d.id.type !== 'Identifier') continue;
      const kind = callee && REACTIVE_FACTORY[callee];
      if (!kind) continue;
      const label = d.id.name;
      const id = addNode(label, kind === 'computed' ? 'computed' : kind);
      bindings.set(label, { id, kind: kind === 'computed' ? 'computed' : kind });

      // toRef(source, 'key') -> source.key -> this ref edge (the derivation linkage)
      if (callee === 'toRef' || callee === 'tracedToRef') {
        const srcArg = d.init.arguments[0];
        const keyArg = d.init.arguments[1];
        if (srcArg && srcArg.type === 'Identifier') {
          const key = keyArg && keyArg.type === 'Literal' && typeof keyArg.value === 'string' ? keyArg.value : undefined;
          addEdge(srcArg.name, id, key);
        }
      }
    }
  }

  // ---- pass 2: build edges for every effect (computed / watch / watchEffect)
  for (const stmt of ast.body as AnyNode[]) {
    const decl = stmt.type === 'VariableDeclaration' ? stmt
      : stmt.type === 'ExportNamedDeclaration' && stmt.declaration?.type === 'VariableDeclaration' ? stmt.declaration
      : null;
    if (!decl) continue;
    for (const d of decl.declarations) {
      if (d.id.type !== 'Identifier' || d.init?.type !== 'CallExpression') continue;
      if (!COMPUTED_NAMES.has(calleeName(d.init.callee)!)) continue;
      const toId = nodeId(d.id.name);
      const getter = d.init.arguments[0];
      for (const dep of readsIn(getter, bindings)) addEdge(dep.label, toId, dep.key);
      // writable computed: { get, set } — writes in `set` become write-edges
      if (getter && getter.type === 'ObjectExpression') {
        const setProp = getter.properties.find((p: AnyNode) => p.type === 'Property' && p.key.type === 'Identifier' && p.key.name === 'set');
        if (setProp) for (const w of writesIn(setProp.value, bindings)) addEdge(d.id.name, nodeId(w.label), w.key, 'write');
      }
    }
  }

  // watch / watchEffect calls (anywhere)
  walk(ast, (node: AnyNode) => {
    if (node.type !== 'CallExpression') return;
    const name = calleeName(node.callee);
    if (name && WATCHEFFECT_NAMES.has(name)) {
      const label = stringArg(node.arguments[1]) || `watchEffect@L${lineOf(code, node.start) || ++anon}`;
      const toId = addNode(label, 'watchEffect');
      for (const dep of readsIn(node.arguments[0], bindings)) addEdge(dep.label, toId, dep.key);
      for (const w of writesIn(node.arguments[0], bindings)) addEdge(label, nodeId(w.label), w.key, 'write');
    } else if (name && WATCH_NAMES.has(name)) {
      const label = stringArg(node.arguments[3]) || `watch@L${lineOf(code, node.start) || ++anon}`;
      const toId = addNode(label, 'watch');
      for (const dep of readsIn(node.arguments[0], bindings)) addEdge(dep.label, toId, dep.key);
      for (const w of writesIn(node.arguments[1], bindings)) addEdge(label, nodeId(w.label), w.key, 'write');
    }
  });

  // ---- template pass: reads in <template> feed the component render effect ---
  if (opts.template) {
    const compLabel = opts.componentLabel || '<Component>';
    let created = false;
    for (const expr of templateExpressions(opts.template)) {
      let sub: AnyNode;
      try { sub = parseModule(`(${expr});`); } catch { continue; }
      for (const dep of readsIn(sub, bindings)) {
        if (!created) { addNode(compLabel, 'component'); created = true; }
        addEdge(dep.label, nodeId(compLabel), dep.key);
      }
    }
  }

  return { nodes, edges: [...edges.values()] };
}

// ---- helpers -------------------------------------------------------------

function calleeName(callee: AnyNode): string | null {
  return callee && callee.type === 'Identifier' ? callee.name : null;
}

function stringArg(node: AnyNode): string | null {
  return node && node.type === 'Literal' && typeof node.value === 'string' ? node.value : null;
}

/**
 * Collect reads of known reactive bindings inside an expression/function.
 * `key` is set for reactive-object member access (state.count -> key "count").
 */
function readsIn(node: AnyNode, bindings: Map<string, Binding>): Read[] {
  const out: Read[] = [];
  const seen = new Set<string>();
  walk(node, (n: AnyNode, parent: AnyNode) => {
    if (n.type !== 'Identifier') return;
    if (parent && parent.type === 'MemberExpression' && parent.property === n && !parent.computed) return;
    const b = bindings.get(n.name);
    if (!b) return;
    let key: string | undefined;
    if (parent && parent.type === 'MemberExpression' && parent.object === n) {
      if (b.kind === 'reactive' && parent.property.type === 'Identifier' && !parent.computed) key = parent.property.name;
    }
    const sig = `${n.name}#${key || ''}`;
    if (seen.has(sig)) return;
    seen.add(sig);
    out.push({ label: n.name, key });
  });
  return out;
}

/**
 * Collect writes to known reactive bindings. Covers assignment/update on member
 * expressions (x.value=…, state.k++, state.a.b=…) and mutating method calls
 * (list.value.push(x), map.set(k,v)).
 */
function writesIn(node: AnyNode, bindings: Map<string, Binding>): Read[] {
  const out: Read[] = [];
  const seen = new Set<string>();
  const push = (label: string, key?: string) => {
    const sig = `${label}#${key || ''}`;
    if (seen.has(sig)) return;
    seen.add(sig);
    out.push({ label, key });
  };
  walk(node, (n: AnyNode) => {
    let target: AnyNode = null;
    if (n.type === 'AssignmentExpression') target = n.left;
    else if (n.type === 'UpdateExpression') target = n.argument;
    if (target && target.type === 'MemberExpression') {
      const base = rootIdentifier(target);
      const b = base && bindings.get(base.name);
      if (b) {
        let key: string | undefined;
        if (b.kind === 'reactive' && base === target.object && target.property.type === 'Identifier' && !target.computed) key = target.property.name;
        push(base.name, key);
      }
      return;
    }
    if (n.type === 'CallExpression' && n.callee.type === 'MemberExpression' && n.callee.property.type === 'Identifier' && MUTATING_METHODS.has(n.callee.property.name)) {
      const base = rootIdentifier(n.callee);
      const b = base && bindings.get(base.name);
      if (b) push(base.name);
    }
  });
  return out;
}

/** Walk a chain of member expressions down to the root Identifier (a.b.c -> a). */
function rootIdentifier(member: AnyNode): AnyNode {
  let obj = member.object;
  while (obj && obj.type === 'MemberExpression') obj = obj.object;
  return obj && obj.type === 'Identifier' ? obj : null;
}

/**
 * Locate binding-expression regions in template text: mustaches `{{ … }}` and
 * dynamic attribute/directive values (`:x="…"`, `v-if="…"`, `@e="…"`). Minimal
 * region-location only — the expressions themselves are parsed by real oxc.
 * (croquis `parseTemplate` exposes the tag tree but its napi AST collapses nested
 * children to counts, so expression bodies aren't walkable through it.)
 */
function templateExpressions(tpl: string): string[] {
  const out: string[] = [];
  for (const m of tpl.matchAll(/\{\{([\s\S]*?)\}\}/g)) out.push(m[1]);
  for (const m of tpl.matchAll(/(?:\bv-[a-z][\w-]*|:[\w.-]+|@[\w.-]+)\s*=\s*"([^"]*)"/g)) {
    let e = m[1];
    // v-for="(item, i) in list" -> the iterated source
    const forM = /\b(?:in|of)\b([\s\S]+)$/.exec(e);
    if (/^\s*\(?[\w,\s]+\)?\s+(?:in|of)\s/.test(e) && forM) e = forM[1];
    if (e.trim()) out.push(e);
  }
  return out;
}

/** Byte-independent line number (UTF-16 safe) for anonymous effect labels. */
function lineOf(code: string, index: number | undefined): number {
  if (index == null) return 0;
  let line = 1;
  for (let i = 0; i < index && i < code.length; i++) if (code[i] === '\n') line++;
  return line;
}

/** Minimal AST walker (depth-first), calls fn(node, parent). */
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
