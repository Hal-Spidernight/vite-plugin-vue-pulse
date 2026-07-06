/**
 * Shared component-scope helpers.
 *
 * Components are a BOUNDARY, not a node: a node is a declaration / reactivity-API
 * usage, and each node's `scope` says which component boundary it lives in. What
 * remains here is the little state both the render tracker (`component-plugin.ts`)
 * and the provide/inject wrappers (`tracer.ts`) must agree on:
 *   - the component name (= the boundary key, matches the static analyzer's scope),
 *   - the per-component `props` node (defineProps IS a declaration → `Comp::props`),
 *   - the provide-key → provider-node registry for DI edges.
 */
import { toRaw } from 'vue';
import { graph } from './graph.js';

const propsFor = new WeakMap<object, string>();
/** injection key (string form) -> node id of the provided reactive */
export const providedNodes = new Map<string, string>();

export function compName(inst: any): string {
  const t = (inst && inst.type) || {};
  if (t.__name || t.name) return t.__name || t.name;
  if (t.__file) return String(t.__file).split('/').pop().replace(/\.\w+$/, '');
  return 'Anonymous';
}

/**
 * Ensure (once per instance) the `props` node for `inst` — the runtime face of
 * the component's props declaration. Deterministic id `Comp::props`, identical to
 * what the static analyzer emits for `defineProps`, so they dedup to ONE node.
 * The raw props object is tagged so render-effect debugger events attribute to it.
 * Idempotent per instance: the refcount stays 1 and teardown works.
 */
export function ensurePropsNode(inst: any): string | undefined {
  const cached = propsFor.get(inst);
  if (cached) return cached;
  const props = inst && inst.props;
  if (!props || typeof props !== 'object' || !Object.keys(props).length) return undefined;
  const raw = toRaw(props);
  const id = `${compName(inst)}::props`;
  try { if (!('__vgId' in raw)) Object.defineProperty(raw, '__vgId', { value: id, enumerable: false, configurable: true }); } catch { /* ignore */ }
  graph.addNode(id, 'props', 'props', 'runtime');
  propsFor.set(inst, id);
  return id;
}

/** Drop this instance's reference to its props node (on unmount). */
export function disposeComponent(inst: any): void {
  const pid = propsFor.get(inst);
  if (pid) graph.removeNode(pid);
}

export function keyToString(key: unknown): string {
  return typeof key === 'symbol' ? key.toString() : String(key);
}
