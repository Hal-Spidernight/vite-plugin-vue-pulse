/**
 * Component / render-effect tracker (Vue plugin).
 *
 * The single biggest reactivity consumer in a Vue app is the *render effect*:
 * the effect Vue creates per component instance to (re-)render its template. It
 * is synthesised internally by Vue, so the build-time transform — which rewrites
 * `ref`/`computed`/`watch`/… in your source — structurally cannot see it.
 *
 * A component is NOT a node (a node is a declaration; a component is the BOUNDARY
 * its declarations live in), so instead of minting a render node we translate the
 * dev-only `renderTracked` / `renderTriggered` hooks into boundary semantics:
 *   - `renderTracked`: the template read a declaration → flag that node with
 *     `template: true` (drawn with a render-dep marker). Reads of the props
 *     object attribute to the component's `props` declaration node.
 *   - `renderTriggered`: the component re-rendered → flash its boundary
 *     (`graph.flashScope`) and ripple a cascade from the changed dependency.
 *   - unmount → drop this instance's props-node reference (teardown; the
 *     component's other nodes are removed by their own `onScopeDispose`).
 *
 * Install with `app.use(reactivityGraphPlugin)`. The hooks are dev-only in Vue
 * (stripped in production), exactly like `onTrack`/`onTrigger` — perfect for a
 * devtool. It complements, and does not replace, the build-time transform.
 */
import type { App, DebuggerEvent } from 'vue';
import { toRaw } from 'vue';
import { graph } from './graph.js';
import { resolveReactiveId } from './tracer.js';
import { compName, ensurePropsNode, disposeComponent } from './component-scope.js';

export interface ReactivityGraphPluginOptions {
  /** ripple a full cascade from the changed dependency on re-render (default true) */
  cascadeOnRender?: boolean;
}

/** Resolve a render-effect debugger target: the props object -> the `Comp::props`
 *  declaration node; anything else -> the tagged (or external) reactive's node. */
function resolveRenderDep(inst: any, e: DebuggerEvent): string | undefined {
  const props = inst && inst.props;
  if (props && typeof props === 'object' && e.target === toRaw(props)) return ensurePropsNode(inst);
  return resolveReactiveId(e.target);
}

export function reactivityGraphPlugin(app: App, options: ReactivityGraphPluginOptions = {}): App {
  // Dev-only devtool: a production build makes this a COMPLETE no-op — no mixin is
  // installed, nothing renders, zero per-component cost. Because Vite replaces both
  // `import.meta.env` and `import.meta.env.PROD` with literals in the build, in
  // production this reads `if (true) return app` and the whole body below (plus its
  // now-unused runtime imports) is dead-code eliminated. The `&&` short-circuits
  // safely outside a Vite build (this package's Node tests / non-Vite hosts) where
  // `import.meta.env` is undefined, so the plugin stays active there.
  if ((import.meta as any).env && (import.meta as any).env.PROD) return app;

  const cascadeOnRender = options.cascadeOnRender !== false;

  app.mixin({
    // `this.$` is the internal component instance (publicPropertiesMap maps $ -> i).
    renderTracked(this: any, e: DebuggerEvent) {
      const src = resolveRenderDep(this.$, e);
      if (src) graph.markTemplate(src);
    },
    renderTriggered(this: any, e: DebuggerEvent) {
      const src = resolveRenderDep(this.$, e);
      if (cascadeOnRender && src && graph.nodes.has(src)) graph.cascadeFrom(src);
      graph.flashScope(compName(this.$));
    },
    beforeUnmount(this: any) {
      disposeComponent(this.$);
    },
  });

  return app;
}

export default reactivityGraphPlugin;
