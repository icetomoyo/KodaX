//! The engine's own resident memory. The Host's watchdog reads it through
//! `engine.status`, so the Host needs no native code to watch another process.

/// Resident bytes now, or `None` where the platform cannot say.
pub fn resident_bytes() -> Option<u64> {
    platform::resident_bytes()
}

#[cfg(windows)]
mod platform {
    use windows_sys::Win32::System::ProcessStatus::{K32GetProcessMemoryInfo, PROCESS_MEMORY_COUNTERS};
    use windows_sys::Win32::System::Threading::GetCurrentProcess;

    pub fn resident_bytes() -> Option<u64> {
        let mut counters: PROCESS_MEMORY_COUNTERS = unsafe { std::mem::zeroed() };
        counters.cb = std::mem::size_of::<PROCESS_MEMORY_COUNTERS>() as u32;
        let done = unsafe { K32GetProcessMemoryInfo(GetCurrentProcess(), &mut counters, counters.cb) };
        (done != 0).then_some(counters.WorkingSetSize as u64)
    }
}

#[cfg(target_os = "linux")]
mod platform {
    pub fn resident_bytes() -> Option<u64> {
        let statm = std::fs::read_to_string("/proc/self/statm").ok()?;
        let pages: u64 = statm.split_whitespace().nth(1)?.parse().ok()?;
        let page_size = unsafe { libc::sysconf(libc::_SC_PAGESIZE) };
        (page_size > 0).then(|| pages * page_size as u64)
    }
}

#[cfg(target_os = "macos")]
mod platform {
    pub fn resident_bytes() -> Option<u64> {
        let mut info: libc::proc_taskinfo = unsafe { std::mem::zeroed() };
        let size = std::mem::size_of::<libc::proc_taskinfo>() as libc::c_int;
        let pointer = (&mut info as *mut libc::proc_taskinfo).cast::<libc::c_void>();
        let written = unsafe { libc::proc_pidinfo(libc::getpid(), libc::PROC_PIDTASKINFO, 0, pointer, size) };
        (written == size).then_some(info.pti_resident_size)
    }
}

#[cfg(not(any(windows, target_os = "linux", target_os = "macos")))]
mod platform {
    pub fn resident_bytes() -> Option<u64> {
        None
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn reports_a_plausible_resident_size() {
        let bytes = super::resident_bytes().expect("supported on the test platforms");
        assert!((1024 * 1024..4 * 1024 * 1024 * 1024).contains(&bytes), "{bytes}");
    }
}
