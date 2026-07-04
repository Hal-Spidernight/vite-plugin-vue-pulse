/**
 * Canvas overlay: force-directed reactivity graph rendered as a rotatable 3D
 * point-cloud, with glowing nodes and propagation pulses. Zero external
 * dependencies (self-contained 3D force sim + our own rotation/projection math +
 * canvas renderer) so it can be dropped into any Vite/Vue app or a plain HTML
 * page.
 *
 * 3D: the force sim lays the graph out in an ORIGIN-CENTERED model space and
 * clamps it to a bounding sphere; the camera is an accumulated 3x3 rotation
 * matrix you spin by dragging (full 360° tumble in any direction, gimbal-lock
 * free) with inertia. Nothing is WebGL — we rotate/project every point ourselves
 * and paint back-to-front on a 2D canvas (painter's algorithm) so near nodes
 * occlude far ones, with atmospheric depth-fade for legibility at scale.
 *
 * The force simulation SETTLES TO SLEEP: once the layout stops moving it freezes
 * (no more force integration), and only wakes when the graph changes
 * (node/edge/remove/resize). Glow/pulse animations and camera spin still redraw
 * while active but do NOT jostle the layout — and once everything is at rest
 * (layout settled, no glow/pulse, camera still) the loop draws nothing, so an
 * idle panel costs zero CPU.
 *
 * Subscribe model: it listens to the shared `graph` store's events —
 *   node/edge/remove-* -> update + wake the layout
 *   glow               -> flash the node (redraw only)
 *   pulse              -> travelling dot along the edge (redraw only)
 */
import type { ReactivityGraph, GraphNode, GraphEdge, NodeKind } from './graph.js';

interface KindStyle { color: string; ring: string; label: string }

const KIND_STYLE: Record<NodeKind, KindStyle> = {
  ref:         { color: '#38bdf8', ring: '#7dd3fc', label: 'ref' },
  reactive:    { color: '#a78bfa', ring: '#c4b5fd', label: 'reactive' },
  computed:    { color: '#34d399', ring: '#6ee7b7', label: 'computed' },
  watch:       { color: '#fbbf24', ring: '#fcd34d', label: 'watch' },
  watchEffect: { color: '#fb7185', ring: '#fda4af', label: 'watchEffect' },
};

/**
 * Deterministic color for a component boundary/filter tag (hash → hue), so the
 * hull, its label and the panel's scope chips all agree without a registry.
 */
export function scopeColor(scope: string, alpha = 1): string {
  let hash = 0;
  for (let i = 0; i < scope.length; i++) hash = (hash * 31 + scope.charCodeAt(i)) | 0;
  const hue = ((hash % 360) + 360) % 360;
  return `hsla(${hue}, 70%, 62%, ${alpha})`;
}

// panel background — far nodes/edges desaturate toward this for atmospheric depth
const PANEL_BG: [number, number, number] = [11, 18, 32];

// precompute each kind's base colour as RGB so we can lerp it toward the
// background by a depth-driven amount (cheaper than re-parsing hex per frame)
const KIND_RGB: Record<NodeKind, [number, number, number]> = Object.fromEntries(
  (Object.keys(KIND_STYLE) as NodeKind[]).map((k) => {
    const n = parseInt(KIND_STYLE[k].color.slice(1), 16);
    return [k, [(n >> 16) & 255, (n >> 8) & 255, n & 255]];
  }),
) as Record<NodeKind, [number, number, number]>;

export interface Body {
  id: string; label: string; kind: NodeKind;
  /** component boundary this declaration belongs to (drives clustering + hull) */
  scope?: string;
  /** read by its component's template (drawn with a render-dep ring) */
  template?: boolean;
  x: number; y: number; z: number;
  vx: number; vy: number; vz: number;
  glow: number;
}
type Spring = GraphEdge;
interface Pulse { from: string; to: string; t: number }

// d3-force-style cooling: forces are scaled by `alpha`, which decays geometrically
// each step so the layout is GUARANTEED to freeze in a bounded number of steps
// (~170), regardless of how frustrated/cramped the graph is — no perpetual jitter.
const ALPHA_DECAY = 0.0228;    // reaches ALPHA_MIN from 1 in ~170 steps
const ALPHA_MIN = 0.02;
const VELOCITY_DECAY = 0.7;    // keep 70% of velocity per step (damping)
const GOLDEN_ANGLE = 2.399963229728653;
// pull toward the same-scope centroid so a component's declarations cluster
// inside its boundary hull (weak vs. the 2600 repulsion — clusters, not clumps)
const CLUSTER_PULL = 0.03;
// keep DIFFERENT boundaries visibly apart: cross-scope pairs repel harder and
// cross-boundary springs relax to a longer rest length than intra-scope ones
const CROSS_SCOPE_REPULSION = 2.4;
const SPRING_REST = 120;
const CROSS_SCOPE_REST = 230;

// margin between the bounding sphere and the panel edge (in px)
const NODE_MARGIN = 40;

/**
 * The radius of the model-space bounding sphere the layout is clamped to, AND
 * the framing radius the projection uses to fit the cloud in the panel. This is
 * the SINGLE source of truth shared by (a) the sim's sphere clamp, (b) draw()'s
 * camera framing, and (c) the layout test's containment assertion — so they can
 * never drift out of sync.
 */
export function boundingRadius(w: number, h: number): number {
  return Math.max(40, 0.5 * Math.min(w, h) - NODE_MARGIN);
}

/* ------------------------------------------------------------------ *
 * Pure 3x3 rotation math (row-major, p' = M · p, +z toward the viewer).
 * Exported so its invariants (identity, round-trip, orthonormality) are
 * testable without a DOM.
 * ------------------------------------------------------------------ */
export type Mat3 = number[];

export function mat3Identity(): Mat3 {
  return [1, 0, 0, 0, 1, 0, 0, 0, 1];
}

/** C = A · B (so applying C to a point = A applied after B). */
export function mat3Mul(a: Mat3, b: Mat3): Mat3 {
  const c = new Array(9);
  for (let r = 0; r < 3; r++) {
    for (let col = 0; col < 3; col++) {
      c[r * 3 + col] = a[r * 3] * b[col] + a[r * 3 + 1] * b[3 + col] + a[r * 3 + 2] * b[6 + col];
    }
  }
  return c;
}

export function mat3RotX(a: number): Mat3 {
  const c = Math.cos(a), s = Math.sin(a);
  return [1, 0, 0, 0, c, -s, 0, s, c];
}

export function mat3RotY(a: number): Mat3 {
  const c = Math.cos(a), s = Math.sin(a);
  return [c, 0, s, 0, 1, 0, -s, 0, c];
}

/**
 * Re-orthonormalize a (numerically-drifted) rotation matrix so repeated
 * composition can't accumulate skew/scale. Gram-Schmidt on the rows, then
 * row2 = row0 × row1 to guarantee a right-handed det = +1 rotation.
 */
export function mat3Orthonormalize(m: Mat3): Mat3 {
  let r0x = m[0], r0y = m[1], r0z = m[2];
  let l0 = Math.hypot(r0x, r0y, r0z) || 1;
  r0x /= l0; r0y /= l0; r0z /= l0;
  let r1x = m[3], r1y = m[4], r1z = m[5];
  const d = r1x * r0x + r1y * r0y + r1z * r0z;
  r1x -= d * r0x; r1y -= d * r0y; r1z -= d * r0z;
  let l1 = Math.hypot(r1x, r1y, r1z) || 1;
  r1x /= l1; r1y /= l1; r1z /= l1;
  // row2 = row0 × row1
  const r2x = r0y * r1z - r0z * r1y;
  const r2y = r0z * r1x - r0x * r1z;
  const r2z = r0x * r1y - r0y * r1x;
  return [r0x, r0y, r0z, r1x, r1y, r1z, r2x, r2y, r2z];
}

export function rotatePoint(m: Mat3, x: number, y: number, z: number): { x: number; y: number; z: number } {
  return {
    x: m[0] * x + m[1] * y + m[2] * z,
    y: m[3] * x + m[4] * y + m[5] * z,
    z: m[6] * x + m[7] * y + m[8] * z,
  };
}

function clamp01(v: number): number { return v < 0 ? 0 : v > 1 ? 1 : v; }

/** Lerp an rgb triple toward the panel background by `amt` (0 = unchanged, 1 = bg). */
function mixToBg(rgb: [number, number, number], amt: number): string {
  const r = rgb[0] + (PANEL_BG[0] - rgb[0]) * amt;
  const g = rgb[1] + (PANEL_BG[1] - rgb[1]) * amt;
  const b = rgb[2] + (PANEL_BG[2] - rgb[2]) * amt;
  return `rgb(${r | 0},${g | 0},${b | 0})`;
}

/**
 * Pure force-directed layout (no DOM), extracted so its convergence is testable.
 * Deterministic 3D phyllotaxis initial placement (an even spherical shell) +
 * centering/repulsion/springs with velocity damping, a bounding-sphere clamp,
 * and a settle-to-sleep tracker so it stops when at rest. Origin-centered:
 * (0,0,0) is the cloud centre; the camera/projection maps model → screen.
 */
export interface ForceLayout {
  bodies: Map<string, Body>;
  springs: Spring[];
  readonly settled: boolean;
  addBody(node: GraphNode): Body;
  addSpring(edge: GraphEdge): void;
  removeBody(id: string): void;
  removeSpring(edge: GraphEdge): void;
  clear(): void;
  resize(w: number, h: number): void;
  wake(): void;
  step(): void;
}

export function createForceLayout(width: number, height: number): ForceLayout {
  const bodies = new Map<string, Body>();
  const springs: Spring[] = [];
  let w = width, h = height;
  let R = boundingRadius(w, h);
  let placed = 0;
  let alpha = 1;
  let settled = false;

  return {
    bodies,
    springs,
    get settled() { return settled; },
    wake() { settled = false; alpha = 1; },
    resize(nw, nh) { w = nw; h = nh; R = boundingRadius(w, h); this.wake(); },
    addBody(node) {
      const found = bodies.get(node.id);
      if (found) return found;
      // deterministic 3D phyllotaxis: golden-angle longitude + a low-discrepancy
      // latitude (golden-ratio sequence) so incrementally-added points spread
      // over a sphere shell instead of collapsing into a plane or onto each other
      const i = placed++;
      const rad0 = 10 + 7 * Math.sqrt(i);
      const phi = i * GOLDEN_ANGLE;
      const zt = ((i * 0.61803398875) % 1) * 2 - 1;      // ∈ (-1, 1), evenly spread
      const ring = Math.sqrt(Math.max(0, 1 - zt * zt));
      const b: Body = {
        id: node.id, label: node.label, kind: node.kind,
        scope: node.scope, template: node.template,
        x: Math.cos(phi) * ring * rad0,
        y: Math.sin(phi) * ring * rad0,
        z: zt * rad0,
        vx: 0, vy: 0, vz: 0, glow: 0,
      };
      bodies.set(node.id, b);
      this.wake();
      return b;
    },
    addSpring(edge) { springs.push({ ...edge }); this.wake(); },
    removeBody(id) {
      bodies.delete(id);
      for (let i = springs.length - 1; i >= 0; i--) if (springs[i].from === id || springs[i].to === id) springs.splice(i, 1);
      this.wake();
    },
    removeSpring(edge) {
      for (let i = springs.length - 1; i >= 0; i--) {
        const s = springs[i];
        if (s.from === edge.from && s.to === edge.to && s.key === edge.key && s.kind === edge.kind) { springs.splice(i, 1); break; }
      }
      this.wake();
    },
    clear() { bodies.clear(); springs.length = 0; this.wake(); },
    step() {
      if (settled) return;
      const arr = [...bodies.values()];
      // all force impulses are scaled by alpha (which cools toward 0)
      for (const b of arr) {
        b.vx += (-b.x) * 0.0015 * alpha; // gentle centering toward the origin
        b.vy += (-b.y) * 0.0015 * alpha;
        b.vz += (-b.z) * 0.0015 * alpha;
      }
      for (let i = 0; i < arr.length; i++) {
        for (let j = i + 1; j < arr.length; j++) {
          const a = arr[i], b = arr[j];
          const dx = a.x - b.x, dy = a.y - b.y, dz = a.z - b.z;
          const d2 = dx * dx + dy * dy + dz * dz || 0.01; // coincident-point guard
          const d = Math.sqrt(d2);
          // bodies in different boundaries repel harder → hulls separate visibly
          const cross = a.scope !== b.scope && (a.scope || b.scope) ? CROSS_SCOPE_REPULSION : 1;
          const f = cross * 2600 / d2 * alpha;
          const ux = dx / d, uy = dy / d, uz = dz / d;
          a.vx += ux * f; a.vy += uy * f; a.vz += uz * f;
          b.vx -= ux * f; b.vy -= uy * f; b.vz -= uz * f;
        }
      }
      for (const s of springs) {
        const a = bodies.get(s.from), b = bodies.get(s.to);
        if (!a || !b) continue;
        const dx = b.x - a.x, dy = b.y - a.y, dz = b.z - a.z;
        const d = Math.hypot(dx, dy, dz) || 0.01; // coincident-point guard
        // a cross-boundary edge relaxes longer so linked hulls don't collide
        const rest = a.scope !== b.scope ? CROSS_SCOPE_REST : SPRING_REST;
        const f = (d - rest) * 0.02 * alpha;
        const ux = dx / d, uy = dy / d, uz = dz / d;
        a.vx += ux * f; a.vy += uy * f; a.vz += uz * f;
        b.vx -= ux * f; b.vy -= uy * f; b.vz -= uz * f;
      }
      // scope clustering: pull each body toward its component's centroid so the
      // boundary hulls come out compact and non-overlapping
      const centroids = new Map<string, { x: number; y: number; z: number; n: number }>();
      for (const b of arr) {
        if (!b.scope) continue;
        let c = centroids.get(b.scope);
        if (!c) centroids.set(b.scope, c = { x: 0, y: 0, z: 0, n: 0 });
        c.x += b.x; c.y += b.y; c.z += b.z; c.n++;
      }
      for (const b of arr) {
        if (!b.scope) continue;
        const c = centroids.get(b.scope)!;
        if (c.n < 2) continue;
        b.vx += (c.x / c.n - b.x) * CLUSTER_PULL * alpha;
        b.vy += (c.y / c.n - b.y) * CLUSTER_PULL * alpha;
        b.vz += (c.z / c.n - b.z) * CLUSTER_PULL * alpha;
      }
      for (const b of arr) {
        b.vx *= VELOCITY_DECAY; b.vy *= VELOCITY_DECAY; b.vz *= VELOCITY_DECAY;
        b.x += b.vx; b.y += b.vy; b.z += b.vz;
        // clamp to a bounding SPHERE (so the cloud stays framed at ANY rotation),
        // and kill the outward radial velocity so bodies don't grind on the shell
        const d = Math.hypot(b.x, b.y, b.z);
        if (d > R) {
          const k = R / d;
          b.x *= k; b.y *= k; b.z *= k;
          const vr = (b.vx * b.x + b.vy * b.y + b.vz * b.z) / (R * R);
          if (vr > 0) { b.vx -= vr * b.x; b.vy -= vr * b.y; b.vz -= vr * b.z; }
        }
      }
      alpha *= (1 - ALPHA_DECAY);
      if (arr.length === 0 || alpha < ALPHA_MIN) settled = true;
    },
  };
}

export interface OverlayHandle {
  canvas: HTMLCanvasElement;
  pause(): void;
  resume(): void;
  resetView(): void;
  /**
   * Filter tag: show/hide every node inside a component boundary (`''` = the
   * scopeless/global group). View-only — the sim keeps all bodies, so toggling
   * never reshuffles the layout.
   */
  setScopeVisible(scope: string, visible: boolean): void;
  destroy(): void;
}

// camera feel knobs
const ROTATE_SPEED = 0.01;   // rad per px of drag
const INERTIA_DECAY = 0.94;  // spin velocity retained per frame (~1s glide)
const SPIN_MIN = 0.0008;     // below this angular speed the spin stops (idle)
const CAM_DIST_MULT = 2.6;   // camera distance = CAM_DIST_MULT · boundingRadius

interface Proj { xr: number; yr: number; zr: number; scale: number; sx: number; sy: number }

export function mountOverlay(graph: ReactivityGraph, opts: { container?: HTMLElement; width?: number; height?: number } = {}): OverlayHandle {
  const host = opts.container || document.body;
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d') as CanvasRenderingContext2D;
  const state = { w: opts.width || host.clientWidth || 720, h: opts.height || host.clientHeight || 480 };

  const layout = createForceLayout(state.w, state.h);
  const bodies = layout.bodies;
  const springs = layout.springs;
  const pulses: Pulse[] = [];
  /** component boundary -> flash intensity (a re-render lights the hull, not a node) */
  const scopeFlash = new Map<string, number>();
  /** hidden filter tags ('' = the scopeless group) */
  const hiddenScopes = new Set<string>();
  const bodyVisible = (b: Body) => !hiddenScopes.has(b.scope || '');

  // ── camera (view-only; the sim never sees this) ──────────────────────────
  // accumulated orientation as a 3x3 rotation matrix; spin* are the angular
  // velocities (rad/frame about the screen X/Y axes) that drive inertia.
  let camR: Mat3 = mat3Identity();
  let dragging = false, spinning = false;
  let lastX = 0, lastY = 0;
  let spinX = 0, spinY = 0;
  let lastMoveT = 0;        // timestamp of the last pointermove (rejects stale-velocity flings)
  let cameraDirty = false;  // set on real camera motion; gates a redraw, never wakes the sim
  let paused = false;

  // "the loop is actually drawing this frame" — the SAME gate the RAF loop uses.
  // Transient glow/pulse events are only enqueued while this is true so a
  // collapsed/hidden panel can't accumulate animation state forever.
  function drawingActive(): boolean {
    return !paused && !(typeof document !== 'undefined' && document.hidden);
  }

  // pre-multiply a screen-relative increment so the tumble feels "grab & spin"
  // from any orientation (no Euler gimbal lock, no clamps → full 360°)
  function applyRotation(rotX: number, rotY: number) {
    const dR = mat3Mul(mat3RotX(rotX), mat3RotY(rotY));
    camR = mat3Orthonormalize(mat3Mul(dR, camR));
  }

  // inertia: apply the last drag velocity with geometric decay until it drops
  // below SPIN_MIN, then stop → the loop returns to true idle (finite, no perpetual CPU)
  function stepCamera() {
    if (!spinning) return;
    applyRotation(spinX, spinY);
    cameraDirty = true;
    spinX *= INERTIA_DECAY; spinY *= INERTIA_DECAY;
    if (Math.hypot(spinX, spinY) < SPIN_MIN) { spinX = 0; spinY = 0; spinning = false; }
  }

  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  let sized = false;
  function size() {
    const nw = opts.width || host.clientWidth || state.w;
    const nh = opts.height || host.clientHeight || state.h;
    // a resize event that doesn't change our dimensions must NOT wake the settled
    // sim (fixed-size panels get one on every window resize) — that would burn a
    // ~170-step CPU burst and reshuffle a resting cloud for nothing.
    if (sized && nw === state.w && nh === state.h) return;
    sized = true;
    state.w = nw; state.h = nh;
    canvas.width = state.w * dpr;
    canvas.height = state.h * dpr;
    canvas.style.width = state.w + 'px';
    canvas.style.height = state.h + 'px';
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    layout.resize(state.w, state.h); // recomputes the bounding-sphere radius + wakes
    cameraDirty = true;
  }
  canvas.style.display = 'block';
  canvas.style.touchAction = 'none';
  canvas.style.cursor = 'grab';
  host.appendChild(canvas);
  size();
  window.addEventListener('resize', size);

  for (const n of graph.nodes.values()) layout.addBody(n);
  for (const e of graph.edges.values()) layout.addSpring(e);

  const unsub = graph.subscribe((ev) => {
    if (ev.type === 'node' && ev.node) layout.addBody(ev.node);
    else if (ev.type === 'edge' && ev.edge) layout.addSpring(ev.edge);
    // glow/pulse for filtered-out scopes are dropped at ENQUEUE time (mirroring
    // the draw-time filter + the 'boundary' gate below) so a hidden noisy
    // component can't keep the anim loop burning redraw frames.
    else if (ev.type === 'glow' && ev.nodeId) { if (drawingActive()) { const b = bodies.get(ev.nodeId); if (b && bodyVisible(b)) b.glow = 1; } }
    else if (ev.type === 'pulse') {
      if (drawingActive()) {
        const a = bodies.get(ev.from!), b = bodies.get(ev.to!);
        if (a && b && bodyVisible(a) && bodyVisible(b)) pulses.push({ from: ev.from!, to: ev.to!, t: 0 });
      }
    }
    else if (ev.type === 'template' && ev.nodeId) { const b = bodies.get(ev.nodeId); if (b && !b.template) { b.template = true; cameraDirty = true; } }
    else if (ev.type === 'boundary' && ev.scope) { if (drawingActive() && !hiddenScopes.has(ev.scope)) scopeFlash.set(ev.scope, 1); }
    else if (ev.type === 'remove-node' && ev.nodeId) layout.removeBody(ev.nodeId);
    else if (ev.type === 'remove-edge' && ev.edge) layout.removeSpring(ev.edge);
    else if (ev.type === 'reset') { layout.clear(); pulses.length = 0; scopeFlash.clear(); }
  });

  // ── drag-to-rotate (pointer + touch, with capture so a drag can leave the canvas) ──
  function onPointerDown(e: PointerEvent) {
    if (paused) return;
    dragging = true; spinning = false; spinX = 0; spinY = 0;
    lastX = e.clientX; lastY = e.clientY;
    canvas.setPointerCapture?.(e.pointerId);
    canvas.style.cursor = 'grabbing';
    e.preventDefault();
  }
  function onPointerMove(e: PointerEvent) {
    if (!dragging) return;
    const dx = e.clientX - lastX, dy = e.clientY - lastY;
    lastX = e.clientX; lastY = e.clientY;
    const rotY = dx * ROTATE_SPEED;  // horizontal drag → spin about screen Y (grabbed point follows the cursor)
    const rotX = -dy * ROTATE_SPEED; // vertical drag → spin about screen X; negated so it ALSO follows the cursor (canvas y-down + screen y-flip)
    applyRotation(rotX, rotY);
    spinX = rotX; spinY = rotY;      // seed inertia with the last frame's velocity
    lastMoveT = nowMs();             // timestamp so a held-still release doesn't fling on a stale delta
    cameraDirty = true;              // NB: never layout.wake() — positions don't change
    e.preventDefault();
  }
  function endDrag(e: PointerEvent) {
    if (!dragging) return;
    dragging = false;
    canvas.releasePointerCapture?.(e.pointerId);
    canvas.style.cursor = 'grab';
    // fling → glide, but ONLY if the pointer was still moving at release; a
    // deliberate hold-then-release must not launch inertia from a stale velocity
    if (nowMs() - lastMoveT < 64 && Math.hypot(spinX, spinY) > SPIN_MIN) spinning = true;
  }
  function doReset() {
    camR = mat3Identity(); spinX = 0; spinY = 0; spinning = false; dragging = false;
    cameraDirty = true;
  }
  canvas.addEventListener('pointerdown', onPointerDown);
  canvas.addEventListener('pointermove', onPointerMove);
  canvas.addEventListener('pointerup', endDrag);
  canvas.addEventListener('pointercancel', endDrag);
  canvas.addEventListener('dblclick', doReset);

  function anyGlow() { for (const b of bodies.values()) if (b.glow > 0) return true; return false; }

  // advance transient animations (glow decay + pulse travel + boundary flash) —
  // independent of the force sim, so they still play when the layout is asleep.
  function animate() {
    for (const b of bodies.values()) if (b.glow > 0) b.glow = Math.max(0, b.glow - 0.02);
    for (const p of pulses) p.t += 0.035;
    for (let i = pulses.length - 1; i >= 0; i--) if (pulses[i].t >= 1) pulses.splice(i, 1);
    for (const [s, v] of scopeFlash) { const nv = v - 0.025; if (nv <= 0) scopeFlash.delete(s); else scopeFlash.set(s, nv); }
  }

  interface Drawable { depth: number; type: 0 | 1 | 2; s?: Spring; b?: Body; p?: Proj; t?: number }

  function draw() {
    ctx.clearRect(0, 0, state.w, state.h);

    // per-frame camera framing (recomputed from state so resize just works)
    const cx = state.w / 2, cy = state.h / 2;
    const Rb = boundingRadius(state.w, state.h);
    const CAM_DIST = Rb * CAM_DIST_MULT;
    const FOCAL = CAM_DIST; // base scale = 1 at the equator (zr = 0)
    const m0 = camR[0], m1 = camR[1], m2 = camR[2];
    const m3 = camR[3], m4 = camR[4], m5 = camR[5];
    const m6 = camR[6], m7 = camR[7], m8 = camR[8];

    const project = (x: number, y: number, z: number): Proj => {
      const xr = m0 * x + m1 * y + m2 * z;
      const yr = m3 * x + m4 * y + m5 * z;
      const zr = m6 * x + m7 * y + m8 * z; // +z toward the viewer → larger = nearer
      const scale = FOCAL / Math.max(CAM_DIST - zr, 1);
      return { xr, yr, zr, scale, sx: cx + xr * scale, sy: cy + yr * scale };
    };

    // project every body once; track the model radius for a rotation-invariant
    // fog scale (using zr for fog would flicker as you spin)
    const proj = new Map<string, Proj>();
    let Rmodel = 1;
    for (const b of bodies.values()) {
      proj.set(b.id, project(b.x, b.y, b.z));
      const rm = Math.hypot(b.x, b.y, b.z);
      if (rm > Rmodel) Rmodel = rm;
    }

    drawBoundaries(proj);

    // ONE depth-sorted list of edges + nodes + pulses so near occludes far
    const drawables: Drawable[] = [];
    for (const s of springs) {
      const a = proj.get(s.from), b = proj.get(s.to);
      if (!a || !b) continue;
      const ba = bodies.get(s.from), bb = bodies.get(s.to);
      if (!ba || !bb || !bodyVisible(ba) || !bodyVisible(bb)) continue; // filter tag
      drawables.push({ depth: (a.zr + b.zr) / 2, type: 0, s });
    }
    for (const b of bodies.values()) {
      if (!bodyVisible(b)) continue; // filter tag
      const p = proj.get(b.id)!;
      drawables.push({ depth: p.zr, type: 1, b });
    }
    for (const p of pulses) {
      const a = bodies.get(p.from), b = bodies.get(p.to);
      if (!a || !b || !bodyVisible(a) || !bodyVisible(b)) continue;
      const e = ease(p.t);
      const pp = project(a.x + (b.x - a.x) * e, a.y + (b.y - a.y) * e, a.z + (b.z - a.z) * e);
      drawables.push({ depth: pp.zr, type: 2, p: pp, t: p.t });
    }
    // ascending zr → far (small zr) drawn first, near (large zr) last (on top)
    drawables.sort((u, v) => u.depth - v.depth);

    for (const d of drawables) {
      const fog = clamp01(0.5 - 0.5 * d.depth / Rmodel); // 0 near .. 1 far
      if (d.type === 0) drawEdge(d.s!, proj, fog);
      else if (d.type === 1) drawNode(d.b!, proj.get(d.b!.id)!, fog);
      else drawPulse(d.p!, d.t!);
    }
  }

  /**
   * Component boundaries: a translucent hull (screen-space circle) around each
   * scope's projected cluster, labeled with the component name. Drawn UNDER the
   * graph — a boundary is context, not a node. A re-render flashes it.
   */
  function drawBoundaries(proj: Map<string, Proj>) {
    interface Hull { sx: number; sy: number; n: number; r: number }
    const hulls = new Map<string, Hull>();
    for (const b of bodies.values()) {
      if (!b.scope || !bodyVisible(b)) continue;
      const p = proj.get(b.id);
      if (!p) continue;
      let hl = hulls.get(b.scope);
      if (!hl) hulls.set(b.scope, hl = { sx: 0, sy: 0, n: 0, r: 0 });
      hl.sx += p.sx; hl.sy += p.sy; hl.n++;
    }
    for (const [scope, hl] of hulls) {
      hl.sx /= hl.n; hl.sy /= hl.n;
      for (const b of bodies.values()) {
        if (b.scope !== scope || !bodyVisible(b)) continue;
        const p = proj.get(b.id);
        if (!p) continue;
        const d = Math.hypot(p.sx - hl.sx, p.sy - hl.sy) + 14 * p.scale;
        if (d > hl.r) hl.r = d;
      }
      hl.r = Math.max(hl.r + 12, 26);
    }
    // larger hulls first so overlapping smaller ones stay legible
    const sorted = [...hulls.entries()].sort((a, b) => b[1].r - a[1].r);
    for (const [scope, hl] of sorted) {
      const flash = scopeFlash.get(scope) || 0;
      ctx.beginPath();
      ctx.fillStyle = scopeColor(scope, 0.05 + 0.14 * flash);
      ctx.arc(hl.sx, hl.sy, hl.r, 0, Math.PI * 2);
      ctx.fill();
      ctx.lineWidth = 1 + flash;
      ctx.strokeStyle = scopeColor(scope, 0.30 + 0.55 * flash);
      ctx.setLineDash([6, 5]);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = scopeColor(scope, 0.65 + 0.35 * flash);
      ctx.font = '10px ui-monospace, monospace';
      ctx.textAlign = 'center';
      ctx.fillText(`⟨${scope}⟩`, hl.sx, hl.sy - hl.r - 4);
    }
  }

  function drawEdge(s: Spring, proj: Map<string, Proj>, fog: number) {
    const a = proj.get(s.from), b = proj.get(s.to);
    if (!a || !b) return;
    const write = s.kind === 'write';
    ctx.globalAlpha = 1 - 0.6 * fog;
    ctx.lineWidth = Math.max(0.4, 1.2 * (a.scale + b.scale) / 2);
    ctx.strokeStyle = write
      ? (s.origin === 'static' ? 'rgba(251,191,36,0.4)' : 'rgba(251,191,36,0.75)')
      : (s.origin === 'static' ? 'rgba(148,163,184,0.35)' : 'rgba(148,163,184,0.6)');
    ctx.setLineDash(s.origin === 'static' ? [4, 4] : []);
    ctx.beginPath(); ctx.moveTo(a.sx, a.sy); ctx.lineTo(b.sx, b.sy); ctx.stroke();
    ctx.setLineDash([]);
    drawArrow(a, b, write ? 'rgba(251,191,36,0.9)' : 'rgba(148,163,184,0.7)');
    ctx.globalAlpha = 1;
  }

  function drawArrow(a: Proj, b: Proj, color: string) {
    const ang = Math.atan2(b.sy - a.sy, b.sx - a.sx);
    const back = 11 * b.scale, barb = 7 * b.scale;
    const ex = b.sx - Math.cos(ang) * back, ey = b.sy - Math.sin(ang) * back;
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.moveTo(ex, ey);
    ctx.lineTo(ex - Math.cos(ang - 0.4) * barb, ey - Math.sin(ang - 0.4) * barb);
    ctx.lineTo(ex - Math.cos(ang + 0.4) * barb, ey - Math.sin(ang + 0.4) * barb);
    ctx.closePath(); ctx.fill();
  }

  function drawNode(b: Body, p: Proj, fog: number) {
    const st = KIND_STYLE[b.kind] || KIND_STYLE.ref;
    const rgb = KIND_RGB[b.kind] || KIND_RGB.ref;
    const scale = p.scale;
    const r = 9 * scale;
    const alpha = 1 - 0.7 * fog;
    if (b.glow > 0) {
      ctx.globalAlpha = 0.18 * b.glow * alpha;
      ctx.beginPath();
      ctx.fillStyle = st.ring;
      ctx.arc(p.sx, p.sy, (14 + 20 * b.glow) * scale, 0, Math.PI * 2); ctx.fill();
    }
    ctx.globalAlpha = alpha;
    ctx.beginPath();
    ctx.fillStyle = mixToBg(rgb, 0.55 * fog);
    ctx.shadowColor = st.ring;
    ctx.shadowBlur = b.glow > 0 ? (8 + 22 * b.glow) * scale : (fog < 0.4 ? 6 * scale : 0);
    ctx.arc(p.sx, p.sy, r, 0, Math.PI * 2); ctx.fill();
    ctx.shadowBlur = 0;
    // render-dep marker: a thin outer ring on declarations the template reads
    if (b.template) {
      ctx.beginPath();
      ctx.lineWidth = Math.max(0.5, 1 * scale);
      ctx.strokeStyle = `rgba(226,232,240,${0.65 * alpha})`;
      ctx.arc(p.sx, p.sy, r + 3 * scale, 0, Math.PI * 2);
      ctx.stroke();
    }
    // label only for near/front nodes (declutter at scale)
    if (fog < 0.5 && scale >= 0.95) {
      ctx.globalAlpha = clamp01((0.5 - fog) / 0.5);
      ctx.fillStyle = '#e5e7eb';
      ctx.font = `${Math.max(8, Math.round(11 * scale))}px ui-monospace, monospace`;
      ctx.textAlign = 'center';
      ctx.fillText(b.label, p.sx, p.sy - (r + 5));
    }
    ctx.globalAlpha = 1;
  }

  function drawPulse(p: Proj, t: number) {
    const r = (5 * (1 - t) + 2) * p.scale;
    ctx.globalAlpha = 1 - t;
    ctx.beginPath();
    ctx.fillStyle = 'rgb(250,250,255)';
    ctx.shadowColor = '#fef08a'; ctx.shadowBlur = 16 * p.scale;
    ctx.arc(p.sx, p.sy, r, 0, Math.PI * 2); ctx.fill();
    ctx.shadowBlur = 0;
    ctx.globalAlpha = 1;
  }

  let raf = 0;
  // ONE authoritative gate: draw iff the layout is moving, an animation is
  // active, OR the camera moved this frame — otherwise idle at zero CPU.
  function loop() {
    if (drawingActive()) {
      if (!layout.settled) layout.step();
      stepCamera();
      const anim = pulses.length > 0 || anyGlow() || scopeFlash.size > 0;
      if (anim) animate();
      if (!layout.settled || anim || cameraDirty) draw();
      cameraDirty = false;
    }
    raf = requestAnimationFrame(loop);
  }
  loop();

  const onVisibility = () => { /* loop re-checks document.hidden each frame */ };
  if (typeof document !== 'undefined') document.addEventListener('visibilitychange', onVisibility);

  return {
    canvas,
    pause() { paused = true; },
    // no layout.wake(): positions didn't change while paused (a graph change
    // during the pause already woke the sim), so expanding the panel must redraw
    // — not re-run ~170 sim steps and reshuffle a resting cloud.
    resume() { paused = false; pulses.length = 0; scopeFlash.clear(); cameraDirty = true; },
    resetView() { doReset(); },
    setScopeVisible(scope, visible) {
      if (visible) hiddenScopes.delete(scope);
      else { hiddenScopes.add(scope); scopeFlash.delete(scope); }
      cameraDirty = true; // view-only: redraw, never reshuffle the layout
    },
    destroy() {
      cancelAnimationFrame(raf);
      unsub();
      window.removeEventListener('resize', size);
      if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', onVisibility);
      canvas.removeEventListener('pointerdown', onPointerDown);
      canvas.removeEventListener('pointermove', onPointerMove);
      canvas.removeEventListener('pointerup', endDrag);
      canvas.removeEventListener('pointercancel', endDrag);
      canvas.removeEventListener('dblclick', doReset);
      canvas.remove();
    },
  };
}

function ease(t: number): number { return t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2; }
function nowMs(): number { return typeof performance !== 'undefined' ? performance.now() : Date.now(); }

export { KIND_STYLE };
