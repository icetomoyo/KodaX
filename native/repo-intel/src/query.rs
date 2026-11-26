//! Answers to the Host's questions, each labeled with how far to trust it:
//! - precision: `syntactic` for definitions and for references resolved through imports,
//!   `heuristic` for references matched by name only;
//! - completeness: the total and the next page, and what the index left out and why;
//! - freshness: hits in files that changed since they were indexed are marked `stale`.
//!
//! "Not found" (no hits, index ready), "not indexed" (a reason) and "unavailable"
//! (an error) stay distinct; nothing is ever filled in.

use crate::extract::Extractor;
use crate::manifest::{self, Language};
use crate::references::{Lookup, Referent};
use crate::resolve::Resolution;
use crate::store::{Entry, Hit, Known, Store, Table};
use serde_json::{Value, json};
use std::fs;
use std::path::Path;
use std::time::UNIX_EPOCH;

pub const DEFAULT_LIMIT: u64 = 50;
pub const MAX_LIMIT: u64 = 500;
/// Long signature lines are cut here.
const SIGNATURE_CHARS: usize = 200;

/// The size and modification time a file has on disk now, if it is a regular file.
pub fn on_disk(file: &Path) -> Option<Known> {
    let metadata = fs::metadata(file).ok().filter(|metadata| metadata.is_file())?;
    let mtime_ns = metadata
        .modified()
        .ok()
        .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
        .map_or(0, |since| since.as_nanos() as i64);
    Some(Known { size: metadata.len(), mtime_ns })
}

pub fn find(store: &Store, root: &Path, table: Table, name: &str, limit: u64, offset: u64) -> rusqlite::Result<Value> {
    let (hits, total) = store.find(table, name, limit, offset)?;
    let end = offset + hits.len() as u64;
    let hits: Vec<Value> = hits.iter().map(|hit| found_json(root, hit)).collect();
    Ok(json!({
        "precision": match table { Table::Definitions => "syntactic", Table::References => "heuristic" },
        "hits": hits,
        "total": total,
        "offset": offset,
        "nextOffset": if end < total { json!(end) } else { Value::Null },
    }))
}

/// The references that name the definition `name` in the file at `path`: first those resolved
/// to that file through its imports (`syntactic`, including uses under an import alias), then
/// those the index cannot resolve, matched by name (`heuristic`), each in path and line order.
/// References resolved elsewhere are left out.
pub fn references_to(store: &Store, root: &Path, path: &str, name: &str, limit: u64, offset: u64) -> rusqlite::Result<Value> {
    let references = store.references_named(name)?;
    let mut lookup = Lookup::new(store);
    lookup.prepare(name, references.iter().map(|(hit, _)| (hit.path.as_str(), hit.language.as_str())))?;
    let (mut resolved, mut matched) = (Vec::new(), Vec::new());
    for (hit, receiver) in references {
        match lookup.referent(&hit.path, name, receiver.as_deref())? {
            Referent::In(files) if files.contains(path) => resolved.push(hit),
            Referent::Unknown => matched.push(hit),
            Referent::In(_) | Referent::Elsewhere => {}
        }
    }
    for (importer, alias) in store.aliases_of(name)? {
        for (hit, receiver) in store.references_in(&importer, &alias)? {
            if matches!(lookup.referent(&hit.path, &alias, receiver.as_deref())?, Referent::In(files) if files.contains(path)) {
                resolved.push(hit);
            }
        }
    }
    resolved.sort_by(|a, b| (&a.path, a.line, a.column).cmp(&(&b.path, b.line, b.column)));
    let total = (resolved.len() + matched.len()) as u64;
    let labeled = resolved.iter().map(|hit| (hit, "syntactic")).chain(matched.iter().map(|hit| (hit, "heuristic")));
    let hits: Vec<Value> = labeled
        .skip(offset as usize)
        .take(limit as usize)
        .map(|(hit, precision)| {
            let mut value = found_json(root, hit);
            value["precision"] = json!(precision);
            value
        })
        .collect();
    let end = offset + hits.len() as u64;
    Ok(json!({
        "path": path,
        "name": name,
        "hits": hits,
        "total": total,
        "resolved": resolved.len(),
        "offset": offset,
        "nextOffset": if end < total { json!(end) } else { Value::Null },
    }))
}

/// A hit as found in the index, marked `stale` when its file changed since.
fn found_json(root: &Path, hit: &Hit) -> Value {
    let mut value = hit_json(hit, None);
    value["stale"] = json!(on_disk(&root.join(&hit.path)).as_ref() != Some(&hit.known));
    value
}

fn hit_json(hit: &Hit, signature: Option<&str>) -> Value {
    let mut value = json!({
        "path": hit.path,
        "name": hit.name,
        "kind": hit.kind,
        "container": hit.container,
        "line": hit.line,
        "column": hit.column,
        "language": hit.language,
    });
    if let Some(end_line) = hit.end_line {
        value["endLine"] = json!(end_line);
    }
    if let Some(signature) = signature {
        value["signature"] = json!(signature);
    }
    value
}

/// What one file imports, from the index, and where each import leads: `target` for a file
/// of the repository, `folder` for a folder (a Go package, a Python namespace package), else
/// `unresolved` (`external` or `missing`); none for Java and C++. `stale` when the file
/// changed since it was indexed. Not indexed: `missing` on disk, `pending` when the index has not seen it yet.
pub fn imports(store: &Store, root: &Path, path: &str) -> Result<Value, String> {
    let failed = |error: rusqlite::Error| format!("the index failed: {error}");
    let now = on_disk(&root.join(path));
    let known = match store.entry(path).map_err(failed)? {
        _ if now.is_none() => return Ok(not_indexed(path, "missing")),
        None => return Ok(not_indexed(path, "pending")),
        Some(Entry::NotIndexed { reason, .. }) => return Ok(not_indexed(path, &reason)),
        Some(Entry::Indexed { known, .. }) => known,
    };
    let imports: Vec<Value> = store
        .imports(path)
        .map_err(failed)?
        .into_iter()
        .map(|row| {
            let mut item = json!({ "module": row.import.module, "name": row.import.name, "local": row.import.local });
            match row.lead {
                Some(Resolution::File(path)) => item["target"] = json!(path),
                Some(Resolution::Folder(path)) => item["folder"] = json!(path),
                Some(Resolution::External) => item["unresolved"] = json!("external"),
                Some(Resolution::Missing) => item["unresolved"] = json!("missing"),
                None => {}
            }
            item
        })
        .collect();
    Ok(json!({ "path": path, "indexed": true, "stale": Some(known) != now, "imports": imports }))
}

/// The outline of one file and whether the index needs to catch up with it.
/// A file that changed since it was indexed is analyzed now instead.
pub fn outline(store: &Store, extractor: &mut Extractor, root: &Path, path: &str) -> Result<(Value, bool), String> {
    let file = root.join(path);
    let entry = store.entry(path).map_err(|error| format!("the index failed: {error}"))?;
    let Some(now) = on_disk(&file) else {
        return Ok((not_indexed(path, "missing"), entry.is_some()));
    };
    match entry {
        Some(Entry::Indexed { known, language, has_syntax_errors, definitions }) if known == now => {
            let lines = manifest::read_source(&file).ok();
            Ok((indexed(path, &language, has_syntax_errors, "index", &definitions, lines.as_deref()), false))
        }
        Some(Entry::NotIndexed { known, reason }) if known == now => Ok((not_indexed(path, &reason), false)),
        _ => Ok((analyze_now(extractor, &file, path, now), true)),
    }
}

fn analyze_now(extractor: &mut Extractor, file: &Path, path: &str, now: Known) -> Value {
    let Some(language) = Language::of(path) else {
        return not_indexed(path, "language");
    };
    if manifest::too_large(now.size) {
        return not_indexed(path, "size");
    }
    let bytes = match manifest::read_source(file) {
        Ok(bytes) => bytes,
        Err(reason) => return not_indexed(path, reason),
    };
    let analysis = match extractor.extract(language, &bytes) {
        Ok(analysis) => analysis,
        Err(error) => {
            eprintln!("kodax-repo-intel: cannot analyze {}: {error}", file.display());
            return not_indexed(path, "unparsed");
        }
    };
    let definitions: Vec<Hit> = analysis
        .definitions
        .into_iter()
        .map(|d| Hit {
            path: path.to_owned(),
            known: now.clone(),
            language: language.name().to_owned(),
            name: d.name,
            kind: d.kind,
            container: d.container,
            line: d.line,
            column: d.column,
            end_line: Some(d.end_line),
        })
        .collect();
    indexed(path, language.name(), analysis.has_syntax_errors, "analyzed-now", &definitions, Some(&bytes))
}

fn indexed(path: &str, language: &str, has_syntax_errors: bool, source: &str, definitions: &[Hit], bytes: Option<&[u8]>) -> Value {
    let text = bytes.map(String::from_utf8_lossy);
    let lines: Vec<&str> = text.as_deref().map(|text| text.lines().collect()).unwrap_or_default();
    let definitions: Vec<Value> = definitions
        .iter()
        .map(|hit| {
            let line = lines.get(hit.line as usize - 1).map(|line| line.trim());
            let signature = line.map(|line| line.chars().take(SIGNATURE_CHARS).collect::<String>());
            hit_json(hit, signature.as_deref())
        })
        .collect();
    json!({
        "path": path,
        "indexed": true,
        "language": language,
        "precision": "syntactic",
        "source": source,
        "withSyntaxErrors": has_syntax_errors,
        "definitions": definitions,
    })
}

fn not_indexed(path: &str, reason: &str) -> Value {
    json!({ "path": path, "indexed": false, "reason": reason })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::extract::{Analysis, Definition};
    use crate::store::{FileRow, FileStatus};

    fn indexed_store(root: &Path, path: &str, text: &str) -> (tempfile::TempDir, Store) {
        fs::write(root.join(path), text).unwrap();
        let dir = tempfile::tempdir().unwrap();
        let store = Store::open(&dir.path().join("index.sqlite")).unwrap();
        let definition = Definition { name: "run".to_owned(), kind: "function".to_owned(), container: None, line: 2, column: 17, end_line: 2 };
        store.record_analysis("h", "typescript", &Analysis { definitions: vec![definition], ..Analysis::default() }).unwrap();
        let known = on_disk(&root.join(path)).unwrap();
        let row = FileRow { path: path.to_owned(), size: known.size, mtime_ns: known.mtime_ns, language: Some("typescript"), status: FileStatus::Indexed { hash: "h".to_owned() } };
        store.record_file(&row).unwrap();
        (dir, store)
    }

    #[test]
    fn labels_hits_and_marks_the_ones_in_changed_files() {
        let root = tempfile::tempdir().unwrap();
        let (_index, store) = indexed_store(root.path(), "a.ts", "// a\nexport function run() {}\n");
        let answer = find(&store, root.path(), Table::Definitions, "run", 10, 0).unwrap();
        assert_eq!(answer["precision"], "syntactic");
        assert_eq!((answer["total"].as_u64(), answer["nextOffset"].is_null()), (Some(1), true));
        assert_eq!(answer["hits"][0]["stale"], false);
        fs::write(root.path().join("a.ts"), "// changed and longer\nexport function run() {}\n").unwrap();
        assert_eq!(find(&store, root.path(), Table::Definitions, "run", 10, 0).unwrap()["hits"][0]["stale"], true);
        assert_eq!(find(&store, root.path(), Table::References, "run", 10, 0).unwrap()["precision"], "heuristic");
    }

    #[test]
    fn outlines_from_the_index_or_analyzes_a_changed_file_now() {
        let root = tempfile::tempdir().unwrap();
        let (_index, store) = indexed_store(root.path(), "a.ts", "// a\nexport function run() {}\n");
        let mut extractor = Extractor::default();
        let (answer, catch_up) = outline(&store, &mut extractor, root.path(), "a.ts").unwrap();
        assert_eq!((answer["source"].as_str(), catch_up), (Some("index"), false));
        assert_eq!(answer["definitions"][0]["signature"], "export function run() {}");
        fs::write(root.path().join("a.ts"), "export class Store {}\n").unwrap();
        let (answer, catch_up) = outline(&store, &mut extractor, root.path(), "a.ts").unwrap();
        assert_eq!((answer["source"].as_str(), catch_up), (Some("analyzed-now"), true));
        assert_eq!(answer["definitions"][0]["name"], "Store");
    }

    #[test]
    fn says_why_a_file_has_no_outline() {
        let root = tempfile::tempdir().unwrap();
        let (_index, store) = indexed_store(root.path(), "a.ts", "x");
        let mut extractor = Extractor::default();
        fs::write(root.path().join("notes.md"), "# notes").unwrap();
        fs::write(root.path().join("blob.ts"), "a\0b").unwrap();
        let reason = |path: &str, extractor: &mut Extractor| outline(&store, extractor, root.path(), path).unwrap().0["reason"].clone();
        assert_eq!(reason("notes.md", &mut extractor), "language");
        assert_eq!(reason("blob.ts", &mut extractor), "binary");
        assert_eq!(reason("gone.ts", &mut extractor), "missing");
        fs::remove_file(root.path().join("a.ts")).unwrap();
        assert_eq!(outline(&store, &mut extractor, root.path(), "a.ts").unwrap(), (not_indexed("a.ts", "missing"), true));
    }
}
