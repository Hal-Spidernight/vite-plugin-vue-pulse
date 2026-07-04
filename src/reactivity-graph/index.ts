/**
 * Public entry for the reactivity-graph devtool runtime.
 *
 *   import { graph, tracedRef, mountPanel, loadStaticGraph, reactivityGraphPlugin }
 *     from 'reactivity-graph/runtime';
 *
 * `mountPanel` renders a floating panel (title bar + legend + the force graph) and
 * can pre-seed the graph with a static "map" produced by the analyzer so you see
 * the full topology before anything fires at runtime. `reactivityGraphPlugin`
 * (app.use) adds component/render-effect tracking.
 */
import { graph } from './graph.js';
import { mountOverlay, KIND_STYLE } from './overlay.js';
import type { OverlayHandle } from './overlay.js';
import type { ReactivityGraphExport } from './types.js';

export { graph, ReactivityGraph } from './graph.js';
export * from './types.js';
export { mountOverlay, KIND_STYLE } from './overlay.js';
export type { OverlayHandle } from './overlay.js';
export * from './tracer.js';
export { reactivityGraphPlugin } from './component-plugin.js';
export type { ReactivityGraphPluginOptions } from './component-plugin.js';

/**
 * Pre-seed the graph with statically-analyzed nodes/edges (the "map").
 * Runtime discovery will later confirm/animate them.
 */
export function loadStaticGraph(data: Partial<ReactivityGraphExport>): void {
  for (const n of data.nodes || []) graph.addNode(n.id, n.label, n.kind, 'static');
  for (const e of data.edges || []) graph.addEdge(e.from, e.to, e.key, 'static', e.kind ?? 'read');
}

export interface PanelOptions { title?: string; width?: number; height?: number; collapsed?: boolean }
export interface PanelHandle { panel: HTMLElement; overlay: OverlayHandle; destroy(): void }

export function mountPanel(opts: PanelOptions = {}): PanelHandle {
  const panel = document.createElement('div');
  panel.style.cssText = `
    position: fixed; right: 16px; bottom: 16px; z-index: 2147483000;
    width: ${(opts.width || 460)}px; background: #0b1220ee; color: #e5e7eb;
    border: 1px solid #1e293b; border-radius: 12px; overflow: hidden;
    font: 12px ui-monospace, SFMono-Regular, Menlo, monospace;
    box-shadow: 0 12px 40px rgba(0,0,0,.5); backdrop-filter: blur(4px);`;

  const bar = document.createElement('div');
  bar.style.cssText = 'display:flex;align-items:center;gap:8px;padding:8px 10px;background:#0f172a;border-bottom:1px solid #1e293b;';
  bar.innerHTML = `<span style="font-weight:600;color:#fff">🕸 reactivity graph</span>
    <span style="opacity:.6">${opts.title || 'runtime + static'}</span>`;
  const toggle = document.createElement('button');
  toggle.textContent = '–';
  toggle.style.cssText = 'margin-left:auto;background:#1e293b;color:#e5e7eb;border:none;border-radius:6px;width:22px;height:22px;cursor:pointer';
  bar.appendChild(toggle);
  panel.appendChild(bar);

  const body = document.createElement('div');
  const graphHost = document.createElement('div');
  graphHost.style.cssText = `width:100%;height:${(opts.height || 320)}px;position:relative;`;
  body.appendChild(graphHost);

  const legend = document.createElement('div');
  legend.style.cssText = 'display:flex;flex-wrap:wrap;gap:10px;padding:8px 10px;border-top:1px solid #1e293b;';
  legend.innerHTML = Object.values(KIND_STYLE).map((s) =>
    `<span style="display:inline-flex;align-items:center;gap:5px"><i style="width:9px;height:9px;border-radius:50%;background:${s.color};display:inline-block"></i>${s.label}</span>`
  ).join('') + '<span style="opacity:.5;margin-left:auto">dashed = static-only · glow/pulse = live</span>';
  body.appendChild(legend);
  panel.appendChild(body);
  document.body.appendChild(panel);

  const ov = mountOverlay(graph, { container: graphHost, width: opts.width || 460, height: opts.height || 320 });

  let collapsed = !!opts.collapsed;
  const apply = () => {
    body.style.display = collapsed ? 'none' : 'block';
    toggle.textContent = collapsed ? '+' : '–';
    // stop the RAF force-sim while hidden so a collapsed panel costs nothing
    if (collapsed) ov.pause(); else ov.resume();
  };
  toggle.onclick = () => { collapsed = !collapsed; apply(); };
  apply();

  return { panel, overlay: ov, destroy() { ov.destroy(); panel.remove(); } };
}
