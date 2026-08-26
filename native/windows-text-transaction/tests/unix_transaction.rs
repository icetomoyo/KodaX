#![cfg(unix)]

use std::fs::{self, OpenOptions};
use std::os::fd::AsRawFd;
use std::os::unix::fs::{MetadataExt, OpenOptionsExt, PermissionsExt};
use std::process::Command;
use std::thread;
use std::time::{Duration, Instant};

use kodax_windows_text_transaction::{CommitOutcome, TrustedRoot};
use sha2::{Digest, Sha256};
use tempfile::tempdir;

fn private_tempdir() -> tempfile::TempDir {
    tempfile::Builder::new()
        .permissions(fs::Permissions::from_mode(0o700))
        .tempdir()
        .unwrap()
}

fn text(path: &std::path::Path) -> String {
    path.to_string_lossy().into_owned()
}

#[test]
#[ignore]
fn cross_process_commit_worker() {
    if std::env::var_os("KODAX_UNIX_TX_WORKER").is_none() {
        return;
    }
    let root = TrustedRoot::open(
        &std::env::var("KODAX_UNIX_TX_ROOT").unwrap(),
        &std::env::var("KODAX_UNIX_TX_STATE").unwrap(),
    )
    .unwrap();
    if let (Some(ready), Some(go)) = (
        std::env::var_os("KODAX_UNIX_TX_READY"),
        std::env::var_os("KODAX_UNIX_TX_GO"),
    ) {
        fs::write(ready, "ready").unwrap();
        let go = std::path::PathBuf::from(go);
        while !go.exists() {
            thread::sleep(Duration::from_millis(5));
        }
        if let Some(entered) = std::env::var_os("KODAX_UNIX_TX_ENTERED") {
            fs::write(entered, "entered").unwrap();
        }
    }
    let outcome = root
        .commit(
            &std::env::var("KODAX_UNIX_TX_TARGET").unwrap(),
            &std::env::var("KODAX_UNIX_TX_REVISION").unwrap(),
            &std::env::var("KODAX_UNIX_TX_CONTENT").unwrap(),
            std::env::var_os("KODAX_UNIX_TX_CREATE_PARENTS").is_some(),
            10_000,
        )
        .unwrap();
    let status = match outcome {
        CommitOutcome::Written(_) => "written",
        CommitOutcome::Stale { .. } => "stale",
        CommitOutcome::CommittedUncertain { .. } => "committed_uncertain",
    };
    fs::write(std::env::var("KODAX_UNIX_TX_RESULT").unwrap(), status).unwrap();
}

#[test]
#[ignore]
fn cross_process_lock_owner_worker() {
    if std::env::var_os("KODAX_UNIX_LOCK_WORKER").is_none() {
        return;
    }
    let lock = OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .mode(0o600)
        .open(std::env::var("KODAX_UNIX_LOCK_PATH").unwrap())
        .unwrap();
    assert_eq!(unsafe { libc::flock(lock.as_raw_fd(), libc::LOCK_EX) }, 0);
    fs::write(std::env::var("KODAX_UNIX_LOCK_READY").unwrap(), "ready").unwrap();
    thread::sleep(Duration::from_secs(60));
}

fn wait_for_file(path: &std::path::Path) {
    let deadline = Instant::now() + Duration::from_secs(5);
    while !path.exists() {
        assert!(Instant::now() < deadline, "worker readiness timed out");
        thread::sleep(Duration::from_millis(10));
    }
}

fn spawn_lock_owner(
    state: &std::path::Path,
    slot_id: &str,
) -> (std::process::Child, std::path::PathBuf) {
    let ready = state.join(format!("ready-{slot_id}"));
    let lock_path = state.join("locks-v1").join(format!("{slot_id}.lock"));
    let child = Command::new(std::env::current_exe().unwrap())
        .args([
            "cross_process_lock_owner_worker",
            "--ignored",
            "--exact",
            "--nocapture",
        ])
        .env("KODAX_UNIX_LOCK_WORKER", "1")
        .env("KODAX_UNIX_LOCK_PATH", lock_path)
        .env("KODAX_UNIX_LOCK_READY", &ready)
        .spawn()
        .unwrap();
    wait_for_file(&ready);
    (child, ready)
}

fn coordination_slot(target: &std::path::Path) -> String {
    let metadata = fs::metadata(target.parent().unwrap()).unwrap();
    let mut hash = Sha256::new();
    hash.update(b"kodax-text-coordination-slot-v1\0");
    hash.update(metadata.dev().to_le_bytes());
    hash.update(metadata.ino().to_le_bytes());
    hash.update(target.file_name().unwrap().as_encoded_bytes());
    format!("{:x}", hash.finalize())
}

#[test]
fn two_processes_commit_one_revision_once() {
    let workspace = tempdir().unwrap();
    let state = private_tempdir();
    let target = workspace.path().join("same.md");
    fs::write(&target, "before").unwrap();
    let root = TrustedRoot::open(&text(workspace.path()), &text(state.path())).unwrap();
    let revision = root.snapshot(&text(&target)).unwrap().revision;
    let (mut owner, ready) = spawn_lock_owner(state.path(), &coordination_slot(&target));
    let executable = std::env::current_exe().unwrap();
    let mut children = Vec::new();
    let mut results = Vec::new();
    let mut readiness = Vec::new();
    let mut entered = Vec::new();
    let go = state.path().join("commit-go");
    for index in 0..2 {
        let result = state.path().join(format!("result-{index}"));
        let ready = state.path().join(format!("commit-ready-{index}"));
        let entering = state.path().join(format!("commit-entered-{index}"));
        results.push(result.clone());
        readiness.push(ready.clone());
        entered.push(entering.clone());
        children.push(
            Command::new(&executable)
                .args([
                    "cross_process_commit_worker",
                    "--ignored",
                    "--exact",
                    "--nocapture",
                ])
                .env("KODAX_UNIX_TX_WORKER", "1")
                .env("KODAX_UNIX_TX_ROOT", workspace.path())
                .env("KODAX_UNIX_TX_STATE", state.path())
                .env("KODAX_UNIX_TX_TARGET", &target)
                .env("KODAX_UNIX_TX_REVISION", &revision)
                .env("KODAX_UNIX_TX_CONTENT", format!("after-{index}"))
                .env("KODAX_UNIX_TX_RESULT", result)
                .env("KODAX_UNIX_TX_READY", ready)
                .env("KODAX_UNIX_TX_GO", &go)
                .env("KODAX_UNIX_TX_ENTERED", entering)
                .spawn()
                .unwrap(),
        );
    }
    for ready in &readiness {
        wait_for_file(ready);
    }
    fs::write(&go, "go").unwrap();
    for entering in &entered {
        wait_for_file(entering);
    }
    thread::sleep(Duration::from_millis(200));
    assert!(results.iter().all(|result| !result.exists()));
    assert!(
        children
            .iter_mut()
            .all(|child| child.try_wait().unwrap().is_none())
    );
    owner.kill().unwrap();
    owner.wait().unwrap();
    fs::remove_file(ready).unwrap();
    for mut child in children {
        assert!(child.wait().unwrap().success());
    }
    let mut statuses = results
        .iter()
        .map(|result| fs::read_to_string(result).unwrap())
        .collect::<Vec<_>>();
    statuses.sort();
    assert_eq!(statuses, ["stale", "written"]);
    assert!(matches!(
        fs::read_to_string(target).unwrap().as_str(),
        "after-0" | "after-1"
    ));
}

#[test]
fn two_processes_create_one_missing_revision_once() {
    let workspace = tempdir().unwrap();
    let state = private_tempdir();
    let target = workspace.path().join("missing").join("same.md");
    let root = TrustedRoot::open(&text(workspace.path()), &text(state.path())).unwrap();
    let revision = root.snapshot(&text(&target)).unwrap().revision;
    let executable = std::env::current_exe().unwrap();
    let mut children = Vec::new();
    let mut results = Vec::new();
    let mut readiness = Vec::new();
    let go = state.path().join("missing-commit-go");
    for index in 0..2 {
        let result = state.path().join(format!("missing-result-{index}"));
        let ready = state.path().join(format!("missing-ready-{index}"));
        results.push(result.clone());
        readiness.push(ready.clone());
        children.push(
            Command::new(&executable)
                .args([
                    "cross_process_commit_worker",
                    "--ignored",
                    "--exact",
                    "--nocapture",
                ])
                .env("KODAX_UNIX_TX_WORKER", "1")
                .env("KODAX_UNIX_TX_ROOT", workspace.path())
                .env("KODAX_UNIX_TX_STATE", state.path())
                .env("KODAX_UNIX_TX_TARGET", &target)
                .env("KODAX_UNIX_TX_REVISION", &revision)
                .env("KODAX_UNIX_TX_CONTENT", format!("created-{index}"))
                .env("KODAX_UNIX_TX_RESULT", result)
                .env("KODAX_UNIX_TX_CREATE_PARENTS", "1")
                .env("KODAX_UNIX_TX_READY", ready)
                .env("KODAX_UNIX_TX_GO", &go)
                .spawn()
                .unwrap(),
        );
    }
    for ready in &readiness {
        wait_for_file(ready);
    }
    fs::write(go, "go").unwrap();
    for mut child in children {
        assert!(child.wait().unwrap().success());
    }
    let mut statuses = results
        .iter()
        .map(|result| fs::read_to_string(result).unwrap())
        .collect::<Vec<_>>();
    statuses.sort();
    assert_eq!(statuses, ["stale", "written"]);
}

#[test]
fn different_slots_do_not_wait_and_dead_owner_releases_the_lock() {
    let workspace = tempdir().unwrap();
    let state = private_tempdir();
    let first = workspace.path().join("first.md");
    let second = workspace.path().join("second.md");
    let root = TrustedRoot::open(&text(workspace.path()), &text(state.path())).unwrap();
    let first_snapshot = root.snapshot(&text(&first)).unwrap();
    let second_snapshot = root.snapshot(&text(&second)).unwrap();
    let (mut owner, ready) = spawn_lock_owner(state.path(), &coordination_slot(&first));

    let first_result = state.path().join("first-result");
    let first_ready = state.path().join("first-ready");
    let first_go = state.path().join("first-go");
    let first_entered = state.path().join("first-entered");
    let mut first_worker = Command::new(std::env::current_exe().unwrap())
        .args([
            "cross_process_commit_worker",
            "--ignored",
            "--exact",
            "--nocapture",
        ])
        .env("KODAX_UNIX_TX_WORKER", "1")
        .env("KODAX_UNIX_TX_ROOT", workspace.path())
        .env("KODAX_UNIX_TX_STATE", state.path())
        .env("KODAX_UNIX_TX_TARGET", &first)
        .env("KODAX_UNIX_TX_REVISION", &first_snapshot.revision)
        .env("KODAX_UNIX_TX_CONTENT", "first")
        .env("KODAX_UNIX_TX_RESULT", &first_result)
        .env("KODAX_UNIX_TX_READY", &first_ready)
        .env("KODAX_UNIX_TX_GO", &first_go)
        .env("KODAX_UNIX_TX_ENTERED", &first_entered)
        .spawn()
        .unwrap();
    wait_for_file(&first_ready);
    fs::write(&first_go, "go").unwrap();
    wait_for_file(&first_entered);
    thread::sleep(Duration::from_millis(200));
    assert!(!first_result.exists());
    assert!(first_worker.try_wait().unwrap().is_none());

    assert!(matches!(
        root.commit(
            &text(&second),
            &second_snapshot.revision,
            "second",
            false,
            100
        )
        .unwrap(),
        CommitOutcome::Written(_)
    ));
    owner.kill().unwrap();
    owner.wait().unwrap();
    fs::remove_file(ready).unwrap();
    assert!(first_worker.wait().unwrap().success());
    assert_eq!(fs::read_to_string(first_result).unwrap(), "written");
}
