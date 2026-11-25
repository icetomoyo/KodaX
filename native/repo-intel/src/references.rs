//! Which file's definition a reference names, for the languages with module resolution.
//! Nothing here is stored: a query resolves the references it returns.
//!
//! A bare name is what the file binds it to: an import, followed to the definition (through
//! re-exports, `export *`, Python package `__init__` files and Rust `pub use`), else a
//! definition in the file, else a wildcard import, else (Go) its package. A name bound by
//! none of these is a builtin, a parameter or a local, not a definition elsewhere.
//! A name used on something (`x.run()`) is resolved when `x` is the file itself (`this`,
//! `self`), a module or an imported item; a method on a value stays unknown.

use crate::resolve::Resolution;
use crate::store::{Entry, Hit, ResolvedImport, Store};
use std::collections::{BTreeSet, HashMap};
use std::rc::Rc;

/// What a reference names, as far as the index can tell.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Referent {
    /// A definition in one of these files.
    In(BTreeSet<String>),
    /// No definition in the repository: something from a package, a builtin, a parameter or a local.
    Elsewhere,
    /// The index cannot tell, such as a method called on a value of unknown type.
    Unknown,
}

/// Where following a name through imports ended.
enum Found {
    In(BTreeSet<String>),
    External,
    /// A missing file, or a file without the name: the index cannot see where it is.
    NotSeen,
}

impl From<Found> for Referent {
    fn from(found: Found) -> Referent {
        match found {
            Found::In(files) => Referent::In(files),
            Found::External => Referent::Elsewhere,
            Found::NotSeen => Referent::Unknown,
        }
    }
}

const RESOLVED_LANGUAGES: [&str; 6] = ["typescript", "tsx", "javascript", "python", "go", "rust"];
/// Receivers that are the file's own code; inherited members stay unknown.
const OWN_RECEIVERS: [&str; 4] = ["this", "self", "Self", "cls"];
/// Re-export chains longer than this are taken as cycles.
const MAX_HOPS: usize = 16;

struct Facts {
    language: String,
    definitions: Vec<Hit>,
    imports: Vec<ResolvedImport>,
}

impl Facts {
    fn defines(&self, name: &str, accept: impl Fn(&Hit) -> bool) -> bool {
        self.definitions.iter().any(|d| d.name == name && accept(d))
    }

    fn import_of(&self, local: &str) -> Option<&ResolvedImport> {
        self.imports.iter().find(|i| i.import.local == local)
    }

    /// Wildcard imports: `from x import *`, `use x::*`, Go's `import . "x"`, TS `export * from`.
    fn wildcards(&self) -> Vec<Resolution> {
        self.imports
            .iter()
            .filter(|i| i.import.name == "*" && i.import.local.is_empty())
            .filter_map(|i| i.lead.clone())
            .collect()
    }
}

/// `import * as ns`, `import pkg`, or `from pkg import models` where `models` is a submodule.
fn binds_module(import: &ResolvedImport) -> bool {
    import.import.name == "*" || import.submodule
}

fn only(path: &str) -> Referent {
    Referent::In(BTreeSet::from([path.to_owned()]))
}

fn folder_of(path: &str) -> &str {
    path.rsplit_once('/').map_or("", |(folder, _)| folder)
}

pub struct Lookup<'s> {
    store: &'s Store,
    facts: HashMap<String, Option<Rc<Facts>>>,
    referents: HashMap<(String, String, Option<String>), Referent>,
}

impl<'s> Lookup<'s> {
    pub fn new(store: &'s Store) -> Lookup<'s> {
        Lookup { store, facts: HashMap::new(), referents: HashMap::new() }
    }

    /// What `name`, used in the file at `path` on `receiver` (`store` in `store.run()`), names.
    pub fn referent(&mut self, path: &str, name: &str, receiver: Option<&str>) -> rusqlite::Result<Referent> {
        let key = (path.to_owned(), name.to_owned(), receiver.map(str::to_owned));
        if let Some(known) = self.referents.get(&key) {
            return Ok(known.clone());
        }
        let referent = match self.facts(path)? {
            Some(facts) if RESOLVED_LANGUAGES.contains(&facts.language.as_str()) => match receiver {
                None => self.bare(path, &facts, name)?,
                Some(receiver) => self.member(path, &facts, receiver, name)?,
            },
            _ => Referent::Unknown,
        };
        self.referents.insert(key, referent.clone());
        Ok(referent)
    }

    fn facts(&mut self, path: &str) -> rusqlite::Result<Option<Rc<Facts>>> {
        if let Some(facts) = self.facts.get(path) {
            return Ok(facts.clone());
        }
        let facts = match self.store.entry(path)? {
            Some(Entry::Indexed { language, definitions, .. }) => {
                Some(Rc::new(Facts { language, definitions, imports: self.store.imports(path)? }))
            }
            _ => None,
        };
        self.facts.insert(path.to_owned(), facts.clone());
        Ok(facts)
    }

    fn bare(&mut self, path: &str, facts: &Facts, name: &str) -> rusqlite::Result<Referent> {
        if let Some(import) = facts.import_of(name) {
            return Ok(match &import.lead {
                Some(lead) if !binds_module(import) => self.follow(lead, &import.import.name, 0)?.into(),
                // A module called as a function, or a language without module resolution.
                _ => Referent::Unknown,
            });
        }
        if facts.defines(name, |d| d.kind != "method") {
            return Ok(only(path));
        }
        // TypeScript `export *` binds nothing in the file itself.
        if matches!(facts.language.as_str(), "python" | "go" | "rust") {
            let found = self.through_wildcards(facts, name, 0)?;
            if !found.is_empty() {
                return Ok(Referent::In(found));
            }
        }
        if facts.language == "go"
            && let Found::In(files) = self.in_package(folder_of(path), name)?
        {
            return Ok(Referent::In(files));
        }
        Ok(Referent::Elsewhere)
    }

    fn member(&mut self, path: &str, facts: &Facts, receiver: &str, name: &str) -> rusqlite::Result<Referent> {
        if OWN_RECEIVERS.contains(&receiver) {
            return Ok(if facts.defines(name, |_| true) { only(path) } else { Referent::Unknown });
        }
        let head = receiver.split(['.', ':']).next().unwrap_or_default();
        let dotted = head.len() != receiver.len();
        let Some(import) = facts.import_of(head).filter(|_| !head.is_empty()) else {
            // A type defined in this file, with the member defined in it.
            let own_member = !dotted && facts.defines(name, |d| d.container.as_deref() == Some(receiver));
            return Ok(if own_member { only(path) } else { Referent::Unknown });
        };
        let Some(lead) = &import.lead else { return Ok(Referent::Unknown) };
        if *lead == Resolution::External {
            return Ok(Referent::Elsewhere);
        }
        if binds_module(import) {
            // `import pkg.util` binds `pkg`; only the whole dotted path is the module it leads to.
            let whole = !dotted || (import.import.name == "*" && import.import.module == receiver);
            return Ok(if whole { self.follow(lead, name, 0)?.into() } else { Referent::Unknown });
        }
        if dotted {
            return Ok(Referent::Unknown);
        }
        // An imported item such as a class: the member is where the item is defined.
        match self.follow(lead, &import.import.name, 0)? {
            Found::In(owners) => self.defining(owners, name),
            found => Ok(found.into()),
        }
    }

    /// Of `owners`, the files that define `name`; unknown when none does (it may be inherited).
    fn defining(&mut self, owners: BTreeSet<String>, name: &str) -> rusqlite::Result<Referent> {
        let mut members = BTreeSet::new();
        for owner in owners {
            if self.facts(&owner)?.is_some_and(|facts| facts.defines(name, |_| true)) {
                members.insert(owner);
            }
        }
        Ok(if members.is_empty() { Referent::Unknown } else { Referent::In(members) })
    }

    /// Where `name` is defined, starting from where an import leads.
    fn follow(&mut self, lead: &Resolution, name: &str, hops: usize) -> rusqlite::Result<Found> {
        match lead {
            Resolution::External => Ok(Found::External),
            Resolution::Missing => Ok(Found::NotSeen),
            Resolution::Folder(folder) => self.in_package(folder, name),
            Resolution::File(path) => self.exported(path, name, hops),
        }
    }

    /// Where the file at `path` gets its top-level `name`: from itself or from what it imports.
    fn exported(&mut self, path: &str, name: &str, hops: usize) -> rusqlite::Result<Found> {
        let Some(facts) = self.facts(path)?.filter(|_| hops <= MAX_HOPS) else { return Ok(Found::NotSeen) };
        if facts.defines(name, |d| d.container.is_none()) {
            return Ok(Found::In(BTreeSet::from([path.to_owned()])));
        }
        if let Some(import) = facts.import_of(name) {
            return match &import.lead {
                Some(lead) if !binds_module(import) => self.follow(lead, &import.import.name, hops + 1),
                _ => Ok(Found::NotSeen),
            };
        }
        let found = self.through_wildcards(&facts, name, hops + 1)?;
        Ok(if found.is_empty() { Found::NotSeen } else { Found::In(found) })
    }

    fn through_wildcards(&mut self, facts: &Facts, name: &str, hops: usize) -> rusqlite::Result<BTreeSet<String>> {
        let mut found = BTreeSet::new();
        for lead in facts.wildcards() {
            if let Found::In(files) = self.follow(&lead, name, hops)? {
                found.extend(files);
            }
        }
        Ok(found)
    }

    /// A Go package: the files right in the folder. (A Python namespace package defines nothing.)
    fn in_package(&mut self, folder: &str, name: &str) -> rusqlite::Result<Found> {
        let files: BTreeSet<String> = self
            .store
            .top_level_paths(name)?
            .into_iter()
            .filter(|path| path.ends_with(".go") && folder_of(path) == folder)
            .collect();
        Ok(if files.is_empty() { Found::NotSeen } else { Found::In(files) })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::manifest::tests::repo;
    use crate::workspace::Workspace;
    use crate::workspace::tests::wait_for_sweeps;

    fn indexed(files: &[(&str, &str)]) -> (tempfile::TempDir, tempfile::TempDir, Workspace) {
        let dir = repo(files);
        let storage = tempfile::tempdir().unwrap();
        let workspace = Workspace::open(dir.path().to_owned(), storage.path().to_owned()).unwrap();
        wait_for_sweeps(&workspace, 1);
        (dir, storage, workspace)
    }

    fn files(paths: &[&str]) -> Referent {
        Referent::In(paths.iter().map(|path| (*path).to_owned()).collect())
    }

    fn check(workspace: &Workspace, cases: &[(&str, &str, Option<&str>, Referent)]) {
        let mut lookup = Lookup::new(workspace.reader());
        for (path, name, receiver, expected) in cases {
            let found = lookup.referent(path, name, *receiver).unwrap();
            assert_eq!(&found, expected, "{name} on {receiver:?} in {path}");
        }
    }

    #[test]
    fn typescript_names_lead_through_imports_and_re_exports() {
        let (_dir, _storage, workspace) = indexed(&[
            ("src/store.ts", "export function open() {}\nexport class Store {\n  load() { this.load(); }\n  static create() {}\n}\nfunction local() { open(); }\n"),
            ("src/index.ts", "export * from './store';\n"),
            ("src/barrel.ts", "export { open, Store } from './index';\n"),
            ("src/other.ts", "export function open() {}\nopen();\n"),
            (
                "src/app.ts",
                "import { open, Store } from './barrel';\nimport * as st from './store';\nimport { join } from 'node:path';\n\
                 import { gone } from './missing';\nopen();\nst.open();\nStore.create();\njoin();\ngone();\ndescribe();\n\
                 store.load();\nnew Store();\nfunction run() { helper(); }\nfunction helper() {}\n",
            ),
        ]);
        check(
            &workspace,
            &[
                ("src/app.ts", "open", None, files(&["src/store.ts"])),
                ("src/app.ts", "open", Some("st"), files(&["src/store.ts"])),
                ("src/app.ts", "create", Some("Store"), files(&["src/store.ts"])),
                ("src/app.ts", "Store", None, files(&["src/store.ts"])),
                ("src/app.ts", "join", None, Referent::Elsewhere),
                ("src/app.ts", "gone", None, Referent::Unknown),
                ("src/app.ts", "describe", None, Referent::Elsewhere),
                ("src/app.ts", "load", Some("store"), Referent::Unknown),
                ("src/app.ts", "helper", None, files(&["src/app.ts"])),
                ("src/store.ts", "load", Some("this"), files(&["src/store.ts"])),
                ("src/store.ts", "open", None, files(&["src/store.ts"])),
                ("src/other.ts", "open", None, files(&["src/other.ts"])),
            ],
        );
        workspace.close().unwrap();
    }

    #[test]
    fn python_names_lead_through_packages_submodules_and_wildcards() {
        let (_dir, _storage, workspace) = indexed(&[
            ("pkg/__init__.py", "from .models import User\nfrom . import util\n"),
            ("pkg/models.py", "class User:\n    def save(self):\n        self.save()\n"),
            ("pkg/util.py", "def helper():\n    pass\n"),
            ("app.py", "from pkg import User, util\nimport pkg.util\nfrom pkg.util import *\nUser()\nutil.helper()\nUser.save()\nhelper()\nlen()\npkg.util.helper()\n"),
        ]);
        check(
            &workspace,
            &[
                ("app.py", "User", None, files(&["pkg/models.py"])),
                ("app.py", "helper", Some("util"), files(&["pkg/util.py"])),
                ("app.py", "save", Some("User"), files(&["pkg/models.py"])),
                ("app.py", "helper", None, files(&["pkg/util.py"])),
                ("app.py", "len", None, Referent::Elsewhere),
                ("app.py", "helper", Some("pkg.util"), files(&["pkg/util.py"])),
                ("pkg/models.py", "save", Some("self"), files(&["pkg/models.py"])),
            ],
        );
        workspace.close().unwrap();
    }

    #[test]
    fn go_names_lead_to_their_package_folder() {
        let (_dir, _storage, workspace) = indexed(&[
            ("go.mod", "module example.com/app\n"),
            ("store/store.go", "package store\n\nfunc Open() {}\n\nfunc helper() {}\n"),
            ("store/other.go", "package store\n\nfunc use() { helper() }\n"),
            ("main.go", "package main\n\nimport \"example.com/app/store\"\n\nfunc main() { store.Open(); println() }\n"),
        ]);
        check(
            &workspace,
            &[
                ("main.go", "Open", Some("store"), files(&["store/store.go"])),
                ("store/other.go", "helper", None, files(&["store/store.go"])),
                ("main.go", "println", None, Referent::Elsewhere),
            ],
        );
        workspace.close().unwrap();
    }

    #[test]
    fn rust_names_lead_through_use_paths_and_module_aliases() {
        let (_dir, _storage, workspace) = indexed(&[
            ("Cargo.toml", "[package]\nname = \"app\"\n"),
            ("src/lib.rs", "mod store;\nuse crate::store::{open, Store};\nuse crate::store as st;\nfn main() { open(); st::open(); Store::new(); }\n"),
            (
                "src/store.rs",
                "pub fn open() {}\npub struct Store;\nimpl Store {\n    pub fn new() -> Self { Self::make() }\n    fn make() -> Self { Store }\n}\n\
                 #[cfg(test)]\nmod tests {\n    use super::*;\n    fn t() { open(); }\n}\n",
            ),
        ]);
        check(
            &workspace,
            &[
                ("src/lib.rs", "open", None, files(&["src/store.rs"])),
                ("src/lib.rs", "open", Some("st"), files(&["src/store.rs"])),
                ("src/lib.rs", "new", Some("Store"), files(&["src/store.rs"])),
                ("src/store.rs", "make", Some("Self"), files(&["src/store.rs"])),
                ("src/store.rs", "open", None, files(&["src/store.rs"])),
            ],
        );
        workspace.close().unwrap();
    }

    #[test]
    fn languages_without_module_resolution_are_left_to_name_matching() {
        let (_dir, _storage, workspace) = indexed(&[("A.java", "class A { void run() { run(); } }\n")]);
        check(&workspace, &[("A.java", "run", None, Referent::Unknown)]);
        workspace.close().unwrap();
    }
}
