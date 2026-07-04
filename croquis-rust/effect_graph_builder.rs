//! Effect-graph builder — the static half of the reactivity visualizer,
//! implemented as an extension to `vize_croquis`.
//!
//! This fills the empty slot left by `effect_graph.rs` (issue #695): it walks a
//! `<script setup>` OXC program and emits the causal graph "which ref /
//! reactive / computed / watch / watchEffect monitor each other on change",
//! as nodes + edges (dependency -> dependent).
//!
//! The output shape is intentionally identical to the runtime tracer's graph
//! (see ../src/reactivity-graph/graph.js), so the static "map" and the live
//! "traffic" can be overlaid on one graph, reconciled by label.
//!
//! Drop this file in `crates/vize_croquis/src/` as `effect_graph_builder.rs`
//! and add `mod effect_graph_builder;` to `lib.rs`. It reuses the existing
//! `ReactiveKind` (reactivity.rs) and `EffectGraph` (effect_graph.rs).
//!
//! NOTE: OXC AST types evolve across versions; method/field names below target
//! the same oxc_ast used by croquis. If a field name drifted, the two-pass
//! structure and the visitor entry points stay the same — only the accessor
//! spellings change. This is a reference implementation to compile against the
//! workspace, not a drop-in for a different oxc version.

use serde::Serialize;
use vize_carton::{CompactString, FxHashMap, FxHashSet};

use crate::effect_graph::EffectGraph;
use crate::reactivity::ReactiveKind;

use oxc_ast::ast::{
    Argument, CallExpression, Expression, MemberExpression, Program, Statement,
    VariableDeclarator,
};
use oxc_ast_visit::{walk, Visit};

/// Kind of node in the reactivity graph (superset of `ReactiveKind` plus sinks).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum NodeKind {
    Ref,
    Reactive,
    Computed,
    Watch,
    WatchEffect,
}

impl NodeKind {
    fn from_reactive_kind(k: ReactiveKind) -> Self {
        match k {
            ReactiveKind::Ref
            | ReactiveKind::ShallowRef
            | ReactiveKind::ToRef
            | ReactiveKind::ToRefs => NodeKind::Ref,
            ReactiveKind::Reactive
            | ReactiveKind::ShallowReactive
            | ReactiveKind::Readonly
            | ReactiveKind::ShallowReadonly => NodeKind::Reactive,
            ReactiveKind::Computed => NodeKind::Computed,
        }
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct GraphNode {
    pub id: CompactString,
    pub label: CompactString,
    pub kind: NodeKind,
    pub origin: &'static str, // always "static" from this pass
}

#[derive(Debug, Clone, Serialize)]
pub struct GraphEdge {
    pub from: CompactString,
    pub to: CompactString,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub key: Option<CompactString>,
    pub origin: &'static str,
}

/// Serializable graph export — matches the runtime tracer's `graph.toJSON()`.
#[derive(Debug, Default, Clone, Serialize)]
pub struct ReactivityGraphExport {
    pub nodes: Vec<GraphNode>,
    pub edges: Vec<GraphEdge>,
}

impl ReactivityGraphExport {
    /// Feed this into the existing cycle detector to flag reactive loops
    /// (`a -> b -> a`), e.g. cyclic computed chains.
    pub fn to_effect_graph(&self) -> EffectGraph {
        let mut g = EffectGraph::default();
        for e in &self.edges {
            g.add_edge(e.from.clone(), e.to.clone());
        }
        g
    }
}

fn node_id(label: &str) -> CompactString {
    let mut s = CompactString::new("static:");
    s.push_str(label);
    s
}

fn reactive_factory_kind(name: &str) -> Option<ReactiveKind> {
    // Real Vue factories + the devtool's traced wrappers.
    let base = name.strip_prefix("traced").map(lower_first);
    let candidate = base.as_deref().unwrap_or(name);
    ReactiveKind::from_name(candidate)
}

fn lower_first(s: &str) -> String {
    let mut c = s.chars();
    match c.next() {
        Some(f) => f.to_lowercase().collect::<String>() + c.as_str(),
        None => String::new(),
    }
}

fn is_watch(name: &str) -> bool {
    name == "watch" || name == "tracedWatch"
}
fn is_watch_effect(name: &str) -> bool {
    name == "watchEffect" || name == "tracedWatchEffect"
}

/// Builds a `ReactivityGraphExport` from a parsed `<script setup>` program.
pub struct EffectGraphBuilder {
    /// Reactive bindings discovered in pass 1: name -> kind.
    bindings: FxHashMap<CompactString, ReactiveKind>,
    export: ReactivityGraphExport,
    seen_nodes: FxHashSet<CompactString>,
    seen_edges: FxHashSet<CompactString>,
    anon: u32,
}

impl EffectGraphBuilder {
    pub fn new() -> Self {
        Self {
            bindings: FxHashMap::default(),
            export: ReactivityGraphExport::default(),
            seen_nodes: FxHashSet::default(),
            seen_edges: FxHashSet::default(),
            anon: 0,
        }
    }

    pub fn build(mut self, program: &Program) -> ReactivityGraphExport {
        self.collect_bindings(program);
        self.walk_effects(program);
        self.export
    }

    fn add_node(&mut self, label: &str, kind: NodeKind) -> CompactString {
        let id = node_id(label);
        if self.seen_nodes.insert(id.clone()) {
            self.export.nodes.push(GraphNode {
                id: id.clone(),
                label: CompactString::new(label),
                kind,
                origin: "static",
            });
        }
        id
    }

    fn add_edge(&mut self, from_label: &str, to: &CompactString, key: Option<CompactString>) {
        let from = node_id(from_label);
        if &from == to {
            return;
        }
        let sig = format!("{from}->{to}#{}", key.as_deref().unwrap_or(""));
        if self.seen_edges.insert(CompactString::new(&sig)) {
            self.export.edges.push(GraphEdge {
                from,
                to: to.clone(),
                key,
                origin: "static",
            });
        }
    }

    /// Pass 1: `const x = ref()/reactive()/computed()/traced*()`.
    fn collect_bindings(&mut self, program: &Program) {
        for stmt in &program.body {
            let Some(decl) = as_var_decl(stmt) else { continue };
            for d in &decl.declarations {
                let (Some(name), Some(call)) = (declarator_name(d), declarator_call(d)) else {
                    continue;
                };
                let Some(callee) = call_callee_name(call) else { continue };
                if let Some(kind) = reactive_factory_kind(callee) {
                    self.bindings.insert(CompactString::new(name), kind);
                    self.add_node(name, NodeKind::from_reactive_kind(kind));
                }
            }
        }
    }

    /// Pass 2: edges for every effect.
    fn walk_effects(&mut self, program: &Program) {
        // computed getters (declared as `const c = computed(getter)`)
        for stmt in &program.body {
            let Some(decl) = as_var_decl(stmt) else { continue };
            for d in &decl.declarations {
                let (Some(name), Some(call)) = (declarator_name(d), declarator_call(d)) else {
                    continue;
                };
                let Some(callee) = call_callee_name(call) else { continue };
                let base = callee.strip_prefix("traced").map(lower_first);
                let is_computed = base.as_deref().unwrap_or(callee) == "computed";
                if !is_computed {
                    continue;
                }
                let to = node_id(name);
                if let Some(getter) = call.arguments.first() {
                    self.collect_reads_into(getter, &to);
                }
            }
        }

        // watch / watchEffect calls anywhere (expression statements)
        // Visit the whole program to catch nested/registered calls too.
        let mut v = EffectCallVisitor { builder: self };
        v.visit_program(program);
    }

    /// Walk an argument (getter / source / body) collecting reactive reads and
    /// wiring `dep -> to` edges.
    fn collect_reads_into(&mut self, arg: &Argument, to: &CompactString) {
        let mut reader = ReadCollector {
            bindings: &self.bindings,
            reads: Vec::new(),
            seen: FxHashSet::default(),
        };
        if let Some(expr) = argument_as_expression(arg) {
            reader.visit_expression(expr);
        }
        let reads = reader.reads;
        for (label, key) in reads {
            self.add_edge(&label, to, key);
        }
    }
}

/// Visitor that finds watch/watchEffect call sites and wires their source deps.
struct EffectCallVisitor<'b> {
    builder: &'b mut EffectGraphBuilder,
}

impl<'a, 'b> Visit<'a> for EffectCallVisitor<'b> {
    fn visit_call_expression(&mut self, call: &CallExpression<'a>) {
        if let Some(name) = call_callee_name(call) {
            if is_watch_effect(name) {
                let label = string_arg(call, 1).unwrap_or_else(|| {
                    self.builder.anon += 1;
                    format!("watchEffect#{}", self.builder.anon)
                });
                let to = self.builder.add_node(&label, NodeKind::WatchEffect);
                if let Some(body) = call.arguments.first() {
                    self.builder.collect_reads_into(body, &to);
                }
            } else if is_watch(name) {
                let label = string_arg(call, 3).unwrap_or_else(|| {
                    self.builder.anon += 1;
                    format!("watch#{}", self.builder.anon)
                });
                let to = self.builder.add_node(&label, NodeKind::Watch);
                // Only the SOURCE (arg 0) establishes the dependency.
                if let Some(source) = call.arguments.first() {
                    self.builder.collect_reads_into(source, &to);
                }
            }
        }
        walk::walk_call_expression(self, call);
    }
}

/// Collects identifier reads that resolve to a known reactive binding.
struct ReadCollector<'a> {
    bindings: &'a FxHashMap<CompactString, ReactiveKind>,
    reads: Vec<(CompactString, Option<CompactString>)>,
    seen: FxHashSet<CompactString>,
}

impl<'a, 'v> Visit<'v> for ReadCollector<'a> {
    fn visit_member_expression(&mut self, member: &MemberExpression<'v>) {
        // `state.count` -> reactive read with key "count".
        if let MemberExpression::StaticMemberExpression(m) = member {
            if let Expression::Identifier(obj) = &m.object {
                let name = obj.name.as_str();
                if let Some(kind) = self.bindings.get(name) {
                    let key = if matches!(
                        kind,
                        ReactiveKind::Reactive | ReactiveKind::ShallowReactive
                    ) && m.property.name.as_str() != "value"
                    {
                        Some(CompactString::new(m.property.name.as_str()))
                    } else {
                        None
                    };
                    self.push(name, key);
                    // don't descend into the property identifier
                    return;
                }
            }
        }
        walk::walk_member_expression(self, member);
    }

    fn visit_identifier_reference(&mut self, ident: &oxc_ast::ast::IdentifierReference<'v>) {
        let name = ident.name.as_str();
        if self.bindings.contains_key(name) {
            self.push(name, None);
        }
    }
}

impl<'a> ReadCollector<'a> {
    fn push(&mut self, name: &str, key: Option<CompactString>) {
        let sig = CompactString::new(format!("{name}#{}", key.as_deref().unwrap_or("")));
        if self.seen.insert(sig) {
            self.reads.push((CompactString::new(name), key));
        }
    }
}

// ---- small OXC accessors (isolate version-sensitive spellings) -----------

fn as_var_decl<'a, 'p>(stmt: &'p Statement<'a>) -> Option<&'p oxc_ast::ast::VariableDeclaration<'a>> {
    match stmt {
        Statement::VariableDeclaration(d) => Some(d),
        Statement::ExportNamedDeclaration(e) => match &e.declaration {
            Some(oxc_ast::ast::Declaration::VariableDeclaration(d)) => Some(d),
            _ => None,
        },
        _ => None,
    }
}

fn declarator_name<'a, 'p>(d: &'p VariableDeclarator<'a>) -> Option<&'p str> {
    d.id.get_binding_identifier().map(|b| b.name.as_str())
}

fn declarator_call<'a, 'p>(d: &'p VariableDeclarator<'a>) -> Option<&'p CallExpression<'a>> {
    match d.init.as_ref()? {
        Expression::CallExpression(c) => Some(c),
        _ => None,
    }
}

fn call_callee_name<'a, 'p>(call: &'p CallExpression<'a>) -> Option<&'p str> {
    match &call.callee {
        Expression::Identifier(i) => Some(i.name.as_str()),
        _ => None,
    }
}

fn argument_as_expression<'a, 'p>(arg: &'p Argument<'a>) -> Option<&'p Expression<'a>> {
    arg.as_expression()
}

fn string_arg(call: &CallExpression, index: usize) -> Option<String> {
    match call.arguments.get(index).and_then(|a| a.as_expression()) {
        Some(Expression::StringLiteral(s)) => Some(s.value.to_string()),
        _ => None,
    }
}

impl Default for EffectGraphBuilder {
    fn default() -> Self {
        Self::new()
    }
}
