//! L1: what a file defines and which names it uses, read from its syntax tree.
//! Each grammar ships a tags query; the extra patterns below fill the gaps that
//! matter for finding a definition (type aliases, enums, module constants).
//! Nothing here resolves a name to its definition: definitions are syntactic,
//! and a reference is only a name at a position.

use crate::manifest::Language;
use std::collections::HashMap;
use tree_sitter::{Node, Parser, Query, QueryCursor, StreamingIterator};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Definition {
    pub name: String,
    pub kind: String,
    /// The definition (or Rust `impl`, Go receiver, C++ `Scope::`) it sits in.
    pub container: Option<String>,
    /// 1-based line and column of the name; the line where the definition ends.
    pub line: u32,
    pub column: u32,
    pub end_line: u32,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Reference {
    pub name: String,
    pub kind: String,
    pub line: u32,
    pub column: u32,
}

#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct Analysis {
    pub definitions: Vec<Definition>,
    pub references: Vec<Reference>,
    /// The parser had to skip text it could not read; some definitions may be missing.
    pub has_syntax_errors: bool,
}

const JS_EXTRA: &str = r#"
(program (lexical_declaration (variable_declarator name: (identifier) @name) @definition.variable))
(export_statement (lexical_declaration (variable_declarator name: (identifier) @name) @definition.variable))
"#;

const TS_EXTRA: &str = r#"
(type_alias_declaration name: (type_identifier) @name) @definition.type
(enum_declaration name: (identifier) @name) @definition.enum
"#;

const GO_EXTRA: &str = r#"
(source_file (const_declaration (const_spec name: (identifier) @name) @definition.constant))
(source_file (var_declaration (var_spec name: (identifier) @name) @definition.variable))
(type_alias name: (type_identifier) @name) @definition.type
(method_declaration
  receiver: (parameter_list (parameter_declaration
    type: [(type_identifier) @name (pointer_type (type_identifier) @name)]))) @container
"#;

const RUST_EXTRA: &str = r#"
(const_item name: (identifier) @name) @definition.constant
(static_item name: (identifier) @name) @definition.constant
(function_signature_item name: (identifier) @name) @definition.method
(impl_item type: [(type_identifier) @name (generic_type type: (type_identifier) @name)]) @container
"#;

const JAVA_EXTRA: &str = r#"
(enum_declaration name: (identifier) @name) @definition.enum
(record_declaration name: (identifier) @name) @definition.class
"#;

const CPP_EXTRA: &str = r#"
(namespace_definition name: (namespace_identifier) @name) @definition.module
(call_expression
  function: [(identifier) @name
             (field_expression field: (field_identifier) @name)
             (qualified_identifier name: (identifier) @name)]) @reference.call
"#;

fn grammar_of(language: Language) -> (tree_sitter::Language, Vec<&'static str>) {
    let js = tree_sitter_javascript::TAGS_QUERY;
    let ts = tree_sitter_typescript::TAGS_QUERY;
    match language {
        Language::TypeScript => (tree_sitter_typescript::LANGUAGE_TYPESCRIPT.into(), vec![js, ts, JS_EXTRA, TS_EXTRA]),
        Language::Tsx => (tree_sitter_typescript::LANGUAGE_TSX.into(), vec![js, ts, JS_EXTRA, TS_EXTRA]),
        Language::JavaScript => (tree_sitter_javascript::LANGUAGE.into(), vec![js, JS_EXTRA]),
        Language::Python => (tree_sitter_python::LANGUAGE.into(), vec![tree_sitter_python::TAGS_QUERY]),
        Language::Go => (tree_sitter_go::LANGUAGE.into(), vec![tree_sitter_go::TAGS_QUERY, GO_EXTRA]),
        Language::Rust => (tree_sitter_rust::LANGUAGE.into(), vec![tree_sitter_rust::TAGS_QUERY, RUST_EXTRA]),
        Language::Java => (tree_sitter_java::LANGUAGE.into(), vec![tree_sitter_java::TAGS_QUERY, JAVA_EXTRA]),
        Language::Cpp => (tree_sitter_cpp::LANGUAGE.into(), vec![tree_sitter_cpp::TAGS_QUERY, CPP_EXTRA]),
    }
}

struct Grammar {
    parser: Parser,
    query: Query,
}

/// Parsers and compiled queries, made on first use and kept: compiling a query costs more than parsing a file.
#[derive(Default)]
pub struct Extractor {
    grammars: HashMap<Language, Grammar>,
}

/// One match of the query, before nesting decides containers.
struct Found<'tree> {
    pattern: usize,
    role: Role,
    kind: String,
    name: Node<'tree>,
    node: Node<'tree>,
    scope: Option<Node<'tree>>,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Role {
    Definition,
    Reference,
    Container,
}

impl Extractor {
    fn grammar(&mut self, language: Language) -> Result<&mut Grammar, String> {
        if !self.grammars.contains_key(&language) {
            let (grammar, queries) = grammar_of(language);
            let mut parser = Parser::new();
            parser.set_language(&grammar).map_err(|error| format!("{}: {error}", language.name()))?;
            let query = Query::new(&grammar, &queries.concat())
                .map_err(|error| format!("{} query: {error}", language.name()))?;
            self.grammars.insert(language, Grammar { parser, query });
        }
        Ok(self.grammars.get_mut(&language).expect("inserted above"))
    }

    pub fn extract(&mut self, language: Language, source: &[u8]) -> Result<Analysis, String> {
        let grammar = self.grammar(language)?;
        let tree = grammar.parser.parse(source, None).ok_or("the parser gave up")?;
        let names = grammar.query.capture_names();
        let mut found = Vec::new();
        let mut cursor = QueryCursor::new();
        let mut matches = cursor.matches(&grammar.query, tree.root_node(), source);
        while let Some(found_match) = matches.next() {
            let (mut name, mut role, mut scope) = (None, None, None);
            for capture in found_match.captures() {
                let capture_name = names[capture.index as usize];
                if capture_name == "name" {
                    name = Some(capture.node);
                } else if capture_name == "local.scope" {
                    scope = Some(capture.node);
                } else if capture_name == "container" {
                    role = Some((Role::Container, String::new(), capture.node));
                } else if let Some(kind) = capture_name.strip_prefix("definition.") {
                    role = Some((Role::Definition, kind.to_owned(), capture.node));
                } else if let Some(kind) = capture_name.strip_prefix("reference.") {
                    role = Some((Role::Reference, kind.to_owned(), capture.node));
                }
            }
            if let (Some(name), Some((role, kind, node))) = (name, role) {
                found.push(Found { pattern: found_match.pattern_index, role, kind, name, node, scope });
            }
        }
        Ok(analysis_of(found, source, tree.root_node().has_error()))
    }
}

fn analysis_of(mut found: Vec<Found>, source: &[u8], has_syntax_errors: bool) -> Analysis {
    let text = |node: Node| node.utf8_text(source).unwrap_or_default().to_owned();
    let mut references: Vec<Reference> = found
        .iter()
        .filter(|item| item.role == Role::Reference)
        .map(|item| Reference {
            name: text(item.name),
            kind: item.kind.clone(),
            line: item.name.start_position().row as u32 + 1,
            column: item.name.start_position().column as u32 + 1,
        })
        .collect();
    // TypeScript runs the JavaScript query too, so both may name the same site.
    references.sort_by_key(|r| (r.line, r.column));
    references.dedup_by(|later, earlier| (later.line, later.column, &later.kind) == (earlier.line, earlier.column, &earlier.kind));
    // Outer before inner; for the same node, the earliest pattern wins
    // (a Rust method also matches the plain function pattern after it).
    found.retain(|item| item.role != Role::Reference);
    found.sort_by_key(|item| (item.node.start_byte(), std::cmp::Reverse(item.node.end_byte()), item.role == Role::Definition, item.pattern));
    found.dedup_by(|later, earlier| later.role == earlier.role && later.node.byte_range() == earlier.node.byte_range());
    let mut open: Vec<(usize, String, String)> = Vec::new();
    let mut definitions = Vec::new();
    for item in found {
        while open.last().is_some_and(|(end, _, _)| *end <= item.node.start_byte()) {
            open.pop();
        }
        let name = text(item.name);
        if item.role == Role::Container {
            open.push((item.node.end_byte(), name, String::new()));
            continue;
        }
        let parent = open.last().cloned();
        let container = item.scope.map(text).or_else(|| parent.as_ref().map(|(_, name, _)| name.clone()));
        let in_class = matches!(parent.as_ref().map(|(_, _, kind)| kind.as_str()), Some("class" | "interface"));
        let kind = if item.kind == "function" && in_class { "method".to_owned() } else { item.kind };
        definitions.push(Definition {
            name: name.clone(),
            kind: kind.clone(),
            container,
            line: item.name.start_position().row as u32 + 1,
            column: item.name.start_position().column as u32 + 1,
            end_line: item.node.end_position().row as u32 + 1,
        });
        open.push((item.node.end_byte(), name, kind));
    }
    Analysis { definitions, references, has_syntax_errors }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn definitions(language: Language, source: &str) -> Vec<(String, String, Option<String>)> {
        let analysis = Extractor::default().extract(language, source.as_bytes()).unwrap();
        analysis.definitions.into_iter().map(|d| (d.name, d.kind, d.container)).collect()
    }

    fn def(name: &str, kind: &str, container: Option<&str>) -> (String, String, Option<String>) {
        (name.to_owned(), kind.to_owned(), container.map(str::to_owned))
    }

    #[test]
    fn every_language_query_compiles() {
        let mut extractor = Extractor::default();
        for language in Language::ALL {
            extractor.extract(language, b"").unwrap();
        }
    }

    #[test]
    fn typescript_definitions_with_their_classes() {
        let source = "export class Store {\n  constructor() {}\n  get size() { return 1; }\n  load(): void {}\n}\n\
            export interface Shape { area(): number }\nexport type Id = string;\nenum Color { Red }\n\
            export function run() { const inner = () => 1; }\nexport const handler = async () => {};\nconst LIMIT = 5;\n";
        assert_eq!(
            definitions(Language::TypeScript, source),
            vec![
                def("Store", "class", None),
                def("size", "method", Some("Store")),
                def("load", "method", Some("Store")),
                def("Shape", "interface", None),
                def("area", "method", Some("Shape")),
                def("Id", "type", None),
                def("Color", "enum", None),
                def("run", "function", None),
                def("inner", "function", Some("run")),
                def("handler", "function", None),
                def("LIMIT", "variable", None),
            ]
        );
    }

    #[test]
    fn typescript_references_are_names_at_positions() {
        let analysis = Extractor::default()
            .extract(Language::TypeScript, b"import { run } from './a';\nrun();\nconst s = new Store();\nlet x: Shape;\n")
            .unwrap();
        let names: Vec<(&str, &str, u32)> =
            analysis.references.iter().map(|r| (r.name.as_str(), r.kind.as_str(), r.line)).collect();
        assert_eq!(names, vec![("run", "call", 2), ("Store", "class", 3), ("Shape", "type", 4)]);
        assert!(!analysis.has_syntax_errors);
    }

    #[test]
    fn tsx_and_javascript_parse_their_own_syntax() {
        assert_eq!(definitions(Language::Tsx, "export const App = () => <div />;\n"), vec![def("App", "function", None)]);
        assert_eq!(
            definitions(Language::JavaScript, "class A { b() {} }\nmodule.exports.c = function () {};\n"),
            vec![def("A", "class", None), def("b", "method", Some("A")), def("c", "function", None)]
        );
    }

    #[test]
    fn python_methods_sit_in_their_class() {
        let source = "LIMIT = 3\nclass Store:\n    def load(self):\n        helper()\n\ndef helper():\n    pass\n";
        assert_eq!(
            definitions(Language::Python, source),
            vec![def("LIMIT", "constant", None), def("Store", "class", None), def("load", "method", Some("Store")), def("helper", "function", None)]
        );
    }

    #[test]
    fn go_methods_sit_in_their_receiver() {
        let source = "package p\nconst Limit = 3\nvar cache = 1\ntype Store struct{}\ntype ID = string\n\
            func (s *Store) Load() {}\nfunc Run() { helper() }\n";
        assert_eq!(
            definitions(Language::Go, source),
            vec![
                def("Limit", "constant", None),
                def("cache", "variable", None),
                def("Store", "type", None),
                def("ID", "type", None),
                def("Load", "method", Some("Store")),
                def("Run", "function", None),
            ]
        );
    }

    #[test]
    fn rust_methods_sit_in_their_impl_once() {
        let source = "const LIMIT: u8 = 3;\nstruct Store;\nimpl Store { fn load(&self) {} }\n\
            trait Shape { fn area(&self) -> f64; }\nfn run() {}\nmacro_rules! m { () => {} }\n";
        assert_eq!(
            definitions(Language::Rust, source),
            vec![
                def("LIMIT", "constant", None),
                def("Store", "class", None),
                def("load", "method", Some("Store")),
                def("Shape", "interface", None),
                def("area", "method", Some("Shape")),
                def("run", "function", None),
                def("m", "macro", None),
            ]
        );
    }

    #[test]
    fn java_members_sit_in_their_type() {
        let source = "class Store { void load() { run(); } }\ninterface Shape { double area(); }\nenum Color { RED }\nrecord Point(int x) {}\n";
        assert_eq!(
            definitions(Language::Java, source),
            vec![
                def("Store", "class", None),
                def("load", "method", Some("Store")),
                def("Shape", "interface", None),
                def("area", "method", Some("Shape")),
                def("Color", "enum", None),
                def("Point", "class", None),
            ]
        );
    }

    #[test]
    fn cpp_definitions_know_their_scope() {
        let source = "namespace app {\nclass Store { void load(); };\nvoid Store::load() { run(); }\n}\nint run() { return 0; }\n";
        assert_eq!(
            definitions(Language::Cpp, source),
            vec![
                def("app", "module", None),
                def("Store", "class", Some("app")),
                def("load", "method", Some("Store")),
                def("load", "method", Some("Store")),
                def("run", "function", None),
            ]
        );
    }

    #[test]
    fn says_when_the_file_does_not_parse_cleanly() {
        let analysis = Extractor::default().extract(Language::TypeScript, b"export function (\n class {").unwrap();
        assert!(analysis.has_syntax_errors);
    }
}
