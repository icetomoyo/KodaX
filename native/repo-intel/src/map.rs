//! The repository map shown to the model at the start of a session: the files the rest of the
//! repository leans on most, each with its most imported top-level definitions, within a token
//! budget. Files are ranked by PageRank over the import graph, so a file ranks high when files
//! that rank high import it. A file's definitions share its rank, each weighted by one plus the
//! number of files that import it by name, so one large file of types cannot fill the map; the
//! highest scores go in until the budget is spent. A name defined more than once in a file
//! (overloads) is listed once, at its first line.
//!
//! The text depends only on what the index holds: nothing time-dependent, files in path order and
//! definitions in line order, so a small shift in ranks does not reorder it. A file changed since
//! it was indexed shows the kind and name of each definition instead of its line.

use crate::query::on_disk;
use crate::store::{Known, Store};
use std::collections::{BTreeMap, HashMap, HashSet};
use std::fs;
use std::path::Path;

pub const DEFAULT_TOKENS: u64 = 1024;
/// Long signature lines are cut here.
const SIGNATURE_CHARS: usize = 120;
const DAMPING: f64 = 0.85;
/// Rounds of PageRank: enough for ranks on an import graph to settle, and a fixed number keeps the result exact.
const ROUNDS: usize = 50;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RepoMap {
    pub text: String,
    pub files: usize,
    pub definitions: usize,
    pub tokens: u64,
}

/// A top-level definition as (path, name, kind, line).
type Definition = (String, String, String, u32);

pub fn repo_map(store: &Store, root: &Path, tokens: u64) -> rusqlite::Result<RepoMap> {
    let definitions = scored_definitions(store)?;
    let mut sources = Sources { root, indexed: store.known_files()?, lines: HashMap::new() };
    let mut chosen: BTreeMap<&str, BTreeMap<u32, String>> = BTreeMap::new();
    let mut budget = Budget::default();
    for (_, (path, name, kind, line)) in &definitions {
        let listed = chosen.get(path.as_str());
        if listed.is_some_and(|lines| lines.contains_key(line)) {
            continue;
        }
        let text = sources.line(path, *line).map_or_else(|| format!("{kind} {name}"), signature);
        let header = if listed.is_none() { Some(path.as_str()) } else { None };
        if !budget.fits(header, &text, tokens) {
            break;
        }
        chosen.entry(path).or_default().insert(*line, text);
    }
    Ok(render(&chosen, budget.tokens()))
}

/// Each file's top-level definitions, one per name, with their share of the file's rank, highest first.
fn scored_definitions(store: &Store) -> rusqlite::Result<Vec<(f64, Definition)>> {
    let paths = store.indexed_paths()?;
    let ranks = file_ranks(&paths, &store.links()?);
    let importers: HashMap<(String, String), u64> =
        store.importer_counts()?.into_iter().map(|(target, name, count)| ((target, name), count)).collect();
    let mut definitions = store.top_level_definitions()?;
    definitions.sort_by(|a, b| (&a.0, a.3).cmp(&(&b.0, b.3)));
    let mut seen = HashSet::new();
    definitions.retain(|(path, name, _, _)| seen.insert((path.clone(), name.clone())));
    let weight = |(path, name, _, _): &Definition| 1 + importers.get(&(path.clone(), name.clone())).copied().unwrap_or(0);
    let mut file_weights: HashMap<&str, u64> = HashMap::new();
    for definition in &definitions {
        *file_weights.entry(definition.0.as_str()).or_default() += weight(definition);
    }
    let mut scored: Vec<(f64, Definition)> = definitions
        .iter()
        .map(|definition| {
            let path = definition.0.as_str();
            let share = weight(definition) as f64 / file_weights[path] as f64;
            (ranks.get(path).copied().unwrap_or(0.0) * share, definition.clone())
        })
        .collect();
    scored.sort_by(|(left, a), (right, b)| right.total_cmp(left).then_with(|| (&a.0, a.3).cmp(&(&b.0, b.3))));
    Ok(scored)
}

/// PageRank of every indexed file over the links (path, target, kind) between them. A link to a
/// folder (a Go package) is shared among the indexed files directly in it.
fn file_ranks<'p>(paths: &'p [String], links: &[(String, String, String)]) -> HashMap<&'p str, f64> {
    let index: HashMap<&str, usize> = paths.iter().enumerate().map(|(i, path)| (path.as_str(), i)).collect();
    let mut in_folder: HashMap<&str, Vec<usize>> = HashMap::new();
    for (i, path) in paths.iter().enumerate() {
        in_folder.entry(path.rsplit_once('/').map_or("", |(folder, _)| folder)).or_default().push(i);
    }
    let mut edges: Vec<(usize, usize)> = Vec::new();
    for (path, target, kind) in links {
        let Some(&from) = index.get(path.as_str()) else { continue };
        let targets = match kind.as_str() {
            "folder" => in_folder.get(target.as_str()).cloned().unwrap_or_default(),
            _ => index.get(target.as_str()).map(|&to| vec![to]).unwrap_or_default(),
        };
        edges.extend(targets.into_iter().filter(|&to| to != from).map(|to| (from, to)));
    }
    edges.sort_unstable();
    edges.dedup();
    let ranks = page_rank(paths.len(), &edges);
    paths.iter().map(String::as_str).zip(ranks).collect()
}

fn page_rank(n: usize, edges: &[(usize, usize)]) -> Vec<f64> {
    if n == 0 {
        return Vec::new();
    }
    let mut out_degree = vec![0usize; n];
    for &(from, _) in edges {
        out_degree[from] += 1;
    }
    let mut rank = vec![1.0 / n as f64; n];
    for _ in 0..ROUNDS {
        // A file that imports nothing hands its rank to every file alike.
        let dangling: f64 = (0..n).filter(|&i| out_degree[i] == 0).map(|i| rank[i]).sum();
        let mut next = vec![(1.0 - DAMPING + DAMPING * dangling) / n as f64; n];
        for &(from, to) in edges {
            next[to] += DAMPING * rank[from] / out_degree[from] as f64;
        }
        rank = next;
    }
    rank
}

/// Source lines of files unchanged since they were indexed, read once each.
struct Sources<'r> {
    root: &'r Path,
    indexed: HashMap<String, Known>,
    lines: HashMap<String, Option<Vec<String>>>,
}

impl Sources<'_> {
    fn line(&mut self, path: &str, line: u32) -> Option<&str> {
        if !self.lines.contains_key(path) {
            let file = self.root.join(path);
            let fresh = on_disk(&file).is_some_and(|now| self.indexed.get(path) == Some(&now));
            let lines = fresh
                .then(|| fs::read(&file).ok())
                .flatten()
                .map(|bytes| String::from_utf8_lossy(&bytes).lines().map(str::to_owned).collect());
            self.lines.insert(path.to_owned(), lines);
        }
        self.lines[path].as_ref()?.get(line as usize - 1).map(String::as_str)
    }
}

/// A definition's line as the map shows it: trimmed, without the opening brace, cut when long.
fn signature(line: &str) -> String {
    let line = line.trim();
    let line = line.strip_suffix('{').map_or(line, str::trim_end);
    match line.char_indices().nth(SIGNATURE_CHARS) {
        Some((cut, _)) => format!("{}…", &line[..cut]),
        None => line.to_owned(),
    }
}

/// Tokens as the memory index estimates them: four ASCII characters to a token, one for any other.
#[derive(Default)]
struct Budget {
    ascii: u64,
    other: u64,
}

impl Budget {
    fn tokens(&self) -> u64 {
        self.ascii.div_ceil(4) + self.other
    }

    /// Takes the lines for one more definition (and its file's header) if they fit in `limit`.
    fn fits(&mut self, header: Option<&str>, signature: &str, limit: u64) -> bool {
        let text = format!("{}  {signature}\n", header.map_or_else(String::new, |path| format!("{path}\n")));
        let ascii = text.chars().filter(char::is_ascii).count() as u64;
        let other = text.chars().count() as u64 - ascii;
        let after = Budget { ascii: self.ascii + ascii, other: self.other + other };
        if after.tokens() > limit {
            return false;
        }
        *self = after;
        true
    }
}

fn render(chosen: &BTreeMap<&str, BTreeMap<u32, String>>, tokens: u64) -> RepoMap {
    let mut text = String::new();
    for (path, lines) in chosen {
        text.push_str(path);
        text.push('\n');
        for line in lines.values() {
            text.push_str("  ");
            text.push_str(line);
            text.push('\n');
        }
    }
    RepoMap { text, files: chosen.len(), definitions: chosen.values().map(BTreeMap::len).sum(), tokens }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::manifest::tests::repo;
    use crate::workspace::Workspace;
    use crate::workspace::tests::wait_for_sweeps;

    fn map_of(files: &[(&str, &str)], tokens: u64) -> RepoMap {
        let dir = repo(files);
        let storage = tempfile::tempdir().unwrap();
        let workspace = Workspace::open(dir.path().to_owned(), storage.path().to_owned()).unwrap();
        wait_for_sweeps(&workspace, 1);
        let map = repo_map(workspace.reader(), dir.path(), tokens).unwrap();
        workspace.close().unwrap();
        map
    }

    const SCRIPTS: &[(&str, &str)] = &[
        ("store.ts", "export function open(path: string) {\n  return path;\n}\nexport function close() {}\nfunction helper() {}\n"),
        ("a.ts", "import { open } from './store';\nexport function a() {\n  open('x');\n}\n"),
        ("b.ts", "import { open, close } from './store';\nexport function b() {\n}\n"),
        ("main.ts", "import { a } from './a';\nimport { b } from './b';\na(); b();\n"),
    ];

    #[test]
    fn lists_files_in_path_order_with_their_definitions_in_line_order() {
        let map = map_of(SCRIPTS, DEFAULT_TOKENS);
        assert_eq!(
            map.text,
            "a.ts\n  export function a()\nb.ts\n  export function b()\nstore.ts\n  export function open(path: string)\n  export function close() {}\n  function helper() {}\n",
        );
        assert_eq!((map.files, map.definitions), (3, 5));
        assert_eq!(map.tokens, map.text.len().div_ceil(4) as u64);
    }

    #[test]
    fn a_files_definitions_share_its_rank() {
        // store.ts ranks first (a.ts and b.ts import it), but its three definitions share that
        // rank: open (imported twice) gets half of it, and a.ts's only definition comes next.
        let map = map_of(SCRIPTS, 19);
        assert_eq!(map.text, "a.ts\n  export function a()\nstore.ts\n  export function open(path: string)\n");
        assert_eq!(map.tokens, 19);
    }

    #[test]
    fn an_overloaded_name_is_listed_once_at_its_first_line() {
        let overloads = "export function f(a: string): void;\nexport function f(a: number): void;\nexport function f(a: unknown) {}\n";
        let map = map_of(&[("over.ts", overloads)], DEFAULT_TOKENS);
        assert_eq!(map.text, "over.ts\n  export function f(a: string): void;\n");
    }

    #[test]
    fn a_go_package_import_ranks_the_files_of_its_folder() {
        let map = map_of(
            &[
                ("go.mod", "module example.com/app\n"),
                ("store/store.go", "package store\n\nfunc Open() {\n}\n"),
                ("main.go", "package main\n\nimport \"example.com/app/store\"\n\nfunc main() {\n\tstore.Open()\n}\n"),
            ],
            8,
        );
        assert_eq!(map.text, "store/store.go\n  func Open()\n");
    }

    #[test]
    fn signatures_drop_the_opening_brace_and_long_tails() {
        assert_eq!(signature("  pub fn run(&self) -> u32 {  "), "pub fn run(&self) -> u32");
        let long = format!("def f({}):", "x, ".repeat(60));
        let cut = signature(&long);
        assert_eq!(cut.chars().count(), SIGNATURE_CHARS + 1);
        assert!(cut.ends_with('…'));
    }

    #[test]
    fn an_empty_index_has_an_empty_map() {
        let map = map_of(&[("notes.md", "# nothing to rank")], DEFAULT_TOKENS);
        assert_eq!(map, RepoMap { text: String::new(), files: 0, definitions: 0, tokens: 0 });
    }
}
