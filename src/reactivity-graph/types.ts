/**
 * Shared node/edge schema — the single source of truth for the graph shape.
 *
 * The runtime tracer, the static analyzer (`../static/analyze.ts`) and the Rust
 * croquis reference (`../../croquis-rust/effect_graph_builder.rs`) all emit this
 * exact shape, so the static "map" and the live "traffic" reconcile onto one
 * graph. Keep the three in sync against this file.
 */

export type NodeKind = 'ref' | 'reactive' | 'computed' | 'watch' | 'watchEffect' | 'component';
export type EdgeKind = 'read' | 'write';
export type Origin = 'static' | 'runtime';

export interface GraphNode {
  id: string;
  label: string;
  kind: NodeKind;
  origin: Origin;
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
  | 'node' | 'edge' | 'glow' | 'pulse' | 'reset' | 'remove-node' | 'remove-edge';

export interface GraphEvent {
  type: GraphEventType;
  node?: GraphNode;
  edge?: GraphEdge;
  nodeId?: string;
  from?: string;
  to?: string;
}

/** Serialized graph — what `ReactivityGraph.toJSON()` and the analyzers produce. */
export interface ReactivityGraphExport {
  nodes: GraphNode[];
  edges: GraphEdge[];
}
