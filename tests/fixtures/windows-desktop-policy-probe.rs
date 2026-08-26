use std::env;
use std::ffi::c_void;
use std::fs;
use std::ptr::null_mut;
use std::thread;
use std::time::{Duration, Instant};

type Handle = *mut c_void;

const UOI_NAME: i32 = 2;
const DESKTOP_READOBJECTS: u32 = 0x0001;

#[link(name = "kernel32")]
unsafe extern "system" {
    fn GetCurrentThreadId() -> u32;
    fn GetLastError() -> u32;
}

#[link(name = "user32")]
unsafe extern "system" {
    fn CloseDesktop(desktop: Handle) -> i32;
    fn GetThreadDesktop(thread_id: u32) -> Handle;
    fn GetUserObjectInformationW(
        object: Handle,
        index: i32,
        information: *mut c_void,
        length: u32,
        needed: *mut u32,
    ) -> i32;
    fn OpenDesktopW(
        name: *const u16,
        flags: u32,
        inherit: i32,
        access: u32,
    ) -> Handle;
}

fn wide(value: &str) -> Vec<u16> {
    value.encode_utf16().chain(Some(0)).collect()
}

fn current_desktop_name() -> Result<String, String> {
    let desktop = unsafe { GetThreadDesktop(GetCurrentThreadId()) };
    if desktop.is_null() {
        return Err(format!("GetThreadDesktop:{}", unsafe { GetLastError() }));
    }
    let mut needed = 0u32;
    unsafe {
        GetUserObjectInformationW(desktop, UOI_NAME, null_mut(), 0, &mut needed);
    }
    if needed < 2 || needed % 2 != 0 {
        return Err(format!("GetUserObjectInformationW(size):{}", unsafe {
            GetLastError()
        }));
    }
    let mut buffer = vec![0u16; needed as usize / 2];
    if unsafe {
        GetUserObjectInformationW(
            desktop,
            UOI_NAME,
            buffer.as_mut_ptr().cast(),
            needed,
            &mut needed,
        )
    } == 0
    {
        return Err(format!("GetUserObjectInformationW(name):{}", unsafe {
            GetLastError()
        }));
    }
    let length = buffer.iter().position(|unit| *unit == 0).unwrap_or(buffer.len());
    String::from_utf16(&buffer[..length]).map_err(|error| error.to_string())
}

fn publish(arguments: &[String]) -> Result<(), String> {
    let name_path = arguments.first().ok_or("missing name path")?;
    let release_path = arguments.get(1).ok_or("missing release path")?;
    fs::write(name_path, current_desktop_name()?).map_err(|error| error.to_string())?;
    let deadline = Instant::now() + Duration::from_secs(30);
    while Instant::now() < deadline {
        if fs::metadata(release_path).is_ok() {
            return Ok(());
        }
        thread::sleep(Duration::from_millis(25));
    }
    Err("release marker was not created".into())
}

fn open(arguments: &[String]) -> Result<(), String> {
    let name = arguments.first().ok_or("missing desktop name")?;
    let name = wide(name);
    let desktop = unsafe { OpenDesktopW(name.as_ptr(), 0, 0, DESKTOP_READOBJECTS) };
    if desktop.is_null() {
        let error = unsafe { GetLastError() };
        println!("DENIED:{error}");
        return if error == 5 {
            Ok(())
        } else {
            Err(format!("OpenDesktopW:{error}"))
        };
    }
    unsafe {
        CloseDesktop(desktop);
    }
    println!("OPENED");
    Err("cross-policy desktop open unexpectedly succeeded".into())
}

fn main() {
    let arguments = env::args().skip(1).collect::<Vec<_>>();
    let result = match arguments.first().map(String::as_str) {
        Some("publish") => publish(&arguments[1..]),
        Some("open") => open(&arguments[1..]),
        _ => Err("expected publish or open mode".into()),
    };
    if let Err(error) = result {
        eprintln!("{error}");
        std::process::exit(42);
    }
}
