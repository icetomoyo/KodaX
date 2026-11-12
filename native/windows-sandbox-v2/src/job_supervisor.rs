//! Daemon Job owner. Replaces the PowerShell + `Add-Type` supervisor: nothing is
//! compiled at startup, so antivirus scans or a loaded machine cannot stall it.
use crate::win::{wide, OwnedHandle};
use anyhow::{ensure, Context, Result};
use serde::Deserialize;
use std::mem::{size_of, zeroed};
use std::os::windows::io::AsRawHandle;
use windows::core::{PCWSTR, PWSTR};
use windows::Win32::Foundation::{GetLastError, ERROR_ALREADY_EXISTS, HANDLE, WAIT_FAILED};
use windows::Win32::System::JobObjects::{
    AssignProcessToJobObject, CreateJobObjectW, JobObjectBasicAccountingInformation,
    JobObjectExtendedLimitInformation, QueryInformationJobObject, SetInformationJobObject,
    TerminateJobObject, JOBOBJECT_BASIC_ACCOUNTING_INFORMATION,
    JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
};
use windows::Win32::System::Threading::{
    CreateProcessW, GetCurrentProcessId, GetExitCodeProcess, ResumeThread, TerminateProcess,
    WaitForSingleObject, CREATE_NO_WINDOW, CREATE_SUSPENDED, INFINITE, PROCESS_INFORMATION,
    STARTF_USESTDHANDLES, STARTUPINFOW,
};

const PAYLOAD_ENV: &str = "KODAX_INTERNAL_WINDOWS_JOB_LAUNCH";
const READY_FILE_ENV: &str = "KODAX_INTERNAL_WINDOWS_JOB_READY_FILE";

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Payload {
    executable: String,
    command_line: String,
    cwd: String,
    ready_file: String,
    log_file: String,
    job_name: String,
}

/// Run the daemon under a named kill-on-close Job; returns the daemon's exit code.
/// A failure before readiness is reported in the ready file, as the SDK expects.
pub fn run() -> Result<u32> {
    let encoded = std::env::var(PAYLOAD_ENV).context("Job launch payload is missing")?;
    let ready_file = std::env::var(READY_FILE_ENV).context("Job ready file is missing")?;
    let outcome = launch(&encoded);
    if let Err(error) = &outcome {
        if !std::path::Path::new(&ready_file).exists() {
            let _ = std::fs::write(&ready_file, format!("ERROR:{error:#}"));
        }
    }
    outcome
}

fn launch(encoded: &str) -> Result<u32> {
    use base64::Engine;
    let bytes = base64::engine::general_purpose::STANDARD.decode(encoded)?;
    let payload: Payload = serde_json::from_slice(&bytes).context("Invalid Job launch payload")?;
    ensure!(
        payload.job_name.starts_with("Global\\KodaXDaemonJob-"),
        "Invalid daemon Job name"
    );
    // The contained daemon reads these to prove its containment; the launch
    // secrets themselves must not leak into it. Single-threaded at this point.
    unsafe {
        std::env::remove_var(PAYLOAD_ENV);
        std::env::remove_var(READY_FILE_ENV);
        std::env::set_var("KODAX_DAEMON_JOB_CONTAINED", "1");
        std::env::set_var(
            "KODAX_DAEMON_JOB_SUPERVISOR_PID",
            GetCurrentProcessId().to_string(),
        );
        std::env::set_var("KODAX_DAEMON_JOB_NAME", &payload.job_name);
    }

    let name = wide(&payload.job_name);
    let job = OwnedHandle::new(
        unsafe { CreateJobObjectW(None, PCWSTR(name.as_ptr())) }.context("CreateJobObjectW")?,
        "daemon Job",
    )?;
    // The name is a fresh UUID; an existing Job means someone else owns it.
    ensure!(
        unsafe { GetLastError() } != ERROR_ALREADY_EXISTS,
        "The daemon Job name already exists"
    );
    let mut limits: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = unsafe { zeroed() };
    limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
    unsafe {
        SetInformationJobObject(
            job.raw(),
            JobObjectExtendedLimitInformation,
            &limits as *const _ as *const _,
            size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
        )
        .context("SetInformationJobObject(KILL_ON_JOB_CLOSE)")?;
    }

    // Inheritable append handle: the daemon's stdout/stderr go to daemon.log.
    let log = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&payload.log_file)
        .with_context(|| format!("open daemon log {}", payload.log_file))?;
    let log_handle = HANDLE(log.as_raw_handle());
    unsafe {
        windows::Win32::Foundation::SetHandleInformation(
            log_handle,
            windows::Win32::Foundation::HANDLE_FLAG_INHERIT.0,
            windows::Win32::Foundation::HANDLE_FLAG_INHERIT,
        )
        .context("make the daemon log inheritable")?;
    }

    let executable = wide(&payload.executable);
    let mut command_line = wide(&payload.command_line);
    let cwd = wide(&payload.cwd);
    let mut startup: STARTUPINFOW = unsafe { zeroed() };
    startup.cb = size_of::<STARTUPINFOW>() as u32;
    startup.dwFlags = STARTF_USESTDHANDLES;
    startup.hStdOutput = log_handle;
    startup.hStdError = log_handle;
    let mut information: PROCESS_INFORMATION = unsafe { zeroed() };
    unsafe {
        CreateProcessW(
            PCWSTR(executable.as_ptr()),
            Some(PWSTR(command_line.as_mut_ptr())),
            None,
            None,
            true,
            CREATE_SUSPENDED | CREATE_NO_WINDOW,
            None,
            PCWSTR(cwd.as_ptr()),
            &startup,
            &mut information,
        )
        .with_context(|| format!("CreateProcessW({})", payload.executable))?;
    }
    let process = OwnedHandle::new(information.hProcess, "daemon process")?;
    let thread = OwnedHandle::new(information.hThread, "daemon thread")?;
    // Never leave a suspended, uncontained daemon behind.
    let assigned = unsafe { AssignProcessToJobObject(job.raw(), process.raw()) };
    if let Err(error) = assigned {
        unsafe {
            let _ = TerminateProcess(process.raw(), 1);
            WaitForSingleObject(process.raw(), 2000);
        }
        return Err(error).context("AssignProcessToJobObject");
    }
    publish_ready(&payload.ready_file, information.dwProcessId)?;
    ensure!(
        unsafe { ResumeThread(thread.raw()) } != u32::MAX,
        "ResumeThread failed"
    );

    ensure!(
        unsafe { WaitForSingleObject(process.raw(), INFINITE) } != WAIT_FAILED,
        "WaitForSingleObject failed"
    );
    let mut exit_code = 1u32;
    unsafe {
        let _ = GetExitCodeProcess(process.raw(), &mut exit_code);
        TerminateJobObject(job.raw(), exit_code).context("TerminateJobObject")?;
    }
    // Do not exit while any contained descendant is still running.
    loop {
        let mut accounting: JOBOBJECT_BASIC_ACCOUNTING_INFORMATION = unsafe { zeroed() };
        unsafe {
            QueryInformationJobObject(
                Some(job.raw()),
                JobObjectBasicAccountingInformation,
                &mut accounting as *mut _ as *mut _,
                size_of::<JOBOBJECT_BASIC_ACCOUNTING_INFORMATION>() as u32,
                None,
            )
            .context("QueryInformationJobObject")?;
        }
        if accounting.ActiveProcesses == 0 {
            return Ok(exit_code);
        }
        std::thread::sleep(std::time::Duration::from_millis(10));
    }
}

/// Atomic publication: the SDK either sees no ready file or a complete one.
fn publish_ready(ready_file: &str, process_pid: u32) -> Result<()> {
    let temporary = format!("{ready_file}.{}.tmp", uuid::Uuid::new_v4().simple());
    let body = format!(
        "{{\"processPid\":{process_pid},\"containmentSupervisorPid\":{}}}",
        unsafe { GetCurrentProcessId() }
    );
    // A scanner may hold the new file briefly; a sharing violation is transient.
    let mut published = std::fs::write(&temporary, &body);
    if published.is_ok() {
        for attempt in 0..10 {
            published = std::fs::rename(&temporary, ready_file);
            if published.is_ok() || attempt == 9 {
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(20));
        }
    }
    if published.is_err() {
        let _ = std::fs::remove_file(&temporary);
    }
    published.context("publish the daemon ready file")
}
