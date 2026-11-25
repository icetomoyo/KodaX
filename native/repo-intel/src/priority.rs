//! Lowers the priority of the threads that index, so indexing yields CPU to the
//! Host and its tools. The thread that answers requests keeps normal priority:
//! lowering the whole process let a busy machine starve queries for seconds.
//! Needs no privilege on any platform.

/// Whether index threads run in the background, and why not when they do not.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Background {
    Active,
    Unavailable(String),
}

/// Tries the lowering on a short-lived thread, so the engine can report at
/// start whether its index threads will run in the background.
pub fn probe() -> Background {
    match std::thread::spawn(lower_this_thread).join() {
        Ok(Ok(())) => Background::Active,
        Ok(Err(reason)) => Background::Unavailable(reason),
        Err(_) => Background::Unavailable("the probe thread crashed".to_owned()),
    }
}

/// Lowers the calling thread only. Threads it starts later inherit the lowering.
pub fn lower_this_thread() -> Result<(), String> {
    platform::lower_this_thread()
}

#[cfg(windows)]
mod platform {
    use windows_sys::Win32::System::Threading::{GetCurrentThread, SetThreadPriority, THREAD_PRIORITY_IDLE};

    // CPU only. Lowering disk and memory priority too (background mode) made a
    // cold index about twice as slow and gave the foreground no measurable gain.
    pub fn lower_this_thread() -> Result<(), String> {
        if unsafe { SetThreadPriority(GetCurrentThread(), THREAD_PRIORITY_IDLE) } == 0 {
            return Err(format!("SetThreadPriority failed: {}", std::io::Error::last_os_error()));
        }
        Ok(())
    }
}

#[cfg(target_os = "linux")]
mod platform {
    const NICE: libc::c_int = 10;
    const IOPRIO_WHO_PROCESS: libc::c_long = 1;
    const IOPRIO_CLASS_IDLE: libc::c_long = 3;
    const IOPRIO_CLASS_SHIFT: libc::c_long = 13;

    // On Linux the nice value and the I/O priority belong to the thread, and
    // `who = 0` names the calling thread.
    pub fn lower_this_thread() -> Result<(), String> {
        let current = unsafe { libc::getpriority(libc::PRIO_PROCESS, 0) };
        if unsafe { libc::setpriority(libc::PRIO_PROCESS, 0, current.max(NICE)) } != 0 {
            return Err(format!("setpriority failed: {}", std::io::Error::last_os_error()));
        }
        let idle = IOPRIO_CLASS_IDLE << IOPRIO_CLASS_SHIFT;
        if unsafe { libc::syscall(libc::SYS_ioprio_set, IOPRIO_WHO_PROCESS, 0 as libc::c_long, idle) } != 0 {
            return Err(format!("ioprio_set failed: {}", std::io::Error::last_os_error()));
        }
        Ok(())
    }
}

#[cfg(target_os = "macos")]
mod platform {
    const PRIO_DARWIN_THREAD: libc::c_int = 3;
    const PRIO_DARWIN_BG: libc::c_int = 0x1000;

    pub fn lower_this_thread() -> Result<(), String> {
        if unsafe { libc::setpriority(PRIO_DARWIN_THREAD, 0, PRIO_DARWIN_BG) } != 0 {
            return Err(format!("setpriority(PRIO_DARWIN_BG) failed: {}", std::io::Error::last_os_error()));
        }
        Ok(())
    }
}

#[cfg(not(any(windows, target_os = "linux", target_os = "macos")))]
mod platform {
    pub fn lower_this_thread() -> Result<(), String> {
        Err("this platform has no background mode".to_owned())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn index_threads_can_run_in_the_background_without_privilege() {
        assert_eq!(probe(), Background::Active);
    }

    #[cfg(windows)]
    #[test]
    fn lowers_only_the_calling_thread() {
        use windows_sys::Win32::System::Threading::{
            GetCurrentProcess, GetCurrentThread, GetPriorityClass, GetThreadPriority, NORMAL_PRIORITY_CLASS,
            THREAD_PRIORITY_IDLE,
        };
        let lowered = std::thread::spawn(|| {
            lower_this_thread().expect("lowered");
            unsafe { GetThreadPriority(GetCurrentThread()) }
        });
        assert_eq!(lowered.join().unwrap(), THREAD_PRIORITY_IDLE);
        assert_eq!(unsafe { GetPriorityClass(GetCurrentProcess()) }, NORMAL_PRIORITY_CLASS);
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn lowers_only_the_calling_thread() {
        let before = unsafe { libc::getpriority(libc::PRIO_PROCESS, 0) };
        let lowered = std::thread::spawn(|| {
            lower_this_thread().expect("lowered");
            unsafe { libc::getpriority(libc::PRIO_PROCESS, 0) }
        });
        assert_eq!(lowered.join().unwrap(), before.max(10));
        assert_eq!(unsafe { libc::getpriority(libc::PRIO_PROCESS, 0) }, before);
    }
}
