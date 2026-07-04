#!/usr/bin/env node
// Static reactivity-graph analyzer CLI.
//   vue-pulse-analyze <file.vue> [more.vue ...]
//     -> prints {nodes,edges} JSON + a Mermaid diagram
import fs from 'node:fs';
import { analyzeSfc, mergeStaticGraphs } from './analyze.js';

const files = process.argv.slice(2);
if (!files.length) { console.error('usage: cli <file.vue> [...]'); process.exit(1); }

// merge per-file analyses (dedup by id, resolve cross-file provide/inject)
const graph = mergeStaticGraphs(files.map((f) => analyzeSfc(fs.readFileSync(f, 'utf8'), f)));

console.log(JSON.stringify(graph, null, 2));
console.log('\n--- Mermaid ---\nflowchart LR');
for (const n of graph.nodes) console.log(`  ${safe(n.id)}["${n.label}<br/><i>${n.kind}</i>"]`);
for (const e of graph.edges) console.log(`  ${safe(e.from)} -->${e.key ? '|' + e.key + '|' : ''} ${safe(e.to)}`);

function safe(id: string): string { return id.replace(/[^a-zA-Z0-9]/g, '_'); }
