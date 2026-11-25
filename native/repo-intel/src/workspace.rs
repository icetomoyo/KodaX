//! One open repository: a thread that keeps its index in step with the files.
//! It sweeps once when opened and every `SWEEP_EVERY` in case something else
//! changed them. A sweep lists the files with git and reads only those whose
//! size or modification time moved. When the Host names files it changed and
//! the index already knows them all, only those files are updated.

use crate::extract::Extractor;
use crate::manifest::{self, Language};
use crate::store::{FileRow, FileStatus, Known, Store};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, RecvTimeoutError, Sender};
use std::sync::{Arc, Mutex};
use std::thread::{self, JoinHandle};
use std::time::{Duration, UNIX_EPOCH};

const SWEEP_EVERY: Duration = Duration::from_secs(15);
/// Larger files are mostly generated or vendored; reading them costs more than they give.
const MAX_FILE_BYTES: u64 = 1024 * 1024;
/// A NUL byte this early means the file is not text.
const BINARY_PROBE_BYTES: usize = 8 * 1024;
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
    storage: PathBuf,
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
    pub fn open(root: PathBuf, storage: PathBuf) -> Workspace {
        let status = Arc::new(Mutex::new(Status { state: "indexing", ..Status::default() }));
        let cancel = Arc::new(AtomicBool::new(false));
        let (signals, inbox) = mpsc::channel();
        let index = storage.join("index.sqlite");
        let (shared, stop) = (status.clone(), cancel.clone());
        let thread = thread::spawn(move || {
            let store = match Store::open(&index) {
                Ok(store) => store,
                Err(error) => return update(&shared, |status| fail(status, format!("cannot open the index: {error}"))),
            };
            let mut index = Indexer { root, store: &store, extractor: Extractor::default(), status: &shared };
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
        Workspace { storage, status, signals, cancel, thread: Some(thread) }
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
}

impl Indexer<'_> {
    fn run(&mut self, pending: &Pending, cancel: &AtomicBool) -> Result<(), String> {
        let mut all_known = true;
        for path in &pending.named {
            all_known &= self.store.known_file(path).map_err(database)?.is_some();
        }
        if pending.full || !all_known {
            // A file the index has not seen may be one git ignores, so let git decide.
            self.sweep(&pending.named, cancel)
        } else {
            self.refresh(&pending.named)
        }
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
                present.insert(path);
            }
        }
        self.store.keep_only(&present).map_err(database)?;
        self.store.commit().map_err(database)
    }

    fn refresh(&mut self, named: &HashSet<String>) -> Result<(), String> {
        self.store.begin().map_err(database)?;
        for path in named {
            if !self.update_file(path, None, true).map_err(database)? {
                self.store.remove_file(path).map_err(database)?;
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
        let Ok(metadata) = fs::metadata(&file) else {
            return Ok(false);
        };
        if !metadata.is_file() {
            return Ok(false);
        }
        let size = metadata.len();
        let mtime_ns = metadata
            .modified()
            .ok()
            .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
            .map_or(0, |since| since.as_nanos() as i64);
        if !named && known.is_some_and(|row| row.size == size && row.mtime_ns == mtime_ns) {
            return Ok(true);
        }
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
        if size > MAX_FILE_BYTES {
            return Ok(FileStatus::NotIndexed { reason: "size" });
        }
        update(self.status, |status| status.files_read += 1);
        let Ok(bytes) = fs::read(file) else {
            return Ok(FileStatus::NotIndexed { reason: "unreadable" });
        };
        if bytes[..bytes.len().min(BINARY_PROBE_BYTES)].contains(&0) {
            return Ok(FileStatus::NotIndexed { reason: "binary" });
        }
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
mod tests {
    use super::*;
    use crate::manifest::tests::repo;
    use std::time::Instant;

    fn wait_for_sweeps(workspace: &Workspace, sweeps: u64) -> Value {
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
        let big = "x".repeat(MAX_FILE_BYTES as usize + 1);
        let dir = repo(&[("a.ts", "let a = 1;"), ("b.md", "# b"), ("big.ts", &big), ("bin.go", "pack\0age")]);
        let storage = tempfile::tempdir().unwrap();
        let workspace = Workspace::open(dir.path().to_owned(), storage.path().to_owned());
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
        let workspace = Workspace::open(dir.path().to_owned(), storage.path().to_owned());
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
        let workspace = Workspace::open(dir.path().to_owned(), storage.path().to_owned());
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
    fn reopening_keeps_the_index_and_reads_nothing() {
        let dir = repo(&[("a.ts", "let a = 1;")]);
        let storage = tempfile::tempdir().unwrap();
        let first = Workspace::open(dir.path().to_owned(), storage.path().to_owned());
        wait_for_sweeps(&first, 1);
        first.close().unwrap();
        let again = Workspace::open(dir.path().to_owned(), storage.path().to_owned());
        let status = wait_for_sweeps(&again, 1);
        assert_eq!((status["indexed"].as_u64(), status["filesRead"].as_u64()), (Some(1), Some(0)));
        again.close().unwrap();
    }

    #[test]
    fn reports_a_folder_that_is_not_a_repository() {
        let dir = tempfile::tempdir().unwrap();
        let storage = tempfile::tempdir().unwrap();
        let workspace = Workspace::open(dir.path().join("missing"), storage.path().to_owned());
        let status = wait_for_sweeps(&workspace, 1);
        assert_eq!(status["state"], "degraded");
        assert!(status["error"].as_str().unwrap().contains("git ls-files failed"), "{status}");
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
