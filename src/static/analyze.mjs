// @ts-check
/**
 * Static reactivity analyzer (the TypeScript/JS "mirror" of the croquis Rust
 * pass). Produces the SAME node/edge JSON shape the runtime tracer uses, so the
 * static "map" and the live "traffic" overlay onto one graph (reconciled by
 * label).
 *
 * It answers your core question statically: *which ref / reactive / computed /
 * watch / watchEffect monitor each other on change* — emitted as edges
 * (dependency -> dependent).
 *
 * Pipeline: @vue/compiler-sfc `parse` -> take `<script setup>` -> @babel/parser
 * -> a small hand-rolled walk that:
 *   1. records reactive bindings (const x = ref()/reactive()/computed()...)
 *   2. for each computed/watch/watchEffect, walks its getter/source/body and
 *      collects identifier reads that resolve to a known reactive binding.
 *
 * This mirrors what `vize_croquis`'s effect_graph builder does over OXC — see
 * ../../croquis-rust/. Same contract, two implementations.
 */
import { parse as parseSfc } from '@vue/compiler-sfc';
import { parse as babelParse } from '@babel/parser';

// Recognises both the real Vue factories (what croquis targets in production
// code) and this devtool's traced wrappers (what the demo uses).
const REACTIVE_FACTORY = {
  ref: 'ref', shallowRef: 'ref', toRef: 'ref', customRef: 'ref',
  reactive: 'reactive', shallowReactive: 'reactive',
  computed: 'computed',
  tracedRef: 'ref', tracedShallowRef: 'ref', tracedReactive: 'reactive', tracedComputed: 'computed',
};
const COMPUTED_NAMES = new Set(['computed', 'tracedComputed']);
const WATCH_NAMES = new Set(['watch', 'tracedWatch']);
const WATCHEFFECT_NAMES = new Set(['watchEffect', 'tracedWatchEffect']);

/**
 * @param {string} source raw .vue file contents
 * @param {string} [filename]
 * @returns {{nodes:Array<{id:string,label:string,kind:string,origin:'static'}>, edges:Array<{from:string,to:string,key?:string,origin:'static'}>}}
 */
export function analyzeSfc(source, filename = 'Anon.vue') {
  const { descriptor } = parseSfc(source, { filename });
  const script = descriptor.scriptSetup || descriptor.script;
  if (!script) return { nodes: [], edges: [] };
  return analyzeScript(script.content);
}

/** @param {string} code */
export function analyzeScript(code) {
  const ast = babelParse(code, {
    sourceType: 'module',
    plugins: ['typescript', 'jsx', 'topLevelAwait'],
  });

  /** @type {Map<string,{id:string,kind:string}>} name -> node */
  const bindings = new Map();
  const nodes = [];
  const edges = new Map();
  let anon = 0;

  const nodeId = (label) => `static:${label}`;
  const addNode = (label, kind) => {
    if (!nodes.find((n) => n.id === nodeId(label))) {
      nodes.push({ id: nodeId(label), label, kind, origin: 'static' });
    }
    return nodeId(label);
  };
  const addEdge = (fromLabel, toId, key, kind = 'read') => {
    const from = nodeId(fromLabel);
    if (from === toId) return;
    const k = `${from}->${toId}${key ? '#' + key : ''}#${kind}`;
    if (!edges.has(k)) edges.set(k, { from, to: toId, key, origin: 'static', kind });
  };

  // ---- pass 1: collect reactive bindings from top-level declarations -----
  for (const stmt of ast.program.body) {
    const decl = stmt.type === 'VariableDeclaration' ? stmt
      : stmt.type === 'ExportNamedDeclaration' && stmt.declaration?.type === 'VariableDeclaration' ? stmt.declaration
      : null;
    if (!decl) continue;
    for (const d of decl.declarations) {
      if (d.id.type !== 'Identifier' || d.init?.type !== 'CallExpression') continue;
      const callee = calleeName(d.init.callee);
      const kind = callee && REACTIVE_FACTORY[callee];
      if (!kind) continue;
      const label = d.id.name;
      const id = addNode(label, kind === 'computed' ? 'computed' : kind);
      bindings.set(label, { id, kind: kind === 'computed' ? 'computed' : kind });
    }
  }

  // ---- pass 2: build edges for every effect (computed / watch / watchEffect)
  // computed getters
  for (const stmt of ast.program.body) {
    const decl = stmt.type === 'VariableDeclaration' ? stmt
      : stmt.type === 'ExportNamedDeclaration' && stmt.declaration?.type === 'VariableDeclaration' ? stmt.declaration
      : null;
    if (!decl) continue;
    for (const d of decl.declarations) {
      if (d.id.type !== 'Identifier' || d.init?.type !== 'CallExpression') continue;
      if (!COMPUTED_NAMES.has(calleeName(d.init.callee))) continue;
      const toId = nodeId(d.id.name);
      const getter = d.init.arguments[0];
      for (const dep of readsIn(getter, bindings)) addEdge(dep.label, toId, dep.key);
    }
  }

  // watch / watchEffect calls (as expression statements)
  walk(ast.program, (node) => {
    if (node.type !== 'CallExpression') return;
    const name = calleeName(node.callee);
    if (WATCHEFFECT_NAMES.has(name)) {
      // label: explicit string (traced style) or line-based for plain code
      const label = stringArg(node.arguments[1]) || `watchEffect@L${node.loc?.start.line ?? ++anon}`;
      const toId = addNode(label, 'watchEffect');
      // body reads -> read edges; body writes -> write edges (mirrors runtime)
      for (const dep of readsIn(node.arguments[0], bindings)) addEdge(dep.label, toId, dep.key);
      for (const w of writesIn(node.arguments[0], bindings)) addEdge(label, nodeId(w.label), w.key, 'write');
    } else if (WATCH_NAMES.has(name)) {
      const label = stringArg(node.arguments[3]) || `watch@L${node.loc?.start.line ?? ++anon}`;
      const toId = addNode(label, 'watch');
      // source (arg 0) -> read deps; callback (arg 1) writes -> write edges
      for (const dep of readsIn(node.arguments[0], bindings)) addEdge(dep.label, toId, dep.key);
      for (const w of writesIn(node.arguments[1], bindings)) addEdge(label, nodeId(w.label), w.key, 'write');
    }
  });

  return { nodes, edges: [...edges.values()] };
}

// ---- helpers -------------------------------------------------------------

function calleeName(callee) {
  if (!callee) return null;
  if (callee.type === 'Identifier') return callee.name;
  return null;
}

function stringArg(node) {
  return node && node.type === 'StringLiteral' ? node.value : null;
}

/**
 * Collect reads of known reactive bindings inside an expression/function.
 * Returns [{label, key}]. `key` is set for reactive-object member access
 * (state.count -> key "count").
 */
function readsIn(node, bindings) {
  /** @type {Array<{label:string,key?:string}>} */
  const out = [];
  const seen = new Set();
  walk(node, (n, parent) => {
    if (n.type !== 'Identifier') return;
    // skip the property position of a.b (that's not a variable read)
    if (parent && parent.type === 'MemberExpression' && parent.property === n && !parent.computed) {
      return;
    }
    const b = bindings.get(n.name);
    if (!b) return;
    let key;
    if (parent && parent.type === 'MemberExpression' && parent.object === n) {
      if (b.kind === 'reactive' && parent.property.type === 'Identifier' && !parent.computed) {
        key = parent.property.name; // state.count
      }
      // ref.value -> plain dep, no key
    }
    const sig = `${n.name}#${key || ''}`;
    if (seen.has(sig)) return;
    seen.add(sig);
    out.push({ label: n.name, key });
  });
  return out;
}

/**
 * Collect writes to known reactive bindings (assignments / updates).
 * `x.value = ...` / `x.value++` -> {label:'x'}; `state.k = ...` -> {label:'state', key:'k'}.
 */
function writesIn(node, bindings) {
  /** @type {Array<{label:string,key?:string}>} */
  const out = [];
  const seen = new Set();
  walk(node, (n) => {
    let target = null;
    if (n.type === 'AssignmentExpression') target = n.left;
    else if (n.type === 'UpdateExpression') target = n.argument;
    if (!target || target.type !== 'MemberExpression' || target.object.type !== 'Identifier') return;
    const b = bindings.get(target.object.name);
    if (!b) return;
    let key;
    if (b.kind === 'reactive' && target.property.type === 'Identifier' && !target.computed) key = target.property.name;
    const sig = `${target.object.name}#${key || ''}`;
    if (seen.has(sig)) return;
    seen.add(sig);
    out.push({ label: target.object.name, key });
  });
  return out;
}

/** Minimal AST walker (depth-first), calls fn(node, parent). */
function walk(node, fn, parent = null) {
  if (!node || typeof node.type !== 'string') return;
  fn(node, parent);
  for (const key of Object.keys(node)) {
    if (key === 'loc' || key === 'start' || key === 'end' || key === 'leadingComments' || key === 'trailingComments') continue;
    const child = node[key];
    if (Array.isArray(child)) {
      for (const c of child) if (c && typeof c.type === 'string') walk(c, fn, node);
    } else if (child && typeof child.type === 'string') {
      walk(child, fn, node);
    }
  }
}
