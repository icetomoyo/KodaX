//! The index on disk: one SQLite file per repository, outside the repository.
//! A file's analysis is stored under its content hash, so content seen before
//! (a branch switched back, a file moved) is never analyzed twice.

use crate::extract::{Analysis, Import};
use crate::resolve::Resolution;
use rusqlite::{Connection, OptionalExtension, params};
use std::collections::{HashMap, HashSet};
use std::path::Path;

/// Bumped when the tables change, or when files are read into them differently
/// (what the extractor finds, which files it reads); an index with another version is rebuilt.
const SCHEMA_VERSION: u32 = 10;

/// Past this size the write-ahead log is cut back once its pages are in the index.
/// SQLite otherwise keeps the log at the size of the largest batch ever written:
/// tens of MB beside the index on a large repository.
const WAL_LIMIT_BYTES: i64 = 4 * 1024 * 1024;

/// Each schema version has its own file, so engines of two versions that share
/// a storage folder never rebuild each other's index.
pub fn index_file_name() -> String {
    format!("index-v{SCHEMA_VERSION}.sqlite")
}

/// The schema version an index file (or its -wal / -shm file) belongs to;
/// `index.sqlite` is from before versions were in the name.
fn index_file_version(name: &str) -> Option<u32> {
    let rest = name.strip_prefix("index")?;
    if rest.starts_with(".sqlite") {
        return Some(0);
    }
    let (digits, suffix) = rest.strip_prefix("-v")?.split_once('.')?;
    if !suffix.starts_with("sqlite") {
        return None;
    }
    digits.parse().ok()
}

/// Removes the index files of older versions from `folder` and says which could
/// not go (an older engine still running may hold one open). Newer ones stay,
/// since a newer engine may be using them.
pub fn remove_older_indexes(folder: &Path) -> Vec<String> {
    let Ok(entries) = std::fs::read_dir(folder) else {
        return Vec::new();
    };
    entries
        .flatten()
        .filter(|entry| index_file_version(&entry.file_name().to_string_lossy()).is_some_and(|v| v < SCHEMA_VERSION))
        .filter_map(|entry| std::fs::remove_file(entry.path()).err().map(|error| format!("{}: {error}", entry.path().display())))
        .collect()
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Known {
    pub size: u64,
    pub mtime_ns: i64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum FileStatus {
    Indexed { hash: String },
    /// Not indexed, and why: `language`, `size`, `binary`, `unreadable` or `unparsed`.
    NotIndexed { reason: &'static str },
}

/// An import with where it leads; `lead` is None when the language has no module resolution.
/// `submodule` when the imported name is itself a module (`from pkg import models`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ResolvedImport {
    pub import: Import,
    pub lead: Option<Resolution>,
    pub submodule: bool,
}

/// Where one import of the file at `path` leads. `name` is empty for the module itself, and
/// the imported name when that is a submodule of it (`from pkg import models`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Edge {
    pub path: String,
    pub module: String,
    pub name: String,
    pub lead: Resolution,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FileRow {
    pub path: String,
    pub size: u64,
    pub mtime_ns: i64,
    pub language: Option<&'static str>,
    pub status: FileStatus,
}

/// A definition or reference found by name, with the file it is in.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Hit {
    pub path: String,
    pub known: Known,
    pub language: String,
    pub name: String,
    pub kind: String,
    pub container: Option<String>,
    pub line: u32,
    pub column: u32,
    /// Definitions only.
    pub end_line: Option<u32>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Table {
    Definitions,
    References,
}

/// What the index holds for one file.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Entry {
    Indexed { known: Known, language: String, has_syntax_errors: bool, definitions: Vec<Hit> },
    NotIndexed { known: Known, reason: String },
}

#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct Counts {
    pub indexed: u64,
    /// Indexed files the parser could not fully read; their definitions may be incomplete.
    pub with_syntax_errors: u64,
    /// Files left out, by reason.
    pub not_indexed: Vec<(String, u64)>,
}

pub struct Store {
    connection: Connection,
}

impl Store {
    pub fn open(path: &Path) -> rusqlite::Result<Store> {
        if let Some(folder) = path.parent() {
            std::fs::create_dir_all(folder).map_err(|error| {
                rusqlite::Error::InvalidPath(folder.join(format!("cannot create: {error}")))
            })?;
        }
        let connection = Connection::open(path)?;
        connection.pragma_update(None, "journal_mode", "WAL")?;
        connection.pragma_update(None, "synchronous", "NORMAL")?;
        connection.pragma_update(None, "journal_size_limit", WAL_LIMIT_BYTES)?;
        // A bounded page cache keeps the engine's memory within its budget.
        connection.pragma_update(None, "cache_size", -16_000)?;
        connection.busy_timeout(std::time::Duration::from_secs(5))?;
        let store = Store { connection };
        store.ensure_schema()?;
        Ok(store)
    }

    fn ensure_schema(&self) -> rusqlite::Result<()> {
        self.connection.execute_batch("CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY, value TEXT NOT NULL);")?;
        let version: Option<String> = self
            .connection
            .query_row("SELECT value FROM meta WHERE key = 'schema'", [], |row| row.get(0))
            .optional()?;
        if version == Some(SCHEMA_VERSION.to_string()) {
            return Ok(());
        }
        self.connection.execute_batch(
            "DROP TABLE IF EXISTS files;
             DROP TABLE IF EXISTS analyses;
             DROP TABLE IF EXISTS definitions;
             DROP TABLE IF EXISTS refs;
             DROP TABLE IF EXISTS imports;
             DROP TABLE IF EXISTS edges;
             CREATE TABLE files(
               path TEXT PRIMARY KEY, size INTEGER NOT NULL, mtime_ns INTEGER NOT NULL,
               language TEXT, hash TEXT, reason TEXT);
             CREATE INDEX files_hash ON files(hash);
             CREATE TABLE analyses(
               id INTEGER PRIMARY KEY, hash TEXT NOT NULL UNIQUE, language TEXT NOT NULL,
               syntax_errors INTEGER NOT NULL);
             -- Rows are stored in name order, so a lookup by name reads them together;
             -- the small integer analysis id keeps each row short. References have no index
             -- by analysis: it would double their size, and only cleanup needs it. Definitions,
             -- far fewer, have one for file outlines.
             CREATE TABLE definitions(
               name TEXT NOT NULL, analysis INTEGER NOT NULL, line INTEGER NOT NULL, column INTEGER NOT NULL,
               kind TEXT NOT NULL, container TEXT, end_line INTEGER NOT NULL,
               PRIMARY KEY(name, analysis, line, column)) WITHOUT ROWID;
             CREATE INDEX definitions_analysis ON definitions(analysis);
             -- receiver: what the name is used on (`store` in `store.run()`), NULL for a bare name.
             CREATE TABLE refs(
               name TEXT NOT NULL, analysis INTEGER NOT NULL, line INTEGER NOT NULL, column INTEGER NOT NULL,
               kind TEXT NOT NULL, receiver TEXT,
               PRIMARY KEY(name, analysis, line, column)) WITHOUT ROWID;
             -- What each analysis imports, read together when its file's imports are resolved.
             CREATE TABLE imports(
               analysis INTEGER NOT NULL, position INTEGER NOT NULL, module TEXT NOT NULL,
               name TEXT NOT NULL, local TEXT NOT NULL,
               PRIMARY KEY(analysis, position)) WITHOUT ROWID;
             -- Where each file's imports lead. Kept by path, not by analysis: the same text
             -- in another folder imports other files. The index on target finds importers.
             -- name is '' for the module, else an imported name that is a submodule of it.
             CREATE TABLE edges(
               path TEXT NOT NULL, module TEXT NOT NULL, name TEXT NOT NULL, target TEXT, kind TEXT NOT NULL,
               PRIMARY KEY(path, module, name)) WITHOUT ROWID;
             CREATE INDEX edges_target ON edges(target) WHERE target IS NOT NULL;
",
        )?;
        self.connection.execute(
            "INSERT OR REPLACE INTO meta(key, value) VALUES ('schema', ?1)",
            params![SCHEMA_VERSION.to_string()],
        )?;
        Ok(())
    }

    pub fn begin(&self) -> rusqlite::Result<()> {
        self.connection.execute_batch("BEGIN")
    }

    pub fn commit(&self) -> rusqlite::Result<()> {
        self.connection.execute_batch("COMMIT")
    }

    pub fn known_files(&self) -> rusqlite::Result<HashMap<String, Known>> {
        let mut statement = self.connection.prepare("SELECT path, size, mtime_ns FROM files")?;
        let rows = statement.query_map([], |row| {
            Ok((row.get::<_, String>(0)?, Known { size: row.get::<_, i64>(1)? as u64, mtime_ns: row.get(2)? }))
        })?;
        rows.collect()
    }

    pub fn has_analysis(&self, hash: &str) -> rusqlite::Result<bool> {
        self.connection
            .query_row("SELECT 1 FROM analyses WHERE hash = ?1", params![hash], |_| Ok(()))
            .optional()
            .map(|found| found.is_some())
    }

    pub fn record_analysis(&self, hash: &str, language: &str, analysis: &Analysis) -> rusqlite::Result<()> {
        self.connection.execute(
            "INSERT INTO analyses(hash, language, syntax_errors) VALUES (?1, ?2, ?3)",
            params![hash, language, analysis.has_syntax_errors],
        )?;
        let id = self.connection.last_insert_rowid();
        // OR IGNORE: one name at one position is one row, however many patterns matched it.
        let mut definition = self.connection.prepare_cached(
            "INSERT OR IGNORE INTO definitions(name, analysis, line, column, kind, container, end_line)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
        )?;
        for d in &analysis.definitions {
            definition.execute(params![d.name, id, d.line, d.column, d.kind, d.container, d.end_line])?;
        }
        let mut reference = self
            .connection
            .prepare_cached("INSERT OR IGNORE INTO refs(name, analysis, line, column, kind, receiver) VALUES (?1, ?2, ?3, ?4, ?5, ?6)")?;
        for r in &analysis.references {
            reference.execute(params![r.name, id, r.line, r.column, r.kind, r.receiver])?;
        }
        let mut import = self
            .connection
            .prepare_cached("INSERT INTO imports(analysis, position, module, name, local) VALUES (?1, ?2, ?3, ?4, ?5)")?;
        for (position, i) in analysis.imports.iter().enumerate() {
            import.execute(params![id, position as i64, i.module, i.name, i.local])?;
        }
        Ok(())
    }

    pub fn record_file(&self, row: &FileRow) -> rusqlite::Result<()> {
        let (hash, reason) = match &row.status {
            FileStatus::Indexed { hash } => (Some(hash.as_str()), None),
            FileStatus::NotIndexed { reason } => (None, Some(*reason)),
        };
        self.connection.execute(
            "INSERT OR REPLACE INTO files(path, size, mtime_ns, language, hash, reason) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![row.path, row.size as i64, row.mtime_ns, row.language, hash, reason],
        )?;
        Ok(())
    }

    pub fn remove_file(&self, path: &str) -> rusqlite::Result<()> {
        self.connection.execute("DELETE FROM files WHERE path = ?1", params![path])?;
        Ok(())
    }

    pub fn known_file(&self, path: &str) -> rusqlite::Result<Option<Known>> {
        self.connection
            .query_row("SELECT size, mtime_ns FROM files WHERE path = ?1", params![path], |row| {
                Ok(Known { size: row.get::<_, i64>(0)? as u64, mtime_ns: row.get(1)? })
            })
            .optional()
    }

    /// Forgets files that are gone, and analyses no file uses any more.
    pub fn keep_only(&self, present: &HashSet<String>) -> rusqlite::Result<()> {
        let gone: Vec<String> = self.known_files()?.into_keys().filter(|path| !present.contains(path)).collect();
        for path in gone {
            self.remove_file(&path)?;
        }
        self.collect_unused()
    }

    /// Forgets analyses no file uses any more.
    pub fn collect_unused(&self) -> rusqlite::Result<()> {
        const UNUSED: &str = "SELECT id FROM analyses WHERE hash NOT IN (SELECT hash FROM files WHERE hash IS NOT NULL)";
        let any_unused = self.connection.query_row(&format!("SELECT EXISTS({UNUSED})"), [], |row| row.get::<_, bool>(0))?;
        if any_unused {
            // One pass over each table, however many analyses went out of use.
            self.connection.execute_batch(&format!(
                "DELETE FROM definitions WHERE analysis IN ({UNUSED});
                 DELETE FROM refs WHERE analysis IN ({UNUSED});
                 DELETE FROM imports WHERE analysis IN ({UNUSED});
                 DELETE FROM analyses WHERE id IN ({UNUSED});"
            ))?;
        }
        Ok(())
    }

    pub fn counts(&self) -> rusqlite::Result<Counts> {
        let indexed = self
            .connection
            .query_row("SELECT COUNT(*) FROM files WHERE hash IS NOT NULL", [], |row| row.get::<_, i64>(0))?;
        let mut statement = self.connection.prepare(
            "SELECT reason, COUNT(*) FROM files WHERE reason IS NOT NULL GROUP BY reason ORDER BY reason",
        )?;
        let not_indexed = statement
            .query_map([], |row| Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)? as u64)))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        let with_syntax_errors = self.connection.query_row(
            "SELECT COUNT(*) FROM files JOIN analyses USING(hash) WHERE analyses.syntax_errors",
            [],
            |row| row.get::<_, i64>(0),
        )?;
        Ok(Counts { indexed: indexed as u64, with_syntax_errors: with_syntax_errors as u64, not_indexed })
    }

    /// One page of the definitions or references named `name`, in path and line order, and how many there are in all.
    pub fn find(&self, table: Table, name: &str, limit: u64, offset: u64) -> rusqlite::Result<(Vec<Hit>, u64)> {
        let (columns, from) = match table {
            Table::Definitions => ("t.kind, t.container, t.end_line", "definitions"),
            Table::References => ("t.kind, NULL, NULL", "refs"),
        };
        let join = format!("{from} t JOIN analyses a ON a.id = t.analysis JOIN files f ON f.hash = a.hash WHERE t.name = ?1");
        let total = self.connection.query_row(&format!("SELECT COUNT(*) FROM {join}"), params![name], |row| row.get::<_, i64>(0))?;
        let mut statement = self.connection.prepare_cached(&format!(
            "SELECT f.path, f.size, f.mtime_ns, a.language, t.line, t.column, {columns} FROM {join}
             ORDER BY f.path, t.line, t.column LIMIT ?2 OFFSET ?3"
        ))?;
        let hits = statement
            .query_map(params![name, limit as i64, offset as i64], |row| {
                Ok(Hit {
                    path: row.get(0)?,
                    known: Known { size: row.get::<_, i64>(1)? as u64, mtime_ns: row.get(2)? },
                    language: row.get(3)?,
                    name: name.to_owned(),
                    line: row.get(4)?,
                    column: row.get(5)?,
                    kind: row.get(6)?,
                    container: row.get(7)?,
                    end_line: row.get(8)?,
                })
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok((hits, total as u64))
    }

    /// Every reference named `name`, with what it is used on, in path and line order.
    pub fn references_named(&self, name: &str) -> rusqlite::Result<Vec<(Hit, Option<String>)>> {
        let mut statement = self.connection.prepare_cached(
            "SELECT f.path, f.size, f.mtime_ns, a.language, t.line, t.column, t.kind, t.receiver
             FROM refs t JOIN analyses a ON a.id = t.analysis JOIN files f ON f.hash = a.hash
             WHERE t.name = ?1 ORDER BY f.path, t.line, t.column",
        )?;
        statement
            .query_map(params![name], |row| {
                let hit = Hit {
                    path: row.get(0)?,
                    known: Known { size: row.get::<_, i64>(1)? as u64, mtime_ns: row.get(2)? },
                    language: row.get(3)?,
                    name: name.to_owned(),
                    line: row.get(4)?,
                    column: row.get(5)?,
                    kind: row.get(6)?,
                    container: None,
                    end_line: None,
                };
                Ok((hit, row.get(7)?))
            })?
            .collect()
    }

    /// The files that import `name` under another name, and that name (`import { a as b }`).
    pub fn aliases_of(&self, name: &str) -> rusqlite::Result<Vec<(String, String)>> {
        let mut statement = self.connection.prepare_cached(
            "SELECT DISTINCT f.path, i.local FROM imports i JOIN analyses a ON a.id = i.analysis JOIN files f ON f.hash = a.hash
             WHERE i.name = ?1 AND i.local <> ?1 AND i.local <> '' ORDER BY f.path, i.local",
        )?;
        statement.query_map(params![name], |row| Ok((row.get(0)?, row.get(1)?)))?.collect()
    }

    /// The paths of files with a top-level definition named `name`.
    pub fn top_level_paths(&self, name: &str) -> rusqlite::Result<Vec<String>> {
        let mut statement = self.connection.prepare_cached(
            "SELECT DISTINCT f.path FROM definitions t JOIN analyses a ON a.id = t.analysis JOIN files f ON f.hash = a.hash
             WHERE t.name = ?1 AND t.container IS NULL ORDER BY f.path",
        )?;
        statement.query_map(params![name], |row| row.get(0))?.collect()
    }

    pub fn entry(&self, path: &str) -> rusqlite::Result<Option<Entry>> {
        let row = self
            .connection
            .query_row(
                "SELECT f.size, f.mtime_ns, f.reason, a.id, a.language, a.syntax_errors
                 FROM files f LEFT JOIN analyses a ON a.hash = f.hash WHERE f.path = ?1",
                params![path],
                |row| {
                    let known = Known { size: row.get::<_, i64>(0)? as u64, mtime_ns: row.get(1)? };
                    let reason: Option<String> = row.get(2)?;
                    let analysis: Option<(i64, String, bool)> = match row.get::<_, Option<i64>>(3)? {
                        Some(id) => Some((id, row.get(4)?, row.get(5)?)),
                        None => None,
                    };
                    Ok((known, reason, analysis))
                },
            )
            .optional()?;
        let Some((known, reason, analysis)) = row else {
            return Ok(None);
        };
        let Some((id, language, has_syntax_errors)) = analysis else {
            return Ok(Some(Entry::NotIndexed { known, reason: reason.unwrap_or_else(|| "unparsed".to_owned()) }));
        };
        let mut statement = self.connection.prepare_cached(
            "SELECT name, kind, container, line, column, end_line FROM definitions WHERE analysis = ?1",
        )?;
        let mut definitions = statement
            .query_map(params![id], |row| {
                Ok(Hit {
                    path: path.to_owned(),
                    known: known.clone(),
                    language: language.clone(),
                    name: row.get(0)?,
                    kind: row.get(1)?,
                    container: row.get(2)?,
                    line: row.get(3)?,
                    column: row.get(4)?,
                    end_line: row.get(5)?,
                })
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        definitions.sort_by_key(|hit| (hit.line, hit.column));
        Ok(Some(Entry::Indexed { known, language, has_syntax_errors, definitions }))
    }

    /// What the file at `path` imports, in source order, with where each import leads; empty when it is not indexed.
    pub fn imports(&self, path: &str) -> rusqlite::Result<Vec<ResolvedImport>> {
        let mut statement = self.connection.prepare_cached(
            "SELECT i.module, i.name, i.local, COALESCE(n.target, m.target), COALESCE(n.kind, m.kind), n.kind IS NOT NULL
             FROM files f JOIN analyses a ON a.hash = f.hash JOIN imports i ON i.analysis = a.id
             LEFT JOIN edges m ON m.path = f.path AND m.module = i.module AND m.name = ''
             LEFT JOIN edges n ON n.path = f.path AND n.module = i.module AND n.name = i.name AND i.name <> ''
             WHERE f.path = ?1 ORDER BY i.position",
        )?;
        statement
            .query_map(params![path], |row| {
                let target: Option<String> = row.get(3)?;
                let kind: Option<String> = row.get(4)?;
                Ok(ResolvedImport {
                    import: Import { module: row.get(0)?, name: row.get(1)?, local: row.get(2)? },
                    lead: kind.and_then(|kind| Resolution::from_parts(target, &kind)),
                    submodule: row.get(5)?,
                })
            })?
            .collect()
    }

    /// Every path the index knows, indexed or not.
    pub fn paths(&self) -> rusqlite::Result<HashSet<String>> {
        Ok(self.known_files()?.into_keys().collect())
    }

    /// What each indexed file imports, as (path, language, module, name), grouped by path
    /// and module: of `paths` only, or of every file.
    pub fn imported_names(&self, paths: Option<&HashSet<String>>) -> rusqlite::Result<Vec<(String, String, String, String)>> {
        const SELECT: &str = "SELECT DISTINCT f.path, a.language, i.module, i.name FROM files f JOIN analyses a ON a.hash = f.hash
             JOIN imports i ON i.analysis = a.id";
        const ORDER: &str = "ORDER BY f.path, i.module";
        let row = |row: &rusqlite::Row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?));
        let Some(paths) = paths else {
            return self.connection.prepare(&format!("{SELECT} {ORDER}"))?.query_map([], row)?.collect();
        };
        let mut statement = self.connection.prepare_cached(&format!("{SELECT} WHERE f.path = ?1 {ORDER}"))?;
        let mut found = Vec::new();
        for path in paths {
            found.extend(statement.query_map(params![path], row)?.collect::<rusqlite::Result<Vec<_>>>()?);
        }
        Ok(found)
    }

    /// Replaces where the imports of `paths` lead (of every file when None) with `edges`.
    pub fn replace_edges(&self, paths: Option<&HashSet<String>>, edges: &[Edge]) -> rusqlite::Result<()> {
        match paths {
            None => {
                self.connection.execute("DELETE FROM edges", [])?;
            }
            Some(paths) => {
                let mut forget = self.connection.prepare_cached("DELETE FROM edges WHERE path = ?1")?;
                for path in paths {
                    forget.execute(params![path])?;
                }
            }
        }
        let mut insert = self
            .connection
            .prepare_cached("INSERT OR REPLACE INTO edges(path, module, name, target, kind) VALUES (?1, ?2, ?3, ?4, ?5)")?;
        for edge in edges {
            let (target, kind) = edge.lead.parts();
            insert.execute(params![edge.path, edge.module, edge.name, target, kind])?;
        }
        Ok(())
    }

    #[cfg(test)]
    pub fn analysis_count(&self) -> rusqlite::Result<u64> {
        self.connection.query_row("SELECT COUNT(*) FROM analyses", [], |row| row.get::<_, i64>(0)).map(|n| n as u64)
    }

    #[cfg(test)]
    pub fn definition_names(&self) -> rusqlite::Result<Vec<String>> {
        let mut statement = self.connection.prepare("SELECT name FROM definitions ORDER BY name")?;
        statement.query_map([], |row| row.get(0))?.collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn row(path: &str, status: FileStatus) -> FileRow {
        FileRow { path: path.to_owned(), size: 1, mtime_ns: 2, language: Some("typescript"), status }
    }

    fn analysis(names: &[&str], has_syntax_errors: bool) -> Analysis {
        let definitions = names
            .iter()
            .map(|name| crate::extract::Definition {
                name: (*name).to_owned(),
                kind: "function".to_owned(),
                container: None,
                line: 1,
                column: 1,
                end_line: 1,
            })
            .collect();
        Analysis { definitions, references: vec![], imports: vec![], has_syntax_errors }
    }

    fn indexed(hash: &str) -> FileStatus {
        FileStatus::Indexed { hash: hash.to_owned() }
    }

    #[test]
    fn keeps_files_and_counts_them_by_outcome() {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::open(&dir.path().join("deep/index.sqlite")).unwrap();
        store.record_file(&row("a.ts", indexed("h1"))).unwrap();
        store.record_file(&row("b.md", FileStatus::NotIndexed { reason: "language" })).unwrap();
        store.record_file(&row("c.md", FileStatus::NotIndexed { reason: "language" })).unwrap();
        store.record_analysis("h1", "typescript", &analysis(&[], true)).unwrap();
        let counts = Counts { indexed: 1, with_syntax_errors: 1, not_indexed: vec![("language".to_owned(), 2)] };
        assert_eq!(store.counts().unwrap(), counts);
        assert_eq!(store.known_files().unwrap()["a.ts"], Known { size: 1, mtime_ns: 2 });
    }

    #[test]
    fn forgets_gone_files_and_the_analyses_only_they_used() {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::open(&dir.path().join("index.sqlite")).unwrap();
        for (path, hash) in [("a.ts", "shared"), ("b.ts", "shared"), ("c.ts", "own")] {
            if !store.has_analysis(hash).unwrap() {
                store.record_analysis(hash, "typescript", &analysis(&[hash], false)).unwrap();
            }
            store.record_file(&row(path, indexed(hash))).unwrap();
        }
        store.keep_only(&HashSet::from(["a.ts".to_owned()])).unwrap();
        assert_eq!(store.known_files().unwrap().len(), 1);
        assert!(store.has_analysis("shared").unwrap());
        assert!(!store.has_analysis("own").unwrap());
        assert_eq!(store.analysis_count().unwrap(), 1);
        assert_eq!(store.definition_names().unwrap(), vec!["shared"]);
    }

    #[test]
    fn finds_by_name_across_files_a_page_at_a_time() {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::open(&dir.path().join("index.sqlite")).unwrap();
        let mut shared = analysis(&["run"], false);
        shared.definitions[0].container = Some("Store".to_owned());
        shared.references.push(crate::extract::Reference { name: "run".to_owned(), kind: "call".to_owned(), line: 4, column: 2, receiver: None });
        store.record_analysis("h", "typescript", &shared).unwrap();
        for path in ["b.ts", "a.ts"] {
            store.record_file(&row(path, indexed("h"))).unwrap();
        }
        let (hits, total) = store.find(Table::Definitions, "run", 1, 0).unwrap();
        assert_eq!((hits.len(), total), (1, 2));
        assert_eq!((hits[0].path.as_str(), hits[0].container.as_deref(), hits[0].end_line), ("a.ts", Some("Store"), Some(1)));
        assert_eq!(store.find(Table::Definitions, "run", 5, 1).unwrap().0[0].path, "b.ts");
        let named = store.references_named("run").unwrap();
        assert_eq!(named.iter().map(|(hit, receiver)| (hit.path.as_str(), receiver.clone())).collect::<Vec<_>>(), vec![("a.ts", None), ("b.ts", None)]);
        assert_eq!(store.top_level_paths("run").unwrap(), Vec::<String>::new(), "run sits in Store");
        let (references, total) = store.find(Table::References, "run", 5, 0).unwrap();
        assert_eq!((references[0].line, references[0].kind.as_str(), references[0].end_line, total), (4, "call", None, 2));
        assert_eq!(store.find(Table::Definitions, "missing", 5, 0).unwrap(), (vec![], 0));
    }

    #[test]
    fn keeps_each_file_s_imports_in_order_until_the_analysis_goes() {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::open(&dir.path().join("index.sqlite")).unwrap();
        let mut with_imports = analysis(&[], false);
        let import = |module: &str, name: &str, local: &str| Import { module: module.to_owned(), name: name.to_owned(), local: local.to_owned() };
        with_imports.imports = vec![import("./z", "b", "b"), import("./a", "*", "")];
        store.record_analysis("h", "typescript", &with_imports).unwrap();
        store.record_file(&row("a.ts", indexed("h"))).unwrap();
        let unresolved = |import: Import| ResolvedImport { import, lead: None, submodule: false };
        assert_eq!(store.imports("a.ts").unwrap(), with_imports.imports.iter().cloned().map(unresolved).collect::<Vec<_>>());
        assert_eq!(store.imports("none.ts").unwrap(), vec![]);
        store.keep_only(&HashSet::new()).unwrap();
        let left = store.connection.query_row("SELECT COUNT(*) FROM imports", [], |row| row.get::<_, i64>(0)).unwrap();
        assert_eq!(left, 0);
    }

    #[test]
    fn keeps_where_imports_lead_by_path_and_replaces_them_for_some_files_or_all() {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::open(&dir.path().join("index.sqlite")).unwrap();
        let mut with_imports = analysis(&[], false);
        let import = |module: &str, name: &str| Import { module: module.to_owned(), name: name.to_owned(), local: name.to_owned() };
        with_imports.imports = vec![import("./b", "x"), import("react", "x"), import("./b", "x"), import("./b", "sub")];
        store.record_analysis("h", "typescript", &with_imports).unwrap();
        for path in ["a.ts", "c.ts"] {
            store.record_file(&row(path, indexed("h"))).unwrap();
        }
        let names = store.imported_names(None).unwrap();
        let name = |path: &str, module: &str, name: &str| (path.to_owned(), "typescript".to_owned(), module.to_owned(), name.to_owned());
        let a = [name("a.ts", "./b", "sub"), name("a.ts", "./b", "x"), name("a.ts", "react", "x")];
        assert_eq!(&names[..2].iter().map(|n| n.2.clone()).collect::<Vec<_>>(), &["./b", "./b"], "grouped by path and module");
        let mut sorted = names.clone();
        sorted.sort();
        assert_eq!(sorted[..3], a);
        let only_a = HashSet::from(["a.ts".to_owned()]);
        assert_eq!(store.imported_names(Some(&only_a)).unwrap().len(), 3);

        let edge = |path: &str, module: &str, name: &str, lead: Resolution| Edge { path: path.to_owned(), module: module.to_owned(), name: name.to_owned(), lead };
        let b = Resolution::File("b.ts".to_owned());
        let edges = [
            edge("a.ts", "./b", "", b.clone()),
            edge("a.ts", "./b", "sub", Resolution::Folder("b".to_owned())),
            edge("a.ts", "react", "", Resolution::External),
            edge("c.ts", "./b", "", Resolution::Missing),
        ];
        store.replace_edges(None, &edges).unwrap();
        let leads = |path: &str| store.imports(path).unwrap().into_iter().map(|i| i.lead).collect::<Vec<_>>();
        let submodules = store.imports("a.ts").unwrap().into_iter().map(|i| i.submodule).collect::<Vec<_>>();
        assert_eq!(submodules, vec![false, false, false, true]);
        let sub = Resolution::Folder("b".to_owned());
        assert_eq!(leads("a.ts"), vec![Some(b.clone()), Some(Resolution::External), Some(b.clone()), Some(sub)]);
        assert_eq!(leads("c.ts")[0], Some(Resolution::Missing));
        assert_eq!(leads("c.ts")[3], Some(Resolution::Missing), "a member with no edge of its own leads where its module does");
        store.replace_edges(Some(&only_a), &[]).unwrap();
        assert_eq!(leads("a.ts")[0], None);
        assert_eq!(leads("c.ts")[0], Some(Resolution::Missing));
    }

    #[test]
    fn tells_an_indexed_file_from_one_left_out_or_unknown() {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::open(&dir.path().join("index.sqlite")).unwrap();
        store.record_analysis("h", "typescript", &analysis(&["b", "a"], true)).unwrap();
        store.record_file(&row("a.ts", indexed("h"))).unwrap();
        store.record_file(&row("a.md", FileStatus::NotIndexed { reason: "language" })).unwrap();
        let Some(Entry::Indexed { has_syntax_errors, definitions, .. }) = store.entry("a.ts").unwrap() else {
            panic!("a.ts is indexed");
        };
        assert!(has_syntax_errors);
        assert_eq!(definitions.iter().map(|d| d.name.as_str()).collect::<Vec<_>>().len(), 2);
        assert!(matches!(store.entry("a.md").unwrap(), Some(Entry::NotIndexed { reason, .. }) if reason == "language"));
        assert_eq!(store.entry("none.ts").unwrap(), None);
    }

    #[test]
    fn survives_reopening_and_rebuilds_an_index_of_another_version() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("index.sqlite");
        Store::open(&path).unwrap().record_file(&row("a.ts", indexed("h"))).unwrap();
        assert_eq!(Store::open(&path).unwrap().counts().unwrap().indexed, 1);
        let old = Connection::open(&path).unwrap();
        old.execute("UPDATE meta SET value = '0' WHERE key = 'schema'", []).unwrap();
        drop(old);
        assert_eq!(Store::open(&path).unwrap().counts().unwrap().indexed, 0);
    }

    #[test]
    fn the_write_ahead_log_shrinks_back_after_a_large_batch() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("index.sqlite");
        let store = Store::open(&path).unwrap();
        let names: Vec<String> = (0..20_000).map(|n| format!("name{n}")).collect();
        let names: Vec<&str> = names.iter().map(String::as_str).collect();
        store.begin().unwrap();
        for n in 0..10 {
            store.record_analysis(&format!("h{n}"), "typescript", &analysis(&names, false)).unwrap();
        }
        store.commit().unwrap();
        store.record_file(&row("a.ts", indexed("h0"))).unwrap();
        let wal = std::fs::metadata(dir.path().join("index.sqlite-wal")).unwrap().len();
        assert!(wal <= WAL_LIMIT_BYTES as u64, "the log is {wal} bytes");
    }
}
