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
import { createRecorder } from './recorder.js';
import type { PropagationSession } from './recorder.js';

export { graph, ReactivityGraph } from './graph.js';
export * from './types.js';
export { mountOverlay, KIND_STYLE, createForceLayout, scopeColor } from './overlay.js';
export type { OverlayHandle, ForceLayout, Body } from './overlay.js';
export * from './tracer.js';
export { reactivityGraphPlugin } from './component-plugin.js';
export type { ReactivityGraphPluginOptions } from './component-plugin.js';
export { createRecorder } from './recorder.js';
export type { RecorderHandle, PropagationSession, PropagationStep } from './recorder.js';

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
    if (n.loc) graph.setLocation(n.id, n.loc);
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
  // reset view: recenter / re-fit / level the camera. The main escape hatch when a
  // shift-drag pan (or a wild zoom/rotate) sends the graph off-screen — re-engages
  // auto-fit so the whole cloud snaps back into frame. (double-click does the same.)
  const recenter = document.createElement('button');
  recenter.textContent = '⟳';
  recenter.title = 'Reset view (recenter · fit · level)';
  recenter.style.cssText = 'margin-left:auto;background:#1e293b;color:#e5e7eb;border:none;border-radius:6px;width:22px;height:22px;cursor:pointer;font-size:13px;line-height:1';
  bar.appendChild(recenter);
  const toggle = document.createElement('button');
  toggle.textContent = '–';
  toggle.style.cssText = 'background:#1e293b;color:#e5e7eb;border:none;border-radius:6px;width:22px;height:22px;cursor:pointer';
  bar.appendChild(toggle);
  panel.appendChild(bar);

  const body = document.createElement('div');

  // two tabs: "graph" (the live 3D overlay + filters) and "record" (captured
  // propagation flows). tabBar is populated after the recorder exists.
  const tabBar = document.createElement('div');
  tabBar.style.cssText = 'display:flex;gap:6px;padding:6px 10px 0;';
  const graphView = document.createElement('div');
  const recordView = document.createElement('div');
  recordView.style.display = 'none';
  body.append(tabBar, graphView, recordView);

  const graphHost = document.createElement('div');
  graphHost.style.cssText = `width:100%;height:${(opts.height || 360)}px;position:relative;`;
  graphView.appendChild(graphHost);

  // code view: clicking a node shows where that declaration lives in source + its
  // snippet. Hidden until something is picked. Header + a scrollable <pre>.
  const codeView = document.createElement('div');
  codeView.style.cssText = 'display:none;border-top:1px solid #1e293b;background:#0b1220;';
  const codeHead = document.createElement('div');
  codeHead.style.cssText = 'display:flex;align-items:center;gap:8px;padding:5px 10px;font:11px ui-monospace,monospace;color:#cbd5e1;';
  const codeTitle = document.createElement('span');
  codeTitle.style.cssText = 'font-weight:600;color:#fff;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;';
  const codeLoc = document.createElement('span');
  codeLoc.style.cssText = 'opacity:.6;white-space:nowrap;';
  const codeClose = document.createElement('button');
  codeClose.textContent = '✕';
  codeClose.title = 'close';
  codeClose.style.cssText = 'margin-left:auto;background:#1e293b;color:#e5e7eb;border:none;border-radius:6px;width:20px;height:20px;cursor:pointer;flex:none;';
  codeHead.append(codeTitle, codeLoc, codeClose);
  const codePre = document.createElement('pre');
  codePre.style.cssText = 'margin:0;padding:0 10px 10px;max-height:180px;overflow:auto;font:11px/1.5 ui-monospace,monospace;color:#e2e8f0;white-space:pre;';
  codeView.append(codeHead, codePre);
  graphView.appendChild(codeView);

  // legend doubles as a per-KIND filter: clicking a swatch shows/hides every node
  // of that kind. Populated after the overlay is created (needs `ov`).
  const legend = document.createElement('div');
  legend.style.cssText = 'display:flex;flex-wrap:wrap;gap:10px;padding:8px 10px;border-top:1px solid #1e293b;';
  graphView.appendChild(legend);
  panel.appendChild(body);
  document.body.appendChild(panel);

  // clicking a node shows its source location + snippet in the code view; clicking
  // empty space (id=null) closes it. Kinds are colored to match the graph legend.
  const showCode = (id: string | null) => {
    const node = id ? graph.nodes.get(id) : undefined;
    if (!node) { codeView.style.display = 'none'; return; }
    const color = (KIND_STYLE[node.kind] || KIND_STYLE.ref).color;
    codeTitle.innerHTML = `<span style="color:${color}">●</span> ${escapeHtml(node.label)}`
      + `<span style="opacity:.5"> · ${node.kind}${node.scope ? ` · ⟨${escapeHtml(node.scope)}⟩` : ''}</span>`;
    const loc = node.loc;
    codeLoc.textContent = loc && loc.file ? `${loc.file}${loc.line ? ':' + loc.line : ''}` : '';
    codePre.textContent = loc?.snippet
      ? loc.snippet
      : '// no source location — this node was seen only at runtime\n// (not covered by the static analysis of your .vue files)';
    codeView.style.display = 'block';
  };

  const ov = mountOverlay(graph, { container: graphHost, width: opts.width || 460, height: opts.height || 360, onPick: showCode });
  recenter.onclick = () => ov.resetView();
  codeClose.onclick = () => { codeView.style.display = 'none'; ov.clearSelection(); };

  // legend = per-kind filter: click a swatch to show/hide every node of that kind
  // (view-only, mirrors the scope chips; dimmed when hidden). Then the help text.
  const hiddenKinds = new Set<string>();
  for (const [kind, s] of Object.entries(KIND_STYLE)) {
    const item = document.createElement('button');
    const applyItem = () => {
      const on = !hiddenKinds.has(kind);
      item.style.cssText = 'display:inline-flex;align-items:center;gap:5px;cursor:pointer;background:none;border:none;padding:0;'
        + `font:inherit;color:#e5e7eb;opacity:${on ? 1 : 0.4};${on ? '' : 'text-decoration:line-through;'}`;
    };
    item.innerHTML = `<i style="width:9px;height:9px;border-radius:50%;background:${s.color};display:inline-block"></i>${s.label}`;
    item.title = `show / hide ${kind} nodes`;
    item.onclick = () => {
      if (hiddenKinds.has(kind)) hiddenKinds.delete(kind); else hiddenKinds.add(kind);
      ov.setKindVisible(kind, !hiddenKinds.has(kind));
      applyItem();
    };
    applyItem();
    legend.appendChild(item);
  }
  const legendHelp = document.createElement('span');
  legendHelp.style.cssText = 'opacity:.5;margin-left:auto';
  legendHelp.textContent = '◯ = component boundary · ring = template dep · dashed = static-only · click a node = show code · click a kind = show/hide · drag to rotate · shift-drag to pan · scroll to zoom · shift-click a tag = solo';
  legend.appendChild(legendHelp);

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
  const btnAll = mkBtn('All', 'Show all boundaries (matching the filter)');
  const btnNone = mkBtn('None', 'Hide all boundaries (matching the filter)');
  const btnInvert = mkBtn('Invert', 'Invert visibility of boundaries (matching the filter)');
  controls.append(search, count, btnAll, btnNone, btnInvert);

  const chips = document.createElement('div');
  chips.style.cssText = 'display:flex;flex-wrap:wrap;gap:6px;max-height:96px;overflow-y:auto;';
  filterWrap.append(controls, chips);
  graphView.insertBefore(filterWrap, graphHost);

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

  // ── recording view: capture + inspect propagation flows (acyclic) ─────────
  const rec = createRecorder(graph);
  let selectedSession: PropagationSession | null = null;
  let fmt: 'mermaid' | 'json' = 'mermaid';

  const mkRecBtn = (text: string, title: string) => {
    const b = document.createElement('button');
    b.textContent = text; b.title = title;
    b.style.cssText = 'background:#1e293b;color:#e5e7eb;border:none;border-radius:6px;padding:3px 9px;cursor:pointer;font:11px ui-monospace,monospace;';
    return b;
  };
  const recSep = () => { const s = document.createElement('span'); s.style.cssText = 'width:1px;height:16px;background:#1e293b;'; return s; };

  const recCtl = document.createElement('div');
  recCtl.style.cssText = 'display:flex;align-items:center;gap:6px;flex-wrap:wrap;padding:8px 10px;border-bottom:1px solid #1e293b;';
  const recBtn = mkRecBtn('● Rec', 'Start / stop recording');
  const clearBtn = mkRecBtn('Clear', 'Clear all recorded flows');
  const fmtMmd = mkRecBtn('Mermaid', 'Export as Mermaid');
  const fmtJson = mkRecBtn('JSON', 'Export as JSON');
  const copyBtn = mkRecBtn('Copy', 'Copy output to clipboard');
  const dlBtn = mkRecBtn('Save', 'Save output to a file');
  recCtl.append(recBtn, clearBtn, recSep(), fmtMmd, fmtJson, recSep(), copyBtn, dlBtn);

  const hint = document.createElement('div');
  hint.style.cssText = 'opacity:.5;padding:6px 10px;font:11px ui-monospace,monospace;';
  hint.textContent = 'Record, then interact with your app — each user action is captured as one acyclic propagation flow.';

  const sessList = document.createElement('div');
  sessList.style.cssText = 'display:flex;flex-direction:column;gap:2px;max-height:70px;overflow-y:auto;padding:4px 10px;';

  const flowCanvas = document.createElement('canvas');
  const FW = opts.width || 460, FH = 200;
  const fdpr = Math.min((typeof window !== 'undefined' && window.devicePixelRatio) || 1, 2);
  flowCanvas.width = FW * fdpr; flowCanvas.height = FH * fdpr;
  flowCanvas.style.cssText = `width:${FW}px;height:${FH}px;display:block;`;
  const fctx = flowCanvas.getContext('2d') as CanvasRenderingContext2D;
  fctx.setTransform(fdpr, 0, 0, fdpr, 0, 0);

  const out = document.createElement('textarea');
  out.readOnly = true;
  out.style.cssText = 'width:100%;box-sizing:border-box;height:104px;background:#0b1220;color:#e2e8f0;border:none;border-top:1px solid #1e293b;padding:8px 10px;font:11px/1.4 ui-monospace,monospace;resize:none;';

  recordView.append(recCtl, hint, sessList, flowCanvas, out);

  const output = (): string => {
    if (selectedSession) return fmt === 'json'
      ? JSON.stringify({ origin: selectedSession.origin, originLabel: selectedSession.originLabel, steps: selectedSession.steps }, null, 2)
      : rec.toMermaid(selectedSession);
    return fmt === 'json' ? rec.toJSON() : rec.toMermaid();
  };
  const updateRecBtn = () => {
    recBtn.textContent = rec.recording ? '■ Stop' : '● Rec';
    recBtn.style.color = rec.recording ? '#fb7185' : '#e5e7eb';
    fmtMmd.style.opacity = fmt === 'mermaid' ? '1' : '0.5';
    fmtJson.style.opacity = fmt === 'json' ? '1' : '0.5';
  };

  const renderSessions = () => {
    sessList.innerHTML = '';
    if (!rec.sessions.length) {
      const empty = document.createElement('div');
      empty.style.cssText = 'opacity:.4;font:11px ui-monospace,monospace;';
      empty.textContent = '(no flows recorded yet)';
      sessList.appendChild(empty);
      return;
    }
    rec.sessions.forEach((s, i) => {
      const row = document.createElement('button');
      const on = s === selectedSession;
      row.style.cssText = `text-align:left;background:${on ? '#1e293b' : 'transparent'};color:#e5e7eb;border:none;border-radius:4px;padding:3px 6px;cursor:pointer;font:11px ui-monospace,monospace;`;
      const sinks = new Set(s.steps.map((st) => st.to)).size;
      row.textContent = `#${i + 1}  ⟨${graph.nodes.get(s.origin)?.scope || 'global'}⟩ ${s.originLabel} → ${sinks} nodes · ${s.steps.length} hops`;
      row.onclick = () => { selectedSession = s; renderRecord(); };
      sessList.appendChild(row);
    });
  };

  // draw the selected flow as a left→right layered DAG (level = BFS depth)
  const drawFlow = (session: PropagationSession | null) => {
    fctx.clearRect(0, 0, FW, FH);
    if (!session || !session.steps.length) return;
    const nodeLevel = new Map<string, number>([[session.origin, 0]]);
    for (const st of session.steps) if (!nodeLevel.has(st.to)) nodeLevel.set(st.to, st.level);
    const levels = new Map<number, string[]>();
    for (const [id, lv] of nodeLevel) { if (!levels.has(lv)) levels.set(lv, []); levels.get(lv)!.push(id); }
    const maxLevel = Math.max(...nodeLevel.values());
    const colW = FW / (maxLevel + 1);
    const pos = new Map<string, { x: number; y: number }>();
    for (const [lv, ids] of levels) {
      const rowH = FH / (ids.length + 1);
      ids.forEach((id, i) => pos.set(id, { x: colW * (lv + 0.5), y: rowH * (i + 1) }));
    }
    for (const st of session.steps) {
      const a = pos.get(st.from), b = pos.get(st.to);
      if (!a || !b) continue;
      const wr = st.kind === 'write';
      fctx.strokeStyle = wr ? 'rgba(251,191,36,0.8)' : 'rgba(148,163,184,0.7)';
      fctx.lineWidth = 1; fctx.setLineDash(wr ? [4, 3] : []);
      fctx.beginPath(); fctx.moveTo(a.x, a.y); fctx.lineTo(b.x, b.y); fctx.stroke();
      fctx.setLineDash([]);
      const ang = Math.atan2(b.y - a.y, b.x - a.x);
      const ex = b.x - Math.cos(ang) * 9, ey = b.y - Math.sin(ang) * 9;
      fctx.fillStyle = wr ? 'rgba(251,191,36,0.95)' : 'rgba(148,163,184,0.95)';
      fctx.beginPath(); fctx.moveTo(ex, ey);
      fctx.lineTo(ex - Math.cos(ang - 0.4) * 6, ey - Math.sin(ang - 0.4) * 6);
      fctx.lineTo(ex - Math.cos(ang + 0.4) * 6, ey - Math.sin(ang + 0.4) * 6);
      fctx.closePath(); fctx.fill();
    }
    for (const [id, p] of pos) {
      const node = graph.nodes.get(id);
      const color = (KIND_STYLE[node?.kind as keyof typeof KIND_STYLE] || KIND_STYLE.ref).color;
      fctx.fillStyle = color;
      fctx.beginPath(); fctx.arc(p.x, p.y, 6, 0, Math.PI * 2); fctx.fill();
      fctx.fillStyle = '#e5e7eb'; fctx.font = '10px ui-monospace, monospace'; fctx.textAlign = 'center';
      fctx.fillText(node?.label || id, p.x, p.y - 10);
    }
  };

  function renderRecord() {
    updateRecBtn();
    if (selectedSession && !rec.sessions.includes(selectedSession)) selectedSession = null;
    renderSessions();
    drawFlow(selectedSession);
    out.value = output();
  }

  recBtn.onclick = () => { if (rec.recording) rec.stop(); else rec.start(); applyTabs(); renderRecord(); };
  clearBtn.onclick = () => { rec.clear(); selectedSession = null; renderRecord(); };
  fmtMmd.onclick = () => { fmt = 'mermaid'; renderRecord(); };
  fmtJson.onclick = () => { fmt = 'json'; renderRecord(); };
  copyBtn.onclick = () => { try { navigator.clipboard?.writeText(output()); } catch { /* clipboard blocked */ } };
  dlBtn.onclick = () => {
    const blob = new Blob([output()], { type: 'text/plain' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = fmt === 'json' ? 'vue-pulse-flow.json' : 'vue-pulse-flow.mmd';
    a.click();
    URL.revokeObjectURL(a.href);
  };
  const unsubRec = rec.subscribe(() => { applyTabs(); if (tab === 'record') renderRecord(); });

  // ── tabs ──────────────────────────────────────────────────────────────────
  let tab: 'graph' | 'record' = 'graph';
  const mkTab = (text: string, id: 'graph' | 'record') => {
    const b = document.createElement('button');
    b.textContent = text;
    b.style.cssText = 'background:none;border:none;border-bottom:2px solid transparent;color:#94a3b8;padding:4px 8px;cursor:pointer;font:12px ui-monospace,monospace;';
    b.onclick = () => setTab(id);
    return b;
  };
  const tabGraph = mkTab('Graph', 'graph');
  const tabRecord = mkTab('Record', 'record');
  tabBar.append(tabGraph, tabRecord);
  function applyTabs() {
    tabGraph.style.color = tab === 'graph' ? '#fff' : '#94a3b8';
    tabGraph.style.borderBottomColor = tab === 'graph' ? '#38bdf8' : 'transparent';
    tabRecord.textContent = rec.recording ? '● Recording' : 'Record';
    tabRecord.style.color = rec.recording ? '#fb7185' : (tab === 'record' ? '#fff' : '#94a3b8');
    tabRecord.style.borderBottomColor = tab === 'record' ? '#38bdf8' : 'transparent';
  }
  function setTab(t: 'graph' | 'record') {
    tab = t;
    graphView.style.display = t === 'graph' ? 'block' : 'none';
    recordView.style.display = t === 'record' ? 'block' : 'none';
    applyTabs();
    updatePause();
    if (t === 'record') renderRecord();
  }

  let collapsed = !!opts.collapsed;
  // pause the RAF force-sim whenever the overlay isn't visible (collapsed OR on the
  // record tab) so a hidden panel costs nothing.
  const updatePause = () => { if (collapsed || tab === 'record') ov.pause(); else ov.resume(); };
  const apply = () => {
    body.style.display = collapsed ? 'none' : 'block';
    toggle.textContent = collapsed ? '+' : '–';
    updatePause();
  };
  toggle.onclick = () => { collapsed = !collapsed; apply(); };
  apply();
  applyTabs();

  return { panel, overlay: ov, destroy() { unsubChips(); unsubRec(); rec.destroy(); ov.destroy(); panel.remove(); } };
}

/** Escape a string for safe insertion as element text via innerHTML. */
function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => (
    c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : c === '"' ? '&quot;' : '&#39;'
  ));
}
