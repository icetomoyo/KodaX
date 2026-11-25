//! Python: dotted names to `.py` files and packages. A relative import starts at the
//! importer's own package. An absolute one is looked up under the folders Python
//! would have on `sys.path` for this file: the folder above its top package (where a
//! script or test runs from), each project folder (with `pyproject.toml`, `setup.py`
//! or `setup.cfg`, the importer's own first) and its `src`, then the repository root.
//!
//! A regular module or package anywhere on those roots wins over a namespace package
//! (a folder of Python files with no `__init__.py`), as in Python. A name found nowhere
//! is external (the standard library or an installed package), unless its first part
//! is in the repository: then it is missing.
//!
//! The folder above a nested top package (`plugins/platforms/` for `plugins/platforms/email/`)
//! is only a guess at a script folder: a standard-library name is not looked up there
//! (`import email` is the standard library's), and a name found only there is external
//! when its rest is not (`telegram.ext` in a package that wraps `telegram`).

use super::{Resolution, file_name, parent, under};
use std::collections::HashSet;

const PROJECT_FILES: [&str; 3] = ["pyproject.toml", "setup.py", "setup.cfg"];

/// The standard library's top-level public modules (`sys.stdlib_module_names`, Python 3.12).
const STANDARD_LIBRARY: [&str; 212] = [
    "abc", "aifc", "antigravity", "argparse", "array", "ast", "asyncio", "atexit", "audioop", "base64", "bdb", "binascii",
    "bisect", "builtins", "bz2", "cProfile", "calendar", "cgi", "cgitb", "chunk", "cmath", "cmd", "code", "codecs", "codeop",
    "collections", "colorsys", "compileall", "concurrent", "configparser", "contextlib", "contextvars", "copy", "copyreg",
    "crypt", "csv", "ctypes", "curses", "dataclasses", "datetime", "dbm", "decimal", "difflib", "dis", "doctest", "email",
    "encodings", "ensurepip", "enum", "errno", "faulthandler", "fcntl", "filecmp", "fileinput", "fnmatch", "fractions",
    "ftplib", "functools", "gc", "genericpath", "getopt", "getpass", "gettext", "glob", "graphlib", "grp", "gzip", "hashlib",
    "heapq", "hmac", "html", "http", "idlelib", "imaplib", "imghdr", "importlib", "inspect", "io", "ipaddress", "itertools",
    "json", "keyword", "lib2to3", "linecache", "locale", "logging", "lzma", "mailbox", "mailcap", "marshal", "math",
    "mimetypes", "mmap", "modulefinder", "msilib", "msvcrt", "multiprocessing", "netrc", "nis", "nntplib", "nt", "ntpath",
    "nturl2path", "numbers", "opcode", "operator", "optparse", "os", "ossaudiodev", "pathlib", "pdb", "pickle", "pickletools",
    "pipes", "pkgutil", "platform", "plistlib", "poplib", "posix", "posixpath", "pprint", "profile", "pstats", "pty", "pwd",
    "py_compile", "pyclbr", "pydoc", "pydoc_data", "pyexpat", "queue", "quopri", "random", "re", "readline", "reprlib",
    "resource", "rlcompleter", "runpy", "sched", "secrets", "select", "selectors", "shelve", "shlex", "shutil", "signal",
    "site", "smtplib", "sndhdr", "socket", "socketserver", "spwd", "sqlite3", "sre_compile", "sre_constants", "sre_parse",
    "ssl", "stat", "statistics", "string", "stringprep", "struct", "subprocess", "sunau", "symtable", "sys", "sysconfig",
    "syslog", "tabnanny", "tarfile", "telnetlib", "tempfile", "termios", "textwrap", "this", "threading", "time", "timeit",
    "tkinter", "token", "tokenize", "tomllib", "trace", "traceback", "tracemalloc", "tty", "turtle", "turtledemo", "types",
    "typing", "unicodedata", "unittest", "urllib", "uu", "uuid", "venv", "warnings", "wave", "weakref", "webbrowser",
    "winreg", "winsound", "wsgiref", "xdrlib", "xml", "xmlrpc", "zipapp", "zipfile", "zipimport", "zlib", "zoneinfo",
];

pub struct Python {
    /// Folders with an `__init__.py`.
    packages: HashSet<String>,
    /// Folders that hold Python files.
    folders: HashSet<String>,
    /// Project folders, the deepest first.
    projects: Vec<String>,
}

impl Python {
    pub fn new(files: &HashSet<String>) -> Python {
        let (mut packages, mut folders, mut projects) = (HashSet::new(), HashSet::new(), Vec::new());
        for path in files {
            let name = file_name(path);
            if name.ends_with(".py") || name.ends_with(".pyi") {
                folders.insert(parent(path).to_owned());
                if name == "__init__.py" || name == "__init__.pyi" {
                    packages.insert(parent(path).to_owned());
                }
            } else if PROJECT_FILES.contains(&name) {
                projects.push(parent(path).to_owned());
            }
        }
        projects.sort_by(|a, b| (b.len(), b).cmp(&(a.len(), a)));
        projects.dedup();
        Python { packages, folders, projects }
    }

    pub fn resolve(&self, files: &HashSet<String>, from: &str, module: &str) -> Resolution {
        let dots = module.len() - module.trim_start_matches('.').len();
        let dotted = &module[dots..];
        if dots > 0 {
            let mut folder = parent(from).to_owned();
            for _ in 1..dots {
                if folder.is_empty() {
                    return Resolution::Missing;
                }
                folder = parent(&folder).to_owned();
            }
            return self.regular(files, &folder, dotted).or_else(|| self.namespace(&folder, dotted)).unwrap_or(Resolution::Missing);
        }
        let first = dotted.split('.').next().unwrap_or_default();
        let (roots, guess) = self.roots(from);
        let real = if guess { &roots[1..] } else { &roots[..] };
        let lookup = if STANDARD_LIBRARY.contains(&first) { real } else { &roots[..] };
        if let Some(found) = lookup.iter().find_map(|root| self.regular(files, root, dotted)) {
            return found;
        }
        if let Some(found) = lookup.iter().find_map(|root| self.namespace(root, dotted)) {
            return found;
        }
        let known = real.iter().any(|root| self.regular(files, root, first).is_some() || self.namespace(root, first).is_some());
        if known { Resolution::Missing } else { Resolution::External }
    }

    /// The module file or package `__init__` for `dotted` under `folder`; `""` is the package of `folder` itself.
    fn regular(&self, files: &HashSet<String>, folder: &str, dotted: &str) -> Option<Resolution> {
        let base = if dotted.is_empty() { folder.to_owned() } else { under(folder, &dotted.replace('.', "/")) };
        let module = (!dotted.is_empty()).then(|| [format!("{base}.py"), format!("{base}.pyi")]).into_iter().flatten();
        let package = ["__init__.py", "__init__.pyi"].map(|init| under(&base, init));
        module.chain(package).find(|candidate| files.contains(candidate)).map(Resolution::File)
    }

    /// The folder of a namespace package for `dotted` under `folder`.
    fn namespace(&self, folder: &str, dotted: &str) -> Option<Resolution> {
        let base = if dotted.is_empty() { folder.to_owned() } else { under(folder, &dotted.replace('.', "/")) };
        (self.folders.contains(&base) && !self.packages.contains(&base)).then_some(Resolution::Folder(base))
    }

    /// Where absolute imports of the file at `from` are looked up, in order, and whether the
    /// first, the folder above its top package, is only a guess (not a project or the repository root).
    fn roots(&self, from: &str) -> (Vec<String>, bool) {
        let mut top = parent(from);
        while !top.is_empty() && self.packages.contains(top) {
            top = parent(top);
        }
        let contains = |project: &String| project.is_empty() || from.starts_with(&format!("{project}/"));
        let own = self.projects.iter().filter(|project| contains(project));
        let others = self.projects.iter().filter(|project| !contains(project));
        let mut roots = vec![top.to_owned()];
        for project in own.chain(others).chain([&String::new()]) {
            roots.push(project.clone());
            roots.push(under(project, "src"));
        }
        let guess = !roots[1..].iter().any(|root| root == top);
        let mut seen = HashSet::new();
        roots.retain(|root| seen.insert(root.clone()));
        (roots, guess)
    }
}

#[cfg(test)]
mod tests {
    use crate::manifest::Language;
    use crate::resolve::Resolution;
    use crate::resolve::tests::{file, resolver};

    #[test]
    fn relative_imports_start_at_the_importers_package() {
        let r = resolver(&[
            ("app/__init__.py", ""),
            ("app/core/__init__.py", ""),
            ("app/core/store.py", ""),
            ("app/core/types.pyi", ""),
            ("app/web/__init__.py", ""),
            ("app/web/views.py", ""),
            ("app/web/forms/__init__.py", ""),
            ("app/plugins/extra.py", ""),
        ]);
        let resolve = |module: &str| r.resolve(Language::Python, "app/web/views.py", module).unwrap();
        assert_eq!(resolve("."), file("app/web/__init__.py"));
        assert_eq!(resolve(".forms"), file("app/web/forms/__init__.py"));
        assert_eq!(resolve("..core.store"), file("app/core/store.py"));
        assert_eq!(resolve("..core.types"), file("app/core/types.pyi"));
        assert_eq!(resolve(".."), file("app/__init__.py"));
        assert_eq!(resolve("..plugins"), Resolution::Folder("app/plugins".to_owned()));
        assert_eq!(resolve("..core.gone"), Resolution::Missing);
        assert_eq!(resolve("...."), Resolution::Missing);
    }

    #[test]
    fn absolute_imports_look_under_the_roots_python_would_use() {
        let r = resolver(&[
            ("pyproject.toml", ""),
            ("src/shop/__init__.py", ""),
            ("src/shop/cart.py", ""),
            ("tests/test_cart.py", ""),
            ("tests/helpers.py", ""),
            ("libs/money/pyproject.toml", ""),
            ("libs/money/money/__init__.py", ""),
            ("scripts/tool.py", ""),
            ("scripts/jobs/nightly.py", ""),
        ]);
        let resolve = |from: &str, module: &str| r.resolve(Language::Python, from, module).unwrap();
        assert_eq!(resolve("tests/test_cart.py", "shop.cart"), file("src/shop/cart.py"));
        assert_eq!(resolve("tests/test_cart.py", "helpers"), file("tests/helpers.py"));
        assert_eq!(resolve("src/shop/cart.py", "shop"), file("src/shop/__init__.py"));
        assert_eq!(resolve("src/shop/cart.py", "money"), file("libs/money/money/__init__.py"));
        assert_eq!(resolve("tests/test_cart.py", "shop.gone"), Resolution::Missing);
        assert_eq!(resolve("tests/test_cart.py", "os.path"), Resolution::External);
        assert_eq!(resolve("tests/test_cart.py", "numpy"), Resolution::External);
        // A folder of Python files with no __init__.py is a namespace package.
        assert_eq!(resolve("scripts/tool.py", "jobs"), Resolution::Folder("scripts/jobs".to_owned()));
        assert_eq!(resolve("scripts/tool.py", "jobs.nightly"), file("scripts/jobs/nightly.py"));
    }

    #[test]
    fn the_folder_above_a_nested_package_is_a_guess_the_standard_library_wins_over() {
        let r = resolver(&[
            ("pyproject.toml", ""),
            ("app/__init__.py", ""),
            ("app/gone_user.py", ""),
            ("plugins/platforms/email/__init__.py", ""),
            ("plugins/platforms/email/adapter.py", ""),
            ("plugins/platforms/telegram/__init__.py", ""),
            ("plugins/platforms/telegram/adapter.py", ""),
            ("plugins/platforms/telegram/helpers.py", ""),
        ]);
        let resolve = |from: &str, module: &str| r.resolve(Language::Python, from, module).unwrap();
        let telegram = "plugins/platforms/telegram/adapter.py";
        assert_eq!(resolve(telegram, "telegram.helpers"), file("plugins/platforms/telegram/helpers.py"));
        assert_eq!(resolve(telegram, "email"), Resolution::External, "the standard library's email");
        assert_eq!(resolve(telegram, "email.utils"), Resolution::External);
        // The package wraps the library it is named after.
        assert_eq!(resolve(telegram, "telegram.ext"), Resolution::External);
        assert_eq!(resolve("app/gone_user.py", "app.gone"), Resolution::Missing);
    }
}
