// Components as BOUNDARY + FILTER TAG: scope derivation from the deterministic
// id, template/boundary events, scope clustering in the force layout, and the
// overlay's per-scope filter API (headless happy-dom + canvas stub).
import { Window } from 'happy-dom';

const win = new Window();
globalThis.window = win;
globalThis.document = win.document;
// stub canvas 2d + rAF so the overlay runs headlessly
win.HTMLCanvasElement.prototype.getContext = () => new Proxy({}, { get: (t, k) => (k in t ? t[k] : () => {}), set: (t, k, v) => ((t[k] = v), true) });
globalThis.requestAnimationFrame = (fn) => setTimeout(() => fn(0), 0);
globalThis.cancelAnimationFrame = (id) => clearTimeout(id);

const { ReactivityGraph } = await import('../dist/reactivity-graph/graph.js');
const { createForceLayout, mountOverlay, scopeColor } = await import('../dist/reactivity-graph/overlay.js');

let pass = 0, fail = 0;
const ok = (c, m) => (c ? (pass++, console.log('  ✓', m)) : (fail++, console.error('  ✗', m)));

console.log('[scope = boundary membership, derived from the id]');
const g = new ReactivityGraph();
ok(g.addNode('App::hoge', 'hoge', 'ref').scope === 'App', 'Comp::label id → scope "App"');
ok(g.addNode('external:1', '⟨ext⟩ ref1', 'ref').scope === undefined, 'external node → no scope (global group)');
ok(g.addNode('bare', 'bare', 'ref').scope === undefined, 'unscoped label → no scope');

console.log('[template flag + boundary flash events]');
const events = [];
const unsub = g.subscribe((e) => events.push(e));
g.markTemplate('App::hoge');
ok(g.nodes.get('App::hoge').template === true, 'markTemplate sets the render-dep flag');
ok(events.some((e) => e.type === 'template' && e.nodeId === 'App::hoge'), "…and emits a 'template' event");
g.markTemplate('App::hoge');
ok(events.filter((e) => e.type === 'template').length === 1, 'markTemplate is idempotent (one event)');
g.flashScope('App');
ok(events.some((e) => e.type === 'boundary' && e.scope === 'App'), "flashScope emits a 'boundary' event (a re-render is a boundary flash, not a node glow)");
unsub();

console.log('[scope clustering in the force layout]');
const layout = createForceLayout(460, 360);
for (const scope of ['A', 'B']) {
  for (let i = 0; i < 8; i++) layout.addBody({ id: `${scope}::n${i}`, label: `n${i}`, kind: 'ref', origin: 'runtime', scope });
  for (let i = 0; i < 7; i++) layout.addSpring({ from: `${scope}::n${i}`, to: `${scope}::n${i + 1}`, origin: 'runtime', kind: 'read' });
}
layout.addSpring({ from: 'A::n0', to: 'B::n0', origin: 'runtime', kind: 'read' }); // one cross-boundary edge
let steps = 0;
while (!layout.settled && steps < 5000) { layout.step(); steps++; }
ok(layout.settled && steps < 5000, `settles with the cluster force active (${steps} steps)`);
const bodies = [...layout.bodies.values()];
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
let intra = 0, nIntra = 0, inter = 0, nInter = 0;
for (let i = 0; i < bodies.length; i++) {
  for (let j = i + 1; j < bodies.length; j++) {
    if (bodies[i].scope === bodies[j].scope) { intra += dist(bodies[i], bodies[j]); nIntra++; }
    else { inter += dist(bodies[i], bodies[j]); nInter++; }
  }
}
ok(intra / nIntra < inter / nInter, `same-boundary nodes cluster (mean intra ${(intra / nIntra).toFixed(1)} < inter ${(inter / nInter).toFixed(1)})`);
// the two boundaries stay visibly APART: centroid distance exceeds the sum of the
// mean cluster radii, i.e. the hulls do not overlap (cross-scope repulsion + the
// longer cross-boundary spring rest length)
const centroid = (scope) => {
  const m = bodies.filter((b) => b.scope === scope);
  return { m, x: m.reduce((a, b) => a + b.x, 0) / m.length, y: m.reduce((a, b) => a + b.y, 0) / m.length, z: m.reduce((a, b) => a + b.z, 0) / m.length };
};
const radius = (c) => c.m.reduce((a, b) => a + Math.hypot(b.x - c.x, b.y - c.y, b.z - c.z), 0) / c.m.length;
const cA = centroid('A'), cB = centroid('B');
const centroidDist = Math.hypot(cA.x - cB.x, cA.y - cB.y, cA.z - cB.z);
ok(centroidDist > radius(cA) + radius(cB),
  `boundaries are separated, not overlapping (centroids ${centroidDist.toFixed(1)} apart > radii ${radius(cA).toFixed(1)} + ${radius(cB).toFixed(1)})`);

console.log('[filter tag API + deterministic boundary colors]');
const g2 = new ReactivityGraph();
g2.addNode('A::x', 'x', 'ref');
g2.addNode('B::y', 'y', 'ref');
g2.addEdge('A::x', 'B::y');
const host = document.createElement('div');
document.body.appendChild(host);
const ov = mountOverlay(g2, { container: host, width: 200, height: 150 });
ok(typeof ov.setScopeVisible === 'function', 'overlay exposes setScopeVisible (per-scope filter)');
ov.setScopeVisible('A', false);
ov.setScopeVisible('A', true);
ov.setScopeVisible('', false); // the global group is filterable too
ok(true, 'toggling scope visibility does not throw');
ok(/^hsla\(/.test(scopeColor('App')) && scopeColor('App') === scopeColor('App'), 'scopeColor is deterministic per boundary');
ov.destroy();

console.log(`\n${fail === 0 ? 'ALL PASS' : 'FAILURES'}: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
