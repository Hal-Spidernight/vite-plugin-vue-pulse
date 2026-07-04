/**
 * Shared node/edge schema — the single source of truth for the graph shape.
 *
 * The runtime tracer and the static analyzer (`../static/analyze.ts`) both emit
 * this exact shape, so the static "map" and the live "traffic" reconcile onto one
 * graph. Keep them in sync against this file.
 */

export type NodeKind = 'ref' | 'reactive' | 'computed' | 'watch' | 'watchEffect';
export type EdgeKind = 'read' | 'write';
export type Origin = 'static' | 'runtime';

export interface GraphNode {
  id: string;
  label: string;
  kind: NodeKind;
  origin: Origin;
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
}

/** Serialized graph — what `ReactivityGraph.toJSON()` and the analyzers produce. */
export interface ReactivityGraphExport {
  nodes: GraphNode[];
  edges: GraphEdge[];
}
