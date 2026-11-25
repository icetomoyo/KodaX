//! What a file imports, read from its syntax tree, for the first-class languages
//! (TypeScript/JavaScript, Python, Go, Rust). Nothing here finds the imported
//! file; that is module resolution, which needs the repository layout.

use crate::manifest::Language;
use tree_sitter::Node;

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct Import {
    /// The module as written: `./store.js`, `..models`, `github.com/a/b`, `crate::store`.
    pub module: String,
    /// The name taken from it; `*` for all of it (a namespace or a wildcard), empty for nothing (a side-effect import).
    pub name: String,
    /// The name it is known by in this file; empty when it binds none (a wildcard, `export * from`, a side-effect import).
    pub local: String,
}

impl Import {
    fn new(module: impl Into<String>, name: impl Into<String>, local: impl Into<String>) -> Import {
        Import { module: module.into(), name: name.into(), local: local.into() }
    }
}

/// The imports of one parsed file, in source order, each once.
pub fn imports_of(language: Language, root: Node, source: &[u8]) -> Vec<Import> {
    let mut found = Vec::new();
    let reader = Reader { source };
    let mut cursor = root.walk();
    let mut stack = vec![root];
    while let Some(node) = stack.pop() {
        let handled = match language {
            Language::TypeScript | Language::Tsx | Language::JavaScript => reader.javascript(node, &mut found),
            Language::Python => reader.python(node, &mut found),
            Language::Go => reader.go(node, &mut found),
            Language::Rust => reader.rust(node, &mut found),
            Language::Java | Language::Cpp => return Vec::new(),
        };
        if !handled {
            // Children in reverse, so they come off the stack in source order.
            let children: Vec<Node> = node.named_children(&mut cursor).collect();
            stack.extend(children.into_iter().rev());
        }
    }
    let mut seen = std::collections::HashSet::new();
    found.retain(|import| seen.insert(import.clone()));
    found
}

struct Reader<'a> {
    source: &'a [u8],
}

impl Reader<'_> {
    fn text(&self, node: Node) -> String {
        node.utf8_text(self.source).unwrap_or_default().to_owned()
    }

    /// A string literal's contents, without its quotes.
    fn unquoted(&self, node: Node) -> String {
        self.text(node).trim_matches(|c| c == '"' || c == '\'' || c == '`').to_owned()
    }

    /// Returns whether the node was an import, so its children need no visit.
    fn javascript(&self, node: Node, found: &mut Vec<Import>) -> bool {
        match node.kind() {
            "import_statement" => {
                let mut cursor = node.walk();
                let clause = node.named_children(&mut cursor).find(|child| child.kind() == "import_clause");
                let required = node.named_children(&mut node.walk()).find(|child| child.kind() == "import_require_clause");
                if let Some(required) = required {
                    // TypeScript `import x = require('m')`.
                    let module = required.child_by_field_name("source").map(|s| self.unquoted(s)).unwrap_or_default();
                    let local = required.named_child(0).map(|id| self.text(id)).unwrap_or_default();
                    found.push(Import::new(module, "*", local));
                    return true;
                }
                let Some(module) = node.child_by_field_name("source").map(|s| self.unquoted(s)) else { return true };
                match clause {
                    None => found.push(Import::new(module, "", "")),
                    Some(clause) => self.import_clause(clause, &module, found),
                }
                true
            }
            "export_statement" => {
                let Some(module) = node.child_by_field_name("source").map(|s| self.unquoted(s)) else { return false };
                let mut cursor = node.walk();
                let mut bound = false;
                for child in node.named_children(&mut cursor) {
                    match child.kind() {
                        "namespace_export" => {
                            let local = child.named_child(0).map(|id| self.text(id)).unwrap_or_default();
                            found.push(Import::new(&module, "*", local));
                            bound = true;
                        }
                        "export_clause" => {
                            self.specifiers(child, "export_specifier", &module, found);
                            bound = true;
                        }
                        _ => {}
                    }
                }
                if !bound {
                    found.push(Import::new(module, "*", ""));
                }
                true
            }
            "call_expression" => {
                let Some(function) = node.child_by_field_name("function") else { return false };
                if !(function.kind() == "import" || (function.kind() == "identifier" && self.text(function) == "require")) {
                    return false;
                }
                let argument = node.child_by_field_name("arguments").and_then(|arguments| arguments.named_child(0));
                let Some(module) = argument.filter(|a| a.kind() == "string").map(|a| self.unquoted(a)) else { return false };
                self.required(node, module, found);
                true
            }
            _ => false,
        }
    }

    fn import_clause(&self, clause: Node, module: &str, found: &mut Vec<Import>) {
        let mut cursor = clause.walk();
        for child in clause.named_children(&mut cursor) {
            match child.kind() {
                "identifier" => found.push(Import::new(module, "default", self.text(child))),
                "namespace_import" => {
                    let local = child.named_child(0).map(|id| self.text(id)).unwrap_or_default();
                    found.push(Import::new(module, "*", local));
                }
                "named_imports" => self.specifiers(child, "import_specifier", module, found),
                _ => {}
            }
        }
    }

    fn specifiers(&self, list: Node, kind: &str, module: &str, found: &mut Vec<Import>) {
        let mut cursor = list.walk();
        for specifier in list.named_children(&mut cursor).filter(|child| child.kind() == kind) {
            let Some(name) = specifier.child_by_field_name("name").map(|n| self.unquoted(n)) else { continue };
            let local = specifier.child_by_field_name("alias").map(|a| self.unquoted(a)).unwrap_or_else(|| name.clone());
            found.push(Import::new(module, name, local));
        }
    }

    /// `require('m')` or `import('m')`, bound by the declaration around it when there is one.
    fn required(&self, call: Node, module: String, found: &mut Vec<Import>) {
        let target = call.parent().filter(|p| p.kind() == "variable_declarator").and_then(|d| d.child_by_field_name("name"));
        match target {
            Some(name) if name.kind() == "identifier" => found.push(Import::new(module, "*", self.text(name))),
            Some(pattern) if pattern.kind() == "object_pattern" => {
                let mut cursor = pattern.walk();
                for property in pattern.named_children(&mut cursor) {
                    match property.kind() {
                        "shorthand_property_identifier_pattern" => {
                            let name = self.text(property);
                            found.push(Import::new(&module, name.clone(), name));
                        }
                        "pair_pattern" => {
                            let key = property.child_by_field_name("key").map(|k| self.unquoted(k));
                            let value = property.child_by_field_name("value").filter(|v| v.kind() == "identifier");
                            if let (Some(key), Some(value)) = (key, value) {
                                found.push(Import::new(&module, key, self.text(value)));
                            }
                        }
                        _ => {}
                    }
                }
            }
            _ => found.push(Import::new(module, "*", "")),
        }
    }

    fn python(&self, node: Node, found: &mut Vec<Import>) -> bool {
        match node.kind() {
            "import_statement" => {
                let mut cursor = node.walk();
                for child in node.named_children(&mut cursor) {
                    match child.kind() {
                        // `import a.b` binds `a`; the module is still `a.b`.
                        "dotted_name" => {
                            let module = self.text(child);
                            let local = module.split('.').next().unwrap_or_default().to_owned();
                            found.push(Import::new(module, "*", local));
                        }
                        "aliased_import" => {
                            let module = child.child_by_field_name("name").map(|n| self.text(n)).unwrap_or_default();
                            let local = child.child_by_field_name("alias").map(|a| self.text(a)).unwrap_or_default();
                            found.push(Import::new(module, "*", local));
                        }
                        _ => {}
                    }
                }
                true
            }
            "import_from_statement" => {
                let Some(module_node) = node.child_by_field_name("module_name") else { return true };
                let module = self.text(module_node);
                let mut cursor = node.walk();
                for child in node.named_children(&mut cursor) {
                    if child.id() == module_node.id() {
                        continue;
                    }
                    match child.kind() {
                        "dotted_name" => {
                            let name = self.text(child);
                            found.push(Import::new(&module, name.clone(), name));
                        }
                        "aliased_import" => {
                            let name = child.child_by_field_name("name").map(|n| self.text(n)).unwrap_or_default();
                            let local = child.child_by_field_name("alias").map(|a| self.text(a)).unwrap_or_default();
                            found.push(Import::new(&module, name, local));
                        }
                        "wildcard_import" => found.push(Import::new(&module, "*", "")),
                        _ => {}
                    }
                }
                true
            }
            _ => false,
        }
    }

    fn go(&self, node: Node, found: &mut Vec<Import>) -> bool {
        if node.kind() != "import_spec" {
            return false;
        }
        let Some(path) = node.child_by_field_name("path").map(|p| self.unquoted(p)) else { return true };
        let alias = node.child_by_field_name("name").map(|n| self.text(n));
        let last = path.rsplit('/').next().unwrap_or_default().to_owned();
        let import = match alias.as_deref() {
            Some(".") => Import::new(path, "*", ""),
            Some("_") => Import::new(path, "", ""),
            Some(alias) => Import::new(path, "*", alias),
            None => Import::new(path, "*", last),
        };
        found.push(import);
        true
    }

    fn rust(&self, node: Node, found: &mut Vec<Import>) -> bool {
        match node.kind() {
            "use_declaration" => {
                if let Some(argument) = node.child_by_field_name("argument") {
                    self.use_tree(argument, "", found);
                }
                true
            }
            // `mod store;` makes the child module `store` of this one, as `use self::store` names it.
            "mod_item" if node.child_by_field_name("body").is_none() => {
                if let Some(name) = node.child_by_field_name("name").map(|n| self.text(n)) {
                    found.push(Import::new(format!("self::{name}"), "*", name));
                }
                true
            }
            _ => false,
        }
    }

    /// One part of a `use` tree; `prefix` is the path of the lists it sits in, ending in `::` when not empty.
    fn use_tree(&self, node: Node, prefix: &str, found: &mut Vec<Import>) {
        let module_of = |path: &str| path.rsplit_once("::").map(|(module, _)| module.to_owned());
        match node.kind() {
            "scoped_identifier" | "identifier" | "crate" | "super" | "self" => {
                let path = format!("{prefix}{}", self.text(node));
                let last = path.rsplit("::").next().unwrap_or_default().to_owned();
                match module_of(&path) {
                    // `use a::{self}` binds the module `a` itself.
                    Some(module) if last == "self" => {
                        let local = module.rsplit("::").next().unwrap_or_default().to_owned();
                        found.push(Import::new(module, "*", local));
                    }
                    Some(module) => found.push(Import::new(module, last.clone(), last)),
                    None => found.push(Import::new(path, "*", last)),
                }
            }
            "use_as_clause" => {
                let Some(path) = node.child_by_field_name("path").map(|p| format!("{prefix}{}", self.text(p))) else { return };
                let local = node.child_by_field_name("alias").map(|a| self.text(a)).unwrap_or_default();
                match module_of(&path) {
                    Some(module) => found.push(Import::new(module, path.rsplit("::").next().unwrap_or_default(), local)),
                    None => found.push(Import::new(path, "*", local)),
                }
            }
            "use_wildcard" => {
                let module = self.text(node);
                let module = module.trim_end_matches("*").trim_end_matches("::");
                found.push(Import::new(format!("{prefix}{module}"), "*", ""));
            }
            "scoped_use_list" => {
                let inner = match node.child_by_field_name("path") {
                    Some(path) => format!("{prefix}{}::", self.text(path)),
                    None => prefix.to_owned(),
                };
                if let Some(list) = node.child_by_field_name("list") {
                    self.use_tree(list, &inner, found);
                }
            }
            "use_list" => {
                let mut cursor = node.walk();
                for item in node.named_children(&mut cursor) {
                    self.use_tree(item, prefix, found);
                }
            }
            _ => {}
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tree_sitter::Parser;

    fn imports(language: Language, source: &str) -> Vec<(String, String, String)> {
        let grammar: tree_sitter::Language = match language {
            Language::TypeScript => tree_sitter_typescript::LANGUAGE_TYPESCRIPT.into(),
            Language::JavaScript => tree_sitter_javascript::LANGUAGE.into(),
            Language::Python => tree_sitter_python::LANGUAGE.into(),
            Language::Go => tree_sitter_go::LANGUAGE.into(),
            Language::Rust => tree_sitter_rust::LANGUAGE.into(),
            _ => unreachable!(),
        };
        let mut parser = Parser::new();
        parser.set_language(&grammar).unwrap();
        let tree = parser.parse(source, None).unwrap();
        imports_of(language, tree.root_node(), source.as_bytes())
            .into_iter()
            .map(|i| (i.module, i.name, i.local))
            .collect()
    }

    fn i(module: &str, name: &str, local: &str) -> (String, String, String) {
        (module.to_owned(), name.to_owned(), local.to_owned())
    }

    #[test]
    fn typescript_imports_and_re_exports() {
        let source = "import Store, { load, save as persist } from './store.js';\nimport * as fs from 'node:fs';\n\
            import type { Shape } from \"./shape\";\nimport './side-effect';\nimport cfg = require('./config');\n\
            export * from './all';\nexport * as ns from './ns';\nexport { run as start, stop } from './run';\n\
            export const local = 1;\n";
        assert_eq!(
            imports(Language::TypeScript, source),
            vec![
                i("./store.js", "default", "Store"),
                i("./store.js", "load", "load"),
                i("./store.js", "save", "persist"),
                i("node:fs", "*", "fs"),
                i("./shape", "Shape", "Shape"),
                i("./side-effect", "", ""),
                i("./config", "*", "cfg"),
                i("./all", "*", ""),
                i("./ns", "*", "ns"),
                i("./run", "run", "start"),
                i("./run", "stop", "stop"),
            ]
        );
    }

    #[test]
    fn javascript_require_and_dynamic_import() {
        let source = "const path = require('path');\nconst { join, resolve: r } = require('./paths');\n\
            require('./register');\nasync function f() { const m = await import('./lazy.js'); }\nfoo('./not-a-module');\n";
        assert_eq!(
            imports(Language::JavaScript, source),
            vec![
                i("path", "*", "path"),
                i("./paths", "join", "join"),
                i("./paths", "resolve", "r"),
                i("./register", "*", ""),
                i("./lazy.js", "*", ""),
            ]
        );
    }

    #[test]
    fn python_imports_absolute_relative_and_wildcard() {
        let source = "import os.path\nimport numpy as np\nfrom . import models\nfrom ..core.store import Store, load as fetch\n\
            from pkg import *\ndef f():\n    from inner import helper\n";
        assert_eq!(
            imports(Language::Python, source),
            vec![
                i("os.path", "*", "os"),
                i("numpy", "*", "np"),
                i(".", "models", "models"),
                i("..core.store", "Store", "Store"),
                i("..core.store", "load", "fetch"),
                i("pkg", "*", ""),
                i("inner", "helper", "helper"),
            ]
        );
    }

    #[test]
    fn go_imports_with_their_package_names() {
        let source = "package p\nimport \"fmt\"\nimport (\n  st \"example.com/app/store\"\n  . \"example.com/app/dot\"\n  _ \"example.com/app/driver\"\n  \"example.com/app/run\"\n)\n";
        assert_eq!(
            imports(Language::Go, source),
            vec![
                i("fmt", "*", "fmt"),
                i("example.com/app/store", "*", "st"),
                i("example.com/app/dot", "*", ""),
                i("example.com/app/driver", "", ""),
                i("example.com/app/run", "*", "run"),
            ]
        );
    }

    #[test]
    fn rust_use_trees_and_module_files() {
        let source = "mod store;\nmod inline { fn f() {} }\npub mod api;\nuse crate::store::Store;\nuse std::{fs, io::{self, Read as R}};\n\
            use super::*;\npub use self::api::run;\nuse serde;\n";
        assert_eq!(
            imports(Language::Rust, source),
            vec![
                i("self::store", "*", "store"),
                i("self::api", "*", "api"),
                i("crate::store", "Store", "Store"),
                i("std", "fs", "fs"),
                i("std::io", "*", "io"),
                i("std::io", "Read", "R"),
                i("super", "*", ""),
                i("self::api", "run", "run"),
                i("serde", "*", "serde"),
            ]
        );
    }
}
