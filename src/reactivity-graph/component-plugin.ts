/**
 * Component / render-effect tracker (Vue plugin).
 *
 * The single biggest reactivity consumer in a Vue app is the *render effect*:
 * the effect Vue creates per component instance to (re-)render its template. It
 * is synthesised internally by Vue, so the build-time transform — which rewrites
 * `ref`/`computed`/`watch`/… in your source — structurally cannot see it. As a
 * result, a ref/reactive used ONLY in `<template>` (the most common UI case) has
 * no traced downstream effect and never glows.
 *
 * This plugin closes that gap WITHOUT touching your source: install it with
 * `app.use(reactivityGraphPlugin)` and a global mixin attaches Vue's dev-only
 * `renderTracked` / `renderTriggered` debugger hooks to every component. From
 * those we:
 *   - add a `component` node per instance (the render effect),
 *   - draw `dependency → <Component>` read-edges (what the template reads),
 *   - wire parent → child (+ props) structural edges (see component-scope),
 *   - ripple a cascade when a template dependency changes, and
 *   - remove the node(s) on unmount (teardown, so an SPA doesn't leak the graph).
 *
 * `renderTracked`/`renderTriggered` are dev-only in Vue (stripped in production),
 * exactly like `onTrack`/`onTrigger` — perfect for a devtool. It complements, and
 * does not replace, the build-time transform.
 */
import type { App, DebuggerEvent } from 'vue';
import { graph } from './graph.js';
import { keyOf, resolveReactiveId } from './tracer.js';
import { ensureComponentNode, disposeComponent } from './component-scope.js';

export interface ReactivityGraphPluginOptions {
  /** ripple a full cascade from the changed dependency on re-render (default true) */
  cascadeOnRender?: boolean;
}

export function reactivityGraphPlugin(app: App, options: ReactivityGraphPluginOptions = {}): App {
  const cascadeOnRender = options.cascadeOnRender !== false;

  app.mixin({
    // `this.$` is the internal component instance (publicPropertiesMap maps $ -> i).
    renderTracked(this: any, e: DebuggerEvent) {
      const id = ensureComponentNode(this.$);
      const src = resolveReactiveId(e.target);
      if (src) graph.addEdge(src, id, keyOf(e), 'runtime', 'read');
    },
    renderTriggered(this: any, e: DebuggerEvent) {
      const id = ensureComponentNode(this.$);
      const src = resolveReactiveId(e.target);
      if (cascadeOnRender && src && graph.nodes.has(src)) graph.cascadeFrom(src);
      else graph.glow(id);
    },
    beforeUnmount(this: any) {
      disposeComponent(this.$);
    },
  });

  return app;
}

export default reactivityGraphPlugin;
