// TEMP repro (deleted after run) — overlay redraw gate + panel chips lifecycle
import { Window } from 'happy-dom';
const win = new Window();
globalThis.window = win;
globalThis.document = win.document;

let clearRectCount = 0;
win.HTMLCanvasElement.prototype.getContext = () => new Proxy({}, {
  get: (t, k) => {
    if (k === 'clearRect') return () => { clearRectCount++; };
    return k in t ? t[k] : () => {};
  },
  set: (t, k, v) => ((t[k] = v), true),
});
let frames = 0;
globalThis.requestAnimationFrame = (fn) => { frames++; return setTimeout(() => fn(0), 0); };
globalThis.cancelAnimationFrame = (id) => clearTimeout(id);
const tick = (n) => new Promise((r) => { let i = 0; const go = () => (++i >= n ? r() : setTimeout(go, 0)); setTimeout(go, 0); });

const { ReactivityGraph } = await import('../dist/reactivity-graph/graph.js');
const { mountOverlay } = await import('../dist/reactivity-graph/overlay.js');
const { graph } = await import('../dist/reactivity-graph/graph.js');
const { mountPanel } = await import('../dist/reactivity-graph/index.js');

console.log('=== E: canvas redraw after the graph empties ===');
const g = new ReactivityGraph();
g.addNode('A::x', 'x', 'ref');
g.addNode('A::y', 'y', 'ref');
g.addEdge('A::x', 'A::y');
const host = document.createElement('div');
document.body.appendChild(host);
const ov = mountOverlay(g, { container: host, width: 200, height: 150 });
// let it settle fully (~170 steps)
await tick(600);
const settledCount = clearRectCount;
await tick(50);
console.log('draws while settled+idle:', clearRectCount - settledCount, '(expect 0 = zero-CPU idle OK)');
const before = clearRectCount;
// empty the graph (what app.unmount() does node-by-node)
g.removeNode('A::x');
g.removeNode('A::y');
await tick(50);
console.log('draws after graph emptied:', clearRectCount - before, '(0 means STALE canvas — removed nodes still painted)');
const before2 = clearRectCount;
g.addNode('B::z', 'z', 'ref'); // non-empty wake path for contrast
await tick(20);
console.log('draws after re-adding a node:', clearRectCount - before2);
// reset path
await tick(600); // settle again
const before3 = clearRectCount;
g.reset();
await tick(50);
console.log('draws after reset():', clearRectCount - before3, '(0 means stale canvas after reset)');
ov.destroy();

console.log('\n=== F: panel chips lifecycle ===');
const baselineSubs = graph.subscribers.size;
graph.reset();
graph.addNode('CompA::a', 'a', 'ref');
graph.addNode('CompB::b', 'b', 'ref');
graph.addNode('bare', 'bare', 'ref');
const panel = mountPanel({ width: 200, height: 150 });
const chipRow = panel.panel.querySelectorAll('button');
const chipTexts = () => [...panel.panel.querySelectorAll('button')].map((b) => b.textContent).filter((t) => t !== '–' && t !== '+');
console.log('chips at mount:', JSON.stringify(chipTexts()));
graph.addNode('CompC::c', 'c', 'ref');
console.log('chips after new scope:', JSON.stringify(chipTexts()));
graph.removeNode('CompC::c');
console.log('chips after scope disappears:', JSON.stringify(chipTexts()));
graph.reset();
console.log('chips after reset:', JSON.stringify(chipTexts()));
graph.addNode('CompA::a2', 'a2', 'ref');
console.log('chips after re-add post-reset:', JSON.stringify(chipTexts()));
console.log('subscribers while mounted:', graph.subscribers.size - baselineSubs);
panel.destroy();
console.log('subscribers after destroy:', graph.subscribers.size - baselineSubs, '(expect 0 = no leak)');
process.exit(0);
