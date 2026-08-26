use std::fs::File;
use std::io::{Read, Write};
use std::sync::mpsc::{SyncSender, sync_channel};
use std::time::{Duration, Instant};

use anyhow::{Context, Result, anyhow, bail};
use serde::Serialize;
use serde::de::DeserializeOwned;

use crate::model::{
    ErrorMessage, ExitMessage, HelloMessage, ReadyMessage, SpawnMessage, StartedMessage,
};
use crate::protocol::{
    Frame, FrameKind, MAX_STREAM_BYTES, PROTOCOL_VERSION, read_frame, write_frame,
};
use crate::win::{
    connect_named_pipe_reader, connect_named_pipe_writer, current_logon_sid, current_token,
    protect_current_process, restricted_policy_token, spawn_target_suspended,
    suppress_system_error_dialogs, token_user_sid,
};

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

enum RunnerEvent {
    Output(FrameKind, Vec<u8>),
    OutputClosed,
    Failure(String, String),
    TerminateRequested,
}

fn pump_output(
    source: File,
    events: SyncSender<RunnerEvent>,
    kind: FrameKind,
) -> std::thread::JoinHandle<()> {
    std::thread::spawn(move || {
        let result = pump_output_stream(source, |payload| {
            events
                .send(RunnerEvent::Output(kind, payload.to_vec()))
                .map_err(|_| anyhow!("Windows sandbox runner event receiver closed"))
        });
        if let Err(error) = result {
            let _ = events.send(RunnerEvent::Failure("output".into(), format!("{error:#}")));
        }
        let _ = events.send(RunnerEvent::OutputClosed);
    })
}

fn pump_output_stream(
    mut source: impl Read,
    mut send: impl FnMut(&[u8]) -> Result<()>,
) -> Result<()> {
    let mut buffer = vec![0u8; MAX_STREAM_BYTES];
    loop {
        let count = match source.read(&mut buffer) {
            Ok(0) => return Ok(()),
            Ok(count) => count,
            Err(error) if error.kind() == std::io::ErrorKind::Interrupted => continue,
            Err(error) => return Err(error).context("read sandbox target output"),
        };
        send(&buffer[..count])?;
    }
}

fn start_control_pump(reader: File, target_stdin: File, events: SyncSender<RunnerEvent>) {
    std::thread::spawn(move || {
        run_control_pump(
            reader,
            target_stdin,
            || {
                let _ = events.send(RunnerEvent::TerminateRequested);
            },
            |stage, error| {
                let _ = events.send(RunnerEvent::Failure(stage.into(), format!("{error:#}")));
            },
        );
    });
}

fn run_control_pump(
    mut reader: impl Read,
    target_stdin: impl Write,
    mut terminate_target: impl FnMut(),
    mut report_error: impl FnMut(&str, &anyhow::Error),
) {
    let mut target_stdin = Some(target_stdin);
    let mut close_received = false;
    loop {
        let frame = match read_frame(&mut reader) {
            Ok(Some(frame)) => frame,
            Ok(None) => {
                terminate_target();
                return;
            }
            Err(error) => {
                report_error("control", &error);
                terminate_target();
                return;
            }
        };
        match frame.kind {
            FrameKind::Stdin if close_received => {
                let error = anyhow!("sandbox host sent stdin after closing target stdin");
                report_error("protocol", &error);
                terminate_target();
                return;
            }
            FrameKind::Stdin if target_stdin.is_some() => {
                if let Err(error) = target_stdin
                    .as_mut()
                    .expect("stdin presence checked above")
                    .write_all(&frame.payload)
                {
                    if error.kind() == std::io::ErrorKind::BrokenPipe {
                        // The target may close stdin before the host reaches EOF. Preserve
                        // protocol state so the host's one CloseStdin frame remains valid.
                        target_stdin = None;
                    } else {
                        let error = anyhow!(error).context("write sandbox target stdin");
                        report_error("stdin", &error);
                        terminate_target();
                        return;
                    }
                }
            }
            FrameKind::Stdin => {
                // The target already closed its pipe. Drain in-flight data until the host's
                // explicit CloseStdin without turning a normal early EPIPE into a run failure.
            }
            FrameKind::CloseStdin if !close_received => {
                close_received = true;
                target_stdin = None;
            }
            FrameKind::CloseStdin => {
                let error = anyhow!("sandbox host closed target stdin more than once");
                report_error("protocol", &error);
                terminate_target();
                return;
            }
            FrameKind::Terminate => {
                terminate_target();
                return;
            }
            unexpected => {
                let error = anyhow!("sandbox host sent unexpected {unexpected:?} frame");
                report_error("protocol", &error);
                terminate_target();
                return;
            }
        }
    }
}

#[cfg(test)]
fn announce_ready_resume_then_started(
    ready: &ReadyMessage,
    publish_ready: impl FnOnce(&ReadyMessage) -> Result<()>,
    authorize_resume: impl FnOnce() -> Result<()>,
    resume: impl FnOnce() -> Result<()>,
    publish_started: impl FnOnce(&StartedMessage) -> Result<()>,
) -> Result<()> {
    if !ready.job_contained {
        bail!("sandbox target must be Job-contained before Ready");
    }
    publish_ready(ready)?;
    authorize_resume()?;
    resume()?;
    publish_started(&StartedMessage {
        protocol: ready.protocol,
        pid: ready.pid,
    })
}

fn pipe_server_identity(pipe_name: &str, role: &str) -> Result<(u32, String)> {
    let suffix = pipe_name
        .strip_prefix(r"\\.\pipe\kodax-sandbox-v2-")
        .ok_or_else(|| anyhow!("Windows sandbox runner pipe name was not trusted"))?;
    let identity = suffix
        .strip_suffix(&format!("-{role}"))
        .ok_or_else(|| anyhow!("Windows sandbox runner pipe role was not trusted"))?;
    let (pid, nonce) = identity
        .split_once('-')
        .ok_or_else(|| anyhow!("Windows sandbox runner pipe identity was incomplete"))?;
    if nonce.len() != 32 || !nonce.bytes().all(|value| value.is_ascii_hexdigit()) {
        bail!("Windows sandbox runner pipe nonce was invalid");
    }
    let pid = pid
        .parse::<u32>()
        .context("parse Windows sandbox pipe host PID")?;
    if pid == 0 {
        bail!("Windows sandbox pipe host PID was invalid");
    }
    Ok((pid, nonce.to_ascii_lowercase()))
}

pub fn run(control_pipe_name: &str, event_pipe_name: &str, host_sid: &str) -> Result<()> {
    // This must be the first fallible operation: the ASRT account owns the
    // just-created process object, so OWNER RIGHTS must be denied before any
    // untrusted target can obtain process-control rights through that owner.
    // Targets inherit this process error mode. Startup failures remain visible
    // through their structured exit code instead of blocking unattended hosts
    // behind a Windows application-error dialog.
    suppress_system_error_dialogs();
    protect_current_process(host_sid)?;
    let current = current_token()?;
    let _runner_sid = token_user_sid(current.raw())?;
    let runner_logon_sid = current_logon_sid()?;
    // The trusted host creates a local-only, single-instance pipe with an unpredictable
    // name before ASRT launches this runner. The host authenticates this client by PID,
    // account/logon SID, exact ASRT ancestry and nonce. The runner authenticates the server
    // PID and echoed nonce without reopening a cross-account process.
    let (control_server_pid, control_nonce) = pipe_server_identity(control_pipe_name, "h2r")?;
    let (event_server_pid, event_nonce) = pipe_server_identity(event_pipe_name, "r2h")?;
    if control_server_pid != event_server_pid || control_nonce != event_nonce {
        bail!("Windows sandbox runner pipes did not share one authenticated identity");
    }
    let (mut control_pipe, actual_control_server_pid) =
        connect_named_pipe_reader(control_pipe_name)?;
    let (mut event_pipe, actual_event_server_pid) = connect_named_pipe_writer(event_pipe_name)?;
    if actual_control_server_pid != control_server_pid
        || actual_event_server_pid != event_server_pid
    {
        bail!("Windows sandbox pipe server PID did not match its authenticated name");
    }
    let session_nonce = control_nonce;

    write_json(
        &mut event_pipe,
        FrameKind::Hello,
        &HelloMessage {
            protocol: PROTOCOL_VERSION,
            pid: std::process::id(),
            logon_sid: runner_logon_sid.clone(),
            session_nonce: session_nonce.clone(),
        },
    )?;
    let spawn_frame = read_frame(&mut control_pipe)?
        .ok_or_else(|| anyhow!("Windows sandbox host disconnected before Spawn"))?;
    if spawn_frame.kind == FrameKind::Error {
        let error: ErrorMessage = serde_json::from_slice(&spawn_frame.payload)
            .context("decode Windows sandbox host error")?;
        bail!(
            "Windows sandbox host failed at {}: {}",
            error.stage,
            error.message
        );
    }
    let spawn: SpawnMessage = decode_json(spawn_frame, FrameKind::Spawn)?;
    if spawn.protocol != PROTOCOL_VERSION {
        bail!("Windows sandbox Spawn frame used an incompatible protocol");
    }
    if spawn.session_nonce != session_nonce {
        bail!("Windows sandbox Spawn frame did not authenticate the pipe session");
    }
    if spawn.target_argv.first().is_none_or(String::is_empty)
        || spawn.cwd.is_empty()
        || !spawn.policy_capability_sid.starts_with("S-1-5-21-")
    {
        bail!("Windows sandbox Spawn frame was incomplete");
    }

    let token = match restricted_policy_token(&spawn.policy_capability_sid) {
        Ok(token) => token,
        Err(error) => {
            write_json(
                &mut event_pipe,
                FrameKind::Error,
                &ErrorMessage {
                    protocol: PROTOCOL_VERSION,
                    stage: "token".into(),
                    message: format!("{error:#}"),
                },
            )?;
            return Err(error);
        }
    };
    let mut target = match spawn_target_suspended(
        token.raw(),
        &spawn.target_argv,
        &spawn.cwd,
        &spawn.target_environment,
        host_sid,
        &runner_logon_sid,
        &spawn.policy_capability_sid,
        &spawn.session_nonce,
    ) {
        Ok(target) => target,
        Err(error) => {
            write_json(
                &mut event_pipe,
                FrameKind::Error,
                &ErrorMessage {
                    protocol: PROTOCOL_VERSION,
                    stage: "target".into(),
                    message: format!("{error:#}"),
                },
            )?;
            return Err(error);
        }
    };
    let prepared_streams = (|| {
        Ok((
            target.take_stdin()?,
            target.take_stdout()?,
            target.take_stderr()?,
        ))
    })();
    let (target_stdin, target_stdout, target_stderr) = match prepared_streams {
        Ok(streams) => streams,
        Err(error) => {
            write_json(
                &mut event_pipe,
                FrameKind::Error,
                &ErrorMessage {
                    protocol: PROTOCOL_VERSION,
                    stage: "streams".into(),
                    message: format!("{error:#}"),
                },
            )?;
            return Err(error);
        }
    };
    let mut writer_file = event_pipe;
    let ready = ReadyMessage {
        protocol: PROTOCOL_VERSION,
        pid: target.pid,
        job_contained: true,
    };
    let start_result = (|| {
        if !ready.job_contained {
            bail!("sandbox target must be Job-contained before Ready");
        }
        write_json(&mut writer_file, FrameKind::Ready, &ready)?;
        let resume = read_frame(&mut control_pipe)?
            .ok_or_else(|| anyhow!("Windows sandbox host disconnected before Resume"))?;
        if resume.kind != FrameKind::Resume || !resume.payload.is_empty() {
            bail!("Windows sandbox host did not authorize Resume");
        }
        target.resume()?;
        write_json(
            &mut writer_file,
            FrameKind::Started,
            &StartedMessage {
                protocol: ready.protocol,
                pid: ready.pid,
            },
        )
    })();
    if let Err(error) = start_result {
        let _ = write_json(
            &mut writer_file,
            FrameKind::Error,
            &ErrorMessage {
                protocol: PROTOCOL_VERSION,
                stage: "resume".into(),
                message: format!("{error:#}"),
            },
        );
        return Err(error);
    }
    let (events_tx, events_rx) = sync_channel(8);
    let _stdout = pump_output(target_stdout, events_tx.clone(), FrameKind::Stdout);
    let _stderr = pump_output(target_stderr, events_tx.clone(), FrameKind::Stderr);
    start_control_pump(control_pipe, target_stdin, events_tx);

    let mut exit: Option<u32> = None;
    let mut stream_drain_deadline: Option<Instant> = None;
    let mut closed_streams = 0usize;
    loop {
        if exit.is_none()
            && let Some(code) = target.try_wait()?
        {
            // The shell root defines the command lifetime. Once it exits, close
            // the entire no-breakaway Job before reporting completion so a
            // background descendant cannot outlive the sandbox result.
            target.terminate_and_drain(1, Duration::from_secs(5))?;
            exit = Some(code);
            stream_drain_deadline = Some(Instant::now() + Duration::from_secs(5));
            if closed_streams == 2 {
                break;
            }
        }
        if stream_drain_deadline.is_some_and(|deadline| Instant::now() >= deadline) {
            bail!("Windows sandbox output streams did not drain after the Job became empty");
        }
        let mut handled_event = true;
        match events_rx.try_recv() {
            Ok(RunnerEvent::Output(kind, payload)) => {
                write_frame(&mut writer_file, kind, &payload)?;
            }
            Ok(RunnerEvent::OutputClosed) => {
                closed_streams += 1;
                if closed_streams == 2 && exit.is_some() {
                    break;
                }
            }
            Ok(RunnerEvent::Failure(stage, message)) => {
                let error = ErrorMessage {
                    protocol: PROTOCOL_VERSION,
                    stage,
                    message,
                };
                let report_failure = write_json(&mut writer_file, FrameKind::Error, &error).err();
                let drain_failure = target.terminate_and_drain(1, Duration::from_secs(5)).err();
                match (report_failure, drain_failure) {
                    (Some(report), Some(drain)) => bail!(
                        "Windows sandbox runner stream failed; reporting failed: {report:#}; Job drain failed: {drain:#}"
                    ),
                    (Some(report), None) => return Err(report),
                    (None, Some(drain)) => return Err(drain),
                    (None, None) => {}
                }
                bail!("Windows sandbox runner stream failed");
            }
            Ok(RunnerEvent::TerminateRequested) => {
                target.terminate_and_drain(1, Duration::from_secs(5))?;
            }
            Err(std::sync::mpsc::TryRecvError::Empty) => handled_event = false,
            Err(std::sync::mpsc::TryRecvError::Disconnected) if exit.is_some() => break,
            Err(std::sync::mpsc::TryRecvError::Disconnected) => {
                bail!("Windows sandbox runner event channel closed before target exit");
            }
        }
        if !handled_event {
            std::thread::sleep(Duration::from_millis(10));
        }
    }
    let code = exit.ok_or_else(|| anyhow!("Windows sandbox output closed before target exit"))?;
    write_json(
        &mut writer_file,
        FrameKind::Exit,
        &ExitMessage {
            protocol: PROTOCOL_VERSION,
            code,
        },
    )?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use std::cell::{Cell, RefCell};
    use std::io::{self, Cursor, Read, Write};
    use std::rc::Rc;
    use std::sync::mpsc;
    use std::time::Duration;

    use super::*;

    #[test]
    fn directional_pipe_names_must_share_one_pid_and_nonce() {
        let nonce = "0123456789abcdef0123456789abcdef";
        let control = format!(r"\\.\pipe\kodax-sandbox-v2-1234-{nonce}-h2r");
        let events = format!(r"\\.\pipe\kodax-sandbox-v2-1234-{nonce}-r2h");
        assert_eq!(
            pipe_server_identity(&control, "h2r").unwrap(),
            pipe_server_identity(&events, "r2h").unwrap(),
        );
        assert!(pipe_server_identity(&control, "r2h").is_err());
        assert!(
            pipe_server_identity(
                r"\\.\pipe\kodax-sandbox-v2-1235-fedcba9876543210fedcba9876543210-r2h",
                "r2h",
            )
            .unwrap()
                != pipe_server_identity(&control, "h2r").unwrap()
        );
    }

    fn encoded_frames(frames: &[(FrameKind, &[u8])]) -> Vec<u8> {
        let mut encoded = Vec::new();
        for (kind, payload) in frames {
            write_frame(&mut encoded, *kind, payload).unwrap();
        }
        encoded
    }

    struct RecordingSink(Rc<RefCell<Vec<u8>>>);

    impl Write for RecordingSink {
        fn write(&mut self, buffer: &[u8]) -> io::Result<usize> {
            self.0.borrow_mut().extend_from_slice(buffer);
            Ok(buffer.len())
        }

        fn flush(&mut self) -> io::Result<()> {
            Ok(())
        }
    }

    struct BrokenSink;

    impl Write for BrokenSink {
        fn write(&mut self, _buffer: &[u8]) -> io::Result<usize> {
            Err(io::Error::new(
                io::ErrorKind::BrokenPipe,
                "target closed stdin",
            ))
        }

        fn flush(&mut self) -> io::Result<()> {
            Ok(())
        }
    }

    #[test]
    fn control_pump_preserves_binary_stdin_and_honors_terminate() {
        let encoded = encoded_frames(&[
            (FrameKind::Stdin, b"\0\xfffirst"),
            (FrameKind::Stdin, b"\x80second"),
            (FrameKind::CloseStdin, b""),
            (FrameKind::Terminate, b""),
        ]);
        let output = Rc::new(RefCell::new(Vec::new()));
        let terminated = Cell::new(0usize);
        let errors = RefCell::new(Vec::new());

        run_control_pump(
            Cursor::new(encoded),
            RecordingSink(Rc::clone(&output)),
            || terminated.set(terminated.get() + 1),
            |stage, error| errors.borrow_mut().push(format!("{stage}: {error:#}")),
        );

        assert_eq!(&*output.borrow(), b"\0\xfffirst\x80second");
        assert_eq!(terminated.get(), 1);
        assert!(errors.borrow().is_empty());
    }

    #[test]
    fn output_pump_preserves_large_binary_streams_with_synchronous_backpressure() {
        struct CountingReader {
            reads: Rc<Cell<usize>>,
            input: Cursor<Vec<u8>>,
        }

        impl Read for CountingReader {
            fn read(&mut self, buffer: &mut [u8]) -> io::Result<usize> {
                self.reads.set(self.reads.get() + 1);
                self.input.read(buffer)
            }
        }

        let input = (0..(4 * 1024 * 1024 + 31))
            .map(|index| (index % 256) as u8)
            .collect::<Vec<_>>();
        let reads = Rc::new(Cell::new(0usize));
        let mut sends = 0usize;
        let mut output = Vec::new();
        pump_output_stream(
            CountingReader {
                reads: Rc::clone(&reads),
                input: Cursor::new(input.clone()),
            },
            |payload| {
                sends += 1;
                assert_eq!(reads.get(), sends);
                assert!(payload.len() <= MAX_STREAM_BYTES);
                output.extend_from_slice(payload);
                Ok(())
            },
        )
        .unwrap();

        assert_eq!(output, input);
        assert_eq!(reads.get(), sends + 1);
    }

    #[test]
    fn independent_command_streams_do_not_share_a_lifecycle_lock() {
        let (first_started_tx, first_started_rx) = mpsc::channel();
        let (release_first_tx, release_first_rx) = mpsc::channel();
        let first = std::thread::spawn(move || {
            pump_output_stream(Cursor::new(b"first"), |_| {
                first_started_tx.send(()).unwrap();
                release_first_rx.recv().unwrap();
                Ok(())
            })
            .unwrap();
        });
        first_started_rx.recv().unwrap();

        let (second_done_tx, second_done_rx) = mpsc::channel();
        let second = std::thread::spawn(move || {
            pump_output_stream(Cursor::new(b"second"), |_| Ok(())).unwrap();
            second_done_tx.send(()).unwrap();
        });
        second_done_rx
            .recv_timeout(Duration::from_secs(1))
            .expect("an unrelated command stream was blocked by the first command");

        release_first_tx.send(()).unwrap();
        first.join().unwrap();
        second.join().unwrap();
    }

    #[test]
    fn early_epipe_still_accepts_the_hosts_single_close_frame() {
        let encoded = encoded_frames(&[
            (FrameKind::Stdin, b"already closed"),
            (FrameKind::CloseStdin, b""),
            (FrameKind::Terminate, b""),
        ]);
        let terminated = Cell::new(0usize);
        let errors = RefCell::new(Vec::new());

        run_control_pump(
            Cursor::new(encoded),
            BrokenSink,
            || terminated.set(terminated.get() + 1),
            |stage, error| errors.borrow_mut().push(format!("{stage}: {error:#}")),
        );

        assert_eq!(terminated.get(), 1);
        assert!(errors.borrow().is_empty());
    }

    #[test]
    fn duplicate_close_is_rejected_and_terminates_the_target_once() {
        let encoded = encoded_frames(&[(FrameKind::CloseStdin, b""), (FrameKind::CloseStdin, b"")]);
        let terminated = Cell::new(0usize);
        let errors = RefCell::new(Vec::new());

        run_control_pump(
            Cursor::new(encoded),
            io::sink(),
            || terminated.set(terminated.get() + 1),
            |stage, error| errors.borrow_mut().push(format!("{stage}: {error:#}")),
        );

        assert_eq!(terminated.get(), 1);
        assert_eq!(errors.borrow().len(), 1);
        assert!(errors.borrow()[0].contains("more than once"));
    }

    #[test]
    fn peer_loss_terminates_the_target_once() {
        let terminated = Cell::new(0usize);
        let errors = RefCell::new(Vec::new());

        run_control_pump(
            Cursor::new(Vec::<u8>::new()),
            io::sink(),
            || terminated.set(terminated.get() + 1),
            |stage, error| errors.borrow_mut().push(format!("{stage}: {error:#}")),
        );

        assert_eq!(terminated.get(), 1);
        assert!(errors.borrow().is_empty());
    }

    #[test]
    fn ready_precedes_resume_and_started_follows_resume() {
        let events = RefCell::new(Vec::new());
        let ready = ReadyMessage {
            protocol: PROTOCOL_VERSION,
            pid: 42,
            job_contained: true,
        };

        announce_ready_resume_then_started(
            &ready,
            |_| {
                events.borrow_mut().push("ready");
                Ok(())
            },
            || {
                events.borrow_mut().push("authorized");
                Ok(())
            },
            || {
                events.borrow_mut().push("resume");
                Ok(())
            },
            |_| {
                events.borrow_mut().push("started");
                Ok(())
            },
        )
        .unwrap();

        assert_eq!(
            &*events.borrow(),
            &["ready", "authorized", "resume", "started"]
        );
    }

    #[test]
    fn ready_failure_missing_containment_or_resume_failure_never_publish_started() {
        let resumes = Cell::new(0usize);
        let started = Cell::new(0usize);
        let ready = ReadyMessage {
            protocol: PROTOCOL_VERSION,
            pid: 42,
            job_contained: true,
        };
        let result = announce_ready_resume_then_started(
            &ready,
            |_| Err(anyhow!("publish failed")),
            || Ok(()),
            || {
                resumes.set(resumes.get() + 1);
                Ok(())
            },
            |_| {
                started.set(started.get() + 1);
                Ok(())
            },
        );
        assert!(result.is_err());

        let result = announce_ready_resume_then_started(
            &ReadyMessage {
                job_contained: false,
                ..ready
            },
            |_| Ok(()),
            || Ok(()),
            || {
                resumes.set(resumes.get() + 1);
                Ok(())
            },
            |_| {
                started.set(started.get() + 1);
                Ok(())
            },
        );
        assert!(result.is_err());

        let result = announce_ready_resume_then_started(
            &ready,
            |_| Ok(()),
            || Ok(()),
            || Err(anyhow!("resume failed")),
            |_| {
                started.set(started.get() + 1);
                Ok(())
            },
        );
        assert!(result.is_err());
        assert_eq!(resumes.get(), 0);
        assert_eq!(started.get(), 0);
    }
}
