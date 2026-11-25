//! One open repository: a thread that keeps its index in step with the files.
//! It sweeps once when opened and every `SWEEP_EVERY` in case something else
//! changed them. A sweep lists the files with git and reads only those whose
//! size or modification time moved. When the Host names files it changed and
//! the index already knows them all, only those files are updated. After each
//! pass it works out where imports lead: for every file when files came or went
//! or a tsconfig or package.json changed, else for the files it re-read.

use crate::extract::Extractor;
use crate::manifest::{self, Language};
use crate::map;
use crate::query;
use crate::resolve::{Resolver, is_resolution_config};
use crate::store::{Edge, FileRow, FileStatus, Known, Store, Table};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, RecvTimeoutError, Sender};
use std::sync::{Arc, Mutex};
use std::thread::{self, JoinHandle};
use std::time::Duration;

const SWEEP_EVERY: Duration = Duration::from_secs(15);
/// Rows written per transaction, so a long first sweep never holds one open.
const BATCH: usize = 500;

#[derive(Debug, Clone, Default)]
struct Status {
    /// `indexing` until the first sweep ends, then `ready`; `degraded` when the last sweep failed.
    state: &'static str,
    error: Option<String>,
    indexed: u64,
    with_syntax_errors: u64,
    not_indexed: Vec<(String, u64)>,
    files_read: u64,
    sweeps: u64,
}

enum Signal {
    Changed(Vec<String>),
    Close,
}

/// What the next pass covers: everything, or only files the Host named.
struct Pending {
    full: bool,
    named: HashSet<String>,
}

impl Pending {
    fn note(&mut self, paths: Vec<String>) {
        self.full |= paths.is_empty();
        self.named.extend(paths);
    }
}

pub struct Workspace {
    root: PathBuf,
    storage: PathBuf,
    /// Queries read through their own connection while the thread writes.
    reader: Store,
    /// For outlines of files that changed since they were indexed.
    extractor: Extractor,
    status: Arc<Mutex<Status>>,
    signals: Sender<Signal>,
    cancel: Arc<AtomicBool>,
    thread: Option<JoinHandle<()>>,
}

/// Where a repository's index lives: named for the folder, keyed by its full path.
pub fn storage_dir(storage_root: &Path, root: &Path) -> PathBuf {
    let text = root.to_string_lossy();
    let key = if cfg!(windows) { text.to_lowercase() } else { text.into_owned() };
    let digest = Sha256::digest(key.trim_end_matches(['/', '\\']).as_bytes());
    let hash: String = digest.iter().take(6).map(|byte| format!("{byte:02x}")).collect();
    let name = root.file_name().map(|name| name.to_string_lossy().into_owned()).unwrap_or_else(|| "root".to_owned());
    storage_root.join(format!("{name}-{hash}"))
}

impl Workspace {
    /// Opens (or makes) the index now, so queries can read it at once; indexing goes on in the background.
    pub fn open(root: PathBuf, storage: PathBuf) -> Result<Workspace, String> {
        for failure in crate::store::remove_older_indexes(&storage) {
            eprintln!("kodax-repo-intel: cannot remove an older index, will try again next time: {failure}");
        }
        let index = storage.join(crate::store::index_file_name());
        let cannot_open = |error: rusqlite::Error| format!("cannot open the index at {}: {error}", index.display());
        let store = Store::open(&index).map_err(cannot_open)?;
        let reader = Store::open(&index).map_err(cannot_open)?;
        let status = Arc::new(Mutex::new(Status { state: "indexing", ..Status::default() }));
        let cancel = Arc::new(AtomicBool::new(false));
        let (signals, inbox) = mpsc::channel();
        let (shared, stop, folder) = (status.clone(), cancel.clone(), root.clone());
        let thread = thread::spawn(move || {
            if let Err(reason) = crate::priority::lower_this_thread() {
                eprintln!("kodax-repo-intel: indexing {} at normal priority: {reason}", folder.display());
            }
            let mut index = Indexer {
                root: folder,
                store: &store,
                extractor: Extractor::default(),
                status: &shared,
                resolver: None,
                reread: HashSet::new(),
                files_moved: false,
            };
            let mut pending = Pending { full: true, named: HashSet::new() };
            loop {
                let outcome = index.run(&pending, &stop);
                pending = Pending { full: false, named: HashSet::new() };
                update(&shared, |status| finish(status, outcome, &store));
                match inbox.recv_timeout(SWEEP_EVERY) {
                    Ok(Signal::Changed(paths)) => pending.note(paths),
                    Ok(Signal::Close) | Err(RecvTimeoutError::Disconnected) => return,
                    Err(RecvTimeoutError::Timeout) => pending.full = true,
                }
                // Edits come in bursts: one pass covers every notice already waiting.
                while let Ok(signal) = inbox.try_recv() {
                    match signal {
                        Signal::Changed(paths) => pending.note(paths),
                        Signal::Close => return,
                    }
                }
            }
        });
        Ok(Workspace { root, storage, reader, extractor: Extractor::default(), status, signals, cancel, thread: Some(thread) })
    }

    /// One page of definitions or references by name, with how complete the index is.
    pub fn find(&self, table: Table, name: &str, limit: u64, offset: u64) -> Result<Value, String> {
        let mut answer = query::find(&self.reader, &self.root, table, name, limit, offset)
            .map_err(|error| format!("the index failed: {error}"))?;
        answer["coverage"] = self.coverage();
        Ok(answer)
    }

    /// One page of the references to the definition `name` in the file at `path`.
    pub fn references_to(&self, path: &str, name: &str, limit: u64, offset: u64) -> Result<Value, String> {
        let mut answer = query::references_to(&self.reader, &self.root, path, name, limit, offset)
            .map_err(|error| format!("the index failed: {error}"))?;
        answer["coverage"] = self.coverage();
        Ok(answer)
    }

    /// The repository map in at most `tokens` tokens.
    pub fn map(&self, tokens: u64) -> Result<Value, String> {
        let map = map::repo_map(&self.reader, &self.root, tokens).map_err(|error| format!("the index failed: {error}"))?;
        Ok(json!({
            "text": map.text,
            "files": map.files,
            "definitions": map.definitions,
            "tokens": map.tokens,
            "coverage": self.coverage(),
        }))
    }

    #[cfg(test)]
    pub fn reader(&self) -> &Store {
        &self.reader
    }

    /// What one file imports and where each import leads.
    pub fn imports(&self, path: &str) -> Result<Value, String> {
        let mut answer = query::imports(&self.reader, &self.root, path)?;
        answer["coverage"] = self.coverage();
        Ok(answer)
    }

    pub fn outline(&mut self, path: &str) -> Result<Value, String> {
        let (answer, catch_up) = query::outline(&self.reader, &mut self.extractor, &self.root, path)?;
        if catch_up {
            self.changed(vec![path.to_owned()]);
        }
        Ok(answer)
    }

    /// What a query could not see: an index still being built, files left out, files that did not parse cleanly.
    fn coverage(&self) -> Value {
        let status = self.status();
        json!({
            "state": status["state"],
            "indexed": status["indexed"],
            "withSyntaxErrors": status["withSyntaxErrors"],
            "notIndexed": status["notIndexed"],
        })
    }

    /// Re-reads the named files now; with no names, sweeps the whole repository now.
    pub fn changed(&self, paths: Vec<String>) {
        // A send fails only when the thread has ended, and `close` reports that.
        let _ = self.signals.send(Signal::Changed(paths));
    }

    pub fn status(&self) -> Value {
        let status = self.status.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).clone();
        let not_indexed: serde_json::Map<String, Value> =
            status.not_indexed.into_iter().map(|(reason, count)| (reason, json!(count))).collect();
        json!({
            "state": status.state,
            "error": status.error,
            "indexed": status.indexed,
            "withSyntaxErrors": status.with_syntax_errors,
            "notIndexed": not_indexed,
            "filesRead": status.files_read,
            "sweeps": status.sweeps,
            "storage": self.storage,
        })
    }

    /// Stops the thread, mid-sweep if need be, and waits for it.
    pub fn close(mut self) -> Result<(), String> {
        self.cancel.store(true, Ordering::Relaxed);
        let _ = self.signals.send(Signal::Close);
        match self.thread.take().map(JoinHandle::join) {
            Some(Err(_)) => Err("the index thread crashed".to_owned()),
            _ => Ok(()),
        }
    }
}

fn update(status: &Mutex<Status>, change: impl FnOnce(&mut Status)) {
    change(&mut status.lock().unwrap_or_else(|poisoned| poisoned.into_inner()));
}

fn fail(status: &mut Status, error: String) {
    status.state = "degraded";
    status.error = Some(error);
}

fn finish(status: &mut Status, outcome: Result<(), String>, store: &Store) {
    status.sweeps += 1;
    let outcome = outcome.and_then(|()| store.counts().map_err(|error| format!("cannot count the index: {error}")));
    match outcome {
        Ok(counts) => {
            status.state = "ready";
            status.error = None;
            status.indexed = counts.indexed;
            status.with_syntax_errors = counts.with_syntax_errors;
            status.not_indexed = counts.not_indexed;
        }
        Err(error) => fail(status, error),
    }
}

fn database(error: rusqlite::Error) -> String {
    format!("the index failed: {error}")
}

struct Indexer<'a> {
    root: PathBuf,
    store: &'a Store,
    extractor: Extractor,
    status: &'a Mutex<Status>,
    /// Kept between passes; built again when files come or go or the configuration changes.
    resolver: Option<Resolver>,
    /// Files re-read in this pass.
    reread: HashSet<String>,
    /// A file came or went in this pass.
    files_moved: bool,
}

impl Indexer<'_> {
    fn run(&mut self, pending: &Pending, cancel: &AtomicBool) -> Result<(), String> {
        let mut all_known = true;
        for path in &pending.named {
            all_known &= self.store.known_file(path).map_err(database)?.is_some();
        }
        if pending.full || !all_known {
            // A file the index has not seen may be one git ignores, so let git decide.
            self.sweep(&pending.named, cancel)?;
        } else {
            self.refresh(&pending.named)?;
        }
        if cancel.load(Ordering::Relaxed) {
            return Ok(());
        }
        self.resolve_imports()
    }

    /// Works out where imports lead, for every file or only the ones this pass re-read.
    fn resolve_imports(&mut self) -> Result<(), String> {
        let reread = std::mem::take(&mut self.reread);
        let files_moved = std::mem::take(&mut self.files_moved);
        let everything = self.resolver.is_none() || files_moved || reread.iter().any(|path| is_resolution_config(path));
        if !everything && reread.is_empty() {
            return Ok(());
        }
        if everything {
            let root = self.root.clone();
            let read = move |path: &str| match std::fs::read_to_string(root.join(path)) {
                Ok(text) => Some(text),
                Err(error) => {
                    eprintln!("kodax-repo-intel: cannot read {path}; imports it configures stay unresolved: {error}");
                    None
                }
            };
            self.resolver = Some(Resolver::new(self.store.paths().map_err(database)?, read));
        }
        let Some(resolver) = &self.resolver else { return Ok(()) };
        let scope = (!everything).then_some(&reread);
        let mut edges: Vec<Edge> = Vec::new();
        for (path, language, module, name) in self.store.imported_names(scope).map_err(database)? {
            let Some(language) = Language::ALL.into_iter().find(|known| known.name() == language) else { continue };
            // Rows come grouped by path and module: the module is resolved once, at its first row.
            let last = edges.iter().rev().find(|edge| edge.name.is_empty());
            let lead = match last.filter(|edge| edge.path == path && edge.module == module) {
                Some(edge) => edge.lead.clone(),
                None => {
                    let Some(lead) = resolver.resolve(language, &path, &module) else { continue };
                    edges.push(Edge { path: path.clone(), module: module.clone(), name: String::new(), lead: lead.clone() });
                    lead
                }
            };
            if let Some(member) = resolver.member(language, &path, &module, &name, &lead) {
                edges.push(Edge { path, module, name, lead: member });
            }
        }
        self.store.begin().map_err(database)?;
        self.store.replace_edges(scope, &edges).map_err(database)?;
        self.store.commit().map_err(database)
    }

    fn sweep(&mut self, named: &HashSet<String>, cancel: &AtomicBool) -> Result<(), String> {
        let paths = manifest::list_files(&self.root)?;
        let known = self.store.known_files().map_err(database)?;
        let mut present = HashSet::with_capacity(paths.len());
        self.store.begin().map_err(database)?;
        for (done, path) in paths.into_iter().enumerate() {
            if cancel.load(Ordering::Relaxed) {
                return self.store.commit().map_err(database);
            }
            if done > 0 && done % BATCH == 0 {
                self.store.commit().and_then(|()| self.store.begin()).map_err(database)?;
            }
            // Listed by git but missing on disk (deleted, not yet staged): the file is gone.
            if self.update_file(&path, known.get(&path), named.contains(&path)).map_err(database)? {
                self.files_moved |= !known.contains_key(&path);
                present.insert(path);
            }
        }
        self.files_moved |= known.keys().any(|path| !present.contains(path));
        self.store.keep_only(&present).map_err(database)?;
        self.store.commit().map_err(database)
    }

    fn refresh(&mut self, named: &HashSet<String>) -> Result<(), String> {
        self.store.begin().map_err(database)?;
        for path in named {
            if !self.update_file(path, None, true).map_err(database)? {
                self.store.remove_file(path).map_err(database)?;
                self.files_moved = true;
            }
        }
        // Analyses this leaves unused stay until the next sweep clears them: no file
        // points at them, so no query sees them, and clearing them scans whole tables.
        self.store.commit().map_err(database)
    }

    /// Brings one file's row up to date, reading it only if it moved or was named.
    /// False when it is not a regular file on disk.
    fn update_file(&mut self, path: &str, known: Option<&Known>, named: bool) -> rusqlite::Result<bool> {
        let file = self.root.join(path);
        let Some(now) = query::on_disk(&file) else {
            return Ok(false);
        };
        if !named && known == Some(&now) {
            return Ok(true);
        }
        self.reread.insert(path.to_owned());
        let Known { size, mtime_ns } = now;
        let language = Language::of(path);
        let status = match language {
            None => FileStatus::NotIndexed { reason: "language" },
            Some(language) => self.index_file(&file, size, language)?,
        };
        let row = FileRow { path: path.to_owned(), size, mtime_ns, language: language.map(Language::name), status };
        self.store.record_file(&row)?;
        Ok(true)
    }

    /// Reads and analyzes a source file, unless its content was analyzed before.
    fn index_file(&mut self, file: &Path, size: u64, language: Language) -> rusqlite::Result<FileStatus> {
        if manifest::too_large(size) {
            return Ok(FileStatus::NotIndexed { reason: "size" });
        }
        update(self.status, |status| status.files_read += 1);
        let bytes = match manifest::read_source(file) {
            Ok(bytes) => bytes,
            Err(reason) => return Ok(FileStatus::NotIndexed { reason }),
        };
        // The language is part of the key: the same text means different things in a .h and a .ts file.
        let digest = Sha256::new().chain_update(language.name()).chain_update([0]).chain_update(&bytes).finalize();
        let hash: String = digest.iter().map(|byte| format!("{byte:02x}")).collect();
        if self.store.has_analysis(&hash)? {
            return Ok(FileStatus::Indexed { hash });
        }
        match self.extractor.extract(language, &bytes) {
            Ok(analysis) => {
                self.store.record_analysis(&hash, language.name(), &analysis)?;
                Ok(FileStatus::Indexed { hash })
            }
            Err(error) => {
                eprintln!("kodax-repo-intel: cannot analyze {}: {error}", file.display());
                Ok(FileStatus::NotIndexed { reason: "unparsed" })
            }
        }
    }
}

#[cfg(test)]
pub mod tests {
    use super::*;
    use crate::manifest::tests::repo;
    use std::fs;
    use std::time::Instant;

    pub fn wait_for_sweeps(workspace: &Workspace, sweeps: u64) -> Value {
        let deadline = Instant::now() + Duration::from_secs(20);
        loop {
            let status = workspace.status();
            if status["sweeps"].as_u64().unwrap() >= sweeps {
                return status;
            }
            assert!(Instant::now() < deadline, "no sweep {sweeps}: {status}");
            thread::sleep(Duration::from_millis(20));
        }
    }

    #[test]
    fn indexes_source_files_and_says_why_others_are_left_out() {
        let big = "x".repeat(manifest::MAX_FILE_BYTES as usize + 1);
        let dir = repo(&[("a.ts", "let a = 1;"), ("b.md", "# b"), ("big.ts", &big), ("bin.go", "pack\0age")]);
        let storage = tempfile::tempdir().unwrap();
        let workspace = Workspace::open(dir.path().to_owned(), storage.path().to_owned()).unwrap();
        let status = wait_for_sweeps(&workspace, 1);
        assert_eq!(status["state"], "ready", "{status}");
        assert_eq!(status["indexed"], 1);
        assert_eq!(status["notIndexed"], json!({ "binary": 1, "language": 1, "size": 1 }));
        assert_eq!(status["filesRead"], 2);
        workspace.close().unwrap();
    }

    #[test]
    fn rereads_only_what_changed_or_was_named() {
        let dir = repo(&[("a.ts", "let a = 1;"), ("b.py", "b = 2")]);
        let storage = tempfile::tempdir().unwrap();
        let workspace = Workspace::open(dir.path().to_owned(), storage.path().to_owned()).unwrap();
        assert_eq!(wait_for_sweeps(&workspace, 1)["filesRead"], 2);
        workspace.changed(vec![]);
        assert_eq!(wait_for_sweeps(&workspace, 2)["filesRead"], 2);
        fs::write(dir.path().join("a.ts"), "let a = 10;").unwrap();
        workspace.changed(vec![]);
        assert_eq!(wait_for_sweeps(&workspace, 3)["filesRead"], 3);
        workspace.changed(vec!["b.py".to_owned()]);
        assert_eq!(wait_for_sweeps(&workspace, 4)["filesRead"], 4);
        fs::remove_file(dir.path().join("b.py")).unwrap();
        workspace.changed(vec![]);
        assert_eq!(wait_for_sweeps(&workspace, 5)["indexed"], 1);
        workspace.close().unwrap();
    }

    #[test]
    fn named_files_skip_the_sweep_unless_the_index_does_not_know_them() {
        let dir = repo(&[("a.ts", "let a = 1;"), (".gitignore", "out/\n")]);
        let storage = tempfile::tempdir().unwrap();
        let workspace = Workspace::open(dir.path().to_owned(), storage.path().to_owned()).unwrap();
        wait_for_sweeps(&workspace, 1);
        fs::remove_file(dir.path().join("a.ts")).unwrap();
        workspace.changed(vec!["a.ts".to_owned()]);
        assert_eq!(wait_for_sweeps(&workspace, 2)["indexed"], 0);
        fs::create_dir(dir.path().join("out")).unwrap();
        fs::write(dir.path().join("out/x.ts"), "let x = 1;").unwrap();
        fs::write(dir.path().join("c.ts"), "let c = 1;").unwrap();
        workspace.changed(vec!["out/x.ts".to_owned(), "c.ts".to_owned()]);
        let status = wait_for_sweeps(&workspace, 3);
        assert_eq!(status["indexed"], 1, "only c.ts, because git ignores out/: {status}");
        workspace.close().unwrap();
    }

    #[test]
    fn follows_imports_to_files_and_keeps_up_with_removals_config_and_edits() {
        let dir = repo(&[
            ("src/a.ts", "import { b } from './b.js';\nimport { c } from '@lib/c';\nimport x from 'react';\n"),
            ("src/b.ts", "export const b = 1;"),
            ("tsconfig.json", r#"{"compilerOptions": {"paths": {"@lib/*": ["./lib/*"]}}}"#),
            ("lib/c.ts", "export const c = 1;"),
            ("lib2/c.ts", "export const c = 2;"),
        ]);
        let storage = tempfile::tempdir().unwrap();
        let workspace = Workspace::open(dir.path().to_owned(), storage.path().to_owned()).unwrap();
        let leads = |workspace: &Workspace| -> Vec<Value> {
            let answer = workspace.imports("src/a.ts").unwrap();
            let imports = answer["imports"].as_array().unwrap_or_else(|| panic!("{answer}"));
            imports.iter().map(|i| json!([i["module"], i["target"], i["unresolved"]])).collect()
        };
        wait_for_sweeps(&workspace, 1);
        let expected = [json!(["./b.js", "src/b.ts", null]), json!(["@lib/c", "lib/c.ts", null]), json!(["react", null, "external"])];
        assert_eq!(leads(&workspace), expected);

        fs::remove_file(dir.path().join("src/b.ts")).unwrap();
        workspace.changed(vec!["src/b.ts".to_owned()]);
        wait_for_sweeps(&workspace, 2);
        assert_eq!(leads(&workspace)[0], json!(["./b.js", null, "missing"]));

        fs::write(dir.path().join("tsconfig.json"), r#"{"compilerOptions": {"paths": {"@lib/*": ["./lib2/*"]}}}"#).unwrap();
        workspace.changed(vec!["tsconfig.json".to_owned()]);
        wait_for_sweeps(&workspace, 3);
        assert_eq!(leads(&workspace)[1], json!(["@lib/c", "lib2/c.ts", null]));

        fs::write(dir.path().join("src/a.ts"), "import { c } from '../lib/c';\n").unwrap();
        workspace.changed(vec!["src/a.ts".to_owned()]);
        wait_for_sweeps(&workspace, 4);
        assert_eq!(leads(&workspace), vec![json!(["../lib/c", "lib/c.ts", null])]);
        assert_eq!(workspace.imports("lib/c.ts").unwrap()["imports"], json!([]));
        assert_eq!(workspace.imports("none.ts").unwrap()["indexed"], false);
        workspace.close().unwrap();
    }

    #[test]
    fn follows_python_go_and_rust_imports_to_submodules_and_package_folders() {
        let dir = repo(&[
            ("pkg/__init__.py", "from . import models\nfrom .models import User\nimport json\n"),
            ("pkg/models.py", "class User: pass\n"),
            ("go.mod", "module example.com/app\n"),
            ("main.go", "package main\n\nimport (\n\t\"fmt\"\n\t\"example.com/app/store\"\n)\n"),
            ("store/store.go", "package store\n"),
            ("Cargo.toml", "[package]\nname = \"app\"\n"),
            ("src/lib.rs", "mod store;\nuse crate::{store as kept, Config};\npub struct Config;\n"),
            ("src/store.rs", "pub struct Store;\n"),
        ]);
        let storage = tempfile::tempdir().unwrap();
        let workspace = Workspace::open(dir.path().to_owned(), storage.path().to_owned()).unwrap();
        wait_for_sweeps(&workspace, 1);
        let leads = |path: &str| -> Vec<Value> {
            let answer = workspace.imports(path).unwrap();
            let imports = answer["imports"].as_array().unwrap_or_else(|| panic!("{answer}"));
            imports.iter().map(|i| json!([i["module"], i["name"], i["target"], i["folder"], i["unresolved"]])).collect()
        };
        assert_eq!(
            leads("pkg/__init__.py"),
            vec![
                json!([".", "models", "pkg/models.py", null, null]),
                json!([".models", "User", "pkg/models.py", null, null]),
                json!(["json", "*", null, null, "external"]),
            ]
        );
        assert_eq!(
            leads("main.go"),
            vec![json!(["fmt", "*", null, null, "external"]), json!(["example.com/app/store", "*", null, "store", null])]
        );
        assert_eq!(
            leads("src/lib.rs"),
            vec![
                json!(["self::store", "*", "src/store.rs", null, null]),
                json!(["crate", "store", "src/store.rs", null, null]),
                json!(["crate", "Config", "src/lib.rs", null, null]),
            ]
        );
        workspace.close().unwrap();
    }

    #[test]
    fn lists_the_references_to_a_definition_resolved_ones_first() {
        let dir = repo(&[
            ("store.ts", "export function open() {}
function local() { open(); }
"),
            ("other.ts", "export function open() {}
open();
"),
            ("app.ts", "import { open } from './store';
open();
conn.open();
"),
            ("alias.ts", "import { open as begin } from './store';
import { open as other } from './other';
begin();
other();
"),
        ]);
        let storage = tempfile::tempdir().unwrap();
        let workspace = Workspace::open(dir.path().to_owned(), storage.path().to_owned()).unwrap();
        wait_for_sweeps(&workspace, 1);
        let sites = |answer: &Value| -> Vec<Value> {
            answer["hits"].as_array().unwrap().iter().map(|hit| json!([hit["path"], hit["line"], hit["precision"]])).collect()
        };
        let first = workspace.references_to("store.ts", "open", 2, 0).unwrap();
        assert_eq!(sites(&first), vec![json!(["alias.ts", 3, "syntactic"]), json!(["app.ts", 2, "syntactic"])]);
        assert_eq!(first["hits"][0]["name"], "begin", "a use under an import alias keeps the name it is used by");
        assert_eq!((first["total"].as_u64(), first["resolved"].as_u64(), first["nextOffset"].as_u64()), (Some(4), Some(3), Some(2)));
        assert_eq!(first["coverage"]["state"], "ready");
        let rest = workspace.references_to("store.ts", "open", 2, 2).unwrap();
        assert_eq!(sites(&rest), vec![json!(["store.ts", 2, "syntactic"]), json!(["app.ts", 3, "heuristic"])]);
        assert!(rest["nextOffset"].is_null());
        let other = workspace.references_to("other.ts", "open", 10, 0).unwrap();
        assert_eq!(sites(&other), vec![json!(["alias.ts", 4, "syntactic"]), json!(["other.ts", 2, "syntactic"]), json!(["app.ts", 3, "heuristic"])]);
        workspace.close().unwrap();
    }

    #[test]
    fn reopening_keeps_the_index_and_reads_nothing() {
        let dir = repo(&[("a.ts", "let a = 1;")]);
        let storage = tempfile::tempdir().unwrap();
        let first = Workspace::open(dir.path().to_owned(), storage.path().to_owned()).unwrap();
        wait_for_sweeps(&first, 1);
        first.close().unwrap();
        let again = Workspace::open(dir.path().to_owned(), storage.path().to_owned()).unwrap();
        let status = wait_for_sweeps(&again, 1);
        assert_eq!((status["indexed"].as_u64(), status["filesRead"].as_u64()), (Some(1), Some(0)));
        again.close().unwrap();
    }

    #[test]
    fn reports_a_folder_that_is_not_a_repository() {
        let dir = tempfile::tempdir().unwrap();
        let storage = tempfile::tempdir().unwrap();
        let workspace = Workspace::open(dir.path().join("missing"), storage.path().to_owned()).unwrap();
        let status = wait_for_sweeps(&workspace, 1);
        assert_eq!(status["state"], "degraded");
        assert!(status["error"].as_str().unwrap().contains("git ls-files failed"), "{status}");
        workspace.close().unwrap();
    }

    #[test]
    fn keeps_its_index_in_a_file_named_for_its_version_and_removes_older_ones() {
        let dir = repo(&[("a.ts", "let a = 1;")]);
        let storage = tempfile::tempdir().unwrap();
        let older = ["index.sqlite", "index.sqlite-wal", "index-v4.sqlite", "index-v4.sqlite-shm"];
        for name in older.iter().chain(&["index-v99.sqlite", "notes.txt"]) {
            fs::write(storage.path().join(name), "").unwrap();
        }
        let workspace = Workspace::open(dir.path().to_owned(), storage.path().to_owned()).unwrap();
        assert_eq!(wait_for_sweeps(&workspace, 1)["indexed"], 1);
        assert!(storage.path().join(crate::store::index_file_name()).is_file());
        for name in older {
            assert!(!storage.path().join(name).exists(), "{name} is left");
        }
        assert!(storage.path().join("index-v99.sqlite").exists(), "a newer engine may still use its index");
        assert!(storage.path().join("notes.txt").exists());
        workspace.close().unwrap();
    }

    #[test]
    fn keeps_each_repository_in_its_own_folder() {
        let storage = Path::new("/store");
        let one = storage_dir(storage, Path::new("/work/app"));
        assert!(one.file_name().unwrap().to_string_lossy().starts_with("app-"));
        assert_eq!(one, storage_dir(storage, Path::new("/work/app/")));
        assert_ne!(one, storage_dir(storage, Path::new("/other/app")));
    }
}
