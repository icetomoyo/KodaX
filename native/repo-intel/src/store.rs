//! The index on disk: one SQLite file per repository, outside the repository.
//! A file's analysis is stored under its content hash, so content seen before
//! (a branch switched back, a file moved) is never analyzed twice.

use crate::extract::Analysis;
use rusqlite::{Connection, OptionalExtension, params};
use std::collections::{HashMap, HashSet};
use std::path::Path;

/// Bumped when the tables change; an index with another version is rebuilt.
const SCHEMA_VERSION: &str = "4";

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

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FileRow {
    pub path: String,
    pub size: u64,
    pub mtime_ns: i64,
    pub language: Option<&'static str>,
    pub status: FileStatus,
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
        if version.as_deref() == Some(SCHEMA_VERSION) {
            return Ok(());
        }
        self.connection.execute_batch(
            "DROP TABLE IF EXISTS files;
             DROP TABLE IF EXISTS analyses;
             DROP TABLE IF EXISTS definitions;
             DROP TABLE IF EXISTS refs;
             CREATE TABLE files(
               path TEXT PRIMARY KEY, size INTEGER NOT NULL, mtime_ns INTEGER NOT NULL,
               language TEXT, hash TEXT, reason TEXT);
             CREATE INDEX files_hash ON files(hash);
             CREATE TABLE analyses(
               id INTEGER PRIMARY KEY, hash TEXT NOT NULL UNIQUE, language TEXT NOT NULL,
               syntax_errors INTEGER NOT NULL);
             -- Rows are stored in name order, so a lookup by name reads them together;
             -- the small integer analysis id keeps each row short. There is no index by
             -- analysis: it would double the size, and only cleanup after an edit needs it.
             CREATE TABLE definitions(
               name TEXT NOT NULL, analysis INTEGER NOT NULL, line INTEGER NOT NULL, column INTEGER NOT NULL,
               kind TEXT NOT NULL, container TEXT, end_line INTEGER NOT NULL,
               PRIMARY KEY(name, analysis, line, column)) WITHOUT ROWID;
             CREATE TABLE refs(
               name TEXT NOT NULL, analysis INTEGER NOT NULL, line INTEGER NOT NULL, column INTEGER NOT NULL,
               kind TEXT NOT NULL,
               PRIMARY KEY(name, analysis, line, column)) WITHOUT ROWID;
",
        )?;
        self.connection.execute(
            "INSERT OR REPLACE INTO meta(key, value) VALUES ('schema', ?1)",
            params![SCHEMA_VERSION],
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
            .prepare_cached("INSERT OR IGNORE INTO refs(name, analysis, line, column, kind) VALUES (?1, ?2, ?3, ?4, ?5)")?;
        for r in &analysis.references {
            reference.execute(params![r.name, id, r.line, r.column, r.kind])?;
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
        Analysis { definitions, references: vec![], has_syntax_errors }
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
}
