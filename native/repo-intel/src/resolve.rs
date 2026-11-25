//! L2: which file of the repository an import names. TypeScript and JavaScript
//! follow the compiler's rules closely enough for navigation: relative paths
//! (a `.js` import of a `.ts` file, folder `index` files), tsconfig/jsconfig
//! `paths` and `baseUrl` (with `extends`), and workspace packages by their
//! package.json name, mapped from built output back to source.

use crate::manifest::Language;
use serde_json::Value;
use std::collections::{HashMap, HashSet};

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Resolution {
    /// A file in the repository.
    File(String),
    /// A package from outside the repository, or a runtime module such as `node:fs`.
    External,
    /// It names something in the repository, but no such file is there.
    Missing,
}

impl Resolution {
    pub fn parts(&self) -> (Option<&str>, Option<&'static str>) {
        match self {
            Resolution::File(path) => (Some(path), None),
            Resolution::External => (None, Some("external")),
            Resolution::Missing => (None, Some("missing")),
        }
    }
}

/// Tried after the path as written and in this order, as the TypeScript compiler does.
const SCRIPT_EXTENSIONS: [&str; 9] = [".ts", ".tsx", ".d.ts", ".js", ".jsx", ".mts", ".cts", ".mjs", ".cjs"];
/// A JavaScript file name in an import stands for the TypeScript source it is compiled from.
const SOURCE_OF_OUTPUT: [(&str, &[&str]); 4] = [
    (".js", &[".ts", ".tsx", ".d.ts"]),
    (".jsx", &[".tsx", ".d.ts"]),
    (".mjs", &[".mts", ".d.mts"]),
    (".cjs", &[".cts", ".d.cts"]),
];
/// Conditions of a package.json `exports` entry, the source-like ones first.
const CONDITIONS: [&str; 7] = ["source", "types", "import", "module", "default", "require", "node"];
/// Where packages commonly put built output, when their tsconfig does not say.
const OUTPUT_FOLDERS: [&str; 4] = ["dist", "lib", "build", "out"];

/// Whether a change to this file can change how imports resolve.
pub fn is_resolution_config(path: &str) -> bool {
    let name = file_name(path);
    name == "package.json" || name == "jsconfig.json" || (name.starts_with("tsconfig") && name.ends_with(".json"))
}

#[derive(Debug, Default, Clone)]
struct ScriptConfig {
    base_url: Option<String>,
    /// `paths` patterns and their targets; targets are relative to `paths_base`.
    paths: Vec<(String, Vec<String>)>,
    paths_base: String,
    out_dir: Option<String>,
    root_dir: Option<String>,
}

pub struct Resolver {
    files: HashSet<String>,
    /// The tsconfig.json (or jsconfig.json) in each folder that has one.
    configs: HashMap<String, ScriptConfig>,
    /// Workspace packages by name: their folder and package.json.
    packages: HashMap<String, (String, Value)>,
}

impl Resolver {
    /// `files` are every path of the repository; `read` gives a file's text, and is asked only for configuration.
    pub fn new(files: HashSet<String>, read: impl Fn(&str) -> Option<String>) -> Resolver {
        let mut configs = HashMap::new();
        let mut packages: HashMap<String, (String, Value)> = HashMap::new();
        let mut paths: Vec<&String> = files.iter().collect();
        // Shorter paths first: a workspace package wins over a fixture of the same name deeper down.
        paths.sort_by_key(|path| (path.len(), path.as_str()));
        for path in paths {
            let name = file_name(path);
            if name == "tsconfig.json" || (name == "jsconfig.json" && !files.contains(&format!("{}tsconfig.json", folder_prefix(path)))) {
                configs.insert(parent(path).to_owned(), load_config(path, &read, 0));
            } else if name == "package.json" {
                let Some(manifest) = read_json(path, &read) else { continue };
                if let Some(package) = manifest.get("name").and_then(Value::as_str) {
                    packages.entry(package.to_owned()).or_insert_with(|| (parent(path).to_owned(), manifest));
                }
            }
        }
        Resolver { files, configs, packages }
    }

    /// Where `module`, imported by the file at `from`, leads; None for languages without module resolution yet.
    pub fn resolve(&self, language: Language, from: &str, module: &str) -> Option<Resolution> {
        match language {
            Language::TypeScript | Language::Tsx | Language::JavaScript => Some(self.script(from, module)),
            _ => None,
        }
    }

    fn script(&self, from: &str, module: &str) -> Resolution {
        if module.starts_with("./") || module.starts_with("../") || module == "." || module == ".." {
            let found = join(parent(from), module).and_then(|base| self.probe(&base).or_else(|| self.source_of(&base)));
            return found.map_or(Resolution::Missing, Resolution::File);
        }
        if module.starts_with('/') || module.starts_with('#') {
            return Resolution::Missing;
        }
        if module.starts_with("node:") {
            return Resolution::External;
        }
        let mut mapped = false;
        if let Some(config) = self.config_for(from) {
            let base = config.base_url.as_deref().unwrap_or(&config.paths_base);
            for (star, targets) in matching_patterns(&config.paths, module) {
                mapped = true;
                let found = targets.iter().filter_map(|target| join(base, &target.replace('*', star))).find_map(|path| self.probe(&path));
                if let Some(found) = found {
                    return Resolution::File(found);
                }
            }
            if let Some(found) = config.base_url.as_deref().and_then(|base_url| join(base_url, module)).and_then(|path| self.probe(&path)) {
                return Resolution::File(found);
            }
        }
        match self.package(module) {
            Some(resolution) => resolution,
            None if mapped => Resolution::Missing,
            None => Resolution::External,
        }
    }

    /// A workspace package's file, by the package.json `exports`, or `types` / `main` when it has none.
    fn package(&self, module: &str) -> Option<Resolution> {
        let segments = if module.starts_with('@') { 2 } else { 1 };
        let mut parts = module.splitn(segments + 1, '/');
        let name = parts.by_ref().take(segments).collect::<Vec<_>>().join("/");
        let subpath = parts.next().unwrap_or_default();
        let (folder, manifest) = self.packages.get(&name)?;
        let key = if subpath.is_empty() { ".".to_owned() } else { format!("./{subpath}") };
        let found = entries(manifest, &key)
            .iter()
            .filter_map(|entry| join(folder, entry))
            .find_map(|path| self.probe(&path).or_else(|| self.source_of(&path)));
        Some(found.map_or(Resolution::Missing, Resolution::File))
    }

    /// The source file that built output at `path` is compiled from.
    fn source_of(&self, path: &str) -> Option<String> {
        let mut candidates = Vec::new();
        if let Some(config) = self.config_for(path)
            && let (Some(out_dir), Some(root_dir)) = (&config.out_dir, &config.root_dir)
            && let Some(rest) = path.strip_prefix(&format!("{out_dir}/"))
        {
            candidates.push(format!("{root_dir}/{rest}"));
        }
        let segments: Vec<&str> = path.split('/').collect();
        for (index, segment) in segments.iter().enumerate() {
            if OUTPUT_FOLDERS.contains(segment) {
                let mut source = segments.clone();
                source[index] = "src";
                candidates.push(source.join("/"));
            }
        }
        candidates.iter().find_map(|candidate| self.probe(output_stem(candidate)))
    }

    /// The file an import of `base` finds: by its name for a source file, with an extension added, or a folder's index file.
    fn probe(&self, base: &str) -> Option<String> {
        let mut candidates = Vec::new();
        for (output, sources) in SOURCE_OF_OUTPUT {
            if let Some(stem) = base.strip_suffix(output) {
                candidates.extend(sources.iter().map(|source| format!("{stem}{source}")));
            }
        }
        candidates.push(base.to_owned());
        candidates.extend(SCRIPT_EXTENSIONS.iter().map(|extension| format!("{base}{extension}")));
        candidates.extend(SCRIPT_EXTENSIONS.iter().map(|extension| format!("{base}/index{extension}")));
        candidates.into_iter().find(|candidate| self.files.contains(candidate))
    }

    /// The configuration in the nearest folder above `path` that has one.
    fn config_for(&self, path: &str) -> Option<&ScriptConfig> {
        let mut folder = parent(path);
        loop {
            if let Some(config) = self.configs.get(folder) {
                return Some(config);
            }
            if folder.is_empty() {
                return None;
            }
            folder = parent(folder);
        }
    }
}

/// The `paths` patterns `module` matches, most specific first, each with what its `*` stands for.
fn matching_patterns<'a>(paths: &'a [(String, Vec<String>)], module: &'a str) -> Vec<(&'a str, &'a [String])> {
    let mut matches: Vec<(usize, &str, &[String])> = paths
        .iter()
        .filter_map(|(pattern, targets)| match pattern.split_once('*') {
            None => (pattern == module).then_some((usize::MAX, "", targets.as_slice())),
            Some((prefix, suffix)) => {
                let star = module.strip_prefix(prefix)?.strip_suffix(suffix)?;
                Some((prefix.len(), star, targets.as_slice()))
            }
        })
        .collect();
    matches.sort_by_key(|(specificity, _, _)| std::cmp::Reverse(*specificity));
    matches.into_iter().map(|(_, star, targets)| (star, targets)).collect()
}

/// What a package exports at `key` (`.` or `./sub`), as paths relative to its folder, best first.
fn entries(manifest: &Value, key: &str) -> Vec<String> {
    let Some(exports) = manifest.get("exports") else {
        if key != "." {
            return vec![key.to_owned()];
        }
        let fields = ["types", "typings", "module", "main"].iter().filter_map(|field| manifest.get(*field)?.as_str());
        return fields.map(str::to_owned).chain(["index".to_owned()]).collect();
    };
    let subpaths = exports.as_object().filter(|map| map.keys().any(|k| k.starts_with('.')));
    let Some(subpaths) = subpaths else {
        return if key == "." { conditions(exports) } else { Vec::new() };
    };
    if let Some(entry) = subpaths.get(key) {
        return conditions(entry);
    }
    for (pattern, entry) in subpaths {
        let star = pattern.split_once('*').and_then(|(prefix, suffix)| key.strip_prefix(prefix)?.strip_suffix(suffix));
        if let Some(star) = star {
            return conditions(entry).iter().map(|target| target.replace('*', star)).collect();
        }
    }
    Vec::new()
}

fn conditions(entry: &Value) -> Vec<String> {
    match entry {
        Value::String(target) => vec![target.clone()],
        Value::Array(choices) => choices.iter().flat_map(conditions).collect(),
        Value::Object(map) => CONDITIONS.iter().filter_map(|condition| map.get(*condition)).flat_map(conditions).collect(),
        _ => Vec::new(),
    }
}

/// A tsconfig with what it `extends` (relative paths only: configs from packages are not in the repository).
fn load_config(path: &str, read: &impl Fn(&str) -> Option<String>, depth: u8) -> ScriptConfig {
    let Some(json) = read_json(path, read) else { return ScriptConfig::default() };
    let folder = parent(path);
    let bases: Vec<&str> = match json.get("extends") {
        Some(Value::String(base)) => vec![base.as_str()],
        Some(Value::Array(bases)) => bases.iter().filter_map(Value::as_str).collect(),
        _ => Vec::new(),
    };
    let mut config = ScriptConfig { paths_base: folder.to_owned(), ..ScriptConfig::default() };
    for base in bases.into_iter().filter(|base| base.starts_with('.') && depth < 8) {
        let file = if base.ends_with(".json") { base.to_owned() } else { format!("{base}.json") };
        if let Some(file) = join(folder, &file) {
            config = load_config(&file, read, depth + 1);
        }
    }
    let options = &json["compilerOptions"];
    let in_folder = |key: &str| options.get(key).and_then(Value::as_str).and_then(|value| join(folder, value));
    if let Some(base_url) = in_folder("baseUrl") {
        config.base_url = Some(base_url);
    }
    if let Some(paths) = options.get("paths").and_then(Value::as_object) {
        config.paths_base = folder.to_owned();
        config.paths = paths
            .iter()
            .map(|(pattern, targets)| {
                let targets = targets.as_array().map(|list| list.iter().filter_map(Value::as_str).map(str::to_owned).collect());
                (pattern.clone(), targets.unwrap_or_default())
            })
            .collect();
    }
    config.out_dir = in_folder("outDir").or(config.out_dir);
    config.root_dir = in_folder("rootDir").or(config.root_dir);
    config
}

/// A configuration file's JSON; one that does not parse is reported and left out.
fn read_json(path: &str, read: &impl Fn(&str) -> Option<String>) -> Option<Value> {
    let json = parse_jsonc(&read(path)?);
    if json.is_none() {
        eprintln!("kodax-repo-intel: {path} is not valid JSON; imports it configures stay unresolved");
    }
    json
}

/// JSON with the comments and trailing commas tsconfig files allow.
pub fn parse_jsonc(text: &str) -> Option<Value> {
    let chars: Vec<char> = text.trim_start_matches('\u{feff}').chars().collect();
    let mut out = String::with_capacity(text.len());
    let mut index = 0;
    let mut in_string = false;
    while index < chars.len() {
        let c = chars[index];
        let next = chars.get(index + 1).copied();
        index += 1;
        if in_string {
            out.push(c);
            if c == '\\' {
                out.extend(next);
                index += 1;
            } else if c == '"' {
                in_string = false;
            }
        } else if c == '/' && next == Some('/') {
            while index < chars.len() && chars[index] != '\n' {
                index += 1;
            }
        } else if c == '/' && next == Some('*') {
            // Past the `/*`, then one more: `/*/` does not close it.
            index += 2;
            while index < chars.len() && !(chars[index - 1] == '*' && chars[index] == '/') {
                index += 1;
            }
            index += 1;
        } else if c == ',' && matches!(next_token(&chars, index), Some('}' | ']')) {
            // A trailing comma: dropped.
        } else {
            in_string = c == '"';
            out.push(c);
        }
    }
    serde_json::from_str(&out).ok()
}

/// The first character from `index` on that is not blank or in a comment.
fn next_token(chars: &[char], mut index: usize) -> Option<char> {
    loop {
        match (chars.get(index)?, chars.get(index + 1)) {
            (c, _) if c.is_whitespace() => index += 1,
            ('/', Some('/')) => index = index + chars[index..].iter().position(|c| *c == '\n')?,
            ('/', Some('*')) => index = index + 2 + chars.get(index + 2..)?.windows(2).position(|w| w == ['*', '/'])? + 2,
            (c, _) => return Some(*c),
        }
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

fn parent(path: &str) -> &str {
    path.rsplit_once('/').map_or("", |(folder, _)| folder)
}

fn folder_prefix(path: &str) -> &str {
    path.rsplit_once('/').map_or("", |(folder, _)| &path[..=folder.len()])
}

fn file_name(path: &str) -> &str {
    path.rsplit('/').next().unwrap_or(path)
}

/// Built output's path without its extension, so `probe` can find the source with any.
fn output_stem(path: &str) -> &str {
    [".d.ts", ".d.mts", ".d.cts", ".js", ".mjs", ".cjs", ".jsx"]
        .iter()
        .find_map(|extension| path.strip_suffix(extension))
        .unwrap_or(path)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn resolver(files: &[(&str, &str)]) -> Resolver {
        let texts: HashMap<String, String> = files.iter().map(|(path, text)| ((*path).to_owned(), (*text).to_owned())).collect();
        let paths = texts.keys().cloned().collect();
        Resolver::new(paths, |path| texts.get(path).cloned())
    }

    fn resolve(resolver: &Resolver, from: &str, module: &str) -> Resolution {
        resolver.resolve(Language::TypeScript, from, module).unwrap()
    }

    fn file(path: &str) -> Resolution {
        Resolution::File(path.to_owned())
    }

    #[test]
    fn relative_imports_find_the_source_behind_a_js_name_and_folder_index_files() {
        let r = resolver(&[
            ("src/a.ts", ""),
            ("src/b.ts", ""),
            ("src/c.tsx", ""),
            ("src/d.mts", ""),
            ("src/dir/index.ts", ""),
            ("src/plain.js", ""),
            ("assets/x.json", ""),
            ("pkg/src/index.ts", ""),
        ]);
        let cases = [
            ("./b.js", file("src/b.ts")),
            ("./b", file("src/b.ts")),
            ("./b.ts", file("src/b.ts")),
            ("./c.js", file("src/c.tsx")),
            ("./d.mjs", file("src/d.mts")),
            ("./dir", file("src/dir/index.ts")),
            ("./dir/index.js", file("src/dir/index.ts")),
            ("./plain.js", file("src/plain.js")),
            ("../assets/x.json", file("assets/x.json")),
            ("../pkg/dist/index.js", file("pkg/src/index.ts")),
            ("./gone.js", Resolution::Missing),
            ("../../outside", Resolution::Missing),
            ("react", Resolution::External),
            ("node:fs", Resolution::External),
        ];
        for (module, expected) in cases {
            assert_eq!(resolve(&r, "src/a.ts", module), expected, "{module}");
        }
    }

    #[test]
    fn tsconfig_paths_and_base_url_follow_extends_and_allow_comments() {
        let base = "{\n  // shared settings\n  \"compilerOptions\": {\n    \"baseUrl\": \"./src\", /* where bare names start */\n    \"paths\": {\"@app/*\": [\"app/*\"], \"@config\": [\"config/index.ts\"], \"@app/special\": [\"special.ts\"],},\n  },\n}";
        let r = resolver(&[
            ("tsconfig.base.json", base),
            ("web/tsconfig.json", "{\"extends\": \"../tsconfig.base\"}"),
            ("web/main.ts", ""),
            ("src/app/run.ts", ""),
            ("src/config/index.ts", ""),
            ("src/special.ts", ""),
            ("src/lib/util.ts", ""),
            ("tools/jsconfig.json", "{\"compilerOptions\": {\"paths\": {\"~/*\": [\"./*\"]}}}"),
            ("tools/y.js", ""),
            ("tools/x.js", ""),
        ]);
        assert_eq!(resolve(&r, "web/main.ts", "@app/run"), file("src/app/run.ts"));
        assert_eq!(resolve(&r, "web/main.ts", "@app/special"), file("src/special.ts"));
        assert_eq!(resolve(&r, "web/main.ts", "@config"), file("src/config/index.ts"));
        assert_eq!(resolve(&r, "web/main.ts", "lib/util.js"), file("src/lib/util.ts"));
        assert_eq!(resolve(&r, "web/main.ts", "@app/none"), Resolution::Missing);
        assert_eq!(resolve(&r, "web/main.ts", "lodash"), Resolution::External);
        assert_eq!(r.resolve(Language::JavaScript, "tools/x.js", "~/y"), Some(file("tools/y.js")));
        // The root has no tsconfig of its own, only the one web/ extends.
        assert_eq!(resolve(&r, "src/app/run.ts", "@app/run"), Resolution::External);
    }

    #[test]
    fn workspace_packages_resolve_to_source_through_exports_or_main() {
        let llm = "{\"name\": \"@k/llm\", \"exports\": {\".\": {\"types\": \"./dist/index.d.ts\", \"import\": \"./dist/index.js\"},\n\
            \"./errors\": {\"types\": \"./dist/errors.d.ts\"}, \"./internal/*\": \"./dist/internal/*.js\"}}";
        let r = resolver(&[
            ("packages/llm/package.json", llm),
            ("packages/llm/tsconfig.json", "{\"compilerOptions\": {\"outDir\": \"./dist\", \"rootDir\": \"./src\"}}"),
            ("packages/llm/src/index.ts", ""),
            ("packages/llm/src/errors.ts", ""),
            ("packages/llm/src/internal/x.ts", ""),
            ("packages/plain/package.json", "{\"name\": \"plain\", \"main\": \"lib/main.js\"}"),
            ("packages/plain/src/main.ts", ""),
            ("packages/plain/sub.ts", ""),
            ("packages/plain/fixtures/copy/package.json", "{\"name\": \"plain\", \"main\": \"other.js\"}"),
            ("app/main.ts", ""),
        ]);
        assert_eq!(resolve(&r, "app/main.ts", "@k/llm"), file("packages/llm/src/index.ts"));
        assert_eq!(resolve(&r, "app/main.ts", "@k/llm/errors"), file("packages/llm/src/errors.ts"));
        assert_eq!(resolve(&r, "app/main.ts", "@k/llm/internal/x"), file("packages/llm/src/internal/x.ts"));
        assert_eq!(resolve(&r, "app/main.ts", "@k/llm/private"), Resolution::Missing);
        assert_eq!(resolve(&r, "app/main.ts", "plain"), file("packages/plain/src/main.ts"));
        assert_eq!(resolve(&r, "app/main.ts", "plain/sub"), file("packages/plain/sub.ts"));
        assert_eq!(resolve(&r, "app/main.ts", "@k/other"), Resolution::External);
    }

    #[test]
    fn other_languages_are_not_resolved_yet_and_config_files_are_recognized() {
        let r = resolver(&[("a.py", "")]);
        assert_eq!(r.resolve(Language::Python, "a.py", "os"), None);
        for config in ["tsconfig.json", "pkg/tsconfig.build.json", "jsconfig.json", "a/package.json"] {
            assert!(is_resolution_config(config), "{config}");
        }
        assert!(!is_resolution_config("src/package.ts"));
        assert!(!is_resolution_config("data.json"));
    }

    #[test]
    fn jsonc_keeps_slashes_and_commas_inside_strings() {
        let value = parse_jsonc("{\"a\": \"http://x/*y*/\", \"b\": [\"c,]\", 1,], // end\n}").unwrap();
        assert_eq!(value, serde_json::json!({"a": "http://x/*y*/", "b": ["c,]", 1]}));
    }
}
