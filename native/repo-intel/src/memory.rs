//! The engine's own memory. The Host's watchdog reads it through
//! `engine.status`, so the Host needs no native code to watch another process.

/// The memory the engine holds now, or `None` where the platform cannot say.
/// Resident size on Linux and macOS. On Windows, private bytes: background mode
/// caps the working set at about 32 MB and moves the rest out of it, so the
/// working set stops growing while the engine's memory still does.
pub fn resident_bytes() -> Option<u64> {
    platform::resident_bytes()
}

#[cfg(windows)]
mod platform {
    use windows_sys::Win32::System::ProcessStatus::{
        K32GetProcessMemoryInfo, PROCESS_MEMORY_COUNTERS, PROCESS_MEMORY_COUNTERS_EX,
    };
    use windows_sys::Win32::System::Threading::GetCurrentProcess;

    pub fn resident_bytes() -> Option<u64> {
        let mut counters: PROCESS_MEMORY_COUNTERS_EX = unsafe { std::mem::zeroed() };
        counters.cb = std::mem::size_of::<PROCESS_MEMORY_COUNTERS_EX>() as u32;
        let pointer = (&mut counters as *mut PROCESS_MEMORY_COUNTERS_EX).cast::<PROCESS_MEMORY_COUNTERS>();
        let done = unsafe { K32GetProcessMemoryInfo(GetCurrentProcess(), pointer, counters.cb) };
        (done != 0).then_some(counters.PrivateUsage as u64)
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
        assert!((64 * 1024..4 * 1024 * 1024 * 1024).contains(&bytes), "{bytes}");
    }

    #[cfg(windows)]
    #[test]
    fn counts_memory_windows_trimmed_out_of_the_working_set() {
        use windows_sys::Win32::System::ProcessStatus::K32EmptyWorkingSet;
        use windows_sys::Win32::System::Threading::GetCurrentProcess;
        const HELD: u64 = 128 * 1024 * 1024;
        let before = super::resident_bytes().expect("supported on Windows");
        let held = std::hint::black_box(vec![1u8; HELD as usize]);
        assert_ne!(unsafe { K32EmptyWorkingSet(GetCurrentProcess()) }, 0);
        let after = super::resident_bytes().expect("supported on Windows");
        assert!(after >= before + HELD, "{before} -> {after}");
        drop(held);
    }
}
