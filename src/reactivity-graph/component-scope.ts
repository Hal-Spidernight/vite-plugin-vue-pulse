/**
 * Shared component-scope registry.
 *
 * Both the render tracker (`component-plugin.ts`) and the provide/inject wrappers
 * (`tracer.ts`) need to agree on the node id for a given component instance, and
 * on the DI provide→inject links. Centralizing them here keeps identity + teardown
 * consistent and avoids a circular import.
 */
import { toRaw } from 'vue';
import { graph } from './graph.js';

const nodeFor = new WeakMap<object, string>();
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
 * Ensure (once per instance) a `component` render node exists for `inst`, wiring:
 *   - a parent → child structural edge (component tree / where props flow), and
 *   - a props node `<Comp>▸props` (tagged on the raw props object) so the child's
 *     reads of `props.x` during render attribute to it, plus parent → props.
 * Idempotent: repeated calls (every renderTracked) return the cached id without
 * re-adding, so the refcount stays 1 and teardown works.
 */
export function ensureComponentNode(inst: any): string {
  const cached = nodeFor.get(inst);
  if (cached) return cached;
  const name = compName(inst);
  const id = `component:${name}#${inst.uid}`;
  graph.addNode(id, `<${name}>`, 'component', 'runtime', `component::${name}`);
  nodeFor.set(inst, id);

  if (inst.parent) graph.addEdge(ensureComponentNode(inst.parent), id, undefined, 'runtime', 'read');

  const props = inst.props;
  if (props && typeof props === 'object' && Object.keys(props).length) {
    const raw = toRaw(props);
    const pid = `props:${name}#${inst.uid}`;
    try { if (!('__vgId' in raw)) Object.defineProperty(raw, '__vgId', { value: pid, enumerable: false, configurable: true }); } catch { /* ignore */ }
    graph.addNode(pid, `<${name}>▸props`, 'reactive', 'runtime', `props::${name}`);
    propsFor.set(inst, pid);
    graph.addEdge(pid, id, undefined, 'runtime', 'read'); // props feed the render
    if (inst.parent) graph.addEdge(ensureComponentNode(inst.parent), pid, undefined, 'runtime', 'read'); // parent feeds props
  }
  return id;
}

export function componentNodeIdIfExists(inst: any): string | undefined {
  return nodeFor.get(inst);
}

/** Remove a component's render node and props node (on unmount). */
export function disposeComponent(inst: any): void {
  const id = nodeFor.get(inst);
  if (id) graph.removeNode(id);
  const pid = propsFor.get(inst);
  if (pid) graph.removeNode(pid);
}

export function keyToString(key: unknown): string {
  return typeof key === 'symbol' ? key.toString() : String(key);
}
