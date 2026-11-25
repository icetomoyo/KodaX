//! L2: where an import leads in the repository, by each language's own rules (see the
//! submodules). An import leads to a file, or to a folder when the language imports
//! folders (a Go package, a Python namespace package); otherwise it is external or missing.
//!
//! `from pkg import x` (Python) and `use crate::{store}` (Rust) can name a submodule:
//! `member` gives that file when the imported name is one.

mod go;
mod python;
mod rust;
mod script;

use crate::manifest::Language;
use std::collections::HashSet;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Resolution {
    /// A file in the repository.
    File(String),
    /// A folder in the repository whose files together make the module.
    Folder(String),
    /// A package from outside the repository, or one of the language's own (`node:fs`, `std`).
    External,
    /// It names something in the repository, but no such file is there.
    Missing,
}

impl Resolution {
    /// The target path, if any, and the kind as stored: `file`, `folder`, `external` or `missing`.
    pub fn parts(&self) -> (Option<&str>, &'static str) {
        match self {
            Resolution::File(path) => (Some(path), "file"),
            Resolution::Folder(path) => (Some(path), "folder"),
            Resolution::External => (None, "external"),
            Resolution::Missing => (None, "missing"),
        }
    }

    pub fn from_parts(target: Option<String>, kind: &str) -> Option<Resolution> {
        match (kind, target) {
            ("file", Some(path)) => Some(Resolution::File(path)),
            ("folder", Some(path)) => Some(Resolution::Folder(path)),
            ("external", _) => Some(Resolution::External),
            ("missing", _) => Some(Resolution::Missing),
            _ => None,
        }
    }
}

/// Whether a change to this file's text can change how imports resolve.
pub fn is_resolution_config(path: &str) -> bool {
    let name = file_name(path);
    script::is_config(name) || name == "go.mod" || name == "Cargo.toml"
}

pub struct Resolver {
    files: HashSet<String>,
    scripts: script::Scripts,
    python: python::Python,
    go: go::Go,
    rust: rust::Rust,
}

impl Resolver {
    /// `files` are every path of the repository; `read` gives a file's text, and is asked only for configuration.
    pub fn new(files: HashSet<String>, read: impl Fn(&str) -> Option<String>) -> Resolver {
        Resolver {
            scripts: script::Scripts::new(&files, &read),
            python: python::Python::new(&files),
            go: go::Go::new(&files, &read),
            rust: rust::Rust::new(&files, &read),
            files,
        }
    }

    /// Where `module`, imported by the file at `from`, leads; None for languages without module resolution.
    pub fn resolve(&self, language: Language, from: &str, module: &str) -> Option<Resolution> {
        match language {
            Language::TypeScript | Language::Tsx | Language::JavaScript => Some(self.scripts.resolve(&self.files, from, module)),
            Language::Python => Some(self.python.resolve(&self.files, from, module)),
            Language::Go => Some(self.go.resolve(module)),
            Language::Rust => Some(self.rust.resolve(&self.files, from, module)),
            Language::Java | Language::Cpp => None,
        }
    }

    /// The submodule `name` of `module` when it is one, given where `module` leads (`lead`).
    pub fn member(&self, language: Language, from: &str, module: &str, name: &str, lead: &Resolution) -> Option<Resolution> {
        if name.is_empty() || name == "*" {
            return None;
        }
        let path = match language {
            Language::Python if module.ends_with('.') => format!("{module}{name}"),
            Language::Python => format!("{module}.{name}"),
            Language::Rust => format!("{module}::{name}"),
            _ => return None,
        };
        let found = self.resolve(language, from, &path)?;
        (matches!(found, Resolution::File(_) | Resolution::Folder(_)) && found != *lead).then_some(found)
    }
}

/// `folder` joined with a relative path, `.` and `..` resolved; None when it leaves the repository.
fn join(folder: &str, relative: &str) -> Option<String> {
    let mut parts: Vec<&str> = folder.split('/').filter(|part| !part.is_empty()).collect();
    for part in relative.split('/') {
        match part {
            "" | "." => {}
            ".." => {
                parts.pop()?;
            }
            part => parts.push(part),
        }
    }
    Some(parts.join("/"))
}

/// `relative` inside `folder`, where `""` is the repository root.
fn under(folder: &str, relative: &str) -> String {
    if folder.is_empty() { relative.to_owned() } else { format!("{folder}/{relative}") }
}

fn parent(path: &str) -> &str {
    path.rsplit_once('/').map_or("", |(folder, _)| folder)
}

fn folder_prefix(path: &str) -> &str {
    path.rsplit_once('/').map_or("", |(folder, _)| &path[..=folder.len()])
}

fn file_name(path: &str) -> &str {
    path.rsplit('/').next().unwrap_or(path)
}

#[cfg(test)]
pub mod tests {
    use super::*;
    use std::collections::HashMap;

    pub fn resolver(files: &[(&str, &str)]) -> Resolver {
        let texts: HashMap<String, String> = files.iter().map(|(path, text)| ((*path).to_owned(), (*text).to_owned())).collect();
        let paths = texts.keys().cloned().collect();
        Resolver::new(paths, |path| texts.get(path).cloned())
    }

    pub fn file(path: &str) -> Resolution {
        Resolution::File(path.to_owned())
    }

    #[test]
    fn config_files_are_recognized_and_java_and_cpp_are_not_resolved() {
        for config in ["tsconfig.json", "pkg/tsconfig.build.json", "jsconfig.json", "a/package.json", "go.mod", "crates/x/Cargo.toml"] {
            assert!(is_resolution_config(config), "{config}");
        }
        assert!(!is_resolution_config("src/package.ts"));
        assert!(!is_resolution_config("data.json"));
        let r = resolver(&[("A.java", "")]);
        assert_eq!(r.resolve(Language::Java, "A.java", "java.util.List"), None);
        assert_eq!(r.resolve(Language::Cpp, "a.cpp", "vector"), None);
    }

    #[test]
    fn a_member_is_a_submodule_only_when_it_leads_somewhere_else() {
        let r = resolver(&[
            ("pkg/__init__.py", ""),
            ("pkg/models.py", ""),
            ("pkg/app.py", ""),
            ("Cargo.toml", "[package]\nname = \"app\"\n"),
            ("src/lib.rs", ""),
            ("src/store.rs", ""),
        ]);
        let init = file("pkg/__init__.py");
        assert_eq!(r.member(Language::Python, "pkg/app.py", ".", "models", &init), Some(file("pkg/models.py")));
        assert_eq!(r.member(Language::Python, "main.py", "pkg", "models", &init), Some(file("pkg/models.py")));
        assert_eq!(r.member(Language::Python, "pkg/app.py", ".", "VERSION", &init), None);
        assert_eq!(r.member(Language::Python, "pkg/app.py", ".", "*", &init), None);
        let lib = file("src/lib.rs");
        assert_eq!(r.member(Language::Rust, "src/lib.rs", "crate", "store", &lib), Some(file("src/store.rs")));
        assert_eq!(r.member(Language::Rust, "src/lib.rs", "crate", "Config", &lib), None);
        assert_eq!(r.member(Language::TypeScript, "a.ts", "./b", "x", &file("b.ts")), None);
    }
}
