//! Answers the Host's requests. One message in, at most one message out.

use crate::priority::Background;
use crate::rpc::{self, failure, success};
use serde_json::{Value, json};
use std::path::PathBuf;

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
}

impl Server {
    pub fn new(background: Background) -> Self {
        Self { state: State::Starting, background }
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
            return Outcome::Silent;
        };
        Outcome::Reply(match self.answer(method, params) {
            Ok(result) => success(id, result),
            Err((code, text)) => failure(id, code, &text),
        })
    }

    fn answer(&mut self, method: &str, params: Value) -> Result<Value, (i64, String)> {
        match (&self.state, method) {
            (State::Starting, "initialize") => self.initialize(params),
            (State::Starting, _) => Err((rpc::SERVER_NOT_INITIALIZED, "Send initialize first.".to_owned())),
            (State::ShutDown, _) => Err((rpc::INVALID_REQUEST, "The engine is shutting down; send exit.".to_owned())),
            (State::Running(_), "initialize") => Err((rpc::INVALID_REQUEST, "The engine is already initialized.".to_owned())),
            (State::Running(_), "shutdown") => {
                self.state = State::ShutDown;
                Ok(Value::Null)
            }
            (State::Running(_), _) => Err((rpc::METHOD_NOT_FOUND, format!("Unknown method: {method}"))),
        }
    }

    fn initialize(&mut self, params: Value) -> Result<Value, (i64, String)> {
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
            "languages": [],
            "memoryBudgetMb": memory_budget_mb,
            "background": background,
        }))
    }
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
    fn exits_cleanly_only_after_shutdown() {
        let mut server = started();
        assert_eq!(server.handle(json!({ "jsonrpc": "2.0", "method": "exit" })), Outcome::Exit(1));
        let mut server = started();
        server.handle(request(2, "shutdown", Value::Null));
        assert_eq!(error_code(server.handle(request(3, "workspace.status", json!({})))), rpc::INVALID_REQUEST);
        assert_eq!(server.handle(json!({ "jsonrpc": "2.0", "method": "exit" })), Outcome::Exit(0));
    }
}
