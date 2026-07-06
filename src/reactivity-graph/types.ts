/**
 * Shared node/edge schema — the single source of truth for the graph shape.
 *
 * The runtime tracer and the static analyzer (`../static/analyze.ts`) both emit
 * this exact shape, so the static "map" and the live "traffic" reconcile onto one
 * graph. Keep them in sync against this file.
 */

// 'props' is a distinct kind, not just a reactive: Vue's props object is a
// shallowReactive under the hood, but semantically it's the component BOUNDARY's
// input (the terminus of a `<Child :p="expr">` cross-component edge), not internal
// state you declared — so it gets its own colour/legend entry.
export type NodeKind = 'ref' | 'reactive' | 'computed' | 'watch' | 'watchEffect' | 'props';
export type EdgeKind = 'read' | 'write';
export type Origin = 'static' | 'runtime';

/**
 * Where a declaration lives in source — captured by the static analyzer so the
 * panel can show the code for a node when you click it. `line` is 1-based within
 * the component's `<script>`; `snippet` is the declaration's source text (may be
 * truncated). Absent on runtime-only nodes the static map never covered.
 */
export interface NodeLoc {
  file?: string;
  line?: number;
  snippet?: string;
}

export interface GraphNode {
  id: string;
  label: string;
  kind: NodeKind;
  origin: Origin;
  /** source location + snippet (static analyzer only) — drives click-to-view-code */
  loc?: NodeLoc;
  /**
   * Component the declaration belongs to (derived from the `Comp::label` id).
   * Components are NOT nodes — a node is a declaration / reactivity-API usage —
   * they are a BOUNDARY: the overlay clusters same-scope nodes inside a labeled
   * hull and the panel offers a per-scope filter tag.
   */
  scope?: string;
  /** true when the declaration is read by its component's <template> (render dep) */
  template?: boolean;
}

export interface GraphEdge {
  from: string;
  to: string;
  key?: string;
  origin: Origin;
  /** read = dependency -> effect; write = effect -> reactive it mutates */
  kind?: EdgeKind;
}

export type GraphEventType =
  | 'node' | 'edge' | 'glow' | 'pulse' | 'reset' | 'remove-node' | 'remove-edge'
  | 'template' | 'boundary';

export interface GraphEvent {
  type: GraphEventType;
  node?: GraphNode;
  edge?: GraphEdge;
  nodeId?: string;
  from?: string;
  to?: string;
  /** for 'boundary': the component boundary that just re-rendered */
  scope?: string;
  /** for 'pulse': BFS depth of this hop within its cascade (1 = origin's direct dependents) */
  level?: number;
  /** for 'pulse': id of the propagation run (cascade) this hop belongs to — lets a
   *  recorder group the hops of one user action into a single acyclic flow */
  cascadeId?: number;
}

/** Serialized graph — what `ReactivityGraph.toJSON()` and the analyzers produce. */
export interface ReactivityGraphExport {
  nodes: GraphNode[];
  edges: GraphEdge[];
}
