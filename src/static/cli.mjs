#!/usr/bin/env node
// Static reactivity-graph analyzer CLI.
//   node src/static/cli.mjs <file.vue> [more.vue ...]  -> prints {nodes,edges} + a Mermaid diagram
import fs from 'node:fs';
import { analyzeSfc } from './analyze.mjs';

const files = process.argv.slice(2);
if (!files.length) { console.error('usage: cli.mjs <file.vue> [...]'); process.exit(1); }

const nodes = new Map();
const edges = new Map();
for (const f of files) {
  const g = analyzeSfc(fs.readFileSync(f, 'utf8'), f);
  for (const n of g.nodes) nodes.set(n.id, n);
  for (const e of g.edges) edges.set(`${e.from}->${e.to}#${e.key || ''}`, e);
}
const graph = { nodes: [...nodes.values()], edges: [...edges.values()] };

console.log(JSON.stringify(graph, null, 2));
console.log('\n--- Mermaid ---\nflowchart LR');
for (const n of graph.nodes) console.log(`  ${safe(n.id)}["${n.label}<br/><i>${n.kind}</i>"]`);
for (const e of graph.edges) console.log(`  ${safe(e.from)} -->${e.key ? '|' + e.key + '|' : ''} ${safe(e.to)}`);

function safe(id) { return id.replace(/[^a-zA-Z0-9]/g, '_'); }
