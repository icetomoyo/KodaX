//! Effect Job supervisor and sandbox SID probe. These replace PowerShell
//! programs that compiled C# with `Add-Type` on every launch: the compile cost
//! about a second, and security software treats a script host compiling and
//! loading code as suspicious.
use crate::win::{self, wide, LocalSid, OwnedHandle};
use anyhow::{bail, ensure, Context, Result};
use std::collections::{BTreeMap, BTreeSet};
use std::io::Write;
use std::mem::{size_of, zeroed};
use windows::core::PCWSTR;
use windows::Win32::Foundation::{
    GetLastError, ERROR_ALREADY_EXISTS, ERROR_FILE_NOT_FOUND, HANDLE, WAIT_FAILED, WAIT_OBJECT_0,
};
use windows::Win32::Security::{CheckTokenMembership, EqualSid};
use windows::Win32::System::Diagnostics::ToolHelp::{
    CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W, TH32CS_SNAPPROCESS,
};
use windows::Win32::System::JobObjects::{
    AssignProcessToJobObject, CreateJobObjectW, JobObjectBasicAccountingInformation,
    JobObjectExtendedLimitInformation, OpenJobObjectW, QueryInformationJobObject,
    SetInformationJobObject, TerminateJobObject, JOBOBJECT_BASIC_ACCOUNTING_INFORMATION,
    JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
};
use windows::Win32::System::RemoteDesktop::{
    WTSEnumerateProcessesW, WTSFreeMemory, WTS_CURRENT_SERVER_HANDLE, WTS_PROCESS_INFOW,
};
use windows::Win32::System::Threading::{
    GetCurrentProcessId, GetExitCodeProcess, OpenProcess, WaitForMultipleObjects, INFINITE,
    PROCESS_QUERY_LIMITED_INFORMATION, PROCESS_SET_QUOTA, PROCESS_SYNCHRONIZE, PROCESS_TERMINATE,
};

const GLOBAL_PREFIX: &str = "Global\\";
const JOB_PREFIX: &str = "KodaXEffect-";
const JOB_OBJECT_TERMINATE: u32 = 0x0008;
const JOB_OBJECT_QUERY: u32 = 0x0004;

/// New Jobs are machine-global; recovery also accepts the older local name.
fn valid_job_name(name: &str, require_global: bool) -> bool {
    let local = match name.strip_prefix(GLOBAL_PREFIX) {
        Some(local) => local,
        None if require_global => return false,
        None => name,
    };
    local.strip_prefix(JOB_PREFIX).is_some_and(|id| {
        id.len() == 36
            && uuid::Uuid::parse_str(id).is_ok_and(|uuid| uuid.get_version_num() == 4)
    })
}

fn valid_sid(value: &str) -> bool {
    let Some(rest) = value.strip_prefix("S-1-").or_else(|| value.strip_prefix("s-1-")) else {
        return false;
    };
    let parts: Vec<&str> = rest.split('-').collect();
    parts.len() >= 2
        && parts
            .iter()
            .all(|part| !part.is_empty() && part.bytes().all(|byte| byte.is_ascii_digit()))
}

fn open_process(pid: u32, access: windows::Win32::System::Threading::PROCESS_ACCESS_RIGHTS, label: &str) -> Result<OwnedHandle> {
    let handle = unsafe { OpenProcess(access, false, pid) }
        .with_context(|| format!("OpenProcess({label} {pid})"))?;
    OwnedHandle::new(handle, label)
}

fn terminate_and_drain(job: &OwnedHandle, exit_code: u32) -> Result<()> {
    unsafe { TerminateJobObject(job.raw(), exit_code) }.context("TerminateJobObject")?;
    // Report completion only once no contained descendant is still running.
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
            return Ok(());
        }
        std::thread::sleep(std::time::Duration::from_millis(10));
    }
}

fn create_effect_job(job_name: &str) -> Result<OwnedHandle> {
    let name = wide(job_name);
    let job = OwnedHandle::new(
        unsafe { CreateJobObjectW(None, PCWSTR(name.as_ptr())) }.context("CreateJobObjectW")?,
        "effect Job",
    )?;
    // The name is a fresh UUID; an existing Job means someone else owns it.
    ensure!(
        unsafe { GetLastError() } != ERROR_ALREADY_EXISTS,
        "The effect Job name already exists"
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
    Ok(job)
}

/// Fence `target_pid` in a kill-on-close Job, print READY, and drain the Job
/// once the target or the owner exits.
pub fn supervise(target_pid: u32, owner_pid: u32, job_name: &str) -> Result<u32> {
    ensure!(valid_job_name(job_name, true), "Invalid effect Job name");
    let job = create_effect_job(job_name)?;
    let target = open_process(
        target_pid,
        PROCESS_SYNCHRONIZE | PROCESS_TERMINATE | PROCESS_SET_QUOTA | PROCESS_QUERY_LIMITED_INFORMATION,
        "effect target",
    )?;
    let owner = open_process(owner_pid, PROCESS_SYNCHRONIZE, "effect owner")?;
    unsafe { AssignProcessToJobObject(job.raw(), target.raw()) }
        .context("AssignProcessToJobObject")?;
    let mut stdout = std::io::stdout();
    writeln!(stdout, "READY")?;
    stdout.flush()?;

    // The owner wins a tie: its exit means nobody waits for the effect.
    let handles: [HANDLE; 2] = [owner.raw(), target.raw()];
    let signaled = unsafe { WaitForMultipleObjects(&handles, false, INFINITE) };
    ensure!(signaled != WAIT_FAILED, "WaitForMultipleObjects failed: {}", std::io::Error::last_os_error());
    let mut exit_code = 1u32;
    if signaled.0 == WAIT_OBJECT_0.0 + 1 {
        unsafe { GetExitCodeProcess(target.raw(), &mut exit_code) }
            .context("GetExitCodeProcess(effect target)")?;
    }
    terminate_and_drain(&job, exit_code)?;
    Ok(0)
}

/// Terminate and drain a Job left by an interrupted owner; false if it is gone.
pub fn recover(job_name: &str) -> Result<bool> {
    ensure!(valid_job_name(job_name, false), "Invalid effect Job name");
    let name = wide(job_name);
    let opened = unsafe {
        OpenJobObjectW(
            JOB_OBJECT_TERMINATE | JOB_OBJECT_QUERY,
            false,
            PCWSTR(name.as_ptr()),
        )
    };
    let handle = match opened {
        Ok(handle) => handle,
        Err(error) if error.code() == ERROR_FILE_NOT_FOUND.to_hresult() => return Ok(false),
        Err(error) => bail!("OpenJobObjectW: {error}"),
    };
    let job = OwnedHandle::new(handle, "effect Job")?;
    terminate_and_drain(&job, 1)?;
    Ok(true)
}

fn current_token_is_administrator() -> Result<bool> {
    let administrators = LocalSid::from_string("S-1-5-32-544")?;
    let mut member = windows::core::BOOL::default();
    unsafe { CheckTokenMembership(None, administrators.raw(), &mut member) }
        .context("CheckTokenMembership(Administrators)")?;
    Ok(member.as_bool())
}

fn processes_with_sid(expected: &LocalSid) -> Result<BTreeSet<u32>> {
    let mut entries: *mut WTS_PROCESS_INFOW = std::ptr::null_mut();
    let mut count = 0u32;
    unsafe { WTSEnumerateProcessesW(Some(WTS_CURRENT_SERVER_HANDLE), 0, 1, &mut entries, &mut count) }
        .context("WTSEnumerateProcessesW")?;
    let rows = unsafe { std::slice::from_raw_parts(entries, count as usize) };
    let matches = rows
        .iter()
        .filter(|row| !row.pUserSid.is_invalid())
        .filter(|row| unsafe { EqualSid(row.pUserSid, expected.raw()) }.is_ok())
        .map(|row| row.ProcessId)
        .collect();
    unsafe { WTSFreeMemory(entries as *mut _) };
    Ok(matches)
}

fn process_parents() -> Result<BTreeMap<u32, u32>> {
    let snapshot = unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) }
        .context("CreateToolhelp32Snapshot(processes)")?;
    let snapshot = OwnedHandle::new(snapshot, "process snapshot")?;
    let mut entry: PROCESSENTRY32W = unsafe { zeroed() };
    entry.dwSize = size_of::<PROCESSENTRY32W>() as u32;
    unsafe { Process32FirstW(snapshot.raw(), &mut entry) }.context("Process32FirstW")?;
    let mut parents = BTreeMap::new();
    loop {
        parents.insert(entry.th32ProcessID, entry.th32ParentProcessID);
        entry.dwSize = size_of::<PROCESSENTRY32W>() as u32;
        if unsafe { Process32NextW(snapshot.raw(), &mut entry) }.is_err() {
            return Ok(parents);
        }
    }
}

fn descends_from(mut process: u32, root: u32, parents: &BTreeMap<u32, u32>) -> bool {
    let mut visited = BTreeSet::new();
    while process != 0 && visited.insert(process) {
        if process == root {
            return true;
        }
        match parents.get(&process) {
            Some(parent) => process = *parent,
            None => return false,
        }
    }
    false
}

/// Whether a process runs as `sid`. With `ignore_probe_tree`, the probe runs
/// as that user and ignores its own launcher's process tree.
pub fn sid_has_processes(sid: &str, ignore_probe_tree: bool) -> Result<bool> {
    ensure!(valid_sid(sid), "Windows sandbox process inspection received an invalid SID");
    let expected = LocalSid::from_string(sid)?;
    let token = win::current_token()?;
    let same_user = win::token_user_sid(token.raw())?
        .eq_ignore_ascii_case(&win::sid_to_string(expected.raw())?);
    if ignore_probe_tree {
        ensure!(same_user, "Process-tree SID probe must run as the expected sandbox user");
    } else {
        ensure!(
            same_user || current_token_is_administrator()?,
            "Machine-wide inspection of a foreign Windows SID requires an elevated administrator token"
        );
    }
    let matches = processes_with_sid(&expected)?;
    if !ignore_probe_tree {
        return Ok(!matches.is_empty());
    }
    let current = unsafe { GetCurrentProcessId() };
    ensure!(matches.contains(&current), "SID probe could not observe its own process");
    let parents = process_parents()?;
    let root = parents.get(&current).copied().unwrap_or(current);
    Ok(matches.iter().any(|process| !descends_from(*process, root, &parents)))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::process::{Command, Stdio};

    #[test]
    fn validates_job_names_and_sids() {
        let id = uuid::Uuid::new_v4();
        assert!(valid_job_name(&format!("Global\\KodaXEffect-{id}"), true));
        assert!(valid_job_name(&format!("KodaXEffect-{id}"), false));
        assert!(!valid_job_name(&format!("KodaXEffect-{id}"), true));
        assert!(!valid_job_name("Global\\KodaXEffect-not-a-uuid", true));
        assert!(!valid_job_name(&format!("Global\\KodaXDaemonJob-{id}"), true));
        assert!(valid_sid("S-1-5-21-1-2-3-1001"));
        assert!(!valid_sid("S-1-5"));
        assert!(!valid_sid("S-1-5-x"));
        assert!(!valid_sid("S-1-5-21--1"));
    }

    #[test]
    fn recovering_a_missing_job_reports_not_found() {
        let name = format!("Global\\KodaXEffect-{}", uuid::Uuid::new_v4());
        assert!(!recover(&name).unwrap());
    }

    #[test]
    fn current_user_has_processes_and_the_probe_tree_is_ignored() {
        let token = win::current_token().unwrap();
        let sid = win::token_user_sid(token.raw()).unwrap();
        assert!(sid_has_processes(&sid, false).unwrap());
        // Ignoring the probe tree still sees the user's unrelated processes
        // (the session's shell or explorer), which never descend from this test.
        assert!(sid_has_processes(&sid, true).unwrap());
        let foreign = sid_has_processes("S-1-5-21-1-2-3-4", false);
        if current_token_is_administrator().unwrap() {
            assert!(!foreign.unwrap());
        } else {
            assert!(foreign.is_err());
        }
        assert!(sid_has_processes("S-1-5-21-1-2-3-4", true).is_err());
    }

    #[test]
    fn supervised_target_is_drained_with_its_descendants() {
        let name = format!("Global\\KodaXEffect-{}", uuid::Uuid::new_v4());
        // The target spawns a grandchild that outlives it unless the Job drains it.
        let mut target = Command::new("cmd.exe")
            .args(["/d", "/c", "start /b ping -n 30 127.0.0.1 >nul & ping -n 2 127.0.0.1 >nul"])
            .stdout(Stdio::null())
            .spawn()
            .unwrap();
        let owner = unsafe { GetCurrentProcessId() };
        let started = std::time::Instant::now();
        assert_eq!(supervise(target.id(), owner, &name).unwrap(), 0);
        assert!(started.elapsed() < std::time::Duration::from_secs(20));
        target.wait().unwrap();
        assert!(!recover(&name).unwrap());
    }
}
