// Click-to-view-code: the static analyzer captures each declaration's source
// location + snippet (NodeLoc), it survives loadStaticGraph onto the live graph,
// and clicking a node's projected position emits onPick + shows the code.
import { describe, it, expect } from 'vitest';
import { Window } from 'happy-dom';

const win = new Window();
globalThis.window = win;
globalThis.document = win.document;
// canvas at a known screen origin so pointer coords map straight to canvas coords
Object.defineProperty(win.HTMLElement.prototype, 'getBoundingClientRect', {
  value: () => ({ left: 0, top: 0, right: 460, bottom: 360, width: 460, height: 360 }), configurable: true,
});
win.HTMLCanvasElement.prototype.getContext = () => new Proxy({}, {
  get: (t, k) => (k in t ? t[k] : () => {}),
  set: (t, k, v) => ((t[k] = v), true),
});
globalThis.requestAnimationFrame = (fn) => setTimeout(() => fn(0), 0);
globalThis.cancelAnimationFrame = (id) => clearTimeout(id);

const { analyzeSfc } = await import('../dist/static/analyze.js');
const { graph } = await import('../dist/reactivity-graph/graph.js');
const { mountOverlay } = await import('../dist/reactivity-graph/overlay.js');
const { loadStaticGraph } = await import('../dist/reactivity-graph/index.js');

const ok = (c, m) => expect(c, m).toBeTruthy();

describe('code_view', () => {
  it('captures source location + snippet, survives loadStaticGraph, and emits onPick on click', async () => {
const tick = (n) => new Promise((r) => { let i = 0; const go = () => (++i >= n ? r() : setTimeout(go, 0)); setTimeout(go, 0); });

console.log('[static analyzer captures source location + snippet per declaration]');
const src = `<script setup>
import { ref, computed, watch } from 'vue';
const count = ref(0);
const doubled = computed(() => count.value * 2);
watch(doubled, (v) => { console.log(v); });
</script>
<template><p>{{ doubled }}</p></template>`;
const analysis = analyzeSfc(src, 'Demo.vue');
const byId = Object.fromEntries(analysis.nodes.map((n) => [n.id, n]));
ok(byId['Demo::count']?.loc?.snippet === 'const count = ref(0);', 'ref snippet captured verbatim');
ok(byId['Demo::count']?.loc?.line === 3, 'ref line number captured (line 3)');
ok(byId['Demo::count']?.loc?.file === 'Demo.vue', 'source file recorded');
ok(/computed\(\(\) => count\.value/.test(byId['Demo::doubled']?.loc?.snippet || ''), 'computed snippet captured');
ok(byId['Demo::watch#1']?.loc?.line === 5 && /^watch\(doubled/.test(byId['Demo::watch#1'].loc.snippet), 'anonymous watch snippet + line captured');

console.log('[loc survives loadStaticGraph onto the live graph]');
graph.reset();
loadStaticGraph(analysis);
ok(graph.nodes.get('Demo::count')?.loc?.snippet === 'const count = ref(0);', 'loadStaticGraph carries loc onto the node');
// first-write-wins: a runtime re-add must not wipe the loc
graph.addNode('Demo::count', 'count', 'ref', 'runtime');
ok(graph.nodes.get('Demo::count')?.loc?.snippet === 'const count = ref(0);', 'runtime re-add keeps the static loc (first-write-wins)');
// setLocation never overwrites an existing loc
graph.setLocation('Demo::count', { snippet: 'OTHER', line: 99 });
ok(graph.nodes.get('Demo::count')?.loc?.line === 3, 'setLocation does not clobber an existing loc');

console.log('[clicking a node emits onPick with its id; empty space clears it]');
graph.reset();
loadStaticGraph(analysis);
const picks = [];
const host = document.createElement('div');
document.body.appendChild(host);
const ov = mountOverlay(graph, { container: host, width: 460, height: 360, onPick: (id) => picks.push(id) });
await tick(600); // let the sim settle + at least one draw populate lastProj

// find a node's on-screen position from the overlay's projection by reading a drawn
// node: we can't read lastProj directly, so click the panel centre — with a settled
// small graph a node sits near the centre. To be deterministic, click exactly where
// a node projects: reconstruct via the same framing the overlay uses.
// Simpler + robust: click the centre; assert SOME node got picked (non-null), then
// assert clicking a far corner (empty) clears it.
const down = (x, y, shift = false) => {
  const e = new win.Event('pointerdown', { bubbles: true, cancelable: true });
  Object.assign(e, { clientX: x, clientY: y, pointerId: 1 });
  Object.defineProperty(e, 'shiftKey', { value: shift });
  e.preventDefault = () => {};
  ov.canvas.dispatchEvent(e);
};
const up = (x, y) => {
  const e = new win.Event('pointerup', { bubbles: true, cancelable: true });
  Object.assign(e, { clientX: x, clientY: y, pointerId: 1 });
  e.preventDefault = () => {};
  ov.canvas.dispatchEvent(e);
};
// sweep a grid of click points until one lands on a node (deterministic settle → a
// hit exists somewhere near the centre); proves the hit-test + onPick wiring works.
let hit = null;
outer: for (let gy = 120; gy <= 240 && !hit; gy += 15) {
  for (let gx = 160; gx <= 300; gx += 15) {
    picks.length = 0;
    down(gx, gy); up(gx, gy);
    await tick(3);
    if (picks.length && picks[picks.length - 1]) { hit = picks[picks.length - 1]; break outer; }
  }
}
ok(!!hit && graph.nodes.has(hit), `clicking a node emits onPick with a real node id (${hit})`);

// clicking far empty space (top-left corner, nothing there) clears the selection
picks.length = 0;
down(2, 2); up(2, 2);
await tick(5);
ok(picks.length === 1 && picks[0] === null, 'clicking empty space emits onPick(null) → closes the code view');

// a drag (moved > 5px) must NOT be treated as a click (no pick)
picks.length = 0;
down(200, 180);
const mv = new win.Event('pointermove', { bubbles: true }); Object.assign(mv, { clientX: 260, clientY: 220 }); mv.preventDefault = () => {}; ov.canvas.dispatchEvent(mv);
up(260, 220);
await tick(5);
ok(picks.length === 0, 'a drag does not fire a pick (click vs drag discrimination)');

ov.destroy();
  });
});
