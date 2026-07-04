// @ts-check
/**
 * Runtime reactivity tracer.
 *
 * Thin instrumented wrappers around Vue's reactivity primitives. Each wrapper:
 *   1. registers a node in the shared graph,
 *   2. tags the underlying reactive object with a stable id so it can be
 *      identified when it shows up as `event.target` in a debugger hook,
 *   3. attaches `onTrack` (edge discovery) and `onTrigger` (propagation pulse).
 *
 * Discovery is fully automatic: you never declare edges. `onTrack` tells us
 * exactly which dependency an effect read; `onTrigger` tells us which effect
 * just re-ran and (often) what changed. See `graph.onEffectFired` for how the
 * cascade is reconstructed.
 *
 * NOTE: `onTrack`/`onTrigger` are dev-only in Vue (stripped in production
 * builds). This is a devtool, so that is exactly what we want.
 */
import {
  ref, shallowRef, reactive, shallowReactive, readonly, shallowReadonly, customRef,
  computed, watch, watchEffect, watchPostEffect, watchSyncEffect,
} from 'vue';
import { graph } from './graph.js';

let seq = 0;
/**
 * Get an id for a node: reuse the id the static analyzer already registered for
 * this label (so runtime confirms & animates the static map), else mint a new
 * one.
 */
const nid = (kind, label) => graph.claimId(label) || `${kind}:${++seq}`;

/** Tag an object with a non-enumerable id so we can identify it later. */
function tag(obj, id) {
  try {
    Object.defineProperty(obj, '__vgId', { value: id, enumerable: false, configurable: true });
  } catch {
    /* frozen / primitive — ignore */
  }
  return obj;
}

/** Resolve a debugger event target back to a graph node id, if known. */
function resolveTarget(target) {
  return target && typeof target === 'object' && '__vgId' in target ? target.__vgId : undefined;
}

// External reactive auto-registration: any reactive object read/triggered inside
// instrumented code but that we did NOT create (Pinia store state, VueUse refs,
// the reactive route, etc.) gets a node keyed by object identity. This is what
// lets the graph include library/store state without transforming node_modules.
const externalIds = new WeakMap();
let extSeq = 0;
function resolveOrRegister(target) {
  if (!target || typeof target !== 'object') return undefined;
  if ('__vgId' in target) return target.__vgId; // one of ours
  let id = externalIds.get(target);
  if (id) return id;
  const ctor = target.constructor && target.constructor.name;
  const kind = ctor === 'ComputedRefImpl' ? 'computed' : (target.__v_isRef ? 'ref' : 'reactive');
  id = `external:${++extSeq}`;
  externalIds.set(target, id);
  graph.addNode(id, `⟨ext⟩ ${kind}${extSeq}`, kind, 'runtime');
  return id;
}

/** Normalise a debugger event key ('value' for refs -> undefined). */
function keyOf(e) {
  if (e.key === undefined || e.key === 'value') return undefined;
  return typeof e.key === 'symbol' ? String(e.key) : String(e.key);
}

// --- write detection ------------------------------------------------------
// The effect (watch / watchEffect) currently executing. A reactive *write* that
// happens while an effect runs is attributed to that effect as a `write` edge
// (effect -> the reactive it mutates). This is what makes two-way sync show up
// as a real loop: celsius -> c2f -> fahrenheit -> f2c -> celsius.
let currentEffect = null;
function runInEffect(id, fn) {
  const prev = currentEffect;
  currentEffect = id;
  try { return fn(); } finally { currentEffect = prev; }
}

/**
 * Wrap a ref/reactive so that assignments made *inside an effect* record a
 * write-edge. Reads/tracking pass straight through (debugger events still see
 * the tagged underlying object, so node identity is unchanged).
 * @param {object} obj  the real ref or reactive proxy
 * @param {string} nodeId
 * @param {boolean} isRefValue  true for refs (intercept `.value`), false for reactive (intercept keys)
 */
function writeProxy(obj, nodeId, isRefValue) {
  return new Proxy(obj, {
    get(t, k, r) { return Reflect.get(t, k, r); },
    set(t, k, v, r) {
      if (currentEffect && (isRefValue ? k === 'value' : typeof k !== 'symbol')) {
        graph.addEdge(currentEffect, nodeId, isRefValue ? undefined : String(k), 'runtime', 'write');
      }
      return Reflect.set(t, k, v, r);
    },
  });
}

/** Build the onTrack/onTrigger option pair for an effect node. */
function hooks(id) {
  return {
    onTrack(e) {
      const src = resolveOrRegister(e.target);
      if (src) graph.addEdge(src, id, keyOf(e), 'runtime', 'read');
    },
    onTrigger(e) {
      graph.onTrigger(id, resolveOrRegister(e.target));
    },
  };
}

/**
 * @template T
 * @param {T} value
 * @param {string} label
 */
export function tracedRef(value, label) {
  const r = ref(value);
  const id = nid('ref', label);
  tag(r, id);
  graph.addNode(id, label, 'ref', 'runtime');
  return writeProxy(r, id, true);
}

/**
 * @template T
 * @param {T} value
 * @param {string} label
 */
export function tracedShallowRef(value, label) {
  const r = shallowRef(value);
  const id = nid('ref', label);
  tag(r, id);
  graph.addNode(id, label, 'ref', 'runtime');
  return writeProxy(r, id, true);
}

/**
 * @template {object} T
 * @param {T} target
 * @param {string} label
 */
export function tracedReactive(target, label) {
  const id = nid('reactive', label);
  tag(target, id); // tag the RAW object: debugger events report the raw target
  const r = reactive(target);
  graph.addNode(id, label, 'reactive', 'runtime');
  return writeProxy(r, id, false);
}

/**
 * @template T
 * @param {(() => T) | { get: () => T, set: (v: T) => void }} getterOrOptions
 * @param {string} label
 */
export function tracedComputed(getterOrOptions, label) {
  const id = nid('computed', label);
  let arg = getterOrOptions;
  // Writable computed: run the setter inside the effect context so that any
  // reactive it writes becomes a write-edge (computed -> written reactive).
  if (getterOrOptions && typeof getterOrOptions === 'object' && typeof getterOrOptions.get === 'function') {
    const { get, set } = getterOrOptions;
    arg = { get, set: typeof set === 'function' ? (v) => runInEffect(id, () => set(v)) : undefined };
  }
  const c = computed(arg, hooks(id));
  tag(c, id);
  graph.addNode(id, label, 'computed', 'runtime');
  return c;
}

/**
 * @param {any} source
 * @param {(...a: any[]) => any} cb
 * @param {object} [options]
 * @param {string} [label]
 */
export function tracedWatch(source, cb, options = {}, label = 'watch') {
  const id = nid('watch', label);
  graph.addNode(id, label, 'watch', 'runtime');
  // run the callback inside the effect context so its reactive writes -> write-edges
  return watch(source, (...a) => runInEffect(id, () => cb(...a)), { ...options, ...hooks(id) });
}

/**
 * @param {(onCleanup: (fn: () => void) => void) => void} fn
 * @param {string} [label]
 * @param {object} [options]
 */
export function tracedWatchEffect(fn, label = 'watchEffect', options = {}) {
  const id = nid('watchEffect', label);
  graph.addNode(id, label, 'watchEffect', 'runtime');
  // body reads -> read-edges (via onTrack); body writes -> write-edges (via proxy)
  return watchEffect((onCleanup) => runInEffect(id, () => fn(onCleanup)), { ...options, ...hooks(id) });
}

/** readonly()/shallowReadonly(): read-only state nodes (no write proxy). */
export function tracedReadonly(target, label) {
  const id = nid('reactive', label);
  tag(target, id);
  const r = readonly(target);
  graph.addNode(id, label, 'reactive', 'runtime');
  return r;
}
export function tracedShallowReadonly(target, label) {
  const id = nid('reactive', label);
  tag(target, id);
  const r = shallowReadonly(target);
  graph.addNode(id, label, 'reactive', 'runtime');
  return r;
}

/**
 * customRef(): tagged as a ref node. NOTE: Vue does not expose the target in
 * customRef's onTrack (verified), so *incoming* read-edges to a customRef can't
 * be attributed automatically — it appears as a node and its writes/cascade
 * still work, but consumers reading it may not draw an edge. Documented gap.
 */
export function tracedCustomRef(factory, label) {
  const r = customRef(factory);
  const id = nid('ref', label);
  tag(r, id);
  graph.addNode(id, label, 'ref', 'runtime');
  return writeProxy(r, id, true);
}

/** watchPostEffect()/watchSyncEffect(): flush-timing variants of watchEffect. */
export function tracedWatchPostEffect(fn, label = 'watchPostEffect', options = {}) {
  const id = nid('watchEffect', label);
  graph.addNode(id, label, 'watchEffect', 'runtime');
  return watchPostEffect((oc) => runInEffect(id, () => fn(oc)), { ...options, ...hooks(id) });
}
export function tracedWatchSyncEffect(fn, label = 'watchSyncEffect', options = {}) {
  const id = nid('watchEffect', label);
  graph.addNode(id, label, 'watchEffect', 'runtime');
  return watchSyncEffect((oc) => runInEffect(id, () => fn(oc)), { ...options, ...hooks(id) });
}

export { graph };
