//! Puts the engine in the background on start, so indexing yields CPU and disk
//! to the Host and its tools. Needs no privilege on any platform.

/// Whether the engine runs in the background, and why not when it does not.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Background {
    Active,
    Unavailable(String),
}

pub fn enter_background() -> Background {
    match platform::enter() {
        Ok(()) => Background::Active,
        Err(reason) => Background::Unavailable(reason),
    }
}

#[cfg(windows)]
mod platform {
    use windows_sys::Win32::System::Threading::{GetCurrentProcess, PROCESS_MODE_BACKGROUND_BEGIN, SetPriorityClass};

    pub fn enter() -> Result<(), String> {
        // Lowers CPU, disk and memory priority together, for this process only.
        let done = unsafe { SetPriorityClass(GetCurrentProcess(), PROCESS_MODE_BACKGROUND_BEGIN) };
        if done == 0 {
            return Err(format!("SetPriorityClass failed: {}", std::io::Error::last_os_error()));
        }
        Ok(())
    }
}

#[cfg(target_os = "linux")]
mod platform {
    const IOPRIO_WHO_PROCESS: libc::c_long = 1;
    const IOPRIO_CLASS_IDLE: libc::c_long = 3;
    const IOPRIO_CLASS_SHIFT: libc::c_long = 13;

    pub fn enter() -> Result<(), String> {
        if unsafe { libc::setpriority(libc::PRIO_PROCESS, 0, 10) } != 0 {
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
    const PRIO_DARWIN_PROCESS: libc::c_int = 4;
    const PRIO_DARWIN_BG: libc::c_int = 0x1000;

    pub fn enter() -> Result<(), String> {
        if unsafe { libc::setpriority(PRIO_DARWIN_PROCESS, 0, PRIO_DARWIN_BG) } != 0 {
            return Err(format!("setpriority(PRIO_DARWIN_BG) failed: {}", std::io::Error::last_os_error()));
        }
        Ok(())
    }
}

#[cfg(not(any(windows, target_os = "linux", target_os = "macos")))]
mod platform {
    pub fn enter() -> Result<(), String> {
        Err("this platform has no background mode".to_owned())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn enters_the_background_without_privilege() {
        assert_eq!(enter_background(), Background::Active);
    }
}
