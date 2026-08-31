use std::env;
use std::ffi::c_void;
use std::ptr::null_mut;

#[link(name = "kernel32")]
unsafe extern "system" {
    fn AddSIDToBoundaryDescriptor(boundary: *mut *mut c_void, sid: *mut c_void) -> i32;
    fn ClosePrivateNamespace(handle: *mut c_void, flags: u32) -> i32;
    fn CreateBoundaryDescriptorW(name: *const u16, flags: u32) -> *mut c_void;
    fn DeleteBoundaryDescriptor(boundary: *mut c_void);
    fn GetLastError() -> u32;
    fn LocalFree(memory: *mut c_void) -> *mut c_void;
    fn OpenPrivateNamespaceW(boundary: *const c_void, alias: *const u16) -> *mut c_void;
}

#[link(name = "advapi32")]
unsafe extern "system" {
    fn ConvertStringSidToSidW(value: *const u16, sid: *mut *mut c_void) -> i32;
}

fn wide(value: &str) -> Vec<u16> {
    value.encode_utf16().chain(Some(0)).collect()
}

fn main() {
    let arguments = env::args().skip(1).collect::<Vec<_>>();
    let host_sid = arguments.first().expect("host SID argument");
    let namespaces = arguments[1..].chunks_exact(2);
    if namespaces.remainder().len() != 0 || namespaces.len() == 0 {
        std::process::exit(47);
    }
    let sid_text = wide(&host_sid);
    for namespace in namespaces {
        let boundary_name = wide(&namespace[0]);
        let alias = wide(&namespace[1]);
        unsafe {
            let mut boundary = CreateBoundaryDescriptorW(boundary_name.as_ptr(), 0);
            if boundary.is_null() {
                std::process::exit(43);
            }
            let mut sid = null_mut();
            if ConvertStringSidToSidW(sid_text.as_ptr(), &mut sid) == 0 {
                DeleteBoundaryDescriptor(boundary);
                std::process::exit(44);
            }
            let added = AddSIDToBoundaryDescriptor(&mut boundary, sid);
            if added == 0 {
                LocalFree(sid);
                DeleteBoundaryDescriptor(boundary);
                std::process::exit(45);
            }
            let opened = OpenPrivateNamespaceW(boundary, alias.as_ptr());
            if !opened.is_null() {
                ClosePrivateNamespace(opened, 0);
                println!("OPENED:{}", namespace[1]);
                LocalFree(sid);
                DeleteBoundaryDescriptor(boundary);
                std::process::exit(42);
            }
            let error = GetLastError();
            if error == 2 || error == 3 {
                println!("UNAVAILABLE:{}:{error}", namespace[1]);
            } else {
                println!("DENIED:{}:{error}", namespace[1]);
            }
            LocalFree(sid);
            DeleteBoundaryDescriptor(boundary);
            if error != 2 && error != 3 && error != 5 {
                std::process::exit(46);
            }
        }
    }
}
