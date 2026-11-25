//! Drives the built engine over stdio, as the Host does.

use serde_json::{Value, json};
use std::io::{BufRead, BufReader, Read, Write};
use std::process::{Child, ChildStdin, ChildStdout, Command, Stdio};

struct Engine {
    child: Child,
    input: ChildStdin,
    output: BufReader<ChildStdout>,
}

impl Engine {
    fn start() -> Self {
        let mut child = Command::new(env!("CARGO_BIN_EXE_kodax-repo-intel"))
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .spawn()
            .expect("the engine starts");
        let input = child.stdin.take().unwrap();
        let output = BufReader::new(child.stdout.take().unwrap());
        Self { child, input, output }
    }

    fn send(&mut self, message: &Value) {
        let body = serde_json::to_vec(message).unwrap();
        write!(self.input, "Content-Length: {}\r\n\r\n", body.len()).unwrap();
        self.input.write_all(&body).unwrap();
        self.input.flush().unwrap();
    }

    fn receive(&mut self) -> Value {
        let mut length = 0;
        loop {
            let mut line = String::new();
            self.output.read_line(&mut line).unwrap();
            let line = line.trim_end();
            if line.is_empty() {
                break;
            }
            if let Some(value) = line.strip_prefix("Content-Length:") {
                length = value.trim().parse().unwrap();
            }
        }
        let mut body = vec![0; length];
        self.output.read_exact(&mut body).unwrap();
        serde_json::from_slice(&body).unwrap()
    }

    fn call(&mut self, id: i64, method: &str, params: Value) -> Value {
        self.send(&json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params }));
        self.receive()
    }
}

#[test]
fn starts_answers_and_exits_cleanly_after_shutdown() {
    let mut engine = Engine::start();
    let root = std::env::temp_dir().join("kodax-repo-intel-protocol");
    let ready = engine.call(1, "initialize", json!({ "storageRoot": root }));
    assert_eq!(ready["result"]["background"]["active"], true);
    assert_eq!(engine.call(2, "shutdown", Value::Null)["result"], Value::Null);
    engine.send(&json!({ "jsonrpc": "2.0", "method": "exit" }));
    assert_eq!(engine.child.wait().unwrap().code(), Some(0));
}

#[test]
fn keeps_serving_after_a_message_that_is_not_json() {
    let mut engine = Engine::start();
    write!(engine.input, "Content-Length: 3\r\n\r\n{{x}}").unwrap();
    engine.input.flush().unwrap();
    assert_eq!(engine.receive()["error"]["code"], -32700);
    let root = std::env::temp_dir().join("kodax-repo-intel-protocol");
    assert!(engine.call(1, "initialize", json!({ "storageRoot": root }))["result"].is_object());
}

#[test]
fn stops_when_the_host_closes_its_input() {
    let mut engine = Engine::start();
    drop(engine.input);
    assert_eq!(engine.child.wait().unwrap().code(), Some(1));
}

#[test]
fn opens_a_repository_and_reports_when_it_is_indexed() {
    let repo = tempfile::Builder::new().prefix("kodax-repo-intel-e2e-").tempdir().unwrap();
    assert!(Command::new("git").arg("-C").arg(repo.path()).args(["init", "-q"]).status().unwrap().success());
    std::fs::write(repo.path().join("a.ts"), "export function run() {}\nrun();\n").unwrap();
    let storage = tempfile::tempdir().unwrap();
    let mut engine = Engine::start();
    engine.call(1, "initialize", json!({ "storageRoot": storage.path() }));
    let root = json!({ "root": repo.path() });
    assert!(engine.call(2, "workspace.open", root.clone())["result"]["state"].is_string());
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(20);
    let mut id = 3;
    let status = loop {
        let status = engine.call(id, "workspace.status", root.clone())["result"].clone();
        if status["state"] != "indexing" || std::time::Instant::now() > deadline {
            break status;
        }
        id += 1;
        std::thread::sleep(std::time::Duration::from_millis(50));
    };
    assert_eq!((status["state"].as_str(), status["indexed"].as_u64()), (Some("ready"), Some(1)), "{status}");
    let find = |name: &str| json!({ "root": repo.path(), "name": name });
    let found = engine.call(id + 10, "symbols.definitions", find("run"))["result"].clone();
    assert_eq!((found["total"].as_u64(), found["hits"][0]["line"].as_u64()), (Some(1), Some(1)), "{found}");
    assert_eq!((found["precision"].as_str(), found["coverage"]["state"].as_str()), (Some("syntactic"), Some("ready")));
    let used = engine.call(id + 11, "symbols.references", find("run"))["result"].clone();
    assert_eq!((used["precision"].as_str(), used["hits"][0]["line"].as_u64()), (Some("heuristic"), Some(2)), "{used}");
    assert_eq!(engine.call(id + 12, "symbols.definitions", find("none"))["result"]["total"], 0);
    let outline = engine.call(id + 13, "file.outline", json!({ "root": repo.path(), "path": "a.ts" }))["result"].clone();
    assert_eq!((outline["source"].as_str(), outline["definitions"][0]["name"].as_str()), (Some("index"), Some("run")), "{outline}");
    assert_eq!(engine.call(id + 1, "workspace.close", root.clone())["result"], Value::Null);
    assert_eq!(engine.call(id + 2, "workspace.status", root)["error"]["code"], -32602);
    assert_eq!(engine.call(id + 3, "shutdown", Value::Null)["result"], Value::Null);
}
