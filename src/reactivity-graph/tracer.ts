/**
 * Runtime reactivity tracer.
 *
 * Thin instrumented wrappers around Vue's reactivity primitives. Each wrapper:
 *   1. registers a node in the shared graph (scoped to the current component),
 *   2. tags the underlying reactive object with a stable id so it can be
 *      identified when it shows up as `event.target` in a debugger hook,
 *   3. attaches `onTrack` (edge discovery) and `onTrigger` (propagation pulse).
 *
 * Discovery is fully automatic: you never declare edges. `onTrack` tells us
 * exactly which dependency an effect read; `onTrigger` tells us which effect just
 * re-ran and (often) what changed — from which `graph.onTrigger`/`cascadeFrom`
 * reconstruct the cascade.
 *
 * NOTE: `onTrack`/`onTrigger` are dev-only in Vue (stripped in production
 * builds). This is a devtool, so that is exactly what we want.
 */
import {
  ref, shallowRef, reactive, readonly, shallowReadonly, customRef,
  computed, watch, watchEffect, watchPostEffect, watchSyncEffect,
  toRef, toRefs, isReactive, toRaw,
  provide, inject,
  getCurrentInstance, getCurrentScope, onScopeDispose,
} from 'vue';
import type { DebuggerEvent, WatchOptions, WatchStopHandle, Ref, InjectionKey } from 'vue';
import { graph } from './graph.js';
import { ensureComponentNode, providedNodes, keyToString } from './component-scope.js';
import type { NodeKind } from './types.js';

/**
 * Component scope of the current call, derived from the active component instance
 * (traced wrappers run during a component's `setup`). Used to namespace node
 * identity so two components that both declare `count` do NOT collapse into one
 * node. Returns '' outside any component (plain scripts / tests) — then identity
 * falls back to the bare label, preserving the original behaviour.
 */
function scopeOf(): string {
  try {
    const inst = getCurrentInstance();
    if (!inst) return '';
    const t: any = inst.type || {};
    return t.__name || t.name || ('cmp' + inst.uid);
  } catch { return ''; }
}

/**
 * Register a node for `label`, scoped to the current component. The id is the
 * DECLARATION's deterministic identity (`Comp::label`, or bare `label` outside a
 * component) — the exact same string the static analyzer emits — so the static
 * map and this runtime node dedup to ONE node in the graph store (see
 * `graph.addNode`), no matter which is created first. Also arranges teardown:
 * when the owning effect scope is disposed, drop our reference.
 */
function registerNode(kind: NodeKind, label: string): string {
  const scope = scopeOf();
  const id = scope ? `${scope}::${label}` : label;
  graph.addNode(id, label, kind, 'runtime');
  try { if (getCurrentScope()) onScopeDispose(() => graph.removeNode(id)); } catch { /* no active scope */ }
  return id;
}

/** Tag an object with a non-enumerable id so we can identify it later. */
function tag<T extends object>(obj: T, id: string): T {
  try {
    Object.defineProperty(obj, '__vgId', { value: id, enumerable: false, configurable: true });
  } catch {
    /* frozen / primitive — ignore */
  }
  return obj;
}

// External reactive auto-registration: any reactive object read/triggered inside
// instrumented code but that we did NOT create (Pinia store state, VueUse refs,
// the reactive route, etc.) gets a node keyed by object identity. This is what
// lets the graph include library/store state without transforming node_modules.
const externalIds = new WeakMap<object, string>();
let extSeq = 0;
function resolveOrRegister(target: any): string | undefined {
  if (!target || typeof target !== 'object') return undefined;
  if ('__vgId' in target) return target.__vgId as string; // one of ours
  const existing = externalIds.get(target);
  if (existing) return existing;
  const ctor = target.constructor && target.constructor.name;
  const kind: NodeKind = ctor === 'ComputedRefImpl' ? 'computed' : (target.__v_isRef ? 'ref' : 'reactive');
  const id = `external:${++extSeq}`;
  externalIds.set(target, id);
  graph.addNode(id, `⟨ext⟩ ${kind}${extSeq}`, kind, 'runtime');
  return id;
}

/** Normalise a debugger event key ('value' for refs -> undefined). */
export function keyOf(e: DebuggerEvent): string | undefined {
  if (e.key === undefined || e.key === 'value') return undefined;
  return String(e.key);
}

/**
 * Resolve a reactive object (as seen in a debugger event's `target`) to a graph
 * node id — reusing our own node when it's tagged, or auto-registering an
 * external `⟨ext⟩` node otherwise. Public so the component/render tracker can
 * attribute render-effect dependencies to the same nodes.
 */
export function resolveReactiveId(target: any): string | undefined {
  return resolveOrRegister(target);
}

// --- write detection ------------------------------------------------------
// The effect (watch / watchEffect) currently executing. A reactive *write* that
// happens while an effect runs is attributed to that effect as a `write` edge
// (effect -> the reactive it mutates). This is what makes two-way sync show up as
// a real loop: celsius -> c2f -> fahrenheit -> f2c -> celsius.
let currentEffect: string | null = null;
function runInEffect<T>(id: string, fn: () => T): T {
  const prev = currentEffect;
  currentEffect = id;
  try { return fn(); } finally { currentEffect = prev; }
}

// --- deep write capture ---------------------------------------------------
// The top-level writeProxy catches `x.value = …` and `state.key = …`. But a lot
// of real mutation happens *through* a reference: `list.value.push(x)`,
// `map.set(k,v)`, `state.nested.field = y`. Those never trip a top-level set
// trap. When we're inside an effect we therefore wrap the reactive VALUE the
// caller just read and record a write-edge for mutating array/collection methods
// and for nested property assignments — attributing them to the same node.
//
// Safety: wrapping happens ONLY while an effect is running (reads for the
// template / render effect are untouched, so Vue's own tracking & object identity
// are preserved), non-mutating methods are bound to the reactive target so
// collection/array internals keep working, and only genuinely-reactive values are
// wrapped.
const ARR_MUT = new Set(['push', 'pop', 'shift', 'unshift', 'splice', 'sort', 'reverse', 'fill', 'copyWithin']);
const COLL_MUT = new Set(['set', 'add', 'delete', 'clear']);
function isCollection(x: any): boolean {
  return x instanceof Map || x instanceof Set || x instanceof WeakMap || x instanceof WeakSet;
}

function recordWrite(nodeId: string, key: string | undefined): void {
  if (currentEffect) graph.addEdge(currentEffect, nodeId, key, 'runtime', 'write');
}

/** Wrap a reactive value read inside an effect so mutations record write-edges. */
function wrapForWrite(v: any, nodeId: string, path: string): any {
  if (!currentEffect || !v || typeof v !== 'object' || !isReactive(v)) return v;
  const raw = toRaw(v);
  const isArr = Array.isArray(raw);
  const isColl = isCollection(raw);
  if (isArr || isColl) return methodRecorder(v, nodeId, path, isArr, isColl);
  return plainChild(v, nodeId, path);
}

function methodRecorder(v: any, nodeId: string, path: string, isArr: boolean, isColl: boolean): any {
  return new Proxy(v, {
    get(t, k, r) {
      const m = Reflect.get(t, k, r);
      if (typeof m === 'function') {
        if (isArr && typeof k === 'string' && ARR_MUT.has(k)) {
          return (...a: any[]) => { recordWrite(nodeId, path || k); return m.apply(t, a); };
        }
        if (isColl && typeof k === 'string' && COLL_MUT.has(k)) {
          return (...a: any[]) => { recordWrite(nodeId, path || (k === 'clear' ? undefined : String(a[0]))); return m.apply(t, a); };
        }
        return m.bind(t); // reads (map.get/forEach, arr.map/filter, …) keep this = the reactive target
      }
      if (m && typeof m === 'object' && isReactive(m)) return wrapForWrite(m, nodeId, path ? path + '.' + String(k) : String(k));
      return m;
    },
    set(t, k, val, r) {
      if (typeof k !== 'symbol') recordWrite(nodeId, path ? path + '.' + String(k) : String(k));
      return Reflect.set(t, k, val, r);
    },
  });
}

function plainChild(v: any, nodeId: string, path: string): any {
  return new Proxy(v, {
    get(t, k, r) {
      const val = Reflect.get(t, k, r);
      if (val && typeof val === 'object' && isReactive(val)) return wrapForWrite(val, nodeId, path ? path + '.' + String(k) : String(k));
      return val;
    },
    set(t, k, val, r) {
      if (typeof k !== 'symbol') recordWrite(nodeId, path ? path + '.' + String(k) : String(k));
      return Reflect.set(t, k, val, r);
    },
  });
}

/**
 * Wrap a ref/reactive so that assignments made *inside an effect* record a
 * write-edge. Reads pass straight through (debugger events still see the tagged
 * underlying object, so node identity is unchanged); inside an effect, reads of a
 * reactive value are wrapped so through-reference mutations are captured too.
 * @param isRefValue true for refs (intercept `.value`), false for reactive keys
 */
function writeProxy<T extends object>(obj: T, nodeId: string, isRefValue: boolean): T {
  // For a reactive that is *itself* a collection/array (reactive(new Map()),
  // reactive([])), its mutating methods must be wrapped at the top level too.
  const raw: any = !isRefValue ? toRaw(obj) : null;
  const topIsArr = !!raw && Array.isArray(raw);
  const topIsColl = !!raw && isCollection(raw);
  return new Proxy(obj, {
    get(t, k, r) {
      const v = Reflect.get(t, k, r);
      if (!currentEffect) return v;
      if (isRefValue) {
        if (k === 'value' && v && typeof v === 'object') return wrapForWrite(v, nodeId, '');
        return v;
      }
      if (typeof v === 'function' && typeof k === 'string') {
        if (topIsArr && ARR_MUT.has(k)) return (...a: any[]) => { recordWrite(nodeId, k); return v.apply(t, a); };
        if (topIsColl && COLL_MUT.has(k)) return (...a: any[]) => { recordWrite(nodeId, k === 'clear' ? undefined : String(a[0])); return v.apply(t, a); };
        return v;
      }
      if (v && typeof v === 'object' && typeof k !== 'symbol') return wrapForWrite(v, nodeId, String(k));
      return v;
    },
    set(t, k, v, r) {
      if (currentEffect && (isRefValue ? k === 'value' : typeof k !== 'symbol')) {
        graph.addEdge(currentEffect, nodeId, isRefValue ? undefined : String(k), 'runtime', 'write');
      }
      return Reflect.set(t, k, v, r);
    },
  }) as T;
}

/** Build the onTrack/onTrigger option pair for an effect node. */
function hooks(id: string) {
  return {
    onTrack(e: DebuggerEvent) {
      const src = resolveOrRegister(e.target);
      if (src) graph.addEdge(src, id, keyOf(e), 'runtime', 'read');
    },
    onTrigger(e: DebuggerEvent) {
      graph.onTrigger(id, resolveOrRegister(e.target));
    },
  };
}

export function tracedRef<T>(value: T, label: string): Ref<T> {
  const r = ref(value);
  const id = registerNode('ref', label);
  tag(r, id);
  return writeProxy(r, id, true) as unknown as Ref<T>;
}

export function tracedShallowRef<T>(value: T, label: string): Ref<T> {
  const r = shallowRef(value);
  const id = registerNode('ref', label);
  tag(r, id);
  return writeProxy(r, id, true) as unknown as Ref<T>;
}

export function tracedReactive<T extends object>(target: T, label: string): T {
  const id = registerNode('reactive', label);
  tag(target, id); // tag the RAW object: debugger events report the raw target
  const r = reactive(target);
  return writeProxy(r, id, false) as T;
}

type WritableComputedOptions<T> = { get: () => T; set: (v: T) => void };

export function tracedComputed<T>(getterOrOptions: (() => T) | WritableComputedOptions<T>, label: string) {
  const id = registerNode('computed', label);
  let arg: any = getterOrOptions;
  // Writable computed: run the setter inside the effect context so any reactive it
  // writes becomes a write-edge (computed -> written reactive).
  if (getterOrOptions && typeof getterOrOptions === 'object' && typeof (getterOrOptions as any).get === 'function') {
    const { get, set } = getterOrOptions as WritableComputedOptions<T>;
    arg = { get, set: typeof set === 'function' ? (v: T) => runInEffect(id, () => set(v)) : undefined };
  }
  const c = computed(arg, hooks(id));
  tag(c, id);
  return c;
}

export function tracedWatch(source: any, cb: (...a: any[]) => any, options: WatchOptions = {}, label = 'watch'): WatchStopHandle {
  const id = registerNode('watch', label);
  // run the callback inside the effect context so its reactive writes -> write-edges
  return watch(source, (...a: any[]) => runInEffect(id, () => cb(...a)), { ...options, ...hooks(id) });
}

export function tracedWatchEffect(fn: (onCleanup: (fn: () => void) => void) => void, label = 'watchEffect', options: any = {}): WatchStopHandle {
  const id = registerNode('watchEffect', label);
  // body reads -> read-edges (via onTrack); body writes -> write-edges (via proxy)
  return watchEffect((onCleanup) => runInEffect(id, () => fn(onCleanup)), { ...options, ...hooks(id) });
}

/** readonly()/shallowReadonly(): read-only state nodes (no write proxy). */
export function tracedReadonly<T extends object>(target: T, label: string) {
  const id = registerNode('reactive', label);
  tag(target, id);
  return readonly(target);
}
export function tracedShallowReadonly<T extends object>(target: T, label: string) {
  const id = registerNode('reactive', label);
  tag(target, id);
  return shallowReadonly(target);
}

/**
 * customRef(): tagged as a ref node. NOTE: Vue does not expose the target in
 * customRef's onTrack (verified), so *incoming* read-edges to a customRef can't
 * be attributed automatically — it appears as a node and its writes/cascade still
 * work, but consumers reading it may not draw an edge. Documented gap.
 */
export function tracedCustomRef(factory: any, label: string) {
  const r = customRef(factory);
  const id = registerNode('ref', label);
  tag(r, id);
  return writeProxy(r, id, true);
}

/** watchPostEffect()/watchSyncEffect(): flush-timing variants of watchEffect. */
export function tracedWatchPostEffect(fn: (onCleanup: (fn: () => void) => void) => void, label = 'watchPostEffect', options: any = {}): WatchStopHandle {
  const id = registerNode('watchEffect', label);
  return watchPostEffect((oc) => runInEffect(id, () => fn(oc)), { ...options, ...hooks(id) });
}
export function tracedWatchSyncEffect(fn: (onCleanup: (fn: () => void) => void) => void, label = 'watchSyncEffect', options: any = {}): WatchStopHandle {
  const id = registerNode('watchEffect', label);
  return watchSyncEffect((oc) => runInEffect(id, () => fn(oc)), { ...options, ...hooks(id) });
}

/**
 * toRef(source, key[, default]): a writable ref view onto one key of a reactive
 * source. We register it as its own node AND draw the `source -> toRef` read edge
 * (keyed) that makes the derivation visible — the linkage the docs promise.
 * Variadic so the build-time transform can append the label as the last arg for
 * any toRef signature.
 */
export function tracedToRef(...args: any[]) {
  const label = args.pop();
  const source = args[0];
  const key = args[1];
  const r = (toRef as any)(...args);
  const id = registerNode('ref', label);
  tag(r, id);
  const srcId = resolveOrRegister(source);
  if (srcId) graph.addEdge(srcId, id, (key != null && typeof key !== 'function') ? String(key) : undefined, 'runtime', 'read');
  return writeProxy(r, id, true);
}

/**
 * toRefs(source): a plain object of refs, one per key of `source`. Passthrough —
 * each destructured ref reads a key of `source`, so when it is read inside a
 * traced effect Vue's `onTrack` already reports `(source, key)` and the
 * dependency lands on the source reactive's node. (No phantom node is created.)
 */
export function tracedToRefs(source: any, _label?: string) {
  return toRefs(source);
}

/**
 * provide(key, value): remember the provided reactive's node keyed by injection
 * key, so a matching `inject` in a descendant can draw the DI edge.
 */
export function tracedProvide<T>(key: InjectionKey<T> | string | symbol, value: T): void {
  provide(key as any, value);
  const nodeId = resolveOrRegister(value as any);
  if (nodeId) providedNodes.set(keyToString(key), nodeId);
}

/**
 * inject(key[, default[, factory]]): draw a `providedReactive -> <ThisComponent>`
 * DI edge so cross-component dependency-injection shows up in the graph. Variadic
 * to pass through inject's default/factory overloads.
 */
export function tracedInject(...args: any[]): any {
  const key = args[0];
  const v = (inject as any)(...args);
  const nodeId = providedNodes.get(keyToString(key)) ?? resolveOrRegister(v);
  const inst = getCurrentInstance();
  if (nodeId && inst) graph.addEdge(nodeId, ensureComponentNode(inst), undefined, 'runtime', 'read');
  return v;
}

export { graph };
