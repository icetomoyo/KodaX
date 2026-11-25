//! Go: an import path names a package, which is a folder. A path inside a module of
//! the repository (the `module` line of a `go.mod`) leads to that folder; every other
//! path is external (the standard library or another module).

use super::{Resolution, file_name, parent, under};
use std::cmp::Reverse;
use std::collections::HashSet;

pub struct Go {
    /// The repository's modules, the longest path first: their path and folder.
    modules: Vec<(String, String)>,
    /// Folders that hold Go files.
    packages: HashSet<String>,
}

impl Go {
    pub fn new(files: &HashSet<String>, read: &impl Fn(&str) -> Option<String>) -> Go {
        let mut modules = Vec::new();
        let mut packages = HashSet::new();
        for path in files {
            if path.ends_with(".go") {
                packages.insert(parent(path).to_owned());
            } else if file_name(path) == "go.mod"
                && let Some(module) = read(path).as_deref().and_then(module_path)
            {
                modules.push((module, parent(path).to_owned()));
            }
        }
        // A longer module path is the more specific one; of two copies, the shallower folder wins.
        modules.sort_by(|(a, a_folder), (b, b_folder)| {
            (Reverse(a.len()), a_folder.len(), a_folder).cmp(&(Reverse(b.len()), b_folder.len(), b_folder))
        });
        Go { modules, packages }
    }

    pub fn resolve(&self, module: &str) -> Resolution {
        for (path, folder) in &self.modules {
            let rest = if module == path { Some("") } else { module.strip_prefix(path.as_str()).and_then(|rest| rest.strip_prefix('/')) };
            let Some(rest) = rest else { continue };
            let target = if rest.is_empty() { folder.clone() } else { under(folder, rest) };
            return if self.packages.contains(&target) { Resolution::Folder(target) } else { Resolution::Missing };
        }
        Resolution::External
    }
}

/// The module path a `go.mod` declares.
fn module_path(go_mod: &str) -> Option<String> {
    go_mod.lines().find_map(|line| {
        let line = line.split("//").next().unwrap_or_default();
        let mut words = line.split_whitespace();
        (words.next() == Some("module")).then(|| words.next().map(|path| path.trim_matches('"').to_owned()))?
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::manifest::Language;
    use crate::resolve::tests::resolver;

    #[test]
    fn module_paths_lead_to_package_folders_and_everything_else_is_external() {
        let r = resolver(&[
            ("go.mod", "// the app\nmodule example.com/app // root\n\ngo 1.22\n"),
            ("main.go", ""),
            ("store/store.go", ""),
            ("store/store_test.go", ""),
            ("tools/gen/go.mod", "module \"example.com/app/tools/gen\"\n"),
            ("tools/gen/main.go", ""),
            ("tools/gen/parse/parse.go", ""),
            ("docs/readme.md", ""),
        ]);
        let resolve = |module: &str| r.resolve(Language::Go, "main.go", module).unwrap();
        let folder = |path: &str| Resolution::Folder(path.to_owned());
        assert_eq!(resolve("example.com/app/store"), folder("store"));
        assert_eq!(resolve("example.com/app"), folder(""));
        assert_eq!(resolve("example.com/app/tools/gen/parse"), folder("tools/gen/parse"));
        assert_eq!(resolve("example.com/app/tools/gen"), folder("tools/gen"));
        assert_eq!(resolve("example.com/app/docs"), Resolution::Missing);
        assert_eq!(resolve("example.com/application"), Resolution::External);
        assert_eq!(resolve("fmt"), Resolution::External);
        assert_eq!(resolve("github.com/pkg/errors"), Resolution::External);
    }
}
