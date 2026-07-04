/**
 * Static reactivity analyzer — the "map".
 *
 * Pipeline:
 *   1. split the SFC into `<script>` / `<template>` with `@vizejs/native`'s
 *      `parseSfc` (that's the ONLY thing vize is used for);
 *   2. parse the `<script>` to an ESTree AST with `oxc-parser`;
 *   3. walk it to collect reactive bindings and wire dependency edges — computed
 *      getters / watch sources / watchEffect bodies (reads), watch-callback
 *      assignments (writes).
 *
 * Components are a BOUNDARY, not a node: every node is a declaration /
 * reactivity-API usage, scoped `Comp::label`. Template reads therefore don't
 * create a render node — they flag the declaration with `template: true` — and
 * cross-component flow is wired between real declarations: `<Child :p="expr">`
 * edges into `Child::props` (the child's defineProps declaration), and
 * provide/inject links the provided declaration to the injecting one (resolved
 * across files by `mergeStaticGraphs`).
 *
 * Emits the SAME node/edge shape the runtime tracer uses (see
 * `../reactivity-graph/types.ts`), so the static "map" and the live "traffic"
 * dedup onto one graph by id.
 */
import { parseSync } from 'oxc-parser';
import { parseSfc } from '@vizejs/native';
import type { NodeKind, EdgeKind, ReactivityGraphExport } from '../reactivity-graph/types.js';

type AnyNode = any;
interface Binding { id: string; kind: string; key?: string }
interface Read { label: string; key?: string }

/** One file's analysis + the DI endpoints `mergeStaticGraphs` links across files. */
export interface StaticAnalysis extends ReactivityGraphExport {
  provides?: Array<{ key: string; id: string }>;
  injects?: Array<{ key: string; id: string }>;
}

// Recognises both the real Vue factories and this devtool's traced wrappers.
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
const DESTRUCTURE_FACTORY = new Set(['toRefs', 'storeToRefs', 'tracedToRefs']);
const COMPUTED_NAMES = new Set(['computed', 'tracedComputed']);
const WATCH_NAMES = new Set(['watch', 'tracedWatch']);
const WATCHEFFECT_NAMES = new Set(['watchEffect', 'tracedWatchEffect', 'watchPostEffect', 'tracedWatchPostEffect', 'watchSyncEffect', 'tracedWatchSyncEffect']);
/** array/collection mutating methods -> a write to the receiver binding */
const MUTATING_METHODS = new Set(['push', 'pop', 'shift', 'unshift', 'splice', 'sort', 'reverse', 'fill', 'copyWithin', 'set', 'add', 'delete', 'clear']);

/** Parse JS/TS to an ESTree program with oxc. */
function parseModule(code: string): AnyNode {
  const r = parseSync('module.ts', code, { sourceType: 'module', lang: 'ts' });
  const program: any = (r as any).program;
  return typeof program === 'string' ? JSON.parse(program) : program;
}

export function analyzeSfc(source: string, filename = 'Anon.vue'): StaticAnalysis {
  const desc: AnyNode = parseSfc(source, { filename });
  // Analyze BOTH <script setup> and a plain <script> (defineOptions/name pattern).
  const parts = [desc?.scriptSetup?.content, desc?.script?.content].filter(Boolean) as string[];
  // Component name = filename basename without extension. This MUST match the
  // runtime scope (Vue sets `inst.type.__name` to the same), so static and runtime
  // nodes reconcile instead of duplicating.
  const name = String(filename).split('/').pop()!.replace(/\.\w+$/, '');
  return analyzeScript(parts.join('\n'), { template: desc?.template?.content, scope: name });
}

export interface AnalyzeOptions {
  /** raw <template> content — reads inside it flag the declarations `template: true` */
  template?: string;
  /** component name used to scope node keys (matches the runtime's `inst.type.__name`) */
  scope?: string;
}

export function analyzeScript(code: string, opts: AnalyzeOptions = {}): StaticAnalysis {
  const ast = code.trim() ? parseModule(code) : { body: [] };

  const bindings = new Map<string, Binding>();
  const nodes: Array<{ id: string; label: string; kind: NodeKind; origin: 'static'; scope?: string; template?: boolean }> = [];
  const edges = new Map<string, { from: string; to: string; key?: string; origin: 'static'; kind: EdgeKind }>();
  const provides: Array<{ key: string; id: string }> = [];
  const injects: Array<{ key: string; id: string }> = [];
  // per-kind counters for anonymous watch/watchEffect — order-index labels match
  // the build-time transform's, so static and runtime effects reconcile.
  let anonWatch = 0, anonWatchEffect = 0;

  // Node id = the declaration's deterministic identity, IDENTICAL to what the
  // runtime tracer produces (`Comp::label`, or bare `label` with no scope), so the
  // static map and the live graph dedup to one node each.
  const scopePrefix = opts.scope ? `${opts.scope}::` : '';
  const nodeId = (label: string) => `${scopePrefix}${label}`;
  const addNode = (label: string, kind: string): string => {
    if (!nodes.find((n) => n.id === nodeId(label))) {
      const n: (typeof nodes)[number] = { id: nodeId(label), label, kind: kind as NodeKind, origin: 'static' };
      if (opts.scope) n.scope = opts.scope; // boundary membership, same as the runtime derives
      nodes.push(n);
    }
    return nodeId(label);
  };
  /** a node owned by ANOTHER component's boundary (e.g. `Child::props`) */
  const addForeignNode = (id: string, label: string, kind: NodeKind): string => {
    if (!nodes.find((n) => n.id === id)) {
      const sep = id.indexOf('::');
      const n: (typeof nodes)[number] = { id, label, kind, origin: 'static' };
      if (sep > 0) n.scope = id.slice(0, sep);
      nodes.push(n);
    }
    return id;
  };
  /** resolve a binding name to its node id (destructured defineProps locals all map to `Comp::props`) */
  const idOf = (label: string) => bindings.get(label)?.id ?? nodeId(label);
  const rawEdge = (from: string, to: string, key: string | undefined, kind: EdgeKind = 'read') => {
    if (from === to) return;
    const k = `${from}->${to}${key ? '#' + key : ''}#${kind}`;
    if (!edges.has(k)) edges.set(k, { from, to, key, origin: 'static', kind });
  };
  const addEdge = (fromLabel: string, toId: string, key: string | undefined, kind: EdgeKind = 'read') => {
    rawEdge(idOf(fromLabel), toId, key, kind);
  };

  // ---- pass 0: which template tags are .vue children? (tag -> child scope) ---
  // The child's scope is the import's basename — the same deterministic scope the
  // child's own analysis and runtime use, so `<Child :p="x">` can edge into
  // `Child::props` without reading the child's file.
  const vueImports = new Map<string, string>();
  for (const stmt of ast.body as AnyNode[]) {
    if (stmt.type !== 'ImportDeclaration') continue;
    const src = String(stmt.source?.value || '');
    if (!src.endsWith('.vue')) continue;
    const base = src.split('/').pop()!.replace(/\.\w+$/, '');
    for (const spec of stmt.specifiers || []) {
      if (spec.local?.name) {
        vueImports.set(spec.local.name, base);
        vueImports.set(kebabCase(spec.local.name), base); // <MyChild> and <my-child>
      }
    }
  }

  // ---- pass 1: collect reactive bindings from top-level declarations -----
  for (const stmt of ast.body as AnyNode[]) {
    const decl = stmt.type === 'VariableDeclaration' ? stmt
      : stmt.type === 'ExportNamedDeclaration' && stmt.declaration?.type === 'VariableDeclaration' ? stmt.declaration
      : null;
    if (!decl) continue;
    for (const d of decl.declarations) {
      if (d.init?.type !== 'CallExpression') continue;
      const callee = calleeName(d.init.callee);

      // defineProps IS the declaration: ONE `Comp::props` node, however it's
      // consumed — `const props = defineProps(...)` or destructured locals (which
      // the runtime render tracker also attributes to the props object).
      if (callee === 'defineProps') {
        const id = addNode('props', 'reactive');
        if (d.id.type === 'Identifier') {
          bindings.set(d.id.name, { id, kind: 'reactive' });
        } else if (d.id.type === 'ObjectPattern') {
          for (const prop of d.id.properties) {
            if (prop.type !== 'Property' || prop.key.type !== 'Identifier') continue;
            const local = prop.value.type === 'Identifier' ? prop.value.name : prop.key.name;
            bindings.set(local, { id, kind: 'reactive', key: prop.key.name });
          }
        }
        continue;
      }

      // `const theme = inject('theme')` is a declaration too — its own node, and
      // a DI endpoint mergeStaticGraphs links to the matching provide() cross-file.
      if (d.id.type === 'Identifier' && (callee === 'inject' || callee === 'tracedInject')) {
        const label = d.id.name;
        const id = addNode(label, 'ref');
        bindings.set(label, { id, kind: 'ref' });
        const keyArg = d.init.arguments[callee === 'tracedInject' ? 1 : 0];
        const key = keyArg && keyArg.type === 'Literal' && typeof keyArg.value === 'string' ? keyArg.value : null;
        if (key) injects.push({ key, id });
        continue;
      }

      // destructured refs: const { a, b } = toRefs(src) / storeToRefs
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

  // watch / watchEffect calls (anywhere). Labels: explicit string arg > assigned
  // variable name > order-index (`watch#1` / `watchEffect#1`) — the same scheme the
  // build-time transform uses, so anonymous effects reconcile static<->runtime.
  walk(ast, (node: AnyNode, parent: AnyNode) => {
    if (node.type !== 'CallExpression') return;
    const name = calleeName(node.callee);
    if (name && WATCHEFFECT_NAMES.has(name)) {
      const label = stringArg(node.arguments[1]) || effectVarName(parent, node) || `watchEffect#${++anonWatchEffect}`;
      const toId = addNode(label, 'watchEffect');
      for (const dep of readsIn(node.arguments[0], bindings)) addEdge(dep.label, toId, dep.key);
      for (const w of writesIn(node.arguments[0], bindings)) addEdge(label, nodeId(w.label), w.key, 'write');
    } else if (name && WATCH_NAMES.has(name)) {
      const label = stringArg(node.arguments[3]) || effectVarName(parent, node) || `watch#${++anonWatch}`;
      const toId = addNode(label, 'watch');
      for (const dep of readsIn(node.arguments[0], bindings)) addEdge(dep.label, toId, dep.key);
      for (const w of writesIn(node.arguments[1], bindings)) addEdge(label, nodeId(w.label), w.key, 'write');
    } else if (name === 'provide' || name === 'tracedProvide') {
      // DI endpoint: remember which declaration was provided under which key so
      // mergeStaticGraphs can wire provide -> inject across files.
      const key = stringArg(node.arguments[0]);
      const valArg = node.arguments[1];
      const b = valArg && valArg.type === 'Identifier' ? bindings.get(valArg.name) : undefined;
      if (key && b) provides.push({ key, id: b.id });
    }
  });

  // ---- template pass: components are a boundary, not a node -----------------
  if (opts.template) {
    // 1. a template read flags the declaration as a render dep (`template: true`)
    //    — the runtime's renderTracked sets the same flag; no synthetic node.
    for (const expr of templateExpressions(opts.template)) {
      let sub: AnyNode;
      try { sub = parseModule(`(${expr});`); } catch { continue; }
      for (const dep of readsIn(sub, bindings)) {
        const n = nodes.find((x) => x.id === idOf(dep.label));
        if (n) n.template = true;
      }
    }

    // 2. cross-boundary props flow between REAL declarations: `<Child :p="expr">`
    //    wires expr's deps into the child's defineProps node (`Child::props`);
    //    v-model additionally writes back (`Child::props -> dep`, the update event).
    for (const [tag, child] of vueImports) {
      const childProps = `${child}::props`;
      // attr region = up to the tag's closing `>`, but a `>` INSIDE a quoted
      // attribute value (`:label="a > b"`) must not truncate the match
      for (const m of opts.template.matchAll(new RegExp(`<${tag}\\b((?:[^>"']|"[^"]*"|'[^']*')*)`, 'g'))) {
        const attrs = m[1];
        const found: Array<{ prop: string; expr: string; twoWay: boolean }> = [];
        for (const am of attrs.matchAll(/(?::|v-bind:)([\w-]+)(?:\.[\w.-]+)?\s*=\s*"([^"]*)"/g)) {
          found.push({ prop: camelCase(am[1]), expr: am[2], twoWay: false });
        }
        for (const am of attrs.matchAll(/v-model(?::([\w-]+))?(?:\.[\w.-]+)?\s*=\s*"([^"]*)"/g)) {
          found.push({ prop: camelCase(am[1] || 'modelValue'), expr: am[2], twoWay: true });
        }
        for (const { prop, expr, twoWay } of found) {
          let sub: AnyNode;
          try { sub = parseModule(`(${expr});`); } catch { continue; }
          for (const dep of readsIn(sub, bindings)) {
            addForeignNode(childProps, 'props', 'reactive');
            addEdge(dep.label, childProps, prop);
            if (twoWay) rawEdge(childProps, idOf(dep.label), prop, 'write');
          }
        }
      }
    }
  }

  return { nodes, edges: [...edges.values()], provides, injects };
}

/**
 * Merge per-file analyses into one static graph: dedup nodes by id (OR-ing the
 * template flag), dedup edges, and resolve provide/inject pairs by key into
 * cross-file DI edges (`providedDeclaration -> injectedDeclaration`).
 */
export function mergeStaticGraphs(graphs: StaticAnalysis[]): ReactivityGraphExport {
  const nodes = new Map<string, StaticAnalysis['nodes'][number]>();
  const edges = new Map<string, StaticAnalysis['edges'][number]>();
  const provided = new Map<string, string>();
  const injected: Array<{ key: string; id: string }> = [];
  for (const g of graphs) {
    for (const n of g.nodes) {
      const prev = nodes.get(n.id);
      if (prev) { if (n.template) prev.template = true; }
      else nodes.set(n.id, { ...n });
    }
    for (const e of g.edges) edges.set(`${e.from}->${e.to}#${e.key || ''}#${e.kind || 'read'}`, e);
    for (const p of g.provides || []) if (!provided.has(p.key)) provided.set(p.key, p.id);
    for (const i of g.injects || []) injected.push(i);
  }
  for (const i of injected) {
    const from = provided.get(i.key);
    if (from && from !== i.id) edges.set(`${from}->${i.id}##read`, { from, to: i.id, origin: 'static', kind: 'read' });
  }
  return { nodes: [...nodes.values()], edges: [...edges.values()] };
}

// ---- helpers -------------------------------------------------------------

function calleeName(callee: AnyNode): string | null {
  return callee && callee.type === 'Identifier' ? callee.name : null;
}

function stringArg(node: AnyNode): string | null {
  return node && node.type === 'Literal' && typeof node.value === 'string' ? node.value : null;
}

/** For `const stop = watch(...)`, the assigned variable name (matches the transform's label). */
function effectVarName(parent: AnyNode, node: AnyNode): string | undefined {
  if (parent && parent.type === 'VariableDeclarator' && parent.init === node && parent.id?.type === 'Identifier') return parent.id.name;
  return undefined;
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
    // a destructured defineProps local reads ONE key of `Comp::props`
    let key: string | undefined = b.key;
    if (!key && parent && parent.type === 'MemberExpression' && parent.object === n) {
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
 * region-location only — the expressions themselves are parsed by oxc.
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

/** PascalCase/camelCase -> kebab-case (template tag spelling of an import). */
function kebabCase(s: string): string {
  return s.replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase();
}

/** kebab-case attr -> camelCase prop name (`:model-value` -> `modelValue`). */
function camelCase(s: string): string {
  return s.replace(/-(\w)/g, (_, c: string) => c.toUpperCase());
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
