#![cfg(windows)]
#![allow(clippy::permissions_set_readonly_false)]

use std::fs;
use std::os::windows::fs::symlink_dir;

use kodax_windows_text_transaction::{
    CommitOutcome, ResourceState, TextTransactionErrorCode, TrustedRoot,
};
use tempfile::tempdir;

fn as_text(path: &std::path::Path) -> String {
    path.to_string_lossy().into_owned()
}

fn dacl_descriptor(path: &std::path::Path) -> Vec<u8> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Security::{DACL_SECURITY_INFORMATION, GetFileSecurityW};

    let wide = path
        .as_os_str()
        .encode_wide()
        .chain(Some(0))
        .collect::<Vec<_>>();
    let mut required = 0;
    unsafe {
        GetFileSecurityW(
            wide.as_ptr(),
            DACL_SECURITY_INFORMATION,
            std::ptr::null_mut(),
            0,
            &mut required,
        )
    };
    assert!(required > 0);
    let mut descriptor = vec![0u8; required as usize];
    assert_ne!(
        unsafe {
            GetFileSecurityW(
                wide.as_ptr(),
                DACL_SECURITY_INFORMATION,
                descriptor.as_mut_ptr().cast(),
                descriptor.len() as u32,
                &mut required,
            )
        },
        0
    );
    descriptor
}

struct BlockingOplock {
    file: windows_sys::Win32::Foundation::HANDLE,
    event: windows_sys::Win32::Foundation::HANDLE,
    _overlapped: Box<windows_sys::Win32::System::IO::OVERLAPPED>,
    _output: Box<windows_sys::Win32::System::Ioctl::REQUEST_OPLOCK_OUTPUT_BUFFER>,
}

impl BlockingOplock {
    fn request(path: &std::path::Path) -> Self {
        use std::mem::size_of;
        use std::os::windows::ffi::OsStrExt;
        use windows_sys::Win32::Foundation::{
            ERROR_IO_PENDING, GetLastError, INVALID_HANDLE_VALUE,
        };
        use windows_sys::Win32::Storage::FileSystem::{
            CreateFileW, FILE_FLAG_OVERLAPPED, FILE_READ_ATTRIBUTES, FILE_READ_DATA,
            FILE_SHARE_DELETE, FILE_SHARE_READ, FILE_SHARE_WRITE, OPEN_EXISTING,
        };
        use windows_sys::Win32::System::IO::{DeviceIoControl, OVERLAPPED};
        use windows_sys::Win32::System::Ioctl::{
            FSCTL_REQUEST_OPLOCK, OPLOCK_LEVEL_CACHE_HANDLE, OPLOCK_LEVEL_CACHE_READ,
            OPLOCK_LEVEL_CACHE_WRITE, REQUEST_OPLOCK_CURRENT_VERSION, REQUEST_OPLOCK_INPUT_BUFFER,
            REQUEST_OPLOCK_INPUT_FLAG_REQUEST, REQUEST_OPLOCK_OUTPUT_BUFFER,
        };
        use windows_sys::Win32::System::Threading::CreateEventW;

        let wide = path
            .as_os_str()
            .encode_wide()
            .chain(Some(0))
            .collect::<Vec<_>>();
        let file = unsafe {
            CreateFileW(
                wide.as_ptr(),
                FILE_READ_DATA | FILE_READ_ATTRIBUTES,
                FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
                std::ptr::null(),
                OPEN_EXISTING,
                FILE_FLAG_OVERLAPPED,
                std::ptr::null_mut(),
            )
        };
        assert_ne!(file, INVALID_HANDLE_VALUE);
        let event = unsafe { CreateEventW(std::ptr::null(), 1, 0, std::ptr::null()) };
        assert!(!event.is_null());
        let input = REQUEST_OPLOCK_INPUT_BUFFER {
            StructureVersion: REQUEST_OPLOCK_CURRENT_VERSION as u16,
            StructureLength: size_of::<REQUEST_OPLOCK_INPUT_BUFFER>() as u16,
            RequestedOplockLevel: OPLOCK_LEVEL_CACHE_READ
                | OPLOCK_LEVEL_CACHE_WRITE
                | OPLOCK_LEVEL_CACHE_HANDLE,
            Flags: REQUEST_OPLOCK_INPUT_FLAG_REQUEST,
        };
        let mut output = Box::new(REQUEST_OPLOCK_OUTPUT_BUFFER {
            StructureVersion: REQUEST_OPLOCK_CURRENT_VERSION as u16,
            StructureLength: size_of::<REQUEST_OPLOCK_OUTPUT_BUFFER>() as u16,
            ..Default::default()
        });
        let mut overlapped = Box::<OVERLAPPED>::default();
        overlapped.hEvent = event;
        let granted = unsafe {
            DeviceIoControl(
                file,
                FSCTL_REQUEST_OPLOCK,
                (&input as *const REQUEST_OPLOCK_INPUT_BUFFER).cast(),
                size_of::<REQUEST_OPLOCK_INPUT_BUFFER>() as u32,
                (&mut *output as *mut REQUEST_OPLOCK_OUTPUT_BUFFER).cast(),
                size_of::<REQUEST_OPLOCK_OUTPUT_BUFFER>() as u32,
                std::ptr::null_mut(),
                &mut *overlapped,
            )
        };
        assert_eq!(granted, 0);
        assert_eq!(unsafe { GetLastError() }, ERROR_IO_PENDING);
        Self {
            file,
            event,
            _overlapped: overlapped,
            _output: output,
        }
    }
}

impl Drop for BlockingOplock {
    fn drop(&mut self) {
        use windows_sys::Win32::Foundation::CloseHandle;

        unsafe {
            CloseHandle(self.file);
            CloseHandle(self.event);
        }
    }
}

#[test]
fn missing_snapshot_can_be_committed_once_and_then_reads_complete_content() {
    let directory = tempdir().unwrap();
    let root = TrustedRoot::open(&as_text(directory.path())).unwrap();
    let target = as_text(&directory.path().join("hello.md"));

    let missing = root.snapshot(&target).unwrap();
    assert_eq!(missing.state, ResourceState::Missing);
    assert!(missing.revision.starts_with("missing:"));
    assert_eq!(missing.slot_id.len(), 64);

    let first = root
        .commit(&target, &missing.revision, "hello\n", false, 5_000)
        .unwrap();
    let receipt = match first {
        CommitOutcome::Written(receipt) => receipt,
        CommitOutcome::Stale { .. } => panic!("first commit unexpectedly became stale"),
        CommitOutcome::CommittedUncertain { .. } => {
            panic!("first commit durability unexpectedly became uncertain")
        }
    };
    assert_eq!(receipt.pre_state, ResourceState::Missing);
    assert_ne!(receipt.post_revision, missing.revision);
    assert_eq!(fs::read_to_string(&target).unwrap(), "hello\n");

    let present = root.snapshot(&target).unwrap();
    assert_eq!(present.state, ResourceState::Present);
    assert_eq!(present.content, "hello\n");
    assert_eq!(present.revision, receipt.post_revision);

    assert!(matches!(
        root.commit(&target, &missing.revision, "lost\n", false, 5_000)
            .unwrap(),
        CommitOutcome::Stale { .. }
    ));
    assert_eq!(fs::read_to_string(&target).unwrap(), "hello\n");
}

#[test]
fn creates_missing_parents_only_when_explicitly_requested() {
    let directory = tempdir().unwrap();
    let root = TrustedRoot::open(&as_text(directory.path())).unwrap();
    let target = as_text(&directory.path().join("nested").join("hello.md"));
    let snapshot = root.snapshot(&target).unwrap();

    let error = root
        .commit(&target, &snapshot.revision, "hello", false, 5_000)
        .unwrap_err();
    assert_eq!(error.code, TextTransactionErrorCode::Io);

    assert!(matches!(
        root.commit(&target, &snapshot.revision, "hello", true, 5_000)
            .unwrap(),
        CommitOutcome::Written(_)
    ));
    assert_eq!(fs::read_to_string(&target).unwrap(), "hello");
}

#[test]
fn rejects_multi_link_targets() {
    let directory = tempdir().unwrap();
    let original = directory.path().join("original.txt");
    let alias = directory.path().join("alias.txt");
    fs::write(&original, "secret").unwrap();
    fs::hard_link(&original, &alias).unwrap();
    let root = TrustedRoot::open(&as_text(directory.path())).unwrap();

    let error = root.snapshot(&as_text(&alias)).unwrap_err();
    assert_eq!(error.code, TextTransactionErrorCode::HardLink);
}

#[test]
fn rejects_replacement_when_an_alternate_data_stream_would_be_lost() {
    let directory = tempdir().unwrap();
    let target_path = directory.path().join("streamed.txt");
    fs::write(&target_path, "before").unwrap();
    let root = TrustedRoot::open(&as_text(directory.path())).unwrap();
    let snapshot = root.snapshot(&as_text(&target_path)).unwrap();
    let stream_path = format!("{}:kodax-test", as_text(&target_path));
    fs::write(&stream_path, "stream-secret").unwrap();

    let error = root
        .commit(
            &as_text(&target_path),
            &snapshot.revision,
            "after",
            false,
            5_000,
        )
        .unwrap_err();
    assert_eq!(error.code, TextTransactionErrorCode::MetadataPreservation);
    assert_eq!(fs::read_to_string(&target_path).unwrap(), "before");
    assert_eq!(fs::read_to_string(stream_path).unwrap(), "stream-secret");
}

#[test]
fn rejects_a_reparse_component_instead_of_following_it() {
    let directory = tempdir().unwrap();
    let outside = tempdir().unwrap();
    let linked = directory.path().join("linked");
    if symlink_dir(outside.path(), &linked).is_err() {
        // Windows hosts without Developer Mode cannot create this fixture.
        return;
    }
    let root = TrustedRoot::open(&as_text(directory.path())).unwrap();
    let target = linked.join("escape.txt");

    let error = root.snapshot(&as_text(&target)).unwrap_err();
    assert_eq!(error.code, TextTransactionErrorCode::ReparsePoint);
    assert!(!outside.path().join("escape.txt").exists());
}

#[test]
fn moving_the_trusted_root_invalidates_the_transaction() {
    let directory = tempdir().unwrap();
    let root_path = directory.path().join("authorized");
    let moved_path = directory.path().join("moved-outside");
    fs::create_dir(&root_path).unwrap();
    let root = TrustedRoot::open(&as_text(&root_path)).unwrap();
    let target = as_text(&root_path.join("hello.txt"));
    let snapshot = root.snapshot(&target).unwrap();
    fs::rename(&root_path, &moved_path).unwrap();

    let error = root
        .commit(&target, &snapshot.revision, "must-not-escape", false, 5_000)
        .unwrap_err();
    assert_eq!(error.code, TextTransactionErrorCode::UnauthorizedPath);
    assert!(!moved_path.join("hello.txt").exists());
}

#[test]
fn two_root_instances_cannot_commit_the_same_revision_twice() {
    let directory = tempdir().unwrap();
    let target = as_text(&directory.path().join("race.txt"));
    let first_root = TrustedRoot::open(&as_text(directory.path())).unwrap();
    let second_root = TrustedRoot::open(&as_text(directory.path())).unwrap();
    let revision = first_root.snapshot(&target).unwrap().revision;
    let barrier = std::sync::Arc::new(std::sync::Barrier::new(3));
    let run =
        |root: TrustedRoot, text: &'static str, barrier: std::sync::Arc<std::sync::Barrier>| {
            let target = target.clone();
            let revision = revision.clone();
            std::thread::spawn(move || {
                barrier.wait();
                root.commit(&target, &revision, text, false, 5_000).unwrap()
            })
        };
    let left = run(first_root, "left", barrier.clone());
    let right = run(second_root, "right", barrier.clone());
    barrier.wait();
    let outcomes = [left.join().unwrap(), right.join().unwrap()];
    assert_eq!(
        outcomes
            .iter()
            .filter(|outcome| matches!(outcome, CommitOutcome::Written(_)))
            .count(),
        1
    );
    assert_eq!(
        outcomes
            .iter()
            .filter(|outcome| matches!(outcome, CommitOutcome::Stale { .. }))
            .count(),
        1
    );
}

#[test]
fn incompatible_external_write_handle_returns_structured_contention() {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Foundation::INVALID_HANDLE_VALUE;
    use windows_sys::Win32::Storage::FileSystem::{
        CreateFileW, FILE_SHARE_DELETE, FILE_SHARE_READ, FILE_SHARE_WRITE, FILE_WRITE_DATA,
        OPEN_EXISTING,
    };

    let directory = tempdir().unwrap();
    let target_path = directory.path().join("externally-held.txt");
    fs::write(&target_path, "before").unwrap();
    let root = TrustedRoot::open(&as_text(directory.path())).unwrap();
    let snapshot = root.snapshot(&as_text(&target_path)).unwrap();
    let wide = target_path
        .as_os_str()
        .encode_wide()
        .chain(Some(0))
        .collect::<Vec<_>>();
    let raw = unsafe {
        CreateFileW(
            wide.as_ptr(),
            FILE_WRITE_DATA,
            FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
            std::ptr::null(),
            OPEN_EXISTING,
            0,
            std::ptr::null_mut(),
        )
    };
    assert_ne!(raw, INVALID_HANDLE_VALUE);

    let error = root
        .commit(
            &as_text(&target_path),
            &snapshot.revision,
            "must-not-overwrite",
            false,
            5_000,
        )
        .unwrap_err();
    unsafe { windows_sys::Win32::Foundation::CloseHandle(raw) };

    assert_eq!(error.code, TextTransactionErrorCode::Contended, "{error:?}");
    assert_eq!(fs::read_to_string(target_path).unwrap(), "before");
}

#[test]
fn external_read_handle_without_delete_sharing_contends_at_atomic_replace() {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Foundation::INVALID_HANDLE_VALUE;
    use windows_sys::Win32::Storage::FileSystem::{
        CreateFileW, FILE_READ_DATA, FILE_SHARE_READ, FILE_SHARE_WRITE, OPEN_EXISTING,
    };

    let directory = tempdir().unwrap();
    let target_path = directory.path().join("replace-held.txt");
    fs::write(&target_path, "before").unwrap();
    let root = TrustedRoot::open(&as_text(directory.path())).unwrap();
    let snapshot = root.snapshot(&as_text(&target_path)).unwrap();
    let wide = target_path
        .as_os_str()
        .encode_wide()
        .chain(Some(0))
        .collect::<Vec<_>>();
    let raw = unsafe {
        CreateFileW(
            wide.as_ptr(),
            FILE_READ_DATA,
            FILE_SHARE_READ | FILE_SHARE_WRITE,
            std::ptr::null(),
            OPEN_EXISTING,
            0,
            std::ptr::null_mut(),
        )
    };
    assert_ne!(raw, INVALID_HANDLE_VALUE);

    let error = root
        .commit(
            &as_text(&target_path),
            &snapshot.revision,
            "must-not-overwrite",
            false,
            5_000,
        )
        .unwrap_err();
    unsafe { windows_sys::Win32::Foundation::CloseHandle(raw) };

    assert_eq!(error.code, TextTransactionErrorCode::Contended, "{error:?}");
    assert_eq!(fs::read_to_string(target_path).unwrap(), "before");
}

#[test]
fn overlapping_authorized_roots_share_one_canonical_slot_and_revision() {
    let directory = tempdir().unwrap();
    let nested = directory.path().join("nested");
    fs::create_dir(&nested).unwrap();
    let target = as_text(&nested.join("same.txt"));
    fs::write(&target, "before").unwrap();
    let outer = TrustedRoot::open(&as_text(directory.path())).unwrap();
    let inner = TrustedRoot::open(&as_text(&nested)).unwrap();

    let outer_snapshot = outer.snapshot(&target).unwrap();
    let inner_snapshot = inner.snapshot(&target).unwrap();
    assert_eq!(outer_snapshot.slot_id, inner_snapshot.slot_id);
    assert_eq!(outer_snapshot.revision, inner_snapshot.revision);

    let barrier = std::sync::Arc::new(std::sync::Barrier::new(3));
    let run = |root: TrustedRoot, text: &'static str| {
        let target = target.clone();
        let revision = outer_snapshot.revision.clone();
        let barrier = barrier.clone();
        std::thread::spawn(move || {
            barrier.wait();
            root.commit(&target, &revision, text, false, 5_000).unwrap()
        })
    };
    let left = run(outer, "outer");
    let right = run(inner, "inner");
    barrier.wait();
    let outcomes = [left.join().unwrap(), right.join().unwrap()];
    assert_eq!(
        outcomes
            .iter()
            .filter(|outcome| matches!(outcome, CommitOutcome::Written(_)))
            .count(),
        1
    );
    assert_eq!(
        outcomes
            .iter()
            .filter(|outcome| matches!(outcome, CommitOutcome::Stale { .. }))
            .count(),
        1
    );
}

#[test]
#[ignore]
fn cross_process_commit_worker() {
    let Ok(root_path) = std::env::var("KODAX_TEXT_TX_WORKER_ROOT") else {
        return;
    };
    let target = std::env::var("KODAX_TEXT_TX_WORKER_TARGET").unwrap();
    let revision = std::env::var("KODAX_TEXT_TX_WORKER_REVISION").unwrap();
    let content = std::env::var("KODAX_TEXT_TX_WORKER_CONTENT").unwrap();
    let ready = std::env::var("KODAX_TEXT_TX_WORKER_READY").unwrap();
    let go = std::env::var("KODAX_TEXT_TX_WORKER_GO").unwrap();
    let output = std::env::var("KODAX_TEXT_TX_WORKER_OUTPUT").unwrap();
    let root = TrustedRoot::open(&root_path).unwrap();
    fs::write(ready, "ready").unwrap();
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
    while !std::path::Path::new(&go).exists() && std::time::Instant::now() < deadline {
        std::thread::sleep(std::time::Duration::from_millis(10));
    }
    assert!(
        std::path::Path::new(&go).exists(),
        "worker barrier timed out"
    );
    let outcome = root
        .commit(&target, &revision, &content, false, 5_000)
        .unwrap();
    fs::write(
        output,
        if matches!(outcome, CommitOutcome::Written(_)) {
            "written"
        } else {
            "stale"
        },
    )
    .unwrap();
}

#[test]
fn two_processes_committing_one_revision_produce_one_stale_conflict() {
    let directory = tempdir().unwrap();
    let root_path = as_text(directory.path());
    let target = as_text(&directory.path().join("process-race.txt"));
    let revision = TrustedRoot::open(&root_path)
        .unwrap()
        .snapshot(&target)
        .unwrap()
        .revision;
    let go = directory.path().join("go");
    let spawn_worker = |index: usize| {
        let ready = directory.path().join(format!("ready-{index}"));
        let output = directory.path().join(format!("output-{index}"));
        let child = std::process::Command::new(std::env::current_exe().unwrap())
            .args(["--exact", "cross_process_commit_worker", "--ignored"])
            .env("KODAX_TEXT_TX_WORKER_ROOT", &root_path)
            .env("KODAX_TEXT_TX_WORKER_TARGET", &target)
            .env("KODAX_TEXT_TX_WORKER_REVISION", &revision)
            .env("KODAX_TEXT_TX_WORKER_CONTENT", format!("worker-{index}"))
            .env("KODAX_TEXT_TX_WORKER_READY", &ready)
            .env("KODAX_TEXT_TX_WORKER_GO", &go)
            .env("KODAX_TEXT_TX_WORKER_OUTPUT", &output)
            .spawn()
            .unwrap();
        (child, ready, output)
    };
    let mut workers = [spawn_worker(0), spawn_worker(1)];
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
    while workers.iter().any(|(_, ready, _)| !ready.exists())
        && std::time::Instant::now() < deadline
    {
        std::thread::sleep(std::time::Duration::from_millis(10));
    }
    assert!(workers.iter().all(|(_, ready, _)| ready.exists()));
    fs::write(&go, "go").unwrap();
    for (child, _, _) in &mut workers {
        assert!(child.wait().unwrap().success());
    }
    let outcomes = workers.map(|(_, _, output)| fs::read_to_string(output).unwrap());
    assert_eq!(
        outcomes.iter().filter(|value| *value == "written").count(),
        1
    );
    assert_eq!(outcomes.iter().filter(|value| *value == "stale").count(), 1);
}

#[test]
fn distinct_slots_commit_concurrently_without_cross_file_contention() {
    let directory = tempdir().unwrap();
    let root_path = as_text(directory.path());
    let target_paths = [
        directory.path().join("left.txt"),
        directory.path().join("right.txt"),
    ];
    for target in &target_paths {
        fs::write(target, "before").unwrap();
    }
    let targets = target_paths.each_ref().map(|target| as_text(target));
    let revisions = targets.clone().map(|target| {
        TrustedRoot::open(&root_path)
            .unwrap()
            .snapshot(&target)
            .unwrap()
            .revision
    });
    // An oplock break is observed only after a production commit has acquired
    // its slot mutex and opened the target. Both breaks must therefore arrive
    // before either transaction is released. A single/global mutex would let
    // only one commit reach this in-lock barrier and make this assertion time out.
    let oplocks = target_paths
        .each_ref()
        .map(|target| BlockingOplock::request(target));
    let handles = targets
        .into_iter()
        .zip(revisions)
        .map(|(target, revision)| {
            let root = TrustedRoot::open(&root_path).unwrap();
            std::thread::spawn(move || {
                root.commit(&target, &revision, "written", false, 5_000)
                    .unwrap()
            })
        });
    let handles = handles.collect::<Vec<_>>();
    let events = oplocks.each_ref().map(|oplock| oplock.event);
    assert_eq!(
        unsafe {
            windows_sys::Win32::System::Threading::WaitForMultipleObjects(
                events.len() as u32,
                events.as_ptr(),
                1,
                5_000,
            )
        },
        windows_sys::Win32::Foundation::WAIT_OBJECT_0,
        "both production commits must reach their in-lock target open concurrently"
    );
    drop(oplocks);
    for handle in handles {
        assert!(matches!(handle.join().unwrap(), CommitOutcome::Written(_)));
    }
}

#[test]
fn successful_replace_preserves_readonly_attribute() {
    use std::os::windows::fs::MetadataExt;

    let directory = tempdir().unwrap();
    let target_path = directory.path().join("readonly.txt");
    fs::write(&target_path, "before").unwrap();
    let mut permissions = fs::metadata(&target_path).unwrap().permissions();
    permissions.set_readonly(true);
    fs::set_permissions(&target_path, permissions).unwrap();
    let dacl_before = dacl_descriptor(&target_path);
    let root = TrustedRoot::open(&as_text(directory.path())).unwrap();
    let snapshot = root.snapshot(&as_text(&target_path)).unwrap();
    let result = root.commit(
        &as_text(&target_path),
        &snapshot.revision,
        "after",
        false,
        5_000,
    );
    if let Err(error) = &result {
        let mut cleanup = fs::metadata(&target_path).unwrap().permissions();
        cleanup.set_readonly(false);
        fs::set_permissions(&target_path, cleanup).unwrap();
        panic!("readonly replacement failed: {error:?}");
    }
    assert_ne!(fs::metadata(&target_path).unwrap().file_attributes() & 1, 0);
    assert_eq!(dacl_descriptor(&target_path), dacl_before);
    let mut cleanup = fs::metadata(&target_path).unwrap().permissions();
    cleanup.set_readonly(false);
    fs::set_permissions(&target_path, cleanup).unwrap();
    assert_eq!(fs::read_to_string(target_path).unwrap(), "after");
}

#[test]
fn a_slot_held_by_another_process_does_not_block_a_different_file() {
    let directory = tempdir().unwrap();
    let root = TrustedRoot::open(&as_text(directory.path())).unwrap();
    let held_target = as_text(&directory.path().join("held.txt"));
    let independent_target = as_text(&directory.path().join("independent.txt"));
    fs::write(&held_target, "before").unwrap();
    let held = root.snapshot(&held_target).unwrap();
    let independent = root.snapshot(&independent_target).unwrap();
    let ready = directory.path().join("held-ready");
    let go = directory.path().join("held-go");
    let output = directory.path().join("held-output");
    let oplock = BlockingOplock::request(std::path::Path::new(&held_target));
    let mut child = std::process::Command::new(std::env::current_exe().unwrap())
        .args(["--exact", "cross_process_commit_worker", "--ignored"])
        .env("KODAX_TEXT_TX_WORKER_ROOT", as_text(directory.path()))
        .env("KODAX_TEXT_TX_WORKER_TARGET", &held_target)
        .env("KODAX_TEXT_TX_WORKER_REVISION", &held.revision)
        .env("KODAX_TEXT_TX_WORKER_CONTENT", "held-written")
        .env("KODAX_TEXT_TX_WORKER_READY", &ready)
        .env("KODAX_TEXT_TX_WORKER_GO", &go)
        .env("KODAX_TEXT_TX_WORKER_OUTPUT", &output)
        .spawn()
        .unwrap();
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
    while !ready.exists() && std::time::Instant::now() < deadline {
        std::thread::sleep(std::time::Duration::from_millis(10));
    }
    assert!(ready.exists(), "child did not reach the commit barrier");
    fs::write(&go, "go").unwrap();
    assert_eq!(
        unsafe { windows_sys::Win32::System::Threading::WaitForSingleObject(oplock.event, 5_000) },
        windows_sys::Win32::Foundation::WAIT_OBJECT_0,
        "child never acquired the first file's production slot"
    );

    let outcome = root
        .commit(
            &independent_target,
            &independent.revision,
            "independent",
            false,
            5_000,
        )
        .unwrap();
    assert!(matches!(outcome, CommitOutcome::Written(_)));
    assert_eq!(
        fs::read_to_string(&independent_target).unwrap(),
        "independent"
    );

    drop(oplock);
    assert!(child.wait().unwrap().success());
    assert_eq!(fs::read_to_string(output).unwrap(), "written");
}
