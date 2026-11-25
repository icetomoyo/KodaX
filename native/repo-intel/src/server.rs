//! Answers the Host's requests. One message in, at most one message out.

use crate::manifest::Language;
use crate::memory;
use crate::priority::Background;
use crate::query;
use crate::rpc::{self, failure, success};
use crate::store::Table;
use crate::workspace::{Workspace, storage_dir};
use serde_json::{Value, json};
use std::collections::HashMap;
use std::path::{Component, Path, PathBuf};

/// Bumped when a method or its parameters change, so a Host refuses an engine
/// it cannot talk to, as after an update installed while the Host kept running.
pub const PROTOCOL: u64 = 1;

/// Memory budget when the Host names none, in MB.
const DEFAULT_MEMORY_BUDGET_MB: u64 = 300;

#[derive(Debug, PartialEq)]
pub enum Outcome {
    Reply(Value),
    /// A notification, which gets no answer.
    Silent,
    /// The process exit code after `exit`: 0 when `shutdown` came first.
    Exit(i32),
}

#[derive(Debug)]
pub struct Config {
    pub storage_root: PathBuf,
    pub memory_budget_mb: u64,
}

enum State {
    Starting,
    Running(Config),
    ShutDown,
}

pub struct Server {
    state: State,
    background: Background,
    workspaces: HashMap<PathBuf, Workspace>,
}

type Answer = Result<Value, (i64, String)>;

impl Server {
    pub fn new(background: Background) -> Self {
        Self { state: State::Starting, background, workspaces: HashMap::new() }
    }

    /// Answers a frame body that is not JSON, keeping the stream usable.
    pub fn unparsable(&self, error: &serde_json::Error) -> Outcome {
        Outcome::Reply(failure(Value::Null, rpc::PARSE_ERROR, &format!("The message is not JSON: {error}")))
    }

    pub fn handle(&mut self, message: Value) -> Outcome {
        let id = message.get("id").cloned();
        let Some(method) = message.get("method").and_then(Value::as_str) else {
            return Outcome::Reply(failure(id.unwrap_or(Value::Null), rpc::INVALID_REQUEST, "The message names no method."));
        };
        let params = message.get("params").cloned().unwrap_or(Value::Null);
        if method == "exit" {
            return Outcome::Exit(if matches!(self.state, State::ShutDown) { 0 } else { 1 });
        }
        let Some(id) = id else {
            self.notified(method, params);
            return Outcome::Silent;
        };
        Outcome::Reply(match self.answer(method, params) {
            Ok(result) => success(id, result),
            Err((code, text)) => failure(id, code, &text),
        })
    }

    /// Notifications get no answer, so a bad one is reported on stderr, which the Host logs.
    fn notified(&mut self, method: &str, params: Value) {
        if !matches!(self.state, State::Running(_)) || method != "files.changed" {
            return;
        }
        let paths: Option<Vec<String>> = params.get("paths").and_then(|paths| serde_json::from_value(paths.clone()).ok());
        match (root_of(&params).ok().and_then(|root| self.workspaces.get(&root)), paths) {
            (Some(workspace), Some(paths)) => workspace.changed(paths),
            _ => eprintln!("kodax-repo-intel: files.changed needs an open root and a list of paths: {params}"),
        }
    }

    fn answer(&mut self, method: &str, params: Value) -> Answer {
        match (&self.state, method) {
            (State::Starting, "initialize") => self.initialize(params),
            (State::Starting, _) => Err((rpc::SERVER_NOT_INITIALIZED, "Send initialize first.".to_owned())),
            (State::ShutDown, _) => Err((rpc::INVALID_REQUEST, "The engine is shutting down; send exit.".to_owned())),
            (State::Running(_), "initialize") => Err((rpc::INVALID_REQUEST, "The engine is already initialized.".to_owned())),
            (State::Running(_), "shutdown") => {
                let closed = self.close_all();
                self.state = State::ShutDown;
                closed
            }
            (State::Running(config), "workspace.open") => {
                let root = root_of(&params)?;
                if !root.is_dir() {
                    return Err((rpc::INVALID_PARAMS, format!("{} is not a folder.", root.display())));
                }
                if !self.workspaces.contains_key(&root) {
                    let workspace = Workspace::open(root.clone(), storage_dir(&config.storage_root, &root))
                        .map_err(|error| (rpc::INTERNAL_ERROR, error))?;
                    self.workspaces.insert(root.clone(), workspace);
                }
                Ok(self.workspaces[&root].status())
            }
            (State::Running(config), "engine.status") => Ok(json!({
                "residentBytes": memory::resident_bytes(),
                "memoryBudgetMb": config.memory_budget_mb,
                "workspaces": self.workspaces.len(),
            })),
            (State::Running(_), "workspace.status") => Ok(self.open_workspace(&params)?.status()),
            (State::Running(_), "workspace.close") => {
                let root = root_of(&params)?;
                self.open_workspace(&params)?;
                let workspace = self.workspaces.remove(&root).expect("checked above");
                workspace.close().map(|()| Value::Null).map_err(|error| (rpc::INTERNAL_ERROR, error))
            }
            (State::Running(_), "symbols.definitions") => self.find(Table::Definitions, &params),
            (State::Running(_), "symbols.references") => self.find(Table::References, &params),
            (State::Running(_), "symbols.referencesTo") => {
                let path = relative_path(&params)?;
                let (name, limit, offset) = named_page(&params)?;
                let workspace = self.open_workspace(&params)?;
                workspace.references_to(&path, name, limit, offset).map_err(|error| (rpc::INTERNAL_ERROR, error))
            }
            (State::Running(_), "file.outline") => {
                let path = relative_path(&params)?;
                let root = root_of(&params)?;
                self.open_workspace(&params)?;
                let workspace = self.workspaces.get_mut(&root).expect("checked above");
                workspace.outline(&path).map_err(|error| (rpc::INTERNAL_ERROR, error))
            }
            (State::Running(_), "file.imports") => {
                let path = relative_path(&params)?;
                self.open_workspace(&params)?.imports(&path).map_err(|error| (rpc::INTERNAL_ERROR, error))
            }
            (State::Running(_), _) => Err((rpc::METHOD_NOT_FOUND, format!("Unknown method: {method}"))),
        }
    }

    fn find(&self, table: Table, params: &Value) -> Answer {
        let (name, limit, offset) = named_page(params)?;
        let workspace = self.open_workspace(params)?;
        workspace.find(table, name, limit, offset).map_err(|error| (rpc::INTERNAL_ERROR, error))
    }

    fn open_workspace(&self, params: &Value) -> Result<&Workspace, (i64, String)> {
        let root = root_of(params)?;
        self.workspaces
            .get(&root)
            .ok_or_else(|| (rpc::INVALID_PARAMS, format!("{} is not open; send workspace.open first.", root.display())))
    }

    fn close_all(&mut self) -> Answer {
        let failures: Vec<String> = self.workspaces.drain().filter_map(|(_, workspace)| workspace.close().err()).collect();
        if failures.is_empty() { Ok(Value::Null) } else { Err((rpc::INTERNAL_ERROR, failures.join("; "))) }
    }

    fn initialize(&mut self, params: Value) -> Answer {
        let storage_root = params
            .get("storageRoot")
            .and_then(Value::as_str)
            .filter(|root| PathBuf::from(root).is_absolute())
            .ok_or((rpc::INVALID_PARAMS, "storageRoot must be an absolute path.".to_owned()))?;
        let memory_budget_mb = match params.get("memoryBudgetMb") {
            None | Some(Value::Null) => DEFAULT_MEMORY_BUDGET_MB,
            Some(value) => value
                .as_u64()
                .filter(|mb| *mb > 0)
                .ok_or((rpc::INVALID_PARAMS, "memoryBudgetMb must be a positive whole number.".to_owned()))?,
        };
        self.state = State::Running(Config { storage_root: PathBuf::from(storage_root), memory_budget_mb });
        let background = match &self.background {
            Background::Active => json!({ "active": true }),
            Background::Unavailable(reason) => json!({ "active": false, "reason": reason }),
        };
        Ok(json!({
            "version": env!("CARGO_PKG_VERSION"),
            "protocol": PROTOCOL,
            "languages": Language::ALL.map(Language::name),
            "memoryBudgetMb": memory_budget_mb,
            "background": background,
        }))
    }
}

/// The `name` asked for and the page: `limit` and `offset`.
fn named_page(params: &Value) -> Result<(&str, u64, u64), (i64, String)> {
    let name = params
        .get("name")
        .and_then(Value::as_str)
        .filter(|name| !name.is_empty())
        .ok_or((rpc::INVALID_PARAMS, "name must be a non-empty string.".to_owned()))?;
    let limit = whole_number(params, "limit", query::DEFAULT_LIMIT)?;
    if !(1..=query::MAX_LIMIT).contains(&limit) {
        return Err((rpc::INVALID_PARAMS, format!("limit must be between 1 and {}.", query::MAX_LIMIT)));
    }
    Ok((name, limit, whole_number(params, "offset", 0)?))
}

fn whole_number(params: &Value, key: &str, default: u64) -> Result<u64, (i64, String)> {
    match params.get(key) {
        None | Some(Value::Null) => Ok(default),
        Some(value) => value
            .as_u64()
            .filter(|number| *number <= i64::MAX as u64)
            .ok_or((rpc::INVALID_PARAMS, format!("{key} must be a whole number."))),
    }
}

/// The file path inside the root, with `/` between parts. Absolute paths and `..`
/// are refused, so a query never reads outside the repository.
fn relative_path(params: &Value) -> Result<String, (i64, String)> {
    let refused = || (rpc::INVALID_PARAMS, "path must be a file path relative to root, without `..`.".to_owned());
    let path = Path::new(params.get("path").and_then(Value::as_str).ok_or_else(refused)?);
    let mut parts = Vec::new();
    for component in path.components() {
        match component {
            Component::Normal(part) => parts.push(part.to_string_lossy().into_owned()),
            Component::CurDir => {}
            _ => return Err(refused()),
        }
    }
    if parts.is_empty() { Err(refused()) } else { Ok(parts.join("/")) }
}

fn root_of(params: &Value) -> Result<PathBuf, (i64, String)> {
    params
        .get("root")
        .and_then(Value::as_str)
        .map(PathBuf::from)
        .filter(|root| root.is_absolute())
        .ok_or((rpc::INVALID_PARAMS, "root must be an absolute path.".to_owned()))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn absolute_root() -> String {
        std::env::temp_dir().join("kodax-repo-intel-test").to_string_lossy().into_owned()
    }

    fn request(id: i64, method: &str, params: Value) -> Value {
        json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params })
    }

    fn error_code(outcome: Outcome) -> i64 {
        match outcome {
            Outcome::Reply(reply) => reply["error"]["code"].as_i64().expect("an error reply"),
            other => panic!("expected a reply, got {other:?}"),
        }
    }

    fn started() -> Server {
        let mut server = Server::new(Background::Active);
        server.handle(request(1, "initialize", json!({ "storageRoot": absolute_root() })));
        server
    }

    #[test]
    fn answers_nothing_but_initialize_until_initialized() {
        let mut server = Server::new(Background::Active);
        assert_eq!(error_code(server.handle(request(1, "workspace.status", json!({})))), rpc::SERVER_NOT_INITIALIZED);
    }

    #[test]
    fn reports_its_version_budget_and_background_mode() {
        let mut server = Server::new(Background::Unavailable("no".to_owned()));
        let Outcome::Reply(reply) = server.handle(request(1, "initialize", json!({ "storageRoot": absolute_root() }))) else {
            panic!("initialize must answer");
        };
        assert_eq!(reply["result"]["memoryBudgetMb"], 300);
        assert_eq!(reply["result"]["background"], json!({ "active": false, "reason": "no" }));
        assert_eq!(reply["result"]["version"], env!("CARGO_PKG_VERSION"));
        assert_eq!(reply["result"]["protocol"], PROTOCOL);
        assert_eq!(reply["result"]["languages"].as_array().unwrap().len(), 8);
    }

    #[test]
    fn refuses_a_relative_storage_root_or_a_zero_budget() {
        let mut server = Server::new(Background::Active);
        assert_eq!(error_code(server.handle(request(1, "initialize", json!({ "storageRoot": "rel" })))), rpc::INVALID_PARAMS);
        let params = json!({ "storageRoot": absolute_root(), "memoryBudgetMb": 0 });
        assert_eq!(error_code(server.handle(request(2, "initialize", params))), rpc::INVALID_PARAMS);
    }

    #[test]
    fn names_unknown_methods_and_messages_without_one() {
        let mut server = started();
        assert_eq!(error_code(server.handle(request(2, "no.such", json!({})))), rpc::METHOD_NOT_FOUND);
        assert_eq!(error_code(server.handle(json!({ "jsonrpc": "2.0", "id": 3 }))), rpc::INVALID_REQUEST);
    }

    #[test]
    fn leaves_notifications_unanswered() {
        let mut server = started();
        assert_eq!(server.handle(json!({ "jsonrpc": "2.0", "method": "files.changed" })), Outcome::Silent);
    }

    #[test]
    fn reports_its_own_memory_against_the_budget() {
        let mut server = started();
        let Outcome::Reply(reply) = server.handle(request(2, "engine.status", Value::Null)) else {
            panic!("engine.status must answer");
        };
        assert!(reply["result"]["residentBytes"].as_u64().is_some_and(|bytes| bytes > 0), "{reply}");
        assert_eq!((reply["result"]["memoryBudgetMb"].as_u64(), reply["result"]["workspaces"].as_u64()), (Some(300), Some(0)));
    }

    #[test]
    fn refuses_bad_query_parameters() {
        let mut server = started();
        let root = absolute_root();
        let find = |name: Value, limit: Value| json!({ "root": root, "name": name, "limit": limit });
        assert_eq!(error_code(server.handle(request(2, "symbols.definitions", find(json!(""), Value::Null)))), rpc::INVALID_PARAMS);
        assert_eq!(error_code(server.handle(request(3, "symbols.references", find(json!("x"), json!(0))))), rpc::INVALID_PARAMS);
        assert_eq!(error_code(server.handle(request(4, "symbols.references", find(json!("x"), json!(501))))), rpc::INVALID_PARAMS);
        let to = |path: Value| json!({ "root": absolute_root(), "path": path, "name": "x" });
        assert_eq!(error_code(server.handle(request(6, "symbols.referencesTo", to(json!("../a.ts"))))), rpc::INVALID_PARAMS);
        assert_eq!(error_code(server.handle(request(7, "symbols.referencesTo", to(Value::Null)))), rpc::INVALID_PARAMS);
        for path in ["../a.ts", "", "a/../../b.ts"] {
            let params = json!({ "root": root, "path": path });
            assert_eq!(error_code(server.handle(request(5, "file.outline", params))), rpc::INVALID_PARAMS, "{path}");
        }
        assert_eq!(relative_path(&json!({ "path": "./src/a.ts" })), Ok("src/a.ts".to_owned()));
        let absolute = std::env::temp_dir().join("a.ts");
        assert!(relative_path(&json!({ "path": absolute })).is_err());
    }

    #[test]
    fn exits_cleanly_only_after_shutdown() {
        let mut server = started();
        assert_eq!(server.handle(json!({ "jsonrpc": "2.0", "method": "exit" })), Outcome::Exit(1));
        let mut server = started();
        server.handle(request(2, "shutdown", Value::Null));
        assert_eq!(error_code(server.handle(request(3, "workspace.status", json!({})))), rpc::INVALID_REQUEST);
        assert_eq!(server.handle(json!({ "jsonrpc": "2.0", "method": "exit" })), Outcome::Exit(0));
    }
}
