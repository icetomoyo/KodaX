use std::fs::{File, OpenOptions};
use std::io::{Read, Write};
use std::os::windows::fs::{MetadataExt, OpenOptionsExt};
use std::path::Path;
use std::sync::atomic::{AtomicBool, AtomicU8, Ordering};
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use anyhow::{Context, Result, anyhow, bail};
use serde::Serialize;
use serde::de::DeserializeOwned;
use windows::Win32::Storage::FileSystem::{
    DELETE, FILE_ATTRIBUTE_REPARSE_POINT, FILE_FLAG_DELETE_ON_CLOSE, FILE_FLAG_OPEN_REPARSE_POINT,
    FILE_GENERIC_READ,
};

use crate::acl::{
    ExecutionDenyCleanup, ensure_policy_aces_until, install_execution_deny_read_until,
    recover_stale_execution_denies_until, verify_control_directory_boundary,
};
use crate::model::{
    BootstrapRequest, ErrorMessage, ExitMessage, HelloMessage, ReadyMessage, RunRequest,
    SpawnMessage, StartedMessage, TerminalRecord, controller_pipe_server_pid,
};
#[cfg(test)]
use crate::protocol::MAX_STREAM_BYTES;
use crate::protocol::{Frame, FrameKind, PROTOCOL_VERSION, read_frame, write_frame};
use crate::win::{
    NamedPipeServer, NamedPipeServers, OwnedHandle, PrivateDesktop, SpawnedHostChild,
    connect_controller_pipe, current_token, disconnect_named_pipe, named_pipe_available_bytes,
    named_pipe_client_identity, process_creation_time, process_is_descendant_of,
    spawn_asrt_launcher, terminate_process, token_user_sid, verify_protected_runner_process,
};

const MAX_REQUEST_BYTES: u64 = 1024 * 1024;
const MAX_BOOTSTRAP_BYTES: usize = 512 * 1024;
pub const TERMINATION_CONFIRMED_EXIT_CODE: u32 = 254;
const CONTROL_OPEN: u8 = 0;
const CONTROL_TERMINATION_REQUESTED: u8 = 1;
const CONTROL_LOST: u8 = 2;
const LAUNCH_PHASE_TIMEOUT: Duration = Duration::from_secs(30);

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum ControllerOutcome {
    Stopped,
    Lost,
}

#[derive(Clone)]
struct HostAbort {
    requested: Arc<AtomicBool>,
    runner_pipe: Arc<Mutex<Option<File>>>,
    asrt_process: Arc<OwnedHandle>,
}

impl HostAbort {
    fn new(asrt_process: OwnedHandle) -> Self {
        Self {
            requested: Arc::new(AtomicBool::new(false)),
            runner_pipe: Arc::new(Mutex::new(None)),
            asrt_process: Arc::new(asrt_process),
        }
    }

    fn request(&self) {
        self.requested.store(true, Ordering::Release);
        let _ = terminate_process(&self.asrt_process, 1);
        if let Ok(mut pipe) = self.runner_pipe.lock()
            && let Some(pipe) = pipe.take()
        {
            let _ = disconnect_named_pipe(&pipe);
        }
    }

    fn attach_runner(&self, pipe: File) -> Result<()> {
        let mut slot = self
            .runner_pipe
            .lock()
            .map_err(|_| anyhow!("Windows sandbox abort pipe lock was poisoned"))?;
        if slot.is_some() {
            bail!("Windows sandbox abort pipe was already attached");
        }
        *slot = Some(pipe);
        if self.requested.load(Ordering::Acquire) {
            if let Some(pipe) = slot.take() {
                disconnect_named_pipe(&pipe)?;
            }
            bail!("Windows sandbox launch was aborted before runner authentication completed");
        }
        Ok(())
    }

    fn ensure_open(&self, stage: &str) -> Result<()> {
        if self.requested.load(Ordering::Acquire) {
            bail!("Windows sandbox launch was aborted during {stage}");
        }
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

fn read_and_retire_request_file(path: &Path) -> Result<Vec<u8>> {
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

fn write_json<T: Serialize>(writer: &mut impl Write, kind: FrameKind, value: &T) -> Result<()> {
    let payload = serde_json::to_vec(value).context("encode Windows sandbox protocol message")?;
    write_frame(writer, kind, &payload)
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

fn pump_control(
    mut input: impl Read,
    outcome: &AtomicU8,
    mut send: impl FnMut(FrameKind, &[u8]) -> Result<()>,
) {
    loop {
        match read_frame(&mut input) {
            Ok(Some(frame)) if matches!(frame.kind, FrameKind::Stdin | FrameKind::CloseStdin) => {
                if send(frame.kind, &frame.payload).is_err() {
                    outcome.store(CONTROL_LOST, Ordering::Release);
                    return;
                }
            }
            Ok(Some(frame)) if frame.kind == FrameKind::Terminate => {
                outcome.store(CONTROL_TERMINATION_REQUESTED, Ordering::Release);
                if send(FrameKind::Terminate, &[]).is_err() {
                    outcome.store(CONTROL_LOST, Ordering::Release);
                }
                return;
            }
            Ok(Some(_)) | Ok(None) | Err(_) => {
                outcome.store(CONTROL_LOST, Ordering::Release);
                let _ = send(FrameKind::Terminate, &[]);
                return;
            }
        }
    }
}

fn start_control_pump(mut writer: File, outcome: Arc<AtomicU8>) {
    std::thread::spawn(move || {
        let input = std::io::stdin().lock();
        pump_control(input, &outcome, |kind, payload| {
            write_frame(&mut writer, kind, payload)
        });
    });
}

pub fn run(request_path: &Path) -> Result<u32> {
    let request = read_request(request_path)?;
    validate_terminal_record_path(request_path, Path::new(&request.terminal_record_path))?;
    let deadline = LaunchDeadline::from_unix_ms(request.operation_deadline_unix_ms)?;
    let current = current_token()?;
    let host_sid = token_user_sid(current.raw())?;
    let control_directory = request_path
        .parent()
        .ok_or_else(|| anyhow!("Windows sandbox request has no control directory"))?;
    verify_control_directory_boundary(&request, control_directory, &host_sid)?;
    recover_stale_execution_denies_until(control_directory, request.operation_deadline_unix_ms)?;
    if host_sid == request.sandbox_user_sid {
        bail!("Windows sandbox host must not run as the restricted account");
    }
    let bootstrap = read_bootstrap(std::io::stdin().lock())?;
    deadline.ensure("bootstrap")?;
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
    let abort = HostAbort::new(child.abort_process()?);
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
    verify_protected_runner_process(client_pid, &host_sid, &request.sandbox_user_sid)?;
    abort.attach_runner(
        control_pipe
            .try_clone()
            .context("clone authenticated Windows sandbox abort pipe")?,
    )?;
    child.close_launch_stdin();
    let runner_creation_time = process_creation_time(client_pid)?
        .ok_or_else(|| anyhow!("Windows sandbox runner exited after authentication"))?;
    runner_watchdog.finish("runner authentication")?;
    let execution_deny_lease = install_execution_deny_read_until(
        &request,
        control_directory,
        &client_logon_sid,
        client_pid,
        request.operation_deadline_unix_ms,
    )?;
    deadline.ensure("denyRead authorization")?;
    abort.ensure_open("denyRead authorization")?;
    if process_creation_time(client_pid)? != Some(runner_creation_time) {
        bail!("Windows sandbox runner identity changed during denyRead authorization");
    }
    let target_watchdog =
        LaunchWatchdog::start(deadline.phase_deadline(LAUNCH_PHASE_TIMEOUT), abort.clone());

    let relay_result = relay_after_hello(
        event_pipe,
        control_pipe,
        &request,
        hello,
        bootstrap,
        filesystem_capability_sids,
        controller_monitor,
        target_watchdog,
        deadline,
        abort,
        desktop,
    );
    let settlement = relay_result?;
    finalize_drained_run(
        settlement,
        || match execution_deny_lease {
            Some(lease) => match lease.finish() {
                ExecutionDenyCleanup::Completed => Ok(None),
                ExecutionDenyCleanup::Deferred(diagnostic) => Ok(Some(diagnostic)),
                ExecutionDenyCleanup::Failed(error) => {
                    Err(error.context("clean Windows denyRead execution ACLs"))
                }
            },
            None => Ok(None),
        },
        |record| write_terminal_record(Path::new(&request.terminal_record_path), record),
        &request.terminal_nonce,
    )
}

struct RelaySettlement {
    host_exit_code: u32,
    target_exit_code: u32,
    termination_requested: bool,
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
    mut control_pipe: File,
    request: &RunRequest,
    hello: HelloMessage,
    bootstrap: BootstrapRequest,
    filesystem_capability_sids: Vec<String>,
    controller_monitor: ControllerMonitor,
    launch_watchdog: LaunchWatchdog,
    deadline: LaunchDeadline,
    _abort: HostAbort,
    _desktop: PrivateDesktop,
) -> Result<RelaySettlement> {
    if hello.protocol != PROTOCOL_VERSION {
        bail!("Windows sandbox runner reported an incompatible protocol");
    }
    write_json(
        &mut control_pipe,
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
    write_frame(&mut control_pipe, FrameKind::Resume, &[])?;
    let started: StartedMessage = decode_json(
        next_frame(&mut event_pipe, FrameKind::Started)?,
        FrameKind::Started,
    )?;
    validate_started(&ready, &started)?;
    deadline.ensure("Started")?;
    launch_watchdog.finish("target Started")?;
    let control_outcome = Arc::new(AtomicU8::new(CONTROL_OPEN));
    start_control_pump(control_pipe, Arc::clone(&control_outcome));
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
    fn close_stdin_keeps_control_open_until_terminate() {
        let mut input = Vec::new();
        write_frame(&mut input, FrameKind::CloseStdin, &[]).unwrap();
        write_frame(&mut input, FrameKind::Terminate, &[]).unwrap();
        let mut frames = Vec::new();
        let outcome = AtomicU8::new(CONTROL_OPEN);
        pump_control(Cursor::new(input), &outcome, |kind, payload| {
            if kind == FrameKind::Terminate {
                assert_eq!(
                    outcome.load(Ordering::Acquire),
                    CONTROL_TERMINATION_REQUESTED,
                );
            }
            frames.push((kind, payload.to_vec()));
            Ok(())
        });

        assert_eq!(
            frames,
            vec![
                (FrameKind::CloseStdin, Vec::new()),
                (FrameKind::Terminate, Vec::new()),
            ]
        );
        assert_eq!(
            outcome.load(Ordering::Acquire),
            CONTROL_TERMINATION_REQUESTED
        );
    }

    #[test]
    fn binary_and_large_control_stdin_are_lossless_and_bounded() {
        let input = (0..(4 * 1024 * 1024 + 17))
            .map(|index| (index % 256) as u8)
            .collect::<Vec<_>>();
        let mut encoded = Vec::new();
        for chunk in input.chunks(MAX_STREAM_BYTES) {
            write_frame(&mut encoded, FrameKind::Stdin, chunk).unwrap();
        }
        write_frame(&mut encoded, FrameKind::CloseStdin, &[]).unwrap();
        write_frame(&mut encoded, FrameKind::Terminate, &[]).unwrap();
        let mut frames = Vec::new();
        let outcome = AtomicU8::new(CONTROL_OPEN);
        pump_control(Cursor::new(encoded), &outcome, |kind, payload| {
            frames.push((kind, payload.to_vec()));
            Ok(())
        });

        assert_eq!(frames.last(), Some(&(FrameKind::Terminate, Vec::new())));
        assert!(
            frames[..frames.len() - 2]
                .iter()
                .all(|(kind, payload)| *kind == FrameKind::Stdin
                    && payload.len() <= MAX_STREAM_BYTES)
        );
        let output = frames[..frames.len() - 2]
            .iter()
            .flat_map(|(_, payload)| payload.iter().copied())
            .collect::<Vec<_>>();
        assert_eq!(output, input);
        assert_eq!(
            outcome.load(Ordering::Acquire),
            CONTROL_TERMINATION_REQUESTED
        );
    }

    #[test]
    fn peer_write_failure_marks_control_lost() {
        let mut input = Vec::new();
        write_frame(&mut input, FrameKind::Stdin, b"input").unwrap();
        let mut kinds = Vec::new();
        let outcome = AtomicU8::new(CONTROL_OPEN);
        pump_control(Cursor::new(input), &outcome, |kind, _| {
            kinds.push(kind);
            Err(anyhow!("peer disconnected"))
        });

        assert_eq!(kinds, vec![FrameKind::Stdin]);
        assert_eq!(outcome.load(Ordering::Acquire), CONTROL_LOST);
    }

    #[test]
    fn control_eof_requests_fail_closed_termination_once() {
        let mut kinds = Vec::new();
        let outcome = AtomicU8::new(CONTROL_OPEN);
        pump_control(Cursor::new(Vec::<u8>::new()), &outcome, |kind, _| {
            kinds.push(kind);
            Ok(())
        });

        assert_eq!(kinds, vec![FrameKind::Terminate]);
        assert_eq!(outcome.load(Ordering::Acquire), CONTROL_LOST);
    }
}
