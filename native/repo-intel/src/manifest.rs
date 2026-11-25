//! L0: which files a repository has, and which language each one is in.

use std::path::Path;
use std::process::Command;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Language {
    TypeScript,
    Tsx,
    JavaScript,
    Python,
    Go,
    Rust,
    Java,
    Cpp,
}

impl Language {
    pub const ALL: [Language; 8] = [
        Language::TypeScript,
        Language::Tsx,
        Language::JavaScript,
        Language::Python,
        Language::Go,
        Language::Rust,
        Language::Java,
        Language::Cpp,
    ];

    pub fn name(self) -> &'static str {
        match self {
            Language::TypeScript => "typescript",
            Language::Tsx => "tsx",
            Language::JavaScript => "javascript",
            Language::Python => "python",
            Language::Go => "go",
            Language::Rust => "rust",
            Language::Java => "java",
            Language::Cpp => "cpp",
        }
    }

    pub fn of(path: &str) -> Option<Language> {
        let extension = path.rsplit_once('.')?.1.to_ascii_lowercase();
        Some(match extension.as_str() {
            "ts" | "mts" | "cts" => Language::TypeScript,
            "tsx" => Language::Tsx,
            "js" | "mjs" | "cjs" | "jsx" => Language::JavaScript,
            "py" | "pyi" => Language::Python,
            "go" => Language::Go,
            "rs" => Language::Rust,
            "java" => Language::Java,
            "cc" | "cpp" | "cxx" | "c++" | "hh" | "hpp" | "hxx" | "h" | "c" | "ipp" | "inl" => Language::Cpp,
            _ => return None,
        })
    }
}

/// Larger files are mostly generated or vendored; reading them costs more than they give.
const MAX_FILE_BYTES: u64 = 1024 * 1024;
/// A NUL byte this early means the file is not text.
const BINARY_PROBE_BYTES: usize = 8 * 1024;

pub fn too_large(size: u64) -> bool {
    size > MAX_FILE_BYTES
}

/// A source file's bytes, or why it is not read as source: `unreadable` or `binary`.
pub fn read_source(file: &Path) -> Result<Vec<u8>, &'static str> {
    let bytes = std::fs::read(file).map_err(|_| "unreadable")?;
    if bytes[..bytes.len().min(BINARY_PROBE_BYTES)].contains(&0) {
        return Err("binary");
    }
    Ok(bytes)
}

/// The repository's files that git tracks or would track: committed, staged,
/// and new files that are not ignored. Paths are relative and use `/`.
pub fn list_files(root: &Path) -> Result<Vec<String>, String> {
    let output = Command::new("git")
        .arg("-C")
        .arg(root)
        .args(["ls-files", "-z", "--cached", "--others", "--exclude-standard", "--deduplicate"])
        .output()
        .map_err(|error| format!("git could not run: {error}"))?;
    if !output.status.success() {
        let detail = String::from_utf8_lossy(&output.stderr);
        return Err(format!("git ls-files failed: {}", detail.trim()));
    }
    let mut files: Vec<String> = output
        .stdout
        .split(|byte| *byte == 0)
        .filter(|path| !path.is_empty())
        .map(|path| String::from_utf8_lossy(path).into_owned())
        .collect();
    files.sort();
    files.dedup();
    Ok(files)
}

#[cfg(test)]
pub mod tests {
    use super::*;
    use std::fs;

    /// A new git repository holding the given files.
    pub fn repo(files: &[(&str, &str)]) -> tempfile::TempDir {
        let dir = tempfile::Builder::new().prefix("kodax-repo-intel-").tempdir().unwrap();
        let status = Command::new("git").arg("-C").arg(dir.path()).args(["init", "-q"]).status().unwrap();
        assert!(status.success());
        for (path, text) in files {
            let file = dir.path().join(path);
            fs::create_dir_all(file.parent().unwrap()).unwrap();
            fs::write(file, text).unwrap();
        }
        dir
    }

    #[test]
    fn lists_new_and_nested_files_but_not_ignored_ones() {
        let dir = repo(&[("src/a.ts", "x"), ("b.py", "y"), (".gitignore", "out/\n"), ("out/c.js", "z")]);
        assert_eq!(list_files(dir.path()).unwrap(), vec![".gitignore", "b.py", "src/a.ts"]);
    }

    #[test]
    fn says_why_when_the_folder_is_not_a_repository() {
        let dir = tempfile::tempdir().unwrap();
        let error = list_files(&dir.path().join("missing")).unwrap_err();
        assert!(error.starts_with("git ls-files failed"), "{error}");
    }

    #[test]
    fn knows_the_language_by_extension_only() {
        assert_eq!(Language::of("a/b.TSX"), Some(Language::Tsx));
        assert_eq!(Language::of("x.d.ts"), Some(Language::TypeScript));
        assert_eq!(Language::of("fmt/core.h"), Some(Language::Cpp));
        assert_eq!(Language::of("README.md"), None);
        assert_eq!(Language::of("Makefile"), None);
    }
}
