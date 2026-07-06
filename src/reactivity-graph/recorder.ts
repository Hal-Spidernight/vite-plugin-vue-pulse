/**
 * Propagation recorder.
 *
 * A "recording" captures how change actually PROPAGATED at runtime: while armed,
 * it groups the graph's `pulse` events by their `cascadeId` (one user action =
 * one cascade = one session) and keeps each hop's `from -> to` and BFS `level`.
 * Because `cascadeFrom` walks outward with a visited-guard, a session is already
 * a DAG (a directed ACYCLIC graph): the origin at level 0, its dependents at
 * level 1, and so on — cycles/diamonds are pruned to the first path that reaches
 * a node. That is exactly the "which flow did the change take" view.
 *
 * Output is serialisable two ways (user-selectable): a structured JSON dump, or a
 * Mermaid `graph LR` flowchart per session (or all sessions).
 */
import type { ReactivityGraph } from './graph.js';
import type { GraphEvent } from './types.js';

export interface PropagationStep {
  from: string;
  to: string;
  /** BFS depth of the `to` node within its cascade (origin = 0, direct deps = 1) */
  level: number;
  /** 'read' (dependency → effect) or 'write' (effect → mutated reactive) */
  kind: 'read' | 'write';
}

export interface PropagationSession {
  id: number;
  /** node id the propagation started from (the changed reactive) */
  origin: string;
  originLabel: string;
  /** ms timestamp (performance.now) of the first hop */
  startedAt: number;
  steps: PropagationStep[];
}

export interface RecorderHandle {
  readonly recording: boolean;
  readonly sessions: PropagationSession[];
  /** arm recording (new pulses are captured); returns nothing */
  start(): void;
  /** disarm recording (captured sessions are kept) */
  stop(): void;
  /** drop all captured sessions */
  clear(): void;
  /** structured dump of every captured session */
  toJSON(): string;
  /** Mermaid `graph LR` flowchart for one session, or all sessions if omitted */
  toMermaid(session?: PropagationSession): string;
  /** notify on any change (start/stop/clear or a new hop) — for view refresh */
  subscribe(fn: () => void): () => void;
  destroy(): void;
}

function now(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}

/** Mermaid-safe node id: only word chars survive, prefixed so it never starts with a digit. */
function mermaidId(id: string): string {
  return 'n_' + id.replace(/[^\w]/g, '_');
}

/** Escape a label for a Mermaid `["..."]` node (quotes/newlines break the syntax). */
function mermaidLabel(s: string): string {
  return s.replace(/"/g, '&quot;').replace(/\n/g, ' ');
}

export function createRecorder(graph: ReactivityGraph): RecorderHandle {
  let recording = false;
  const sessions: PropagationSession[] = [];
  const byId = new Map<number, PropagationSession>();
  const listeners = new Set<() => void>();
  const notify = () => { for (const fn of listeners) fn(); };
  const labelOf = (id: string) => graph.nodes.get(id)?.label ?? id;
  const edgeKind = (from: string, to: string): 'read' | 'write' => {
    for (const e of graph.edges.values()) if (e.from === from && e.to === to) return e.kind === 'write' ? 'write' : 'read';
    return 'read';
  };

  const unsub = graph.subscribe((e: GraphEvent) => {
    if (!recording || e.type !== 'pulse' || e.cascadeId == null || !e.from || !e.to) return;
    let s = byId.get(e.cascadeId);
    if (!s) {
      s = { id: e.cascadeId, origin: e.from, originLabel: labelOf(e.from), startedAt: now(), steps: [] };
      byId.set(e.cascadeId, s);
      sessions.push(s);
    }
    // dedup identical hop (a diamond can pulse the same edge twice in a level)
    if (!s.steps.some((st) => st.from === e.from && st.to === e.to && st.level === e.level)) {
      s.steps.push({ from: e.from, to: e.to, level: e.level ?? 1, kind: edgeKind(e.from, e.to) });
      notify();
    }
  });

  return {
    get recording() { return recording; },
    get sessions() { return sessions; },
    start() { recording = true; notify(); },
    stop() { recording = false; notify(); },
    clear() { sessions.length = 0; byId.clear(); notify(); },
    toJSON() {
      return JSON.stringify({
        sessions: sessions.map((s) => ({
          origin: s.origin,
          originLabel: s.originLabel,
          steps: s.steps.map((st) => ({ from: st.from, to: st.to, level: st.level, kind: st.kind })),
        })),
      }, null, 2);
    },
    toMermaid(session) {
      const list = session ? [session] : sessions;
      const lines = ['graph LR'];
      const declared = new Set<string>();
      const decl = (id: string) => {
        const m = mermaidId(id);
        if (!declared.has(id)) { declared.add(id); lines.push(`  ${m}["${mermaidLabel(labelOf(id))}"]`); }
        return m;
      };
      for (const s of list) {
        for (const st of s.steps) {
          const a = decl(st.from), b = decl(st.to);
          // write hops as a dotted labelled edge, reads as a solid arrow
          lines.push(st.kind === 'write' ? `  ${a} -. write .-> ${b}` : `  ${a} --> ${b}`);
        }
      }
      return lines.join('\n');
    },
    subscribe(fn) { listeners.add(fn); return () => { listeners.delete(fn); }; },
    destroy() { unsub(); listeners.clear(); },
  };
}
