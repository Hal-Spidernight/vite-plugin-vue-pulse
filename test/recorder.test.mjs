// Recording mode: capture runtime propagation as an ACYCLIC flow (DAG) per user
// action, group by cascadeId, and export as JSON / Mermaid. Also checks the panel
// wires a graph/record tab + recorder controls (headless happy-dom).
import { describe, it, expect } from 'vitest';
import { Window } from 'happy-dom';

const win = new Window();
globalThis.window = win;
globalThis.document = win.document;
win.HTMLCanvasElement.prototype.getContext = () => new Proxy({}, {
  get: (t, k) => (k in t ? t[k] : () => {}),
  set: (t, k, v) => ((t[k] = v), true),
});
globalThis.requestAnimationFrame = (fn) => setTimeout(() => fn(0), 0);
globalThis.cancelAnimationFrame = (id) => clearTimeout(id);

const { ReactivityGraph, graph } = await import('../dist/reactivity-graph/graph.js');
const { createRecorder } = await import('../dist/reactivity-graph/recorder.js');
const { mountPanel } = await import('../dist/reactivity-graph/index.js');

const ok = (c, m) => expect(c, m).toBeTruthy();

describe('recorder', () => {
  it('captures cascades as acyclic sessions, exports JSON/Mermaid, and wires the panel tabs + controls', async () => {
const sync = { schedule: (fn) => fn(), step: 0, travel: 0 }; // deterministic cascade

console.log('[recorder captures one cascade as one acyclic session]');
{
  const g = new ReactivityGraph();
  // diamond a->b->d, a->c->d + a write-back d->a (must NOT reappear: acyclic)
  for (const [id, k] of [['A::a', 'ref'], ['A::b', 'computed'], ['A::c', 'computed'], ['A::d', 'watchEffect']]) g.addNode(id, id.split('::')[1], k);
  g.addEdge('A::a', 'A::b'); g.addEdge('A::a', 'A::c'); g.addEdge('A::b', 'A::d'); g.addEdge('A::c', 'A::d');
  g.addEdge('A::d', 'A::a', undefined, 'runtime', 'write');
  const rec = createRecorder(g);

  // not recording yet → nothing captured
  g.cascadeFrom('A::a', sync);
  ok(rec.sessions.length === 0, 'no capture while disarmed');

  rec.start();
  g.lastCascade.clear(); // bypass debounce for the test
  g.cascadeFrom('A::a', sync);
  rec.stop();
  ok(rec.sessions.length === 1, 'one cascade → one session');
  const s = rec.sessions[0];
  ok(s.origin === 'A::a', 'session origin is the changed reactive');
  ok(!s.steps.some((st) => st.to === 'A::a'), 'flow is ACYCLIC — the write-back to the origin is pruned');
  ok(s.steps.every((st) => st.level >= 1), 'every hop has a BFS level');
  const levelOfB = s.steps.find((st) => st.to === 'A::b')?.level;
  const levelOfD = s.steps.find((st) => st.to === 'A::d')?.level;
  ok(levelOfB === 1 && levelOfD === 2, 'levels reflect propagation depth (b@1, d@2)');
  ok(s.steps.some((st) => st.from === 'A::d' && st.kind === 'write') === false, 'no write hop leaves the DAG (write-back excluded)');

  console.log('[export: JSON + Mermaid]');
  const json = JSON.parse(rec.toJSON());
  ok(Array.isArray(json.sessions) && json.sessions.length === 1, 'toJSON emits the sessions array');
  ok(json.sessions[0].steps.length === s.steps.length, 'JSON steps match');
  const mmd = rec.toMermaid(s);
  ok(/^graph LR/.test(mmd), 'Mermaid starts with `graph LR`');
  ok(/n_A__a\["a"\]/.test(mmd) && /n_A__a --> n_A__b/.test(mmd), 'Mermaid declares nodes + draws the a→b edge');

  rec.clear();
  ok(rec.sessions.length === 0, 'clear() drops captured sessions');
  rec.destroy();
}

console.log('[write hops render as dotted labelled Mermaid edges]');
{
  const g = new ReactivityGraph();
  g.addNode('A::src', 'src', 'ref'); g.addNode('A::eff', 'eff', 'watchEffect'); g.addNode('A::dst', 'dst', 'ref');
  g.addEdge('A::src', 'A::eff');                         // read: src → eff
  g.addEdge('A::eff', 'A::dst', undefined, 'runtime', 'write'); // write: eff → dst
  const rec = createRecorder(g);
  rec.start();
  g.cascadeFrom('A::src', sync);
  rec.stop();
  const mmd = rec.toMermaid();
  ok(/n_A__src --> n_A__eff/.test(mmd), 'read hop is a solid arrow');
  ok(/n_A__eff -\. write \.-> n_A__dst/.test(mmd), 'write hop is a dotted `-. write .->` edge');
  rec.destroy();
}

console.log('[panel wires the graph/record tabs + recorder controls]');
{
  graph.reset();
  graph.addNode('App::a', 'a', 'ref'); graph.addNode('App::b', 'b', 'computed');
  graph.addEdge('App::a', 'App::b');
  const panel = mountPanel({ width: 460, height: 360 });
  const buttons = () => [...panel.panel.querySelectorAll('button')];
  const byText = (t) => buttons().find((b) => b.textContent.trim() === t);
  ok(!!byText('Graph') && !!byText('Record'), 'panel has graph + record tabs');
  byText('Record').click();
  ok(!!byText('● Rec') && !!byText('Mermaid') && !!byText('JSON') && !!byText('Copy') && !!byText('Save'),
    'record view exposes record / format / copy / save controls');
  byText('● Rec').click();
  ok(!!byText('■ Stop'), 'record button toggles to stop while armed');
  graph.lastCascade.clear();
  graph.cascadeFrom('App::a', sync);
  byText('■ Stop').click();
  const rows = buttons().filter((b) => /^#\d/.test(b.textContent));
  ok(rows.length === 1, 'a captured session shows up in the list');
  rows[0].click();
  const ta = panel.panel.querySelector('textarea');
  ok(/graph LR/.test(ta.value), 'selecting a session shows its Mermaid output');
  byText('JSON').click();
  ok(/"steps"/.test(panel.panel.querySelector('textarea').value), 'switching to JSON shows JSON output');
  panel.destroy();
}
  });
});
