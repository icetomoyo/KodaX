//! Process snapshots and exact termination for SDK process-tree cleanup.
//!
//! The SDK used to compile the same logic through PowerShell `Add-Type` on each
//! call, which blocks the Host event loop for about a second. Output formats
//! match that script so the SDK parsers stay unchanged:
//! rows are `pid,parentPid,creationMs`, identities are `pid,creationMs`, and
//! `creationMs` is FILETIME / 10_000 (0 when the process cannot be opened).
use crate::win::OwnedHandle;
use anyhow::{Context, Result, ensure};
use std::fmt::Write as _;
use std::mem::{size_of, zeroed};
use std::time::{SystemTime, UNIX_EPOCH};
use windows::Win32::Foundation::FILETIME;
use windows::Win32::System::Diagnostics::ToolHelp::{
    CreateToolhelp32Snapshot, PROCESSENTRY32W, Process32FirstW, Process32NextW, TH32CS_SNAPPROCESS,
};
use windows::Win32::System::Threading::{
    GetProcessTimes, OpenProcess, PROCESS_ACCESS_RIGHTS, PROCESS_QUERY_LIMITED_INFORMATION,
    PROCESS_TERMINATE, TerminateProcess,
};

pub const TERMINATION_COMPLETED: &str = "KODAX_TERMINATION_COMPLETED";
pub const SNAPSHOT_COMPLETED: &str = "KODAX_SNAPSHOT_COMPLETED";
const FILETIME_UNIX_OFFSET_MS: u128 = 11_644_473_600_000;

fn open(pid: u32, access: PROCESS_ACCESS_RIGHTS) -> Option<OwnedHandle> {
    let handle = unsafe { OpenProcess(access, false, pid) }.ok()?;
    OwnedHandle::new(handle, "process").ok()
}

fn creation_ms(process: &OwnedHandle) -> u64 {
    let (mut creation, mut exit, mut kernel, mut user) = (
        FILETIME::default(),
        FILETIME::default(),
        FILETIME::default(),
        FILETIME::default(),
    );
    if unsafe { GetProcessTimes(process.raw(), &mut creation, &mut exit, &mut kernel, &mut user) }
        .is_err()
    {
        return 0;
    }
    ((u64::from(creation.dwHighDateTime) << 32) | u64::from(creation.dwLowDateTime)) / 10_000
}

fn start_identity(pid: u32) -> u64 {
    open(pid, PROCESS_QUERY_LIMITED_INFORMATION).map_or(0, |process| creation_ms(&process))
}

fn now_filetime_ms() -> u64 {
    let unix_ms = SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |d| d.as_millis());
    (unix_ms + FILETIME_UNIX_OFFSET_MS) as u64
}

/// Every process with its parent. A process created after the snapshot began
/// is left out so a reused PID never joins a tree it was not part of.
pub fn snapshot_rows() -> Result<String> {
    let cutoff = now_filetime_ms();
    let snapshot = unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) }
        .context("CreateToolhelp32Snapshot(processes)")?;
    let snapshot = OwnedHandle::new(snapshot, "process snapshot")?;
    let mut entry: PROCESSENTRY32W = unsafe { zeroed() };
    entry.dwSize = size_of::<PROCESSENTRY32W>() as u32;
    let mut rows = String::new();
    let mut present = unsafe { Process32FirstW(snapshot.raw(), &mut entry) }.is_ok();
    while present {
        let creation = start_identity(entry.th32ProcessID);
        if creation == 0 || creation <= cutoff {
            let _ = writeln!(rows, "{},{},{}", entry.th32ProcessID, entry.th32ParentProcessID, creation);
        }
        present = unsafe { Process32NextW(snapshot.raw(), &mut entry) }.is_ok();
    }
    Ok(rows)
}

pub fn start_identity_rows(pids: &[u32]) -> String {
    pids.iter().fold(String::new(), |mut rows, pid| {
        let _ = writeln!(rows, "{pid},{}", start_identity(*pid));
        rows
    })
}

/// Terminate only the process whose creation time still matches; a reused PID is left alone.
pub fn terminate_exact(pid: u32, expected_ms: u64) -> u8 {
    let Some(process) = open(
        pid,
        PROCESS_ACCESS_RIGHTS(PROCESS_QUERY_LIMITED_INFORMATION.0 | PROCESS_TERMINATE.0),
    ) else {
        return 0;
    };
    let actual = creation_ms(&process);
    if actual == 0 {
        return 0;
    }
    if actual != expected_ms {
        return 2;
    }
    u8::from(unsafe { TerminateProcess(process.raw(), 1) }.is_ok())
}

pub fn parse_pid(value: &str) -> Result<u32> {
    let pid = value.parse::<u32>().with_context(|| format!("Invalid PID {value}"))?;
    ensure!(pid > 0, "Invalid PID {value}");
    Ok(pid)
}

pub fn parse_exact_target(value: &str) -> Result<(u32, u64)> {
    let (pid, creation) = value.split_once(':').context("Target must be pid:creationMs")?;
    Ok((parse_pid(pid)?, creation.parse::<u64>().context("Invalid creation identity")?))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_its_own_start_identity_and_row() {
        let pid = std::process::id();
        let identity = start_identity(pid);
        assert!(identity > 0);
        assert_eq!(start_identity_rows(&[pid]), format!("{pid},{identity}\n"));
        let rows = snapshot_rows().unwrap();
        assert!(rows.lines().any(|row| row.starts_with(&format!("{pid},")) && row.ends_with(&format!(",{identity}"))));
    }

    #[test]
    fn leaves_a_mismatched_identity_alone() {
        let pid = std::process::id();
        assert_eq!(terminate_exact(pid, start_identity(pid) + 1), 2);
    }

    #[test]
    fn parses_exact_targets() {
        assert_eq!(parse_exact_target("12:34").unwrap(), (12, 34));
        assert!(parse_exact_target("0:34").is_err());
        assert!(parse_exact_target("12").is_err());
    }
}
