// Components as BOUNDARY + FILTER TAG: scope derivation from the deterministic
// id, template/boundary events, scope clustering in the force layout, and the
// overlay's per-scope filter API (headless happy-dom + canvas stub).
import { Window } from 'happy-dom';

const win = new Window();
globalThis.window = win;
globalThis.document = win.document;
// stub canvas 2d + rAF so the overlay runs headlessly. The stub also RECORDS
// draw frames (clearRect starts a draw()) and that frame's arc radii, so tests
// can observe how OFTEN the overlay draws (idle-CPU invariant) and how BIG it
// draws (zoom actually scales the scene).
const frames = { count: 0, arcs: [] };
win.HTMLCanvasElement.prototype.getContext = () => new Proxy({}, {
  get: (t, k) => {
    if (k === 'clearRect') return () => { frames.count++; frames.arcs = []; };
    if (k === 'arc') return (_x, _y, r) => { frames.arcs.push(r); };
    return k in t ? t[k] : () => {};
  },
  set: (t, k, v) => ((t[k] = v), true),
});
globalThis.requestAnimationFrame = (fn) => setTimeout(() => fn(0), 0);
globalThis.cancelAnimationFrame = (id) => clearTimeout(id);

const { ReactivityGraph } = await import('../dist/reactivity-graph/graph.js');
const { createForceLayout, mountOverlay, scopeColor, boundingRadius } = await import('../dist/reactivity-graph/overlay.js');

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

console.log('[many boundaries stay separated in the default (auto-fit) view]');
// The real fuzz case: dozens of components at once. Rather than cramming them into
// a fixed sphere (which piled the hulls — overlapRate was ~0.62 at 40 scopes), the
// sim GROWS its clamp radius with the scope count so components reach their natural
// spacing; the camera frames that grown radius and the default view auto-fits the
// whole cloud (zoom = base/radius). This block reproduces that exact view and
// asserts the hulls stay mostly separated and the sphere actually grew.
{
  const W = 460, H = 360;
  const many = createForceLayout(W, H);
  let s = 12345; const rnd = () => (s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  const kinds = ['ref', 'reactive', 'computed', 'watch', 'watchEffect'];
  const groups = [];
  for (let g = 0; g < 40; g++) {
    const scope = 'C' + g, ids = [];
    const n = 1 + Math.floor(rnd() * 4);
    for (let i = 0; i < n; i++) { const id = `${scope}::n${i}`; many.addBody({ id, label: 'n' + i, kind: kinds[i % kinds.length], origin: 'runtime', scope }); ids.push(id); }
    for (let i = 0; i < n - 1; i++) many.addSpring({ from: ids[i], to: ids[i + 1], origin: 'runtime', kind: 'read' });
    groups.push(ids);
  }
  for (let g = 1; g < 40; g++) if (rnd() < 0.5) many.addSpring({ from: groups[g - 1][0], to: groups[g][0], origin: 'runtime', kind: 'read' });
  let st = 0; while (!many.settled && st < 5000) { many.step(); st++; }
  const base = boundingRadius(W, H), Rgrown = many.radius;
  ok(Rgrown > base * 1.5, `the sphere grows with the scope count (radius ${Rgrown.toFixed(0)} > ${(base * 1.5).toFixed(0)}) — components spread instead of cramming`);
  // reproduce the default view exactly: camera frames the GROWN radius + auto-fit zoom
  const cx = W / 2, cy = H / 2, CAM = Rgrown * 2.6;
  const zoom = Math.max(0.05, Math.min(8, base / Rgrown));
  const proj = new Map();
  for (const b of many.bodies.values()) { const sc = zoom * CAM / Math.max(CAM - b.z, 1); proj.set(b.id, { sx: cx + b.x * sc, sy: cy + b.y * sc, scale: sc }); }
  // build one hull circle per scope with the same formula as drawBoundaries()
  const hulls = new Map();
  for (const b of many.bodies.values()) { const p = proj.get(b.id); let hl = hulls.get(b.scope); if (!hl) hulls.set(b.scope, hl = { sx: 0, sy: 0, n: 0, r: 0 }); hl.sx += p.sx; hl.sy += p.sy; hl.n++; }
  for (const [scope, hl] of hulls) {
    hl.sx /= hl.n; hl.sy /= hl.n;
    for (const b of many.bodies.values()) { if (b.scope !== scope) continue; const p = proj.get(b.id); const d = Math.hypot(p.sx - hl.sx, p.sy - hl.sy) + 20 * p.scale; if (d > hl.r) hl.r = d; }
    hl.r = Math.max(hl.r + 18, 42); // hull padding — keep in sync with drawBoundaries()
  }
  const H2 = [...hulls.values()];
  let pairs = 0, over = 0, sumR = 0;
  for (let i = 0; i < H2.length; i++) { sumR += H2[i].r; for (let j = i + 1; j < H2.length; j++) { pairs++; if (Math.hypot(H2[i].sx - H2[j].sx, H2[i].sy - H2[j].sy) < H2[i].r + H2[j].r) over++; } }
  const rate = over / pairs, meanR = sumR / H2.length;
  // guards the BALANCE the tool wants: in the whole-cloud default view, far fewer
  // overlaps than the old crammed layout (~0.62 at 40 scopes) while hulls stay
  // large/legible (not collapsed to dots). Zooming in separates them further.
  ok(rate < 0.35, `40 boundaries mostly don't overlap in the default view (overlapRate ${rate.toFixed(3)} < 0.35, baseline ~0.62)`);
  ok(meanR > 30, `boundary hulls stay large enough to read (mean hull radius ${meanR.toFixed(1)}px > 30, not collapsed)`);
}

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
ok(typeof ov.setKindVisible === 'function', 'overlay exposes setKindVisible (per-kind filter)');
ov.setKindVisible('ref', false);
ov.setKindVisible('ref', true);
ov.setKindVisible('computed', false);
ok(true, 'toggling kind visibility does not throw');
ok(/^hsla\(/.test(scopeColor('App')) && scopeColor('App') === scopeColor('App'), 'scopeColor is deterministic per boundary');

console.log('[wheel → zoom: event wiring + view-only invariant]');
// wait until the overlay is TRULY idle: no new draw frames across a sustained
// window of loop ticks (the settled sim + no anims + no camera motion = no draw)
const idle = async () => {
  for (let quiet = 0; quiet < 30;) {
    const seen = frames.count;
    await new Promise((r) => setTimeout(r, 2));
    quiet = frames.count === seen ? quiet + 1 : 0;
  }
};
const mkWheel = (deltaY) => {
  const e = new win.Event('wheel', { bubbles: true, cancelable: true });
  e.deltaY = deltaY; e.deltaMode = 0;
  return e;
};
await idle();
const baseRadius = Math.min(...frames.arcs); // smallest arc in a frame = a node circle (9·scale)

// a same-tick burst of wheel events must cost exactly ONE redraw: zoom is
// view-only, so it must NOT wake the force sim (a woken sim draws ~170 frames)
const seenWheel = frames.count;
let consumed = true;
for (let i = 0; i < 4; i++) { const e = mkWheel(-120); ov.canvas.dispatchEvent(e); consumed = e.defaultPrevented && consumed; }
await idle();
ok(consumed, 'wheel on the canvas is handled (preventDefault → no page scroll)');
ok(frames.count - seenWheel === 1, `wheel burst = exactly one redraw, sim stays asleep (got ${frames.count - seenWheel} frames)`);
// …and the wheel actually zoomed: node circles grow by EXACTLY the zoom factor
const zoomRatio = Math.min(...frames.arcs) / baseRadius;
const expected = Math.exp(4 * 120 * 0.0015); // 4 notches · 120px · ZOOM_SPEED
// 1e-6 tolerance: the baseline frame predates the sim's final (undrawn) micro-step,
// so radii carry ~1e-9 px of positional noise; a real regression is >10% off
ok(Math.abs(zoomRatio - expected) < 1e-6, `4 notches in scales the scene by e^0.72 ≈ ${expected.toFixed(3)} (got ×${zoomRatio.toFixed(3)})`);

// dblclick resets zoom (and orientation): one redraw, radii back to baseline exactly
const seenReset = frames.count;
ov.canvas.dispatchEvent(new win.MouseEvent('dblclick', { bubbles: true }));
await idle();
ok(frames.count - seenReset === 1, 'dblclick reset = exactly one redraw (still no sim wake)');
ok(Math.abs(Math.min(...frames.arcs) - baseRadius) < 1e-6, 'dblclick resets zoom to 1 (node radii return to baseline)');

// …but not while paused: a collapsed panel must not swallow the page's scroll
ov.pause();
const wheelPaused = mkWheel(-120);
ov.canvas.dispatchEvent(wheelPaused);
ok(!wheelPaused.defaultPrevented, 'wheel is ignored while paused (page scroll not hijacked)');
ov.resume();
ov.destroy();

console.log(`\n${fail === 0 ? 'ALL PASS' : 'FAILURES'}: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
