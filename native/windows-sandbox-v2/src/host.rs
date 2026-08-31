use std::fs::{File, OpenOptions};
use std::io::{Read, Write};
use std::mem::size_of;
use std::os::windows::fs::{MetadataExt, OpenOptionsExt};
use std::os::windows::io::AsRawHandle;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU8, Ordering};
use std::sync::{Arc, Condvar, Mutex, OnceLock};
use std::thread::JoinHandle;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use anyhow::{Context, Result, anyhow, bail};
use serde::Serialize;
use serde::de::DeserializeOwned;
use sha2::{Digest, Sha256};
use windows::Win32::Foundation::HANDLE;
use windows::Win32::Storage::FileSystem::{
    DELETE, FILE_ATTRIBUTE_REPARSE_POINT, FILE_FLAG_DELETE_ON_CLOSE, FILE_FLAG_OPEN_REPARSE_POINT,
    FILE_GENERIC_READ, FILE_SHARE_READ, FILE_STANDARD_INFO, FileStandardInfo,
    GetFileInformationByHandleEx,
};

use crate::acl::{ensure_policy_aces_until, verify_control_directory_boundary};
use crate::model::{
    BootstrapRequest, ErrorMessage, ExitMessage, HelloMessage, ReadyMessage, RunRequest,
    SpawnMessage, StartedMessage, StartedRecord, TerminalRecord, controller_pipe_server_pid,
};
use crate::protocol::{Frame, FrameKind, PROTOCOL_VERSION, read_frame, write_frame};
use crate::win::{
    KillOnCloseJob, NamedPipeServer, NamedPipeServers, OwnedHandle, PrivateDesktop,
    SpawnedHostChild, connect_controller_pipe, current_token, disconnect_named_pipe,
    named_pipe_available_bytes, named_pipe_client_identity, process_is_descendant_of,
    spawn_asrt_launcher, terminate_process, token_user_sid, verify_protected_runner_process,
};

const MAX_REQUEST_BYTES: u64 = 1024 * 1024;
const MAX_BOOTSTRAP_BYTES: usize = 512 * 1024;
pub const TERMINATION_CONFIRMED_EXIT_CODE: u32 = 254;
const CONTROL_OPEN: u8 = 0;
const CONTROL_TERMINATION_REQUESTED: u8 = 1;
const CONTROL_LOST: u8 = 2;
const LAUNCH_PHASE_TIMEOUT: Duration = Duration::from_secs(30);
const LAUNCH_ABORT_DRAIN_TIMEOUT: Duration = Duration::from_secs(5);

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum ControllerOutcome {
    Stopped,
    Lost,
}

#[derive(Clone)]
struct HostAbort {
    requested: Arc<AtomicBool>,
    completed: Arc<(Mutex<bool>, Condvar)>,
    started: Arc<AtomicBool>,
    runner_abort: Arc<Mutex<Option<RunnerAbort>>>,
    runner_writer: Arc<Mutex<Option<File>>>,
    asrt_process: Arc<OwnedHandle>,
    launch_job: Arc<KillOnCloseJob>,
    terminal_record_path: Arc<PathBuf>,
    terminal_nonce: Arc<String>,
}

struct RunnerAbort {
    control: File,
    events: File,
    process: OwnedHandle,
}

impl HostAbort {
    fn new(
        asrt_process: OwnedHandle,
        launch_job: KillOnCloseJob,
        terminal_record_path: PathBuf,
        terminal_nonce: String,
    ) -> Self {
        Self {
            requested: Arc::new(AtomicBool::new(false)),
            completed: Arc::new((Mutex::new(false), Condvar::new())),
            started: Arc::new(AtomicBool::new(false)),
            runner_abort: Arc::new(Mutex::new(None)),
            runner_writer: Arc::new(Mutex::new(None)),
            asrt_process: Arc::new(asrt_process),
            launch_job: Arc::new(launch_job),
            terminal_record_path: Arc::new(terminal_record_path),
            terminal_nonce: Arc::new(terminal_nonce),
        }
    }

    fn request(&self) {
        if self.requested.swap(true, Ordering::AcqRel) {
            return;
        }
        let _ = self.launch_job.terminate(1);
        if let Ok(mut runner) = self.runner_abort.lock()
            && let Some(runner) = runner.take()
        {
            let _ = terminate_process(&runner.process, 1);
            let _ = disconnect_named_pipe(&runner.control);
            let _ = disconnect_named_pipe(&runner.events);
        }
        let _ = terminate_process(&self.asrt_process, 1);
        if self
            .launch_job
            .terminate_and_drain(1, LAUNCH_ABORT_DRAIN_TIMEOUT)
            .is_ok()
        {
            let _ = write_terminal_record(
                &self.terminal_record_path,
                &TerminalRecord {
                    protocol: PROTOCOL_VERSION,
                    nonce: self.terminal_nonce.as_str().to_owned(),
                    job_drained: true,
                    target_exit_code: 1,
                    termination_requested: true,
                    deny_read_cleanup_deferred: false,
                    deny_read_cleanup_diagnostic: None,
                },
            );
        }
        let (completed, wake) = &*self.completed;
        if let Ok(mut completed) = completed.lock() {
            *completed = true;
            wake.notify_all();
        }
    }

    fn wait_for_completion(&self) {
        if !self.requested.load(Ordering::Acquire) {
            return;
        }
        let (completed, wake) = &*self.completed;
        let Ok(mut completed) = completed.lock() else {
            return;
        };
        while !*completed {
            let Ok(next) = wake.wait(completed) else {
                return;
            };
            completed = next;
        }
    }

    fn attach_runner(&self, control: File, events: File, process: OwnedHandle) -> Result<()> {
        let abort_control = control
            .try_clone()
            .context("clone authenticated Windows sandbox control pipe for abort")?;
        let mut slot = self
            .runner_abort
            .lock()
            .map_err(|_| anyhow!("Windows sandbox runner lifetime lock was poisoned"))?;
        if slot.is_some() {
            bail!("Windows sandbox runner lifetime was already attached");
        }
        *slot = Some(RunnerAbort {
            control: abort_control,
            events,
            process,
        });
        if self.requested.load(Ordering::Acquire) {
            if let Some(runner) = slot.take() {
                let _ = terminate_process(&runner.process, 1);
                let _ = disconnect_named_pipe(&runner.control);
                let _ = disconnect_named_pipe(&runner.events);
            }
            bail!("Windows sandbox launch was aborted before runner authentication completed");
        }
        drop(slot);
        let mut writer = self
            .runner_writer
            .lock()
            .map_err(|_| anyhow!("Windows sandbox runner writer lock was poisoned"))?;
        if writer.is_some() {
            bail!("Windows sandbox runner writer was already attached");
        }
        *writer = Some(control);
        if self.requested.load(Ordering::Acquire) {
            bail!("Windows sandbox launch was aborted during runner authentication");
        }
        Ok(())
    }

    fn write_runner_frame(&self, kind: FrameKind, payload: &[u8]) -> Result<()> {
        let mut slot = self
            .runner_writer
            .lock()
            .map_err(|_| anyhow!("Windows sandbox runner writer lock was poisoned"))?;
        if self.requested.load(Ordering::Acquire) {
            bail!("Windows sandbox launch was aborted");
        }
        let writer = slot
            .as_mut()
            .ok_or_else(|| anyhow!("Windows sandbox runner writer was not attached"))?;
        write_frame(writer, kind, payload)
    }

    fn write_runner_json<T: Serialize>(&self, kind: FrameKind, value: &T) -> Result<()> {
        let payload =
            serde_json::to_vec(value).context("encode Windows sandbox protocol message")?;
        self.write_runner_frame(kind, &payload)
    }

    fn mark_started_and_close_stdin(&self) -> Result<()> {
        let mut slot = self
            .runner_writer
            .lock()
            .map_err(|_| anyhow!("Windows sandbox runner writer lock was poisoned"))?;
        if self.requested.load(Ordering::Acquire) {
            bail!("Windows sandbox launch was aborted before target Started settled");
        }
        let writer = slot
            .as_mut()
            .ok_or_else(|| anyhow!("Windows sandbox runner writer was not attached"))?;
        write_frame(writer, FrameKind::CloseStdin, &[])?;
        self.started.store(true, Ordering::Release);
        Ok(())
    }

    fn target_started(&self) -> bool {
        self.started.load(Ordering::Acquire)
    }

    fn request_termination(&self, started: bool) -> Result<()> {
        if started {
            return self
                .write_runner_frame(FrameKind::Terminate, &[])
                .inspect_err(|_| self.request());
        }
        self.request();
        Ok(())
    }
}

fn monitor_controller_liveness(
    mut available: impl FnMut() -> Result<u32>,
    stop: &AtomicBool,
    mut wait: impl FnMut(),
) -> ControllerOutcome {
    loop {
        if stop.load(Ordering::Acquire) {
            return ControllerOutcome::Stopped;
        }
        match available() {
            Ok(0) => {
                wait();
            }
            Ok(_) | Err(_) => return ControllerOutcome::Lost,
        }
    }
}

struct ControllerMonitor {
    stop: Arc<AtomicBool>,
    thread: Option<JoinHandle<ControllerOutcome>>,
}

impl ControllerMonitor {
    fn start(controller: File, abort: HostAbort) -> Self {
        let stop = Arc::new(AtomicBool::new(false));
        let thread_stop = Arc::clone(&stop);
        let thread = std::thread::spawn(move || {
            let outcome = monitor_controller_liveness(
                || named_pipe_available_bytes(&controller),
                &thread_stop,
                || std::thread::sleep(Duration::from_millis(10)),
            );
            if outcome == ControllerOutcome::Lost {
                abort.request();
            }
            outcome
        });
        Self {
            stop,
            thread: Some(thread),
        }
    }

    fn finish(mut self) -> Result<ControllerOutcome> {
        self.stop.store(true, Ordering::Release);
        self.join()
    }

    fn join(&mut self) -> Result<ControllerOutcome> {
        self.thread
            .take()
            .ok_or_else(|| anyhow!("Windows sandbox controller monitor was already joined"))?
            .join()
            .map_err(|_| anyhow!("Windows sandbox controller monitor panicked"))
    }
}

impl Drop for ControllerMonitor {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Release);
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
    }
}

struct LaunchWatchdog {
    stop: Arc<AtomicBool>,
    expired: Arc<AtomicBool>,
    thread: Option<JoinHandle<()>>,
}

impl LaunchWatchdog {
    fn start(deadline: Instant, abort: HostAbort) -> Self {
        let stop = Arc::new(AtomicBool::new(false));
        let expired = Arc::new(AtomicBool::new(false));
        let thread_stop = Arc::clone(&stop);
        let thread_expired = Arc::clone(&expired);
        let thread = std::thread::spawn(move || {
            while !thread_stop.load(Ordering::Acquire) {
                let now = Instant::now();
                if now >= deadline {
                    thread_expired.store(true, Ordering::Release);
                    abort.request();
                    return;
                }
                std::thread::sleep((deadline - now).min(Duration::from_millis(10)));
            }
        });
        Self {
            stop,
            expired,
            thread: Some(thread),
        }
    }

    fn finish(mut self, stage: &str) -> Result<()> {
        self.stop.store(true, Ordering::Release);
        self.join()?;
        if self.expired.load(Ordering::Acquire) {
            bail!("Windows sandbox launch deadline expired during {stage}");
        }
        Ok(())
    }

    fn join(&mut self) -> Result<()> {
        self.thread
            .take()
            .ok_or_else(|| anyhow!("Windows sandbox launch watchdog was already joined"))?
            .join()
            .map_err(|_| anyhow!("Windows sandbox launch watchdog panicked"))
    }
}

#[derive(Clone, Copy)]
struct LaunchDeadline(Instant);

impl LaunchDeadline {
    fn from_unix_ms(value: u64) -> Result<Self> {
        let now_unix_ms = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .context("read Windows sandbox launch clock")?
            .as_millis();
        if now_unix_ms >= u128::from(value) {
            bail!("Windows sandbox launch deadline already expired");
        }
        let remaining = u64::try_from(u128::from(value) - now_unix_ms)
            .context("convert Windows sandbox launch deadline")?;
        let deadline = Instant::now()
            .checked_add(Duration::from_millis(remaining))
            .ok_or_else(|| anyhow!("Windows sandbox launch deadline overflow"))?;
        Ok(Self(deadline))
    }

    fn ensure(self, stage: &str) -> Result<()> {
        if Instant::now() >= self.0 {
            bail!("Windows sandbox launch deadline expired at {stage}");
        }
        Ok(())
    }

    fn remaining(self, stage: &str) -> Result<Duration> {
        self.ensure(stage)?;
        Ok(self.0.saturating_duration_since(Instant::now()))
    }

    fn phase_deadline_at(self, now: Instant, budget: Duration) -> Instant {
        self.0.min(now.checked_add(budget).unwrap_or(self.0))
    }

    fn phase_deadline(self, budget: Duration) -> Instant {
        self.phase_deadline_at(Instant::now(), budget)
    }
}

impl Drop for LaunchWatchdog {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Release);
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
    }
}

fn read_request(path: &Path) -> Result<RunRequest> {
    let bytes = read_and_retire_request_file(path)?;
    let request: RunRequest =
        serde_json::from_slice(&bytes).context("decode Windows sandbox request")?;
    request.validate()?;
    Ok(request)
}

fn hold_setup_marker(request: &RunRequest) -> Result<File> {
    let token = current_token()?;
    let host_sid = token_user_sid(token.raw())?;
    open_setup_marker(
        &request.setup_marker_path,
        &request.setup_marker_sha256,
        &request.filesystem_capability_nonce,
        &host_sid,
        &request.sandbox_user_sid,
        &request.sandbox_group_sid,
        None,
    )
}

pub fn setup_installing_marker_is_current(
    path: &str,
    expected_sha256: &str,
    expected_capability_nonce: &str,
    expected_sandbox_user_sid: &str,
    expected_sandbox_group_sid: &str,
) -> Result<bool> {
    let token = current_token()?;
    let host_sid = token_user_sid(token.raw())?;
    Ok(try_open_setup_marker(
        path,
        expected_sha256,
        expected_capability_nonce,
        &host_sid,
        expected_sandbox_user_sid,
        expected_sandbox_group_sid,
        Some("installing"),
    )?
    .is_some())
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SetupMarkerCapability {
    version: u32,
    protocol: u16,
    generation_nonce: String,
    filesystem_capability_nonce: String,
    host_user_sid: String,
    sandbox_user_sid: String,
    sandbox_group_sid: String,
    #[serde(default)]
    state: Option<String>,
}

fn setup_marker_matches(
    marker: &SetupMarkerCapability,
    expected_capability_nonce: &str,
    expected_host_sid: &str,
    expected_sandbox_user_sid: &str,
    expected_sandbox_group_sid: &str,
    expected_state: Option<&str>,
) -> Result<bool> {
    let generation_nonce = uuid::Uuid::parse_str(&marker.generation_nonce)
        .context("decode Windows sandbox setup generation nonce")?;
    let capability_nonce = uuid::Uuid::parse_str(&marker.filesystem_capability_nonce)
        .context("decode Windows sandbox filesystem capability nonce")?;
    Ok(marker.version == 9
        && marker.protocol == PROTOCOL_VERSION
        && generation_nonce.get_version_num() == 4
        && capability_nonce.get_version_num() == 4
        && marker
            .filesystem_capability_nonce
            .eq_ignore_ascii_case(expected_capability_nonce)
        && marker.host_user_sid.eq_ignore_ascii_case(expected_host_sid)
        && marker
            .sandbox_user_sid
            .eq_ignore_ascii_case(expected_sandbox_user_sid)
        && marker
            .sandbox_group_sid
            .eq_ignore_ascii_case(expected_sandbox_group_sid)
        && marker.state.as_deref() == expected_state)
}

fn open_setup_marker(
    path: &str,
    expected_sha256: &str,
    expected_capability_nonce: &str,
    expected_host_sid: &str,
    expected_sandbox_user_sid: &str,
    expected_sandbox_group_sid: &str,
    expected_state: Option<&str>,
) -> Result<File> {
    try_open_setup_marker(
        path,
        expected_sha256,
        expected_capability_nonce,
        expected_host_sid,
        expected_sandbox_user_sid,
        expected_sandbox_group_sid,
        expected_state,
    )?
    .ok_or_else(|| anyhow!("Windows sandbox setup marker generation changed before host launch"))
}

fn try_open_setup_marker(
    path: &str,
    expected_sha256: &str,
    expected_capability_nonce: &str,
    expected_host_sid: &str,
    expected_sandbox_user_sid: &str,
    expected_sandbox_group_sid: &str,
    expected_state: Option<&str>,
) -> Result<Option<File>> {
    let mut file = match OpenOptions::new()
        .read(true)
        .share_mode(FILE_SHARE_READ.0)
        .custom_flags(FILE_FLAG_OPEN_REPARSE_POINT.0)
        .open(path)
    {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => {
            return Err(error).context("open Windows sandbox setup marker launch gate");
        }
    };
    let metadata = file
        .metadata()
        .context("inspect Windows sandbox setup marker launch gate")?;
    if !metadata.is_file()
        || metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT.0 != 0
        || metadata.len() > 4_096
    {
        bail!("Windows sandbox setup marker launch gate is not a bounded regular file");
    }
    let mut bytes = Vec::with_capacity(metadata.len() as usize);
    file.read_to_end(&mut bytes)
        .context("read Windows sandbox setup marker launch gate")?;
    let observed = format!("{:x}", Sha256::digest(&bytes));
    if !observed.eq_ignore_ascii_case(expected_sha256) {
        return Ok(None);
    }
    let marker: SetupMarkerCapability =
        serde_json::from_slice(&bytes).context("decode Windows sandbox setup marker capability")?;
    if !setup_marker_matches(
        &marker,
        expected_capability_nonce,
        expected_host_sid,
        expected_sandbox_user_sid,
        expected_sandbox_group_sid,
        expected_state,
    )? {
        return Ok(None);
    }
    Ok(Some(file))
}

fn validate_terminal_record_path(request_path: &Path, terminal_path: &Path) -> Result<()> {
    if !terminal_path.is_absolute() || terminal_path.parent() != request_path.parent() {
        bail!("Windows sandbox terminal record must share the request directory");
    }
    let name = terminal_path
        .file_name()
        .and_then(|value| value.to_str())
        .ok_or_else(|| anyhow!("Windows sandbox terminal record name is not Unicode"))?;
    if !name.starts_with("windows-terminal-") || !name.ends_with(".json") {
        bail!("Windows sandbox terminal record name is invalid");
    }
    Ok(())
}

fn launch_record_path(terminal_path: &Path, kind: &str) -> Result<std::path::PathBuf> {
    let name = terminal_path
        .file_name()
        .and_then(|value| value.to_str())
        .ok_or_else(|| anyhow!("Windows sandbox terminal record name is not Unicode"))?;
    let suffix = name
        .strip_prefix("windows-terminal-")
        .ok_or_else(|| anyhow!("Windows sandbox terminal record name is invalid"))?;
    Ok(terminal_path.with_file_name(format!("windows-{kind}-{suffix}")))
}

fn write_launch_record(path: &Path, record: &StartedRecord) -> Result<()> {
    let payload = serde_json::to_vec(record).context("encode Windows sandbox started record")?;
    let temporary = path.with_extension(format!(
        "{}.{}.tmp",
        std::process::id(),
        uuid::Uuid::new_v4().simple(),
    ));
    let result = (|| {
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temporary)
            .context("create Windows sandbox started record staging file")?;
        file.write_all(&payload)
            .context("write Windows sandbox started record")?;
        file.sync_all()
            .context("flush Windows sandbox started record")?;
        drop(file);
        std::fs::rename(&temporary, path).context("publish Windows sandbox started record")
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(temporary);
    }
    result
}

fn write_terminal_record(path: &Path, record: &TerminalRecord) -> Result<()> {
    let payload = serde_json::to_vec(record).context("encode Windows sandbox terminal record")?;
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(path)
        .context("create Windows sandbox terminal record")?;
    file.write_all(&payload)
        .context("write Windows sandbox terminal record")?;
    file.sync_all()
        .context("flush Windows sandbox terminal record")
}

fn read_bootstrap(mut reader: impl Read) -> Result<BootstrapRequest> {
    let mut header = [0u8; 4];
    reader
        .read_exact(&mut header)
        .context("read Windows sandbox bootstrap header")?;
    let length = u32::from_le_bytes(header) as usize;
    if length == 0 || length > MAX_BOOTSTRAP_BYTES {
        bail!("Windows sandbox bootstrap frame exceeded its bound");
    }
    let mut payload = vec![0u8; length];
    reader
        .read_exact(&mut payload)
        .context("read Windows sandbox bootstrap payload")?;
    let bootstrap: BootstrapRequest =
        serde_json::from_slice(&payload).context("decode Windows sandbox bootstrap")?;
    bootstrap.validate()?;
    Ok(bootstrap)
}

pub(crate) fn read_and_retire_request_file(path: &Path) -> Result<Vec<u8>> {
    if !path.is_absolute() {
        bail!("Windows sandbox request path must be absolute");
    }
    let mut file = OpenOptions::new()
        .access_mode((FILE_GENERIC_READ | DELETE).0)
        .share_mode(0)
        .custom_flags((FILE_FLAG_OPEN_REPARSE_POINT | FILE_FLAG_DELETE_ON_CLOSE).0)
        .open(path)
        .with_context(|| format!("open Windows sandbox request {}", path.display()))?;
    let metadata = file
        .metadata()
        .with_context(|| format!("inspect Windows sandbox request {}", path.display()))?;
    if !metadata.is_file()
        || metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT.0 != 0
        || metadata.len() > MAX_REQUEST_BYTES
    {
        bail!("Windows sandbox request is not a bounded regular file");
    }
    let mut standard: FILE_STANDARD_INFO = unsafe { std::mem::zeroed() };
    unsafe {
        GetFileInformationByHandleEx(
            HANDLE(file.as_raw_handle()),
            FileStandardInfo,
            &mut standard as *mut FILE_STANDARD_INFO as *mut std::ffi::c_void,
            size_of::<FILE_STANDARD_INFO>() as u32,
        )
        .context("inspect Windows sandbox request link count")?;
    }
    if standard.NumberOfLinks != 1 {
        bail!("Windows sandbox request must be a single-link file");
    }
    let mut bytes = Vec::with_capacity(metadata.len() as usize);
    Read::by_ref(&mut file)
        .take(MAX_REQUEST_BYTES + 1)
        .read_to_end(&mut bytes)
        .with_context(|| format!("read Windows sandbox request {}", path.display()))?;
    if bytes.len() as u64 > MAX_REQUEST_BYTES {
        bail!("Windows sandbox request exceeded its bounded read");
    }
    drop(file);
    Ok(bytes)
}

fn decode_json<T: DeserializeOwned>(frame: Frame, expected: FrameKind) -> Result<T> {
    if frame.kind != expected {
        bail!("expected {expected:?} frame, received {:?}", frame.kind);
    }
    serde_json::from_slice(&frame.payload)
        .with_context(|| format!("decode Windows sandbox {expected:?} frame"))
}

fn next_frame(reader: &mut impl Read, expected: FrameKind) -> Result<Frame> {
    let frame = read_frame(reader)?
        .ok_or_else(|| anyhow!("Windows sandbox runner disconnected before {expected:?}"))?;
    if frame.kind == FrameKind::Error {
        let error: ErrorMessage = serde_json::from_slice(&frame.payload)
            .context("decode Windows sandbox runner error")?;
        bail!(
            "Windows sandbox runner failed at {}: {}",
            error.stage,
            error.message
        );
    }
    Ok(frame)
}

fn connect_runner(
    mut server: NamedPipeServer,
    child: &SpawnedHostChild,
    deadline: LaunchDeadline,
) -> Result<(File, u32)> {
    loop {
        match server.try_connect()? {
            Ok(connected) => return Ok(connected),
            Err(pending) => server = pending,
        }
        if let Some(code) = child.wait(0)? {
            bail!("ASRT exited with code {code} before the sandbox runner connected");
        }
        deadline.ensure("runner connection")?;
        std::thread::sleep(Duration::from_millis(10));
    }
}

fn consume_initial_close_stdin(reader: &mut impl Read) -> Result<()> {
    let frame = read_frame(reader)?
        .ok_or_else(|| anyhow!("Windows sandbox controller disconnected before CloseStdin"))?;
    if frame.kind != FrameKind::CloseStdin || !frame.payload.is_empty() {
        bail!("Windows sandbox controller did not close target stdin after bootstrap");
    }
    Ok(())
}

fn pump_termination_control(
    mut input: impl Read,
    outcome: &AtomicU8,
    mut target_started: impl FnMut() -> bool,
    mut terminate: impl FnMut(bool) -> Result<()>,
) {
    match read_frame(&mut input) {
        Ok(Some(frame)) if frame.kind == FrameKind::Terminate && frame.payload.is_empty() => {
            outcome.store(CONTROL_TERMINATION_REQUESTED, Ordering::Release);
            if terminate(target_started()).is_err() {
                outcome.store(CONTROL_LOST, Ordering::Release);
            }
        }
        Ok(Some(_)) | Ok(None) | Err(_) => {
            outcome.store(CONTROL_LOST, Ordering::Release);
            let _ = terminate(target_started());
        }
    }
}

fn start_termination_control(abort: Arc<OnceLock<HostAbort>>, outcome: Arc<AtomicU8>) {
    std::thread::spawn(move || {
        let input = std::io::stdin().lock();
        pump_termination_control(
            input,
            &outcome,
            || abort.get().is_some_and(HostAbort::target_started),
            |started| match abort.get() {
                Some(abort) => abort.request_termination(started),
                // No ASRT launcher exists yet, or it is still held by this host's
                // creation-time kill-on-close Job. Exiting the exact host closes
                // that Job before any target can cross the resume-record boundary.
                None => std::process::exit(TERMINATION_CONFIRMED_EXIT_CODE as i32),
            },
        );
    });
}

pub fn run(request_path: &Path) -> Result<u32> {
    let request = read_request(request_path)?;
    validate_terminal_record_path(request_path, Path::new(&request.terminal_record_path))?;
    let resume_record = launch_record_path(Path::new(&request.terminal_record_path), "resume")?;
    let started_record = launch_record_path(Path::new(&request.terminal_record_path), "started")?;
    let deadline = LaunchDeadline::from_unix_ms(request.operation_deadline_unix_ms)?;
    let mut input = std::io::stdin().lock();
    let bootstrap = read_bootstrap(&mut input)?;
    consume_initial_close_stdin(&mut input)?;
    drop(input);
    let abort_slot = Arc::new(OnceLock::new());
    let control_outcome = Arc::new(AtomicU8::new(CONTROL_OPEN));
    start_termination_control(Arc::clone(&abort_slot), Arc::clone(&control_outcome));
    deadline.ensure("bootstrap")?;
    let current = current_token()?;
    let host_sid = token_user_sid(current.raw())?;
    let control_directory = request_path
        .parent()
        .ok_or_else(|| anyhow!("Windows sandbox request has no control directory"))?;
    verify_control_directory_boundary(&request, control_directory, &host_sid)?;
    if host_sid == request.sandbox_user_sid {
        bail!("Windows sandbox host must not run as the restricted account");
    }
    let setup_marker = hold_setup_marker(&request)?;
    let (controller, controller_pid) = connect_controller_pipe(
        &request.controller_pipe,
        deadline.remaining("controller connection")?,
    )?;
    if controller_pid != controller_pipe_server_pid(&request.controller_pipe)? {
        bail!("Windows sandbox controller pipe server PID did not match its authenticated name");
    }
    deadline.ensure("controller authentication")?;
    let executable = std::env::current_exe().context("resolve Windows sandbox executable")?;
    let runner_directory = executable
        .parent()
        .ok_or_else(|| anyhow!("Windows sandbox executable has no parent"))?;
    deadline.ensure("ACL authorization")?;
    let filesystem_capability_sids = ensure_policy_aces_until(
        &request,
        runner_directory,
        request.operation_deadline_unix_ms,
    )?;
    deadline.ensure("ACL authorization")?;

    let servers = NamedPipeServers::create(&host_sid, &request.sandbox_user_sid)?;
    let session_nonce = servers.session_nonce.clone();
    let desktop = PrivateDesktop::create(
        &host_sid,
        &request.sandbox_group_sid,
        &request.policy_capability_sid,
        &session_nonce,
    )?;
    let mut asrt_args = request.asrt_prefix_args.clone();
    asrt_args.push(executable.to_string_lossy().into_owned());
    asrt_args.push("__runner".into());
    asrt_args.push(servers.runner_control.name.clone());
    asrt_args.push(servers.runner_events.name.clone());
    asrt_args.push(host_sid.clone());
    deadline.ensure("ASRT creation")?;
    let mut child = spawn_asrt_launcher(&request.asrt_executable, &asrt_args, &request.cwd)?;
    let abort = HostAbort::new(
        child.abort_process()?,
        child.abort_job()?,
        PathBuf::from(&request.terminal_record_path),
        request.terminal_nonce.clone(),
    );
    abort_slot
        .set(abort.clone())
        .map_err(|_| anyhow!("Windows sandbox abort boundary was already attached"))?;
    let run_result = (|| {
        let controller_monitor = ControllerMonitor::start(controller, abort.clone());
        let runner_watchdog =
            LaunchWatchdog::start(deadline.phase_deadline(LAUNCH_PHASE_TIMEOUT), abort.clone());
        deadline.ensure("ASRT resume")?;
        child.resume()?;
        child.start_diagnostic_pump();
        let (control_pipe, control_client_pid) =
            connect_runner(servers.runner_control, &child, deadline)?;
        let (mut event_pipe, event_client_pid) =
            connect_runner(servers.runner_events, &child, deadline)?;
        if control_client_pid != event_client_pid {
            bail!("Windows sandbox runner pipe endpoints used different client processes");
        }
        let client_pid = event_client_pid;
        if !process_is_descendant_of(client_pid, child.pid)? {
            bail!(
                "Windows sandbox runner did not descend from the exact ASRT launcher {}",
                child.pid,
            );
        }
        // Bind the exact peer handle before reading attacker-controlled protocol data;
        // every later identity check and abort uses this same process object.
        let runner_process =
            verify_protected_runner_process(client_pid, &host_sid, &request.sandbox_user_sid)?;
        abort.attach_runner(
            control_pipe,
            event_pipe
                .try_clone()
                .context("clone Windows sandbox event pipe for abort")?,
            runner_process,
        )?;
        let hello: HelloMessage = decode_json(
            next_frame(&mut event_pipe, FrameKind::Hello)?,
            FrameKind::Hello,
        )?;
        // Windows permits named-pipe client impersonation only after the server has read
        // client data. The authenticated Hello above establishes that ordering.
        let (client_sid, client_logon_sid, client_restricted) =
            named_pipe_client_identity(&event_pipe)?;
        if client_sid != request.sandbox_user_sid {
            bail!("Windows sandbox pipe client did not run as the restricted account");
        }
        if client_restricted {
            bail!("Windows sandbox runner pipe client used a restricted target token");
        }
        if hello.pid != client_pid
            || hello.logon_sid != client_logon_sid
            || hello.session_nonce != session_nonce
        {
            bail!("Windows sandbox runner identity did not match its pipe peer");
        }
        child.close_launch_stdin();
        runner_watchdog.finish("runner authentication")?;
        let target_watchdog =
            LaunchWatchdog::start(deadline.phase_deadline(LAUNCH_PHASE_TIMEOUT), abort.clone());

        let relay_result = relay_after_hello(
            event_pipe,
            &request,
            hello,
            bootstrap,
            filesystem_capability_sids,
            controller_monitor,
            target_watchdog,
            deadline,
            abort.clone(),
            control_outcome,
            desktop,
            &resume_record,
            &started_record,
            setup_marker,
        );
        finalize_relay(
            relay_result,
            || Ok(None),
            |record| write_terminal_record(Path::new(&request.terminal_record_path), record),
            &request.terminal_nonce,
        )
    })();
    if run_result.is_err() {
        abort.request();
    }
    abort.wait_for_completion();
    run_result
}

struct RelaySettlement {
    host_exit_code: u32,
    target_exit_code: u32,
    termination_requested: bool,
}

fn finalize_relay(
    relay: Result<RelaySettlement>,
    cleanup: impl FnOnce() -> Result<Option<String>>,
    write_terminal: impl FnOnce(&TerminalRecord) -> Result<()>,
    terminal_nonce: &str,
) -> Result<u32> {
    match relay {
        Ok(settlement) => finalize_drained_run(settlement, cleanup, write_terminal, terminal_nonce),
        // A relay error is not Job-drain proof, so it cannot publish a successful
        // terminal record. Protocol 9 performs no command-scoped ACL cleanup.
        Err(relay_error) => Err(relay_error),
    }
}

fn finalize_drained_run(
    settlement: RelaySettlement,
    cleanup: impl FnOnce() -> Result<Option<String>>,
    write_terminal: impl FnOnce(&TerminalRecord) -> Result<()>,
    terminal_nonce: &str,
) -> Result<u32> {
    let cleanup_result = cleanup();
    let (cleanup_deferred, cleanup_diagnostic) = match &cleanup_result {
        Ok(Some(diagnostic)) => (true, Some(diagnostic.clone())),
        Ok(None) => (false, None),
        Err(error) => (
            true,
            Some(format!("{error:#}").chars().take(2_048).collect()),
        ),
    };
    let terminal_result = write_terminal(&TerminalRecord {
        protocol: PROTOCOL_VERSION,
        nonce: terminal_nonce.to_owned(),
        job_drained: true,
        target_exit_code: settlement.target_exit_code,
        termination_requested: settlement.termination_requested,
        deny_read_cleanup_deferred: cleanup_deferred,
        deny_read_cleanup_diagnostic: cleanup_diagnostic,
    });
    match (cleanup_result, terminal_result) {
        (Ok(_), Ok(())) => Ok(settlement.host_exit_code),
        (Err(error), Ok(())) => Err(error),
        (Ok(_), Err(error)) => Err(error.context("write Windows sandbox terminal record")),
        (Err(cleanup_error), Err(terminal_error)) => Err(anyhow!(
            "Windows sandbox ACL cleanup failed: {cleanup_error:#}; terminal record also failed: {terminal_error:#}",
        )),
    }
}

#[allow(clippy::too_many_arguments)] // Own all authenticated launch guards until Exit.
fn relay_after_hello(
    mut event_pipe: File,
    request: &RunRequest,
    hello: HelloMessage,
    bootstrap: BootstrapRequest,
    filesystem_capability_sids: Vec<String>,
    controller_monitor: ControllerMonitor,
    launch_watchdog: LaunchWatchdog,
    deadline: LaunchDeadline,
    abort: HostAbort,
    control_outcome: Arc<AtomicU8>,
    _desktop: PrivateDesktop,
    resume_record_path: &Path,
    started_record_path: &Path,
    setup_marker: File,
) -> Result<RelaySettlement> {
    if hello.protocol != PROTOCOL_VERSION {
        bail!("Windows sandbox runner reported an incompatible protocol");
    }
    abort.write_runner_json(
        FrameKind::Spawn,
        &SpawnMessage {
            protocol: PROTOCOL_VERSION,
            target_argv: request.target_argv.clone(),
            cwd: request.cwd.clone(),
            policy_capability_sid: request.policy_capability_sid.clone(),
            filesystem_capability_sids,
            session_nonce: hello.session_nonce.clone(),
            target_environment: bootstrap.target_environment,
        },
    )?;
    let ready: ReadyMessage = decode_json(
        next_frame(&mut event_pipe, FrameKind::Ready)?,
        FrameKind::Ready,
    )?;
    deadline.ensure("Ready")?;
    if ready.protocol != PROTOCOL_VERSION || !ready.job_contained {
        bail!("Windows sandbox target was not proven contained before resume");
    }
    deadline.ensure("target resume")?;
    let launch_record = StartedRecord {
        protocol: PROTOCOL_VERSION,
        nonce: request.terminal_nonce.clone(),
        target_pid: ready.pid,
        job_contained: ready.job_contained,
    };
    write_launch_record(resume_record_path, &launch_record)?;
    deadline.ensure("Resume attestation")?;
    abort.write_runner_frame(FrameKind::Resume, &[])?;
    let started: StartedMessage = decode_json(
        next_frame(&mut event_pipe, FrameKind::Started)?,
        FrameKind::Started,
    )?;
    validate_started(&ready, &started)?;
    deadline.ensure("Started")?;
    abort.mark_started_and_close_stdin()?;
    write_launch_record(started_record_path, &launch_record)?;
    drop(setup_marker);
    deadline.ensure("Started attestation")?;
    launch_watchdog.finish("target Started")?;
    loop {
        let frame = read_frame(&mut event_pipe)?
            .ok_or_else(|| anyhow!("Windows sandbox runner disconnected before Exit"))?;
        match frame.kind {
            FrameKind::Stdout => {
                let mut output = std::io::stdout().lock();
                output.write_all(&frame.payload)?;
                output.flush()?;
            }
            FrameKind::Stderr => {
                let mut output = std::io::stderr().lock();
                output.write_all(&frame.payload)?;
                output.flush()?;
            }
            FrameKind::Exit => {
                let exit: ExitMessage = serde_json::from_slice(&frame.payload)?;
                if exit.protocol != PROTOCOL_VERSION {
                    bail!("Windows sandbox Exit frame used an incompatible protocol");
                }
                if controller_monitor.finish()? == ControllerOutcome::Lost {
                    bail!("Windows sandbox controller disconnected before Exit settled");
                }
                let control_state = control_outcome.load(Ordering::Acquire);
                let termination_requested = control_state == CONTROL_TERMINATION_REQUESTED;
                let host_exit_code = match control_state {
                    CONTROL_OPEN => exit.code,
                    CONTROL_TERMINATION_REQUESTED => TERMINATION_CONFIRMED_EXIT_CODE,
                    CONTROL_LOST => {
                        bail!("Windows sandbox host control stream was lost before Exit settled")
                    }
                    _ => bail!("Windows sandbox host control state was invalid"),
                };
                return Ok(RelaySettlement {
                    host_exit_code,
                    target_exit_code: exit.code,
                    termination_requested,
                });
            }
            FrameKind::Error => {
                let error: ErrorMessage = serde_json::from_slice(&frame.payload)?;
                bail!(
                    "Windows sandbox runner failed at {}: {}",
                    error.stage,
                    error.message
                );
            }
            unexpected => bail!("runner sent unexpected {unexpected:?} frame after Ready"),
        }
    }
}

fn validate_started(ready: &ReadyMessage, started: &StartedMessage) -> Result<()> {
    if started.protocol != PROTOCOL_VERSION || started.pid != ready.pid {
        bail!("Windows sandbox Started frame did not match the suspended target");
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use std::cell::Cell;
    use std::io::Cursor;

    use super::*;

    #[test]
    fn setup_marker_requires_the_exact_generation_identity_and_phase() {
        let ready: SetupMarkerCapability = serde_json::from_str(
            r#"{"version":9,"protocol":9,"generationNonce":"00000000-0000-4000-8000-000000000001","filesystemCapabilityNonce":"00000000-0000-4000-8000-000000000002","hostUserSid":"S-1-5-21-1","sandboxUserSid":"S-1-5-21-2","sandboxGroupSid":"S-1-5-21-3"}"#,
        )
        .unwrap();
        assert!(
            setup_marker_matches(
                &ready,
                "00000000-0000-4000-8000-000000000002",
                "S-1-5-21-1",
                "S-1-5-21-2",
                "S-1-5-21-3",
                None,
            )
            .unwrap()
        );
        assert!(
            !setup_marker_matches(
                &ready,
                "00000000-0000-4000-8000-000000000002",
                "S-1-5-21-1",
                "S-1-5-21-9",
                "S-1-5-21-3",
                None,
            )
            .unwrap()
        );

        let installing: SetupMarkerCapability = serde_json::from_str(
            r#"{"version":9,"protocol":9,"generationNonce":"00000000-0000-4000-8000-000000000001","filesystemCapabilityNonce":"00000000-0000-4000-8000-000000000002","hostUserSid":"S-1-5-21-1","sandboxUserSid":"S-1-5-21-2","sandboxGroupSid":"S-1-5-21-3","state":"installing"}"#,
        )
        .unwrap();
        assert!(
            setup_marker_matches(
                &installing,
                "00000000-0000-4000-8000-000000000002",
                "S-1-5-21-1",
                "S-1-5-21-2",
                "S-1-5-21-3",
                Some("installing"),
            )
            .unwrap()
        );
        assert!(serde_json::from_str::<SetupMarkerCapability>(
            r#"{"version":9,"protocol":9,"generationNonce":"00000000-0000-4000-8000-000000000001","filesystemCapabilityNonce":"00000000-0000-4000-8000-000000000002","hostUserSid":"S-1-5-21-1","sandboxUserSid":"S-1-5-21-2","sandboxGroupSid":"S-1-5-21-3","unexpected":true}"#,
        )
        .is_err());
    }

    #[test]
    fn phase_deadline_restarts_without_exceeding_the_operation_deadline() {
        let now = Instant::now();
        let operation = LaunchDeadline(now + Duration::from_secs(120));

        assert_eq!(
            operation.phase_deadline_at(now, Duration::from_secs(30)),
            now + Duration::from_secs(30),
        );
        assert_eq!(
            operation.phase_deadline_at(now + Duration::from_secs(105), Duration::from_secs(30),),
            now + Duration::from_secs(120),
        );
    }

    #[test]
    fn drained_terminal_is_written_even_when_acl_cleanup_fails() {
        let terminal_written = Cell::new(false);
        let error = finalize_drained_run(
            RelaySettlement {
                host_exit_code: 0,
                target_exit_code: 0,
                termination_requested: false,
            },
            || Err(anyhow!("cleanup failed")),
            |_| {
                terminal_written.set(true);
                Ok(())
            },
            "terminal-nonce",
        )
        .unwrap_err();

        assert!(terminal_written.get());
        assert!(error.to_string().contains("cleanup failed"));
    }

    #[test]
    fn drained_terminal_records_durable_acl_cleanup_deferral_as_success() {
        let terminal_deferred = Cell::new(false);
        let exit_code = finalize_drained_run(
            RelaySettlement {
                host_exit_code: 0,
                target_exit_code: 0,
                termination_requested: false,
            },
            || Ok(Some("ACL transaction remained busy".into())),
            |record| {
                terminal_deferred.set(record.deny_read_cleanup_deferred);
                assert_eq!(
                    record.deny_read_cleanup_diagnostic.as_deref(),
                    Some("ACL transaction remained busy"),
                );
                Ok(())
            },
            "terminal-nonce",
        )
        .unwrap();

        assert_eq!(exit_code, 0);
        assert!(terminal_deferred.get());
    }

    #[test]
    fn relay_failure_preserves_the_execution_deny_lease_until_runner_death() {
        let cleanup_called = Cell::new(false);
        let terminal_written = Cell::new(false);
        let error = finalize_relay(
            Err(anyhow!("relay failed before drain")),
            || {
                cleanup_called.set(true);
                Ok(None)
            },
            |_| {
                terminal_written.set(true);
                Ok(())
            },
            "terminal-nonce",
        )
        .unwrap_err();

        assert!(!cleanup_called.get());
        assert!(!terminal_written.get());
        assert!(error.to_string().contains("relay failed before drain"));
    }

    #[test]
    fn setup_marker_handle_blocks_cutover_until_the_target_start_window_closes() {
        let path = std::env::temp_dir().join(format!(
            "kodax-setup-marker-{}-{}.json",
            std::process::id(),
            uuid::Uuid::new_v4(),
        ));
        let capability_nonce = "00000000-0000-4000-8000-000000000003";
        let payload = br#"{"version":9,"protocol":9,"generationNonce":"00000000-0000-4000-8000-000000000001","filesystemCapabilityNonce":"00000000-0000-4000-8000-000000000003","hostUserSid":"S-1-5-21-1","sandboxUserSid":"S-1-5-21-2","sandboxGroupSid":"S-1-5-21-3"}"#;
        std::fs::write(&path, payload).unwrap();
        let digest = format!("{:x}", Sha256::digest(payload));

        let marker = open_setup_marker(
            path.to_str().unwrap(),
            &digest,
            capability_nonce,
            "S-1-5-21-1",
            "S-1-5-21-2",
            "S-1-5-21-3",
            None,
        )
        .unwrap();
        assert!(std::fs::remove_file(&path).is_err());
        drop(marker);
        std::fs::remove_file(path).unwrap();
    }

    #[test]
    fn setup_marker_probe_waits_for_the_exact_generation() {
        let path = std::env::temp_dir().join(format!(
            "kodax-setup-marker-probe-{}-{}.json",
            std::process::id(),
            uuid::Uuid::new_v4(),
        ));
        let capability_nonce = "00000000-0000-4000-8000-000000000003";
        let payload = br#"{"version":9,"protocol":9,"generationNonce":"00000000-0000-4000-8000-000000000001","filesystemCapabilityNonce":"00000000-0000-4000-8000-000000000003","hostUserSid":"S-1-5-21-1","sandboxUserSid":"S-1-5-21-2","sandboxGroupSid":"S-1-5-21-3","state":"installing"}"#;
        let digest = format!("{:x}", Sha256::digest(payload));

        assert!(
            try_open_setup_marker(
                path.to_str().unwrap(),
                &digest,
                capability_nonce,
                "S-1-5-21-1",
                "S-1-5-21-2",
                "S-1-5-21-3",
                Some("installing"),
            )
            .unwrap()
            .is_none()
        );
        std::fs::write(&path, br#"{"version":7}"#).unwrap();
        assert!(
            try_open_setup_marker(
                path.to_str().unwrap(),
                &digest,
                capability_nonce,
                "S-1-5-21-1",
                "S-1-5-21-2",
                "S-1-5-21-3",
                Some("installing"),
            )
            .unwrap()
            .is_none()
        );
        std::fs::write(&path, payload).unwrap();
        assert!(
            try_open_setup_marker(
                path.to_str().unwrap(),
                &digest,
                capability_nonce,
                "S-1-5-21-1",
                "S-1-5-21-2",
                "S-1-5-21-3",
                Some("installing"),
            )
            .unwrap()
            .is_some()
        );
        std::fs::remove_file(path).unwrap();
    }

    #[test]
    fn controller_no_data_is_alive_but_eof_or_payload_is_lost() {
        let stop = AtomicBool::new(false);
        assert_eq!(
            monitor_controller_liveness(
                || Ok(0),
                &stop,
                || {
                    stop.store(true, Ordering::Release);
                }
            ),
            ControllerOutcome::Stopped
        );
        assert_eq!(
            monitor_controller_liveness(
                || Err(anyhow!("controller disconnected")),
                &AtomicBool::new(false),
                || { unreachable!("disconnect must not wait") }
            ),
            ControllerOutcome::Lost
        );
        assert_eq!(
            monitor_controller_liveness(
                || Ok(1),
                &AtomicBool::new(false),
                || { unreachable!("controller payload must not wait") }
            ),
            ControllerOutcome::Lost
        );
    }

    #[test]
    fn request_file_is_read_and_retired_through_one_exclusive_handle() {
        let path = std::env::temp_dir().join(format!(
            "kodax-sandbox-v2-request-{}-{}.json",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::write(&path, b"request-body").unwrap();

        assert_eq!(
            read_and_retire_request_file(&path).unwrap(),
            b"request-body"
        );
        assert!(!path.exists());
    }

    #[test]
    fn request_file_rejects_hardlinks_and_oversized_payloads() {
        let root = std::env::temp_dir().join(format!(
            "kodax-sandbox-v2-request-boundary-{}-{}",
            std::process::id(),
            uuid::Uuid::new_v4(),
        ));
        std::fs::create_dir(&root).unwrap();
        let original = root.join("original.json");
        let hardlink = root.join("hardlink.json");
        std::fs::write(&original, b"{}").unwrap();
        std::fs::hard_link(&original, &hardlink).unwrap();
        assert!(
            read_and_retire_request_file(&hardlink)
                .unwrap_err()
                .to_string()
                .contains("single-link")
        );

        let oversized = root.join("oversized.json");
        std::fs::write(&oversized, vec![b'x'; (MAX_REQUEST_BYTES + 1) as usize]).unwrap();
        assert!(
            read_and_retire_request_file(&oversized)
                .unwrap_err()
                .to_string()
                .contains("bounded regular file")
        );
        std::fs::remove_file(original).unwrap();
        std::fs::remove_dir(root).unwrap();
    }

    #[test]
    fn started_must_match_the_ready_target() {
        let ready = ReadyMessage {
            protocol: PROTOCOL_VERSION,
            pid: 42,
            job_contained: true,
        };
        validate_started(
            &ready,
            &StartedMessage {
                protocol: PROTOCOL_VERSION,
                pid: 42,
            },
        )
        .unwrap();
        assert!(
            validate_started(
                &ready,
                &StartedMessage {
                    protocol: PROTOCOL_VERSION,
                    pid: 43,
                },
            )
            .is_err()
        );
    }

    #[test]
    fn close_stdin_is_consumed_before_termination_control_starts() {
        let mut input = Vec::new();
        write_frame(&mut input, FrameKind::CloseStdin, &[]).unwrap();
        write_frame(&mut input, FrameKind::Terminate, &[]).unwrap();
        let mut input = Cursor::new(input);
        consume_initial_close_stdin(&mut input).unwrap();
        let outcome = AtomicU8::new(CONTROL_OPEN);
        let mut termination_started = Vec::new();
        pump_termination_control(
            &mut input,
            &outcome,
            || true,
            |started| {
                termination_started.push(started);
                Ok(())
            },
        );

        assert_eq!(termination_started, vec![true]);
        assert_eq!(
            outcome.load(Ordering::Acquire),
            CONTROL_TERMINATION_REQUESTED
        );
    }

    #[test]
    fn launch_control_holds_close_stdin_and_observes_pre_started_terminate() {
        let mut input = Vec::new();
        write_frame(&mut input, FrameKind::CloseStdin, &[]).unwrap();
        write_frame(&mut input, FrameKind::Terminate, &[]).unwrap();
        let mut input = Cursor::new(input);
        consume_initial_close_stdin(&mut input).unwrap();

        let outcome = AtomicU8::new(CONTROL_OPEN);
        let mut termination_started = Vec::new();
        pump_termination_control(
            &mut input,
            &outcome,
            || false,
            |started| {
                termination_started.push(started);
                Ok(())
            },
        );

        assert_eq!(termination_started, vec![false]);
        assert_eq!(
            outcome.load(Ordering::Acquire),
            CONTROL_TERMINATION_REQUESTED,
        );
    }

    #[test]
    fn unexpected_termination_control_frame_fails_closed() {
        let mut input = Vec::new();
        write_frame(&mut input, FrameKind::Stdin, b"unexpected").unwrap();
        let outcome = AtomicU8::new(CONTROL_OPEN);
        let mut termination_started = Vec::new();
        pump_termination_control(
            Cursor::new(input),
            &outcome,
            || false,
            |started| {
                termination_started.push(started);
                Ok(())
            },
        );

        assert_eq!(termination_started, vec![false]);
        assert_eq!(outcome.load(Ordering::Acquire), CONTROL_LOST);
    }

    #[test]
    fn termination_failure_marks_control_lost() {
        let mut input = Vec::new();
        write_frame(&mut input, FrameKind::Terminate, &[]).unwrap();
        let outcome = AtomicU8::new(CONTROL_OPEN);
        let mut calls = 0;
        pump_termination_control(
            Cursor::new(input),
            &outcome,
            || true,
            |_| {
                calls += 1;
                Err(anyhow!("runner disconnected"))
            },
        );

        assert_eq!(calls, 1);
        assert_eq!(outcome.load(Ordering::Acquire), CONTROL_LOST);
    }

    #[test]
    fn control_eof_requests_fail_closed_termination_once() {
        let mut termination_started = Vec::new();
        let outcome = AtomicU8::new(CONTROL_OPEN);
        pump_termination_control(
            Cursor::new(Vec::<u8>::new()),
            &outcome,
            || true,
            |started| {
                termination_started.push(started);
                Ok(())
            },
        );

        assert_eq!(termination_started, vec![true]);
        assert_eq!(outcome.load(Ordering::Acquire), CONTROL_LOST);
    }
}
