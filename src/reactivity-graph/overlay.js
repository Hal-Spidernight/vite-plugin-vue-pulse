// @ts-check
/**
 * Canvas overlay: force-directed reactivity graph with glowing nodes and
 * propagation pulses. Zero external dependencies (self-contained force sim +
 * canvas renderer) so it can be dropped into any Vite/Vue app or a plain HTML
 * page.
 *
 * Subscribe model: it listens to the shared `graph` store's events —
 *   node  -> add a body to the sim
 *   edge  -> add a spring
 *   glow  -> flash the node
 *   pulse -> send a travelling dot along the edge
 */

const KIND_STYLE = {
  ref:         { color: '#38bdf8', ring: '#7dd3fc', label: 'ref' },
  reactive:    { color: '#a78bfa', ring: '#c4b5fd', label: 'reactive' },
  computed:    { color: '#34d399', ring: '#6ee7b7', label: 'computed' },
  watch:       { color: '#fbbf24', ring: '#fcd34d', label: 'watch' },
  watchEffect: { color: '#fb7185', ring: '#fda4af', label: 'watchEffect' },
};

/**
 * @param {import('./graph.js').ReactivityGraph} graph
 * @param {{ container?: HTMLElement, width?: number, height?: number }} [opts]
 */
export function mountOverlay(graph, opts = {}) {
  const host = opts.container || document.body;
  const canvas = document.createElement('canvas');
  const ctx = /** @type {CanvasRenderingContext2D} */ (canvas.getContext('2d'));
  const state = { w: opts.width || host.clientWidth || 720, h: opts.height || host.clientHeight || 480 };

  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  function size() {
    state.w = opts.width || host.clientWidth || state.w;
    state.h = opts.height || host.clientHeight || state.h;
    canvas.width = state.w * dpr;
    canvas.height = state.h * dpr;
    canvas.style.width = state.w + 'px';
    canvas.style.height = state.h + 'px';
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }
  canvas.style.display = 'block';
  host.appendChild(canvas);
  size();
  window.addEventListener('resize', size);

  /** @type {Map<string, any>} */
  const bodies = new Map();
  /** @type {Array<any>} */
  const springs = [];
  /** @type {Array<any>} */
  const pulses = [];

  function ensureBody(node) {
    if (bodies.has(node.id)) return bodies.get(node.id);
    const b = {
      id: node.id, label: node.label, kind: node.kind,
      x: state.w / 2 + (Math.random() - 0.5) * 160,
      y: state.h / 2 + (Math.random() - 0.5) * 160,
      vx: 0, vy: 0, glow: 0,
    };
    bodies.set(node.id, b);
    return b;
  }

  for (const n of graph.nodes.values()) ensureBody(n);
  for (const e of graph.edges.values()) springs.push({ ...e });

  const unsub = graph.subscribe((ev) => {
    if (ev.type === 'node' && ev.node) ensureBody(ev.node);
    else if (ev.type === 'edge' && ev.edge) springs.push({ ...ev.edge });
    else if (ev.type === 'glow' && ev.nodeId) { const b = bodies.get(ev.nodeId); if (b) b.glow = 1; }
    else if (ev.type === 'pulse') pulses.push({ from: ev.from, to: ev.to, t: 0 });
    else if (ev.type === 'reset') { bodies.clear(); springs.length = 0; pulses.length = 0; }
  });

  // ---- force simulation -------------------------------------------------
  function step() {
    const arr = [...bodies.values()];
    const cx = state.w / 2, cy = state.h / 2;
    for (const b of arr) {
      // gentle centering
      b.vx += (cx - b.x) * 0.0015;
      b.vy += (cy - b.y) * 0.0015;
    }
    // repulsion
    for (let i = 0; i < arr.length; i++) {
      for (let j = i + 1; j < arr.length; j++) {
        const a = arr[i], b = arr[j];
        let dx = a.x - b.x, dy = a.y - b.y;
        let d2 = dx * dx + dy * dy || 0.01;
        const d = Math.sqrt(d2);
        const f = 2600 / d2;
        const ux = dx / d, uy = dy / d;
        a.vx += ux * f; a.vy += uy * f;
        b.vx -= ux * f; b.vy -= uy * f;
      }
    }
    // springs (edges) — directed, target rest length
    for (const s of springs) {
      const a = bodies.get(s.from), b = bodies.get(s.to);
      if (!a || !b) continue;
      const dx = b.x - a.x, dy = b.y - a.y;
      const d = Math.hypot(dx, dy) || 0.01;
      const f = (d - 120) * 0.02;
      const ux = dx / d, uy = dy / d;
      a.vx += ux * f; a.vy += uy * f;
      b.vx -= ux * f; b.vy -= uy * f;
    }
    for (const b of arr) {
      b.vx *= 0.82; b.vy *= 0.82;
      b.x += b.vx; b.y += b.vy;
      b.x = Math.max(30, Math.min(state.w - 30, b.x));
      b.y = Math.max(30, Math.min(state.h - 30, b.y));
      if (b.glow > 0) b.glow = Math.max(0, b.glow - 0.02);
    }
    for (const p of pulses) p.t += 0.035;
    for (let i = pulses.length - 1; i >= 0; i--) if (pulses[i].t >= 1) pulses.splice(i, 1);
  }

  // ---- render -----------------------------------------------------------
  function draw() {
    ctx.clearRect(0, 0, state.w, state.h);

    // edges — read (dep->effect) gray; write (effect->reactive it mutates) amber
    ctx.lineWidth = 1.2;
    for (const s of springs) {
      const a = bodies.get(s.from), b = bodies.get(s.to);
      if (!a || !b) continue;
      const write = s.kind === 'write';
      ctx.strokeStyle = write
        ? (s.origin === 'static' ? 'rgba(251,191,36,0.4)' : 'rgba(251,191,36,0.75)')
        : (s.origin === 'static' ? 'rgba(148,163,184,0.35)' : 'rgba(148,163,184,0.6)');
      ctx.setLineDash(s.origin === 'static' ? [4, 4] : []);
      ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
      ctx.setLineDash([]);
      drawArrow(a, b, write ? 'rgba(251,191,36,0.9)' : 'rgba(148,163,184,0.7)');
    }

    // pulses (travelling dots)
    for (const p of pulses) {
      const a = bodies.get(p.from), b = bodies.get(p.to);
      if (!a || !b) continue;
      const x = a.x + (b.x - a.x) * ease(p.t);
      const y = a.y + (b.y - a.y) * ease(p.t);
      const r = 5 * (1 - p.t) + 2;
      ctx.beginPath();
      ctx.fillStyle = 'rgba(250,250,255,' + (1 - p.t) + ')';
      ctx.shadowColor = '#fef08a'; ctx.shadowBlur = 16;
      ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill();
      ctx.shadowBlur = 0;
    }

    // nodes
    for (const b of bodies.values()) {
      const st = KIND_STYLE[b.kind] || KIND_STYLE.ref;
      if (b.glow > 0) {
        ctx.beginPath();
        ctx.fillStyle = hexA(st.ring, 0.18 * b.glow);
        ctx.arc(b.x, b.y, 14 + 20 * b.glow, 0, Math.PI * 2); ctx.fill();
      }
      ctx.beginPath();
      ctx.fillStyle = st.color;
      ctx.shadowColor = st.ring; ctx.shadowBlur = 8 + 22 * b.glow;
      ctx.arc(b.x, b.y, 9, 0, Math.PI * 2); ctx.fill();
      ctx.shadowBlur = 0;
      ctx.fillStyle = '#e5e7eb';
      ctx.font = '11px ui-monospace, monospace';
      ctx.textAlign = 'center';
      ctx.fillText(b.label, b.x, b.y - 14);
    }
  }

  function drawArrow(a, b, color = 'rgba(148,163,184,0.7)') {
    const ang = Math.atan2(b.y - a.y, b.x - a.x);
    const ex = b.x - Math.cos(ang) * 11, ey = b.y - Math.sin(ang) * 11;
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.moveTo(ex, ey);
    ctx.lineTo(ex - Math.cos(ang - 0.4) * 7, ey - Math.sin(ang - 0.4) * 7);
    ctx.lineTo(ex - Math.cos(ang + 0.4) * 7, ey - Math.sin(ang + 0.4) * 7);
    ctx.closePath(); ctx.fill();
  }

  let raf = 0;
  function loop() { step(); draw(); raf = requestAnimationFrame(loop); }
  loop();

  return {
    canvas,
    destroy() { cancelAnimationFrame(raf); unsub(); window.removeEventListener('resize', size); canvas.remove(); },
  };
}

function ease(t) { return t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2; }
function hexA(hex, a) {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}

export { KIND_STYLE };
