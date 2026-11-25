//! Rust: `use` paths and `mod` declarations to the files of the module tree.
//! - A file's child modules sit next to it when it is a crate root or a `mod.rs`, and
//!   in the folder named after it otherwise (`src/a.rs` → `src/a/b.rs`), each as
//!   `x.rs` or `x/mod.rs`.
//! - `self`, `super` and `crate` start at the file's own module, its parent and the
//!   crate root. A first segment that is a child module of the file starts there
//!   (Rust 2018 paths); one that is the name of a workspace crate starts at its
//!   library root. Anything else is external.
//! - The path is followed while its segments are module files; the rest names items
//!   (or inline modules) of the last file reached.
//! - A `mod` with a `#[path]` attribute imports that file, relative to the folder of the
//!   declaring file; declared in inline modules, under them as folders (and, unless the file
//!   is a crate root or a `mod.rs`, under the folder named after it). A file reached this
//!   way has its `super` read as if it were an ordinary module file. A `[lib] path` in
//!   Cargo.toml names the library root.

use super::{Resolution, file_name, join, parent, under};
use std::collections::HashSet;

/// Crate roots other than the library and `src/main.rs`: their folders, relative to the crate.
const ROOT_FOLDERS: [&str; 4] = ["src/bin", "tests", "examples", "benches"];

pub struct Rust {
    /// The workspace's crates, the shallowest first.
    crates: Vec<Crate>,
}

struct Crate {
    folder: String,
    /// The name code uses for it.
    name: String,
    /// Its library root, `src/lib.rs` unless Cargo.toml says otherwise.
    lib: String,
}

/// A module: its file, if it has one, and the folder its child modules are in.
#[derive(Debug, Clone)]
struct Module {
    file: Option<String>,
    folder: String,
}

impl Rust {
    pub fn new(files: &HashSet<String>, read: &impl Fn(&str) -> Option<String>) -> Rust {
        let mut crates: Vec<Crate> = files
            .iter()
            .filter(|path| file_name(path) == "Cargo.toml")
            .filter_map(|path| {
                let (name, lib) = read_manifest(&read(path)?)?;
                let folder = parent(path).to_owned();
                let lib = join(&folder, lib.as_deref().unwrap_or("src/lib.rs"))?;
                Some(Crate { folder, name, lib })
            })
            .collect();
        crates.sort_by(|a, b| (a.folder.len(), &a.folder).cmp(&(b.folder.len(), &b.folder)));
        Rust { crates }
    }

    pub fn resolve(&self, files: &HashSet<String>, from: &str, module: &str) -> Resolution {
        if module.contains('/') || module.ends_with(".rs") {
            // A `#[path]` module. One declared in an inline module of `src/a.rs` is under `src/a/`.
            let own = own_module(&self.root_of(files, from), from);
            let mut paths = [parent(from), own.folder.as_str()].into_iter().filter_map(|folder| join(folder, module));
            return paths.find(|path| files.contains(path)).map_or(Resolution::Missing, Resolution::File);
        }
        let segments: Vec<&str> = module.trim_start_matches("::").split("::").collect();
        let root = self.root_of(files, from);
        let own = own_module(&root, from);
        let (mut at, rest) = match segments[0] {
            "self" => (own, &segments[1..]),
            "crate" => (root, &segments[1..]),
            "super" => {
                let supers = segments.iter().take_while(|segment| **segment == "super").count();
                let mut at = own;
                for _ in 0..supers {
                    if at.folder == root.folder {
                        return Resolution::Missing;
                    }
                    let folder = parent(&at.folder).to_owned();
                    at = Module { file: owner(files, &root, &folder), folder };
                }
                (at, &segments[supers..])
            }
            first if child(files, &own.folder, first).is_some() => (own, &segments[..]),
            first => match self.crates.iter().find(|krate| krate.name == first) {
                Some(krate) => (library(files, &krate.lib), &segments[1..]),
                None => return Resolution::External,
            },
        };
        for segment in rest {
            let Some(file) = child(files, &at.folder, segment) else { break };
            at = Module { file: Some(file), folder: under(&at.folder, segment) };
        }
        at.file.map_or(Resolution::Missing, Resolution::File)
    }

    /// The root module of the crate target `from` belongs to.
    fn root_of(&self, files: &HashSet<String>, from: &str) -> Module {
        let krate = self.crates.iter().rev().find(|krate| krate.folder.is_empty() || from.starts_with(&format!("{}/", krate.folder)));
        let (folder, lib) = krate.map_or(("", "src/lib.rs"), |krate| (krate.folder.as_str(), krate.lib.as_str()));
        let relative = if folder.is_empty() { from } else { &from[folder.len() + 1..] };
        if from == lib || is_root(relative) {
            return Module { file: Some(from.to_owned()), folder: parent(from).to_owned() };
        }
        let sources = parent(lib);
        if sources.is_empty() || from.starts_with(&format!("{sources}/")) {
            let file = [lib.to_owned(), under(sources, "main.rs")].into_iter().find(|root| files.contains(root));
            return Module { file, folder: sources.to_owned() };
        }
        // A module of a test, example or bench: its root is not known from the path alone.
        let top = relative.split('/').next().unwrap_or_default();
        Module { file: None, folder: under(folder, top) }
    }
}

/// Whether `relative` (a path in a crate) is a crate root.
fn is_root(relative: &str) -> bool {
    if matches!(relative, "src/lib.rs" | "src/main.rs" | "build.rs") {
        return true;
    }
    ROOT_FOLDERS.iter().any(|folder| {
        relative.strip_prefix(folder).and_then(|rest| rest.strip_prefix('/')).is_some_and(|rest| match rest.split_once('/') {
            None => rest.ends_with(".rs"),
            Some((_, last)) => last == "main.rs",
        })
    })
}

/// The module of the file at `path`.
fn own_module(root: &Module, path: &str) -> Module {
    let name = file_name(path);
    let folder = if root.file.as_deref() == Some(path) || name == "mod.rs" {
        parent(path).to_owned()
    } else {
        under(parent(path), name.trim_end_matches(".rs"))
    };
    Module { file: Some(path.to_owned()), folder }
}

/// The file of the module whose children are in `folder`.
fn owner(files: &HashSet<String>, root: &Module, folder: &str) -> Option<String> {
    if folder == root.folder {
        return root.file.clone();
    }
    [format!("{folder}.rs"), format!("{folder}/mod.rs")].into_iter().find(|file| files.contains(file))
}

/// The file of the child module `name` of the module whose children are in `folder`.
fn child(files: &HashSet<String>, folder: &str, name: &str) -> Option<String> {
    let base = under(folder, name);
    [format!("{base}.rs"), format!("{base}/mod.rs")].into_iter().find(|file| files.contains(file))
}

/// The library root module at `lib`.
fn library(files: &HashSet<String>, lib: &str) -> Module {
    Module { file: files.contains(lib).then(|| lib.to_owned()), folder: parent(lib).to_owned() }
}

/// What a Cargo.toml says of its crate: the name code uses (`[lib]` name, else `[package]`
/// name with `-` read as `_`) and the `[lib]` path, if it has one.
fn read_manifest(manifest: &str) -> Option<(String, Option<String>)> {
    let (mut section, mut package, mut lib, mut path) = ("", None, None, None);
    for line in manifest.lines().map(str::trim) {
        if line.starts_with('[') {
            section = line;
            continue;
        }
        let Some((key, value)) = line.split_once('=') else { continue };
        let value = value.trim();
        let Some(quote) = value.chars().next().filter(|c| *c == '"' || *c == '\'') else { continue };
        let Some(name) = value[1..].split(quote).next() else { continue };
        match (section, key.trim()) {
            ("[package]", "name") => package = Some(name.to_owned()),
            ("[lib]", "name") => lib = Some(name.to_owned()),
            ("[lib]", "path") => path = Some(name.to_owned()),
            _ => {}
        }
    }
    Some((lib.or(package)?.replace('-', "_"), path))
}

#[cfg(test)]
mod tests {
    use crate::manifest::Language;
    use crate::resolve::Resolution;
    use crate::resolve::tests::{file, resolver};

    #[test]
    fn paths_follow_the_module_tree_and_workspace_crates() {
        let r = resolver(&[
            ("Cargo.toml", "[workspace]\nmembers = [\"crates/*\"]\n"),
            ("crates/core/Cargo.toml", "[package]\nname = \"app-core\" # the core\nversion = \"0.1.0\"\n"),
            ("crates/core/src/lib.rs", ""),
            ("crates/core/src/store.rs", ""),
            ("crates/core/src/store/sqlite.rs", ""),
            ("crates/core/src/query/mod.rs", ""),
            ("crates/core/src/query/plan.rs", ""),
            ("crates/cli/Cargo.toml", "[package]\nname = \"cli\"\n\n[lib]\nname = 'cli_lib'\n"),
            ("crates/cli/src/main.rs", ""),
            ("crates/cli/src/args.rs", ""),
            ("crates/cli/tests/run.rs", ""),
        ]);
        let resolve = |from: &str, module: &str| r.resolve(Language::Rust, from, module).unwrap();
        let sqlite = "crates/core/src/store/sqlite.rs";
        assert_eq!(resolve(sqlite, "super"), file("crates/core/src/store.rs"));
        assert_eq!(resolve(sqlite, "super::super"), file("crates/core/src/lib.rs"));
        assert_eq!(resolve(sqlite, "super::super::query"), file("crates/core/src/query/mod.rs"));
        assert_eq!(resolve(sqlite, "crate::query::plan"), file("crates/core/src/query/plan.rs"));
        assert_eq!(resolve(sqlite, "self"), file(sqlite));
        // Not a module file: an item or inline module of the last file reached.
        assert_eq!(resolve(sqlite, "crate::Config"), file("crates/core/src/lib.rs"));
        assert_eq!(resolve(sqlite, "std::fs"), Resolution::External);
        let lib = "crates/core/src/lib.rs";
        assert_eq!(resolve(lib, "self::store"), file("crates/core/src/store.rs"));
        assert_eq!(resolve(lib, "store"), file("crates/core/src/store.rs"));
        assert_eq!(resolve(lib, "super"), Resolution::Missing);
        assert_eq!(resolve("crates/core/src/store.rs", "self::sqlite"), file(sqlite));
        assert_eq!(resolve("crates/core/src/query/mod.rs", "self::plan"), file("crates/core/src/query/plan.rs"));
        let main = "crates/cli/src/main.rs";
        assert_eq!(resolve(main, "app_core::store"), file("crates/core/src/store.rs"));
        assert_eq!(resolve(main, "::app_core"), file("crates/core/src/lib.rs"));
        assert_eq!(resolve(main, "crate::args"), file("crates/cli/src/args.rs"));
        assert_eq!(resolve(main, "cli_lib"), Resolution::Missing);
        assert_eq!(resolve("crates/cli/tests/run.rs", "app_core::query"), file("crates/core/src/query/mod.rs"));
        assert_eq!(resolve("crates/cli/tests/run.rs", "serde"), Resolution::External);
    }

    #[test]
    fn a_lib_path_in_cargo_toml_and_path_attributes_name_the_files() {
        let r = resolver(&[
            ("crates/core/Cargo.toml", "[package]\nname = \"core\"\n"),
            ("crates/core/src/lib.rs", ""),
            ("crates/core/src/client.rs", ""),
            ("crates/core/src/client_tests.rs", ""),
            ("crates/core/src/client/tests/retry_tests.rs", ""),
            ("crates/core/src/tests/lib_tests.rs", ""),
            ("crates/core/tests/run.rs", ""),
            ("crates/core/tests/common/Cargo.toml", "[package]\nname = \"core_test_support\"\n\n[lib]\npath = \"lib.rs\"\ndoctest = false\n"),
            ("crates/core/tests/common/lib.rs", ""),
            ("crates/core/tests/common/responses.rs", ""),
        ]);
        let resolve = |from: &str, module: &str| r.resolve(Language::Rust, from, module).unwrap();
        assert_eq!(resolve("crates/core/tests/run.rs", "core_test_support::responses"), file("crates/core/tests/common/responses.rs"));
        assert_eq!(resolve("crates/core/tests/common/lib.rs", "self::responses"), file("crates/core/tests/common/responses.rs"));
        assert_eq!(resolve("crates/core/tests/common/responses.rs", "crate"), file("crates/core/tests/common/lib.rs"));
        assert_eq!(resolve("crates/core/src/client.rs", "client_tests.rs"), file("crates/core/src/client_tests.rs"));
        assert_eq!(resolve("crates/core/src/client.rs", "impl/unix.rs"), Resolution::Missing);
        assert_eq!(resolve("crates/core/src/client.rs", "tests/retry_tests.rs"), file("crates/core/src/client/tests/retry_tests.rs"));
        assert_eq!(resolve("crates/core/src/lib.rs", "tests/lib_tests.rs"), file("crates/core/src/tests/lib_tests.rs"));
    }
}
