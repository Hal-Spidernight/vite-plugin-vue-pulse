/**
 * Reactivity graph store.
 *
 * Holds the *nodes* (ref / reactive / computed / watch / watchEffect / component)
 * and the *edges* (dependency -> dependent, i.e. "when `from` changes, `to`
 * re-runs").
 *
 * The store is framework-agnostic and side-effect free: the runtime tracer feeds
 * it discovered edges and propagation events, and the overlay subscribes to
 * render them. The exact same node/edge shape (see `./types.ts`) is what the
 * static analyzer emits, so the static "map" and the runtime "traffic" overlay
 * onto one graph, reconciled by (scoped) label.
 */
import type {
  NodeKind, EdgeKind, Origin, GraphNode, GraphEdge, GraphEvent, ReactivityGraphExport,
} from './types.js';

export type { NodeKind, EdgeKind, Origin, GraphNode, GraphEdge, GraphEvent, ReactivityGraphExport };

type ScheduleFn = (fn: () => void, ms: number) => void;

export class ReactivityGraph {
  nodes = new Map<string, GraphNode>();
  /**
   * Reference count per node id. A node can be seeded by the static pass and then
   * confirmed by 1..N runtime call-sites / component instances. removeNode only
   * actually drops a node once its last referrer is gone, so a component
   * unmounting does not delete state still live in another instance, and the
   * static "map" survives a runtime node's teardown.
   */
  refs = new Map<string, number>();
  edges = new Map<string, GraphEdge>();
  subscribers = new Set<(e: GraphEvent) => void>();
  /** origin node -> last cascade timestamp (debounce) */
  lastCascade = new Map<string, number>();
  /** one user action = one ripple: collapse duplicate origin triggers within this window */
  cascadeDebounceMs = 120;

  subscribe(fn: (e: GraphEvent) => void): () => void {
    this.subscribers.add(fn);
    return () => this.subscribers.delete(fn);
  }

  emit(e: GraphEvent): void {
    for (const fn of this.subscribers) fn(e);
  }

  /**
   * The node `id` IS the identity: a deterministic key derived from the
   * declaration (`Comp::label` at runtime, the same string statically). One
   * declaration → one id → one node. The static pass and the runtime tracer both
   * address a node by that id, so they dedup here regardless of load order — no
   * label-matching reconciliation, no duplicates.
   */
  addNode(id: string, label: string, kind: NodeKind, origin: Origin = 'runtime'): GraphNode {
    const existing = this.nodes.get(id);
    if (existing) {
      this.refs.set(id, (this.refs.get(id) || 0) + 1);
      if (existing.origin === 'static' && origin === 'runtime') existing.origin = 'runtime';
      return existing;
    }
    const node: GraphNode = { id, label, kind, origin };
    this.nodes.set(id, node);
    this.refs.set(id, 1);
    this.emit({ type: 'node', node });
    return node;
  }

  /**
   * Drop a node (and its incident edges) once its last referrer is gone.
   * Decrements the refcount; only actually removes when it hits zero. Called on
   * component unmount / effect-scope dispose so an SPA does not leak the graph.
   * @returns true if the node was actually removed
   */
  removeNode(id: string): boolean {
    const cur = this.refs.get(id) || 0;
    if (cur > 1) { this.refs.set(id, cur - 1); return false; }
    this.refs.delete(id);
    const node = this.nodes.get(id);
    if (!node) return false;
    this.nodes.delete(id);
    for (const [k, e] of this.edges) {
      if (e.from === id || e.to === id) { this.edges.delete(k); this.emit({ type: 'remove-edge', edge: e }); }
    }
    this.lastCascade.delete(id);
    this.emit({ type: 'remove-node', nodeId: id });
    return true;
  }

  addEdge(from: string, to: string, key?: string, origin: Origin = 'runtime', kind: EdgeKind = 'read'): GraphEdge | undefined {
    if (from === to) return; // self-edge, ignore
    const id = `${from}->${to}${key ? '#' + key : ''}#${kind}`;
    const found = this.edges.get(id);
    if (found) return found;
    const edge: GraphEdge = { from, to, key, origin, kind };
    this.edges.set(id, edge);
    this.emit({ type: 'edge', edge });
    return edge;
  }

  /** Mark a node as firing right now (glow). */
  glow(nodeId: string): void {
    if (!this.nodes.has(nodeId)) return;
    this.emit({ type: 'glow', nodeId });
  }

  /** Animate a propagation pulse along an edge from -> to. */
  pulse(from: string, to: string): void {
    this.emit({ type: 'pulse', from, to });
  }

  /** Incoming edges of a node (deps that feed it). */
  incoming(nodeId: string): GraphEdge[] {
    const out: GraphEdge[] = [];
    for (const e of this.edges.values()) if (e.to === nodeId) out.push(e);
    return out;
  }

  /** Outgoing edges of a node (dependents it feeds). */
  outgoing(nodeId: string): GraphEdge[] {
    const out: GraphEdge[] = [];
    for (const e of this.edges.values()) if (e.from === nodeId) out.push(e);
    return out;
  }

  /**
   * An effect fired (onTrigger). We use it only to recover the *origin* of a
   * change: Vue reports the mutated source object on the effect that reads it
   * directly. From that origin we drive a deterministic, staggered cascade
   * outward (see `cascadeFrom`) so propagation is always clearly visible —
   * independent of whether downstream onTriggers carry a target.
   */
  onTrigger(_effectId: string, sourceId: string | undefined): void {
    if (sourceId && this.nodes.has(sourceId)) this.cascadeFrom(sourceId);
  }

  /**
   * Light up the graph starting at `originId` and rippling outward along
   * dependency -> dependent edges, one level at a time. Each level: pulse the
   * edges, then glow the reached nodes when the pulse arrives.
   *
   * Debounced per origin so one user action = one ripple, even if several effects
   * report the same source. A visited-guard terminates cyclic/diamond graphs.
   */
  cascadeFrom(originId: string, opts: { step?: number; travel?: number; schedule?: ScheduleFn } = {}): void {
    const t = now();
    const last = this.lastCascade.get(originId);
    if (last != null && t - last < this.cascadeDebounceMs) return;
    this.lastCascade.set(originId, t);

    const step = opts.step ?? 300;     // ms between ripple levels
    const travel = opts.travel ?? 300; // ms for a pulse to reach the next node
    const schedule: ScheduleFn = opts.schedule ?? ((fn, ms) => { setTimeout(fn, ms); });

    const visited = new Set<string>([originId]);
    let frontier: string[] = [originId];

    this.glow(originId); // origin lights up immediately

    const walkLevel = () => {
      const next: string[] = [];
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
        schedule(walkLevel, step);
      }
    };
    schedule(walkLevel, 0);
  }

  toJSON(): ReactivityGraphExport {
    return {
      nodes: [...this.nodes.values()],
      edges: [...this.edges.values()].map(({ from, to, key, origin, kind }) => ({ from, to, key, origin, kind })),
    };
  }

  reset(): void {
    this.nodes.clear();
    this.edges.clear();
    this.refs.clear();
    this.lastCascade.clear();
    this.emit({ type: 'reset' });
  }
}

function now(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}

/** Process-wide singleton so tracer and overlay share one graph. */
export const graph = new ReactivityGraph();
