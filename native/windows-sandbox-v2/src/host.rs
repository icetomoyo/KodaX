use std::fs::{File, OpenOptions};
use std::io::{Read, Write};
use std::os::windows::fs::{MetadataExt, OpenOptionsExt};
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
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

use crate::acl::{ensure_allow_aces, ensure_execution_denies};
use crate::model::{
    BootstrapRequest, ErrorMessage, ExitMessage, HelloMessage, ReadyMessage, RunRequest,
    SpawnMessage, StartedMessage, controller_pipe_server_pid,
};
use crate::protocol::{
    Frame, FrameKind, MAX_STREAM_BYTES, PROTOCOL_VERSION, read_frame, write_frame,
};
use crate::win::{
    NamedPipeServer, OwnedHandle, PrivateDesktop, SpawnedHostChild, connect_controller_pipe,
    current_token, disconnect_named_pipe, named_pipe_available_bytes, named_pipe_client_identity,
    process_is_descendant_of, spawn_asrt_launcher, terminate_process, token_user_sid,
    verify_protected_runner_process,
};

const MAX_REQUEST_BYTES: u64 = 1024 * 1024;
const MAX_BOOTSTRAP_BYTES: usize = 512 * 1024;

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

    fn finish(mut self) -> Result<()> {
        self.stop.store(true, Ordering::Release);
        self.join()?;
        if self.expired.load(Ordering::Acquire) {
            bail!("Windows sandbox launch deadline expired before Started");
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

fn write_locked(writer: &Arc<Mutex<File>>, kind: FrameKind, payload: &[u8]) -> Result<()> {
    let mut writer = writer
        .lock()
        .map_err(|_| anyhow!("Windows sandbox protocol writer lock was poisoned"))?;
    write_frame(&mut *writer, kind, payload)
}

fn pump_stdin(mut input: impl Read, mut send: impl FnMut(FrameKind, &[u8]) -> Result<()>) {
    let mut buffer = vec![0u8; MAX_STREAM_BYTES];
    loop {
        let count = match input.read(&mut buffer) {
            Ok(0) => {
                let _ = send(FrameKind::CloseStdin, &[]);
                return;
            }
            Ok(count) => count,
            Err(error) if error.kind() == std::io::ErrorKind::Interrupted => continue,
            Err(_) => {
                let _ = send(FrameKind::Terminate, &[]);
                return;
            }
        };
        if send(FrameKind::Stdin, &buffer[..count]).is_err() {
            return;
        }
    }
}

fn start_stdin_pump(writer: Arc<Mutex<File>>) {
    std::thread::spawn(move || {
        let input = std::io::stdin().lock();
        pump_stdin(input, |kind, payload| write_locked(&writer, kind, payload));
    });
}

pub fn run(request_path: &Path) -> Result<u32> {
    let request = read_request(request_path)?;
    let deadline = LaunchDeadline::from_unix_ms(request.launch_deadline_unix_ms)?;
    let bootstrap = read_bootstrap(std::io::stdin().lock())?;
    deadline.ensure("bootstrap")?;
    let (controller, controller_pid) = connect_controller_pipe(&request.controller_pipe)?;
    if controller_pid != controller_pipe_server_pid(&request.controller_pipe)? {
        bail!("Windows sandbox controller pipe server PID did not match its authenticated name");
    }
    deadline.ensure("controller authentication")?;
    let current = current_token()?;
    let host_sid = token_user_sid(current.raw())?;
    if host_sid == request.sandbox_user_sid {
        bail!("Windows sandbox host must not run as the restricted account");
    }
    let executable = std::env::current_exe().context("resolve Windows sandbox executable")?;
    let runner_directory = executable
        .parent()
        .ok_or_else(|| anyhow!("Windows sandbox executable has no parent"))?;
    deadline.ensure("ACL authorization")?;
    ensure_allow_aces(&request, runner_directory)?;
    deadline.ensure("ACL authorization")?;

    let server = NamedPipeServer::create(&host_sid, &request.sandbox_user_sid)?;
    let session_nonce = server.session_nonce.clone();
    let desktop = PrivateDesktop::create(
        &host_sid,
        &request.sandbox_group_sid,
        &request.policy_capability_sid,
        &session_nonce,
    )?;
    let mut asrt_args = request.asrt_prefix_args.clone();
    asrt_args.push(executable.to_string_lossy().into_owned());
    asrt_args.push("__runner".into());
    asrt_args.push(server.name.clone());
    asrt_args.push(host_sid.clone());
    deadline.ensure("ASRT creation")?;
    let mut child = spawn_asrt_launcher(&request.asrt_executable, &asrt_args, &request.cwd)?;
    let abort = HostAbort::new(child.abort_process()?);
    let controller_monitor = ControllerMonitor::start(controller, abort.clone());
    let launch_watchdog = LaunchWatchdog::start(deadline.0, abort.clone());
    deadline.ensure("ASRT resume")?;
    child.resume()?;
    child.start_diagnostic_pump();
    let (pipe, client_pid) = connect_runner(server, &child, deadline)?;
    if !process_is_descendant_of(client_pid, child.pid)? {
        bail!(
            "Windows sandbox runner did not descend from the exact ASRT launcher {}",
            child.pid,
        );
    }
    let mut hello_reader = pipe
        .try_clone()
        .context("clone pipe for runner authentication")?;
    let hello: HelloMessage = decode_json(
        next_frame(&mut hello_reader, FrameKind::Hello)?,
        FrameKind::Hello,
    )?;
    drop(hello_reader);
    // Windows permits named-pipe client impersonation only after the server has read
    // client data. The authenticated Hello above establishes that ordering.
    let (client_sid, client_logon_sid, client_restricted) = named_pipe_client_identity(&pipe)?;
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
        pipe.try_clone()
            .context("clone authenticated Windows sandbox abort pipe")?,
    )?;
    child.close_launch_stdin();

    // relay() owns the protocol read cursor. Re-open its first message by passing the
    // authenticated Hello explicitly would add a second state machine, so authentication
    // above reads from a clone only for identity and relay starts at the shared cursor.
    // Named-pipe handles share their file position; the next frame is Spawn/Ready traffic.
    relay_after_hello(
        pipe,
        &request,
        hello,
        bootstrap,
        controller_monitor,
        launch_watchdog,
        deadline,
        abort,
        desktop,
    )
}

#[allow(clippy::too_many_arguments)] // Own all authenticated launch guards until Exit.
fn relay_after_hello(
    mut pipe: File,
    request: &RunRequest,
    hello: HelloMessage,
    bootstrap: BootstrapRequest,
    controller_monitor: ControllerMonitor,
    launch_watchdog: LaunchWatchdog,
    deadline: LaunchDeadline,
    _abort: HostAbort,
    _desktop: PrivateDesktop,
) -> Result<u32> {
    if hello.protocol != PROTOCOL_VERSION {
        bail!("Windows sandbox runner reported an incompatible protocol");
    }
    ensure_execution_denies(
        request,
        std::env::current_exe()?
            .parent()
            .ok_or_else(|| anyhow!("Windows sandbox executable has no parent"))?,
        &hello.logon_sid,
    )?;
    deadline.ensure("execution deny verification")?;
    let mut writer_file = pipe
        .try_clone()
        .context("clone Windows sandbox pipe writer")?;
    write_json(
        &mut writer_file,
        FrameKind::Spawn,
        &SpawnMessage {
            protocol: PROTOCOL_VERSION,
            target_argv: request.target_argv.clone(),
            cwd: request.cwd.clone(),
            policy_capability_sid: request.policy_capability_sid.clone(),
            session_nonce: hello.session_nonce.clone(),
            target_environment: bootstrap.target_environment,
        },
    )?;
    let ready: ReadyMessage =
        decode_json(next_frame(&mut pipe, FrameKind::Ready)?, FrameKind::Ready)?;
    deadline.ensure("Ready")?;
    if ready.protocol != PROTOCOL_VERSION || !ready.job_contained {
        bail!("Windows sandbox target was not proven contained before resume");
    }
    deadline.ensure("target resume")?;
    write_frame(&mut writer_file, FrameKind::Resume, &[])?;
    let started: StartedMessage = decode_json(
        next_frame(&mut pipe, FrameKind::Started)?,
        FrameKind::Started,
    )?;
    validate_started(&ready, &started)?;
    deadline.ensure("Started")?;
    launch_watchdog.finish()?;
    let writer = Arc::new(Mutex::new(writer_file));
    start_stdin_pump(Arc::clone(&writer));
    loop {
        let frame = read_frame(&mut pipe)?
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
                return Ok(exit.code);
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
    use std::io::{self, Cursor, Read};
    use std::rc::Rc;

    use super::*;

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
    fn empty_stdin_emits_exactly_one_close_frame() {
        let mut frames = Vec::new();
        pump_stdin(Cursor::new(Vec::<u8>::new()), |kind, payload| {
            frames.push((kind, payload.to_vec()));
            Ok(())
        });

        assert_eq!(frames, vec![(FrameKind::CloseStdin, Vec::new())]);
    }

    #[test]
    fn binary_and_large_stdin_are_lossless_and_bounded() {
        let input = (0..(4 * 1024 * 1024 + 17))
            .map(|index| (index % 256) as u8)
            .collect::<Vec<_>>();
        let mut frames = Vec::new();
        pump_stdin(Cursor::new(input.clone()), |kind, payload| {
            frames.push((kind, payload.to_vec()));
            Ok(())
        });

        assert_eq!(frames.last(), Some(&(FrameKind::CloseStdin, Vec::new())));
        assert!(
            frames[..frames.len() - 1]
                .iter()
                .all(|(kind, payload)| *kind == FrameKind::Stdin
                    && payload.len() <= MAX_STREAM_BYTES)
        );
        let output = frames[..frames.len() - 1]
            .iter()
            .flat_map(|(_, payload)| payload.iter().copied())
            .collect::<Vec<_>>();
        assert_eq!(output, input);
    }

    #[test]
    fn stdin_pump_applies_synchronous_backpressure_to_a_slow_peer() {
        struct CountingReader {
            reads: Rc<Cell<usize>>,
            remaining: usize,
        }

        impl Read for CountingReader {
            fn read(&mut self, buffer: &mut [u8]) -> io::Result<usize> {
                self.reads.set(self.reads.get() + 1);
                if self.remaining == 0 {
                    return Ok(0);
                }
                let count = self.remaining.min(buffer.len()).min(3);
                buffer[..count].fill(b'x');
                self.remaining -= count;
                Ok(count)
            }
        }

        let reads = Rc::new(Cell::new(0));
        let mut sent = 0usize;
        pump_stdin(
            CountingReader {
                reads: Rc::clone(&reads),
                remaining: 9,
            },
            |kind, _| {
                if kind == FrameKind::Stdin {
                    sent += 1;
                    assert_eq!(reads.get(), sent);
                }
                Ok(())
            },
        );
        assert_eq!(sent, 3);
        assert_eq!(reads.get(), 4);
    }

    #[test]
    fn peer_write_failure_stops_without_sending_a_late_close() {
        let mut kinds = Vec::new();
        pump_stdin(Cursor::new(b"input"), |kind, _| {
            kinds.push(kind);
            Err(anyhow!("peer disconnected"))
        });

        assert_eq!(kinds, vec![FrameKind::Stdin]);
    }

    #[test]
    fn stdin_read_failure_requests_termination_once() {
        struct FailedInput;

        impl Read for FailedInput {
            fn read(&mut self, _buffer: &mut [u8]) -> io::Result<usize> {
                Err(io::Error::other("stdin failed"))
            }
        }

        let mut kinds = Vec::new();
        pump_stdin(FailedInput, |kind, _| {
            kinds.push(kind);
            Ok(())
        });

        assert_eq!(kinds, vec![FrameKind::Terminate]);
    }
}
