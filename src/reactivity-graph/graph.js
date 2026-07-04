// @ts-check
/**
 * Reactivity graph store.
 *
 * Holds the *nodes* (ref / reactive / computed / watch / watchEffect) and the
 * *edges* (dependency -> dependent, i.e. "when `from` changes, `to` re-runs").
 *
 * The store is framework-agnostic and side-effect free: the runtime tracer
 * feeds it discovered edges and propagation events, and the overlay subscribes
 * to render them. The exact same node/edge shape is what the static analyzer
 * (croquis / the TS mirror) emits. That shared shape is the contract that lets
 * the static "map" and the runtime "traffic" overlay onto one graph.
 *
 * @typedef {'ref'|'reactive'|'computed'|'watch'|'watchEffect'} NodeKind
 * @typedef {Object} GraphNode
 * @property {string} id
 * @property {string} label
 * @property {NodeKind} kind
 * @property {'static'|'runtime'} origin
 *
 * @typedef {Object} GraphEdge
 * @property {string} from
 * @property {string} to
 * @property {string=} key
 * @property {'static'|'runtime'} origin
 *
 * @typedef {Object} GraphEvent
 * @property {'node'|'edge'|'glow'|'pulse'|'reset'} type
 * @property {GraphNode=} node
 * @property {GraphEdge=} edge
 * @property {string=} nodeId
 * @property {string=} from
 * @property {string=} to
 */

export class ReactivityGraph {
  constructor() {
    /** @type {Map<string, GraphNode>} */
    this.nodes = new Map();
    /** @type {Map<string, string>} label -> node id (for static/runtime reconciliation) */
    this.labelIndex = new Map();
    /** @type {Map<string, GraphEdge>} */
    this.edges = new Map();
    /** @type {Set<(e: GraphEvent) => void>} */
    this.subscribers = new Set();
    /** @type {Map<string, number>} origin node -> last cascade timestamp (debounce) */
    this.lastCascade = new Map();
    /** one user action = one ripple: collapse duplicate origin triggers within this window */
    this.cascadeDebounceMs = 120;
  }

  /** @param {(e: GraphEvent) => void} fn @returns {() => void} */
  subscribe(fn) {
    this.subscribers.add(fn);
    return () => this.subscribers.delete(fn);
  }

  /** @param {GraphEvent} e */
  emit(e) {
    for (const fn of this.subscribers) fn(e);
  }

  /**
   * @param {string} id
   * @param {string} label
   * @param {NodeKind} kind
   * @param {'static'|'runtime'} [origin]
   */
  addNode(id, label, kind, origin = 'runtime') {
    const existing = this.nodes.get(id);
    if (existing) {
      if (existing.origin === 'static' && origin === 'runtime') existing.origin = 'runtime';
      return existing;
    }
    /** @type {GraphNode} */
    const node = { id, label, kind, origin };
    this.nodes.set(id, node);
    if (!this.labelIndex.has(label)) this.labelIndex.set(label, id);
    this.emit({ type: 'node', node });
    return node;
  }

  /**
   * Return the id of an already-known node with this label (e.g. one seeded by
   * the static analyzer), so the runtime tracer can reuse it and light up the
   * same node instead of creating a duplicate. Returns undefined if unseen.
   * @param {string} label
   */
  claimId(label) {
    return this.labelIndex.get(label);
  }

  /**
   * @param {string} from
   * @param {string} to
   * @param {string} [key]
   * @param {'static'|'runtime'} [origin]
   * @param {'read'|'write'} [kind]  read = dependency->effect; write = effect->reactive it mutates
   */
  addEdge(from, to, key, origin = 'runtime', kind = 'read') {
    if (from === to) return; // self-edge, ignore
    const id = `${from}->${to}${key ? '#' + key : ''}#${kind}`;
    if (this.edges.has(id)) return this.edges.get(id);
    /** @type {GraphEdge} */
    const edge = { from, to, key, origin, kind };
    this.edges.set(id, edge);
    this.emit({ type: 'edge', edge });
    return edge;
  }

  /** Mark a node as firing right now (glow). */
  glow(nodeId) {
    if (!this.nodes.has(nodeId)) return;
    this.emit({ type: 'glow', nodeId });
  }

  /** Animate a propagation pulse along an edge from -> to. */
  pulse(from, to) {
    this.emit({ type: 'pulse', from, to });
  }

  /** Incoming edges of a node (deps that feed it). @returns {GraphEdge[]} */
  incoming(nodeId) {
    const out = [];
    for (const e of this.edges.values()) if (e.to === nodeId) out.push(e);
    return out;
  }

  /** Outgoing edges of a node (dependents it feeds). @returns {GraphEdge[]} */
  outgoing(nodeId) {
    const out = [];
    for (const e of this.edges.values()) if (e.from === nodeId) out.push(e);
    return out;
  }

  /**
   * An effect fired (onTrigger). We use it only to recover the *origin* of a
   * change: Vue reports the mutated source object on the effect that reads it
   * directly. From that origin we drive a deterministic, staggered cascade
   * outward (see `cascadeFrom`) so propagation is always clearly visible —
   * independent of whether downstream onTriggers carry a target.
   *
   * @param {string} effectId  the effect node that re-ran
   * @param {string|undefined} sourceId  node id resolved from event.target, if any
   */
  onTrigger(effectId, sourceId) {
    // The origin's *direct* dependent always reports the mutated source, so a
    // single cascadeFrom(origin) drives the whole ripple. Downstream effects
    // re-run with no target — we intentionally ignore those to keep the cascade
    // clean (the ripple lights them in order instead of them pre-flashing).
    if (sourceId && this.nodes.has(sourceId)) {
      this.cascadeFrom(sourceId);
    }
  }

  /**
   * Light up the graph starting at `originId` and rippling outward along
   * dependency -> dependent edges, one level at a time. Each level: pulse the
   * edges, then glow the reached nodes when the pulse arrives. This is the
   * "変更元を起点に連鎖的に発光" behaviour.
   *
   * Debounced per origin so one user action = one ripple, even if several
   * effects report the same source.
   *
   * @param {string} originId
   * @param {{ step?: number, travel?: number, schedule?: (fn: () => void, ms: number) => void }} [opts]
   */
  cascadeFrom(originId, opts = {}) {
    const t = now();
    const last = this.lastCascade.get(originId);
    if (last != null && t - last < this.cascadeDebounceMs) return;
    this.lastCascade.set(originId, t);

    const step = opts.step ?? 300;    // ms between ripple levels
    const travel = opts.travel ?? 300; // ms for a pulse to reach the next node
    const schedule = opts.schedule ?? ((fn, ms) => setTimeout(fn, ms));

    const visited = new Set([originId]);
    let frontier = [originId];
    let depth = 0;

    this.glow(originId); // origin lights up immediately

    const walkLevel = () => {
      const next = [];
      for (const id of frontier) {
        for (const e of this.outgoing(id)) {
          if (visited.has(e.to)) continue; // cycle / diamond guard
          visited.add(e.to);
          this.pulse(e.from, e.to);
          const target = e.to;
          schedule(() => this.glow(target), travel);
          next.push(target);
        }
      }
      if (next.length) {
        frontier = next;
        depth++;
        schedule(walkLevel, step);
      }
    };
    schedule(walkLevel, 0);
  }

  toJSON() {
    return {
      nodes: [...this.nodes.values()],
      edges: [...this.edges.values()].map(({ from, to, key, origin, kind }) => ({ from, to, key, origin, kind })),
    };
  }

  reset() {
    this.nodes.clear();
    this.edges.clear();
    this.lastCascade.clear();
    this.emit({ type: 'reset' });
  }
}

function now() {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}

/** Process-wide singleton so tracer and overlay share one graph. */
export const graph = new ReactivityGraph();
