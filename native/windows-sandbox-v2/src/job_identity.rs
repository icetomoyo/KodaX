//! Read-only daemon attestation. No PowerShell, provider, network or sandbox setup is needed.
use crate::win::OwnedHandle;
use anyhow::{ensure, Context, Result};
use std::mem::size_of;
use windows::core::PCWSTR;
use windows::Win32::Foundation::{FILETIME, HANDLE};
use windows::Win32::System::JobObjects::{
    IsProcessInJob, JobObjectExtendedLimitInformation, OpenJobObjectW, QueryInformationJobObject,
    JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
};
use windows::Win32::System::Threading::{
    GetProcessTimes, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION,
};
const JOB_OBJECT_QUERY: u32 = 4;

fn creation_time(process: HANDLE) -> Result<String> {
    let (mut creation, mut exit, mut kernel, mut user) = (
        FILETIME::default(),
        FILETIME::default(),
        FILETIME::default(),
        FILETIME::default(),
    );
    unsafe {
        GetProcessTimes(process, &mut creation, &mut exit, &mut kernel, &mut user)?;
    }
    let ticks = (u64::from(creation.dwHighDateTime) << 32) | u64::from(creation.dwLowDateTime);
    ensure!(ticks > 0, "Process creation identity is unavailable");
    // SDK process-tree fences use decimal milliseconds since the FILETIME epoch.
    Ok((ticks / 10_000).to_string())
}

pub fn query(name: &str, pid: u32, supervisor_pid: u32) -> Result<serde_json::Value> {
    let uuid = name
        .strip_prefix("Global\\KodaXDaemonJob-")
        .context("Invalid daemon Job name")?;
    ensure!(
        uuid::Uuid::parse_str(uuid)?.get_version_num() == 4,
        "Invalid daemon Job generation"
    );
    ensure!(
        pid > 0 && supervisor_pid > 0 && pid != supervisor_pid,
        "Invalid daemon process IDs"
    );
    let name: Vec<u16> = name.encode_utf16().chain(Some(0)).collect();
    let job = OwnedHandle::new(
        unsafe { OpenJobObjectW(JOB_OBJECT_QUERY, false, PCWSTR(name.as_ptr()))? },
        "daemon Job",
    )?;
    let process = OwnedHandle::new(
        unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid)? },
        "daemon process",
    )?;
    let supervisor = OwnedHandle::new(
        unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, supervisor_pid)? },
        "daemon supervisor",
    )?;
    let mut contained = false.into();
    unsafe {
        IsProcessInJob(process.raw(), Some(job.raw()), &mut contained)?;
    }
    ensure!(
        contained.as_bool(),
        "Daemon process is not in the named Job"
    );
    let mut limits = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
    unsafe {
        QueryInformationJobObject(
            Some(job.raw()),
            JobObjectExtendedLimitInformation,
            &mut limits as *mut _ as *mut _,
            size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
            None,
        )?;
    }
    ensure!(
        (limits.BasicLimitInformation.LimitFlags & JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE).0 != 0,
        "Daemon Job does not enforce kill-on-close"
    );
    Ok(serde_json::json!({
        "processStartIdentity": creation_time(process.raw())?,
        "supervisorProcessStartIdentity": creation_time(supervisor.raw())?,
    }))
}
