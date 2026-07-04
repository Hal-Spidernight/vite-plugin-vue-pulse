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
import { mountOverlay, KIND_STYLE, scopeColor } from './overlay.js';
import type { OverlayHandle } from './overlay.js';
import type { ReactivityGraphExport } from './types.js';

export { graph, ReactivityGraph } from './graph.js';
export * from './types.js';
export { mountOverlay, KIND_STYLE, createForceLayout, scopeColor } from './overlay.js';
export type { OverlayHandle, ForceLayout, Body } from './overlay.js';
export * from './tracer.js';
export { reactivityGraphPlugin } from './component-plugin.js';
export type { ReactivityGraphPluginOptions } from './component-plugin.js';

/**
 * Pre-seed the graph with statically-analyzed nodes/edges (the "map").
 * Runtime discovery will later confirm/animate them.
 */
export function loadStaticGraph(data: Partial<ReactivityGraphExport>): void {
  // Static node ids are the SAME deterministic `Comp::label` ids the runtime
  // tracer uses, so addNode dedups by id: whether the map is loaded before OR
  // after the app mounts, each declaration is ONE node (origin flips static→runtime
  // when the runtime confirms it). No reconciliation, no duplicates. The template
  // flag is merged the same way (markTemplate flags whichever node won the dedup).
  for (const n of data.nodes || []) {
    graph.addNode(n.id, n.label, n.kind, 'static');
    if (n.template) graph.markTemplate(n.id);
  }
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
  bar.innerHTML = `<span style="font-weight:600;color:#fff">🕸 vue-pulse</span>
    <span style="opacity:.6">${opts.title || 'runtime + static'}</span>`;
  const toggle = document.createElement('button');
  toggle.textContent = '–';
  toggle.style.cssText = 'margin-left:auto;background:#1e293b;color:#e5e7eb;border:none;border-radius:6px;width:22px;height:22px;cursor:pointer';
  bar.appendChild(toggle);
  panel.appendChild(bar);

  const body = document.createElement('div');

  const graphHost = document.createElement('div');
  graphHost.style.cssText = `width:100%;height:${(opts.height || 360)}px;position:relative;`;
  body.appendChild(graphHost);

  const legend = document.createElement('div');
  legend.style.cssText = 'display:flex;flex-wrap:wrap;gap:10px;padding:8px 10px;border-top:1px solid #1e293b;';
  legend.innerHTML = Object.values(KIND_STYLE).map((s) =>
    `<span style="display:inline-flex;align-items:center;gap:5px"><i style="width:9px;height:9px;border-radius:50%;background:${s.color};display:inline-block"></i>${s.label}</span>`
  ).join('') + '<span style="opacity:.5;margin-left:auto">◯ = component boundary · ring = template dep · dashed = static-only · drag to rotate · scroll to zoom · shift-click a tag = solo</span>';
  body.appendChild(legend);
  panel.appendChild(body);
  document.body.appendChild(panel);

  const ov = mountOverlay(graph, { container: graphHost, width: opts.width || 460, height: opts.height || 360 });

  // ── component filter: one chip per boundary + bulk controls ──────────────
  // A fuzz graph can have ~100 scopes, so toggling one-by-one is unusable: the
  // control row adds a substring filter, a live shown/total count, and
  // show-all / hide-all / invert that act on the *filtered* subset (type "Leaf"
  // then "hide all" to drop every Leaf* boundary at once). Shift-click a chip to
  // solo it. All view-only — visibility never reshuffles the layout.
  const hidden = new Set<string>();                                    // '' = the scopeless/global group
  const chipEls = new Map<string, { chip: HTMLButtonElement; apply: () => void }>();
  let allKeys: string[] = [];
  let query = '';

  const filterWrap = document.createElement('div');
  filterWrap.style.cssText = 'display:none;flex-direction:column;gap:6px;padding:6px 10px;border-bottom:1px solid #1e293b;';

  const controls = document.createElement('div');
  controls.style.cssText = 'display:flex;align-items:center;gap:6px;flex-wrap:wrap;';
  const search = document.createElement('input');
  search.type = 'search';
  search.placeholder = 'filter boundaries…';
  search.style.cssText = 'flex:1 1 90px;min-width:70px;background:#0b1220;color:#e5e7eb;border:1px solid #1e293b;border-radius:6px;padding:2px 8px;font:11px ui-monospace,monospace;';
  const count = document.createElement('span');
  count.style.cssText = 'opacity:.6;white-space:nowrap;';
  const mkBtn = (text: string, title: string) => {
    const b = document.createElement('button');
    b.textContent = text; b.title = title;
    b.style.cssText = 'background:#1e293b;color:#e5e7eb;border:none;border-radius:6px;padding:2px 8px;cursor:pointer;font:11px ui-monospace,monospace;';
    return b;
  };
  const btnAll = mkBtn('すべて', 'Show all boundaries (matching the filter)');
  const btnNone = mkBtn('なし', 'Hide all boundaries (matching the filter)');
  const btnInvert = mkBtn('反転', 'Invert visibility of boundaries (matching the filter)');
  controls.append(search, count, btnAll, btnNone, btnInvert);

  const chips = document.createElement('div');
  chips.style.cssText = 'display:flex;flex-wrap:wrap;gap:6px;max-height:96px;overflow-y:auto;';
  filterWrap.append(controls, chips);
  body.insertBefore(filterWrap, graphHost);

  const chipLabel = (scope: string) => scope ? `⟨${scope}⟩` : 'global';
  const matches = (scope: string) => !query || chipLabel(scope).toLowerCase().includes(query) || scope.toLowerCase().includes(query);
  const filteredKeys = () => allKeys.filter(matches);
  const setOne = (scope: string, visible: boolean) => {
    if (visible) hidden.delete(scope); else hidden.add(scope);
    ov.setScopeVisible(scope, visible);
  };
  const updateCount = () => { count.textContent = `${allKeys.filter((s) => !hidden.has(s)).length}/${allKeys.length}`; };
  const restyle = (scopes: string[]) => { for (const s of scopes) chipEls.get(s)?.apply(); updateCount(); };

  btnAll.onclick = () => { const ks = filteredKeys(); ks.forEach((s) => setOne(s, true)); restyle(ks); };
  btnNone.onclick = () => { const ks = filteredKeys(); ks.forEach((s) => setOne(s, false)); restyle(ks); };
  btnInvert.onclick = () => { const ks = filteredKeys(); ks.forEach((s) => setOne(s, hidden.has(s))); restyle(ks); };
  search.oninput = () => {
    query = search.value.trim().toLowerCase();
    for (const [scope, { chip }] of chipEls) chip.style.display = matches(scope) ? 'inline-flex' : 'none';
  };

  // keep the chip row in sync with the boundaries present in the graph
  let chipKeys: string | null = null;
  function refreshChips() {
    const scopes = new Set<string>();
    let scopeless = false;
    for (const n of graph.nodes.values()) { if (n.scope) scopes.add(n.scope); else scopeless = true; }
    const keys = [...scopes].sort();
    if (scopeless) keys.push('');
    // length-prefixed so [] (empty graph) and [''] (global-only) don't collide on
    // the same '' signature — that would suppress the whole filter UI for a
    // scopeless-only graph (and never re-show it once chipKeys had been '').
    const sig = keys.length + '\0' + keys.join('\0');
    if (sig === chipKeys) return;
    chipKeys = sig;
    // a scope that left the graph must not keep the user's stale hide state — else
    // a re-added same-name boundary (HMR / route change) would come back hidden and
    // undercounted. Drop departed scopes from both the panel set and the overlay.
    for (const s of [...hidden]) if (!keys.includes(s)) { hidden.delete(s); ov.setScopeVisible(s, true); }
    allKeys = keys;
    chips.innerHTML = '';
    chipEls.clear();
    filterWrap.style.display = keys.length ? 'flex' : 'none';
    for (const scope of keys) {
      const chip = document.createElement('button');
      const color = scope ? scopeColor(scope) : '#94a3b8';
      const apply = () => {
        const on = !hidden.has(scope);
        chip.style.cssText = `display:${matches(scope) ? 'inline-flex' : 'none'};align-items:center;gap:5px;font:11px ui-monospace,monospace;cursor:pointer;`
          + `background:#0f172a;color:#e5e7eb;border:1px solid ${on ? color : '#1e293b'};border-radius:999px;padding:2px 9px;opacity:${on ? 1 : 0.45};`;
      };
      chip.innerHTML = `<i style="width:8px;height:8px;border-radius:50%;background:${color};display:inline-block"></i>${scope ? `⟨${scope}⟩` : 'global'}`;
      chip.onclick = (e: MouseEvent) => {
        if (e.shiftKey) {                                   // solo: show only this boundary
          allKeys.forEach((s) => setOne(s, s === scope));
          restyle(allKeys);
        } else {
          setOne(scope, hidden.has(scope));                 // toggle
          apply(); updateCount();
        }
      };
      apply();
      chips.appendChild(chip);
      chipEls.set(scope, { chip, apply });
    }
    updateCount();
  }
  refreshChips();
  const unsubChips = graph.subscribe((e) => {
    if (e.type === 'node' || e.type === 'remove-node' || e.type === 'reset') refreshChips();
  });

  let collapsed = !!opts.collapsed;
  const apply = () => {
    body.style.display = collapsed ? 'none' : 'block';
    toggle.textContent = collapsed ? '+' : '–';
    // stop the RAF force-sim while hidden so a collapsed panel costs nothing
    if (collapsed) ov.pause(); else ov.resume();
  };
  toggle.onclick = () => { collapsed = !collapsed; apply(); };
  apply();

  return { panel, overlay: ov, destroy() { unsubChips(); ov.destroy(); panel.remove(); } };
}
