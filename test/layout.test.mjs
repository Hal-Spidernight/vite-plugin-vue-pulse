// The force layout must SETTLE (stop moving) instead of animating forever, now in
// 3D. Drives the pure force sim headlessly and asserts it reaches `settled` within
// a bounded number of steps, stays asleep until woken, and keeps every body inside
// the model-space bounding SPHERE. Also exercises the pure rotation math the camera
// is built on (identity / round-trip / orthonormality), no DOM required.
import {
  createForceLayout, boundingRadius,
  mat3Identity, mat3Mul, mat3RotX, mat3RotY, mat3Orthonormalize, rotatePoint,
} from '../dist/reactivity-graph/overlay.js';

let pass = 0, fail = 0;
const ok = (c, m) => (c ? (pass++, console.log('  ✓', m)) : (fail++, console.error('  ✗', m)));

const W = 460, H = 360;
const layout = createForceLayout(W, H);
// a non-trivial graph (chain + hub + a cycle), like a real component's reactivity
const kinds = ['ref', 'reactive', 'computed', 'watch', 'watchEffect', 'component'];
for (let i = 0; i < 30; i++) layout.addBody({ id: 'n' + i, label: 'n' + i, kind: kinds[i % kinds.length], origin: 'runtime' });
for (let i = 0; i < 29; i++) layout.addSpring({ from: 'n' + i, to: 'n' + (i + 1), origin: 'runtime', kind: 'read' });
for (let i = 0; i < 12; i++) layout.addSpring({ from: 'n0', to: 'n' + (i + 5), origin: 'runtime', kind: 'read' }); // hub
layout.addSpring({ from: 'n29', to: 'n0', origin: 'runtime', kind: 'write' }); // cycle

let steps = 0;
const MAX = 5000;
while (!layout.settled && steps < MAX) { layout.step(); steps++; }
console.log('[settle] steps to rest:', steps, '/ cap', MAX);
ok(layout.settled, 'layout settles (stops moving) — not animating forever');
ok(steps < MAX, `settled within the cap (${steps} steps)`);

// stepping again while settled is a no-op (stays asleep => no perpetual CPU)
const before = [...layout.bodies.values()].map((b) => [b.x, b.y, b.z]);
for (let i = 0; i < 100; i++) layout.step();
const after = [...layout.bodies.values()].map((b) => [b.x, b.y, b.z]);
ok(JSON.stringify(before) === JSON.stringify(after), 'stays asleep: further steps do not move anything');

// all bodies stayed within the model-space bounding SPHERE (nothing drifted out),
// mirroring the sim's clamp via the single shared boundingRadius() formula
const Rb = boundingRadius(W, H);
const contained = [...layout.bodies.values()].every(
  (b) => Number.isFinite(b.x) && Number.isFinite(b.y) && Number.isFinite(b.z) && Math.hypot(b.x, b.y, b.z) <= Rb + 1e-6,
);
ok(contained, `all nodes remain within the bounding sphere (R=${Rb})`);

// a graph change wakes it back up
layout.addBody({ id: 'n30', label: 'n30', kind: 'ref', origin: 'runtime' });
ok(!layout.settled, 'adding a node wakes the layout (re-settles on next change)');

// ── pure rotation math (the camera's foundation) ──────────────────────────
const I = mat3Identity();
const p0 = rotatePoint(I, 3, -4, 5);
ok(p0.x === 3 && p0.y === -4 && p0.z === 5, 'rotatePoint(identity) is the identity');

// composing a full 2π about Y returns to identity (within epsilon)
let spun = mat3Identity();
const N = 720, dTheta = (2 * Math.PI) / N;
for (let i = 0; i < N; i++) spun = mat3Orthonormalize(mat3Mul(mat3RotY(dTheta), spun));
const back = rotatePoint(spun, 1, 2, 3);
const roundTrip = Math.hypot(back.x - 1, back.y - 2, back.z - 3);
ok(roundTrip < 1e-6, `full 2π compose returns to identity (err ${roundTrip.toExponential(1)})`);

// after many random composes (mirroring applyRotation) the matrix stays a proper
// rotation: unit orthogonal rows and det ≈ +1
let m = mat3Identity();
for (let i = 0; i < 10000; i++) {
  const rx = (Math.random() - 0.5) * 0.2, ry = (Math.random() - 0.5) * 0.2;
  const dR = mat3Mul(mat3RotX(rx), mat3RotY(ry));
  m = mat3Orthonormalize(mat3Mul(dR, m)); // same pre-multiply as applyRotation
}
const row = (i) => [m[i * 3], m[i * 3 + 1], m[i * 3 + 2]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const len = (a) => Math.hypot(a[0], a[1], a[2]);
const r0 = row(0), r1 = row(1), r2 = row(2);
const unit = Math.abs(len(r0) - 1) < 1e-6 && Math.abs(len(r1) - 1) < 1e-6 && Math.abs(len(r2) - 1) < 1e-6;
const orth = Math.abs(dot(r0, r1)) < 1e-6 && Math.abs(dot(r0, r2)) < 1e-6 && Math.abs(dot(r1, r2)) < 1e-6;
const det =
  m[0] * (m[4] * m[8] - m[5] * m[7]) -
  m[1] * (m[3] * m[8] - m[5] * m[6]) +
  m[2] * (m[3] * m[7] - m[4] * m[6]);
ok(unit && orth, 'orientation stays orthonormal after 10k composes (unit, orthogonal rows)');
ok(Math.abs(det - 1) < 1e-6, `orientation stays a proper rotation (det=${det.toFixed(6)})`);

console.log(`\n${fail === 0 ? 'ALL PASS' : 'FAILURES'}: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
