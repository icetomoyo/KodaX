use std::collections::BTreeMap;
use std::ffi::c_void;
use std::io::{self, Write};
use std::mem::{size_of, zeroed};
use std::os::windows::io::{AsRawHandle, FromRawHandle, RawHandle};
use std::path::Path;
use std::ptr::null_mut;
use std::sync::{Mutex, OnceLock, mpsc};
use std::thread;
use std::time::Duration;

use anyhow::{Context, Result, anyhow, bail};
use windows::Win32::Foundation::{
    CloseHandle, DUPLICATE_SAME_ACCESS, DuplicateHandle, ERROR_ALREADY_EXISTS,
    ERROR_FILE_NOT_FOUND, ERROR_NO_DATA, ERROR_PIPE_BUSY, ERROR_PIPE_CONNECTED,
    ERROR_PIPE_LISTENING, ERROR_SUCCESS, FILETIME, GENERIC_ALL, GENERIC_READ, GENERIC_WRITE,
    GetLastError, HANDLE, HANDLE_FLAG_INHERIT, HLOCAL, INVALID_HANDLE_VALUE, LocalFree,
    SetHandleInformation, SetLastError, WAIT_ABANDONED, WAIT_OBJECT_0, WAIT_TIMEOUT,
};
use windows::Win32::Security::Authorization::{
    ConvertSidToStringSidW, ConvertStringSecurityDescriptorToSecurityDescriptorW,
    ConvertStringSidToSidW, EXPLICIT_ACCESS_W, GRANT_ACCESS, GetSecurityInfo, NO_MULTIPLE_TRUSTEE,
    SDDL_REVISION_1, SE_KERNEL_OBJECT, SetEntriesInAclW, SetSecurityInfo, TRUSTEE_IS_SID,
    TRUSTEE_IS_UNKNOWN, TRUSTEE_W,
};
use windows::Win32::Security::{
    ACL, AdjustTokenPrivileges, CreateRestrictedToken, DACL_SECURITY_INFORMATION,
    DISABLE_MAX_PRIVILEGE, DuplicateTokenEx, GetAce, GetLengthSid, GetSecurityDescriptorControl,
    GetTokenInformation, LUA_TOKEN, LookupPrivilegeValueW, OWNER_SECURITY_INFORMATION,
    PROTECTED_DACL_SECURITY_INFORMATION, PSECURITY_DESCRIPTOR, PSID, RevertToSelf,
    SE_DACL_PROTECTED, SE_PRIVILEGE_ENABLED, SECURITY_ATTRIBUTES, SID_AND_ATTRIBUTES,
    SecurityImpersonation, SetKernelObjectSecurity, SetTokenInformation, TOKEN_ALL_ACCESS,
    TOKEN_DEFAULT_DACL, TOKEN_GROUPS, TOKEN_INFORMATION_CLASS, TOKEN_PRIVILEGES, TOKEN_QUERY,
    TOKEN_USER, TokenDefaultDacl, TokenGroups, TokenPrimary, TokenRestrictedSids, TokenUser,
    WRITE_RESTRICTED,
};
use windows::Win32::Storage::FileSystem::{
    CreateFileW, FILE_ALL_ACCESS, FILE_ATTRIBUTE_NORMAL, FILE_FLAG_FIRST_PIPE_INSTANCE,
    FILE_GENERIC_EXECUTE, FILE_GENERIC_READ, FILE_GENERIC_WRITE, FILE_SHARE_MODE, FILE_SHARE_READ,
    FILE_SHARE_WRITE, OPEN_EXISTING, PIPE_ACCESS_DUPLEX, PIPE_ACCESS_OUTBOUND, READ_CONTROL,
    WRITE_DAC,
};
use windows::Win32::System::Console::GetStdHandle;
use windows::Win32::System::Diagnostics::ToolHelp::{
    CreateToolhelp32Snapshot, PROCESSENTRY32W, Process32FirstW, Process32NextW, TH32CS_SNAPPROCESS,
};
use windows::Win32::System::JobObjects::{
    CreateJobObjectW, IsProcessInJob, JOB_OBJECT_LIMIT, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    JOBOBJECT_BASIC_ACCOUNTING_INFORMATION, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
    JobObjectBasicAccountingInformation, JobObjectExtendedLimitInformation,
    QueryInformationJobObject, SetInformationJobObject, TerminateJobObject,
};
use windows::Win32::System::Pipes::{
    ConnectNamedPipe, CreateNamedPipeW, DisconnectNamedPipe, GetNamedPipeClientProcessId,
    ImpersonateNamedPipeClient, PIPE_NOWAIT, PIPE_READMODE_BYTE, PIPE_REJECT_REMOTE_CLIENTS,
    PIPE_TYPE_BYTE, PIPE_WAIT, PeekNamedPipe, SetNamedPipeHandleState, WaitNamedPipeW,
};
use windows::Win32::System::StationsAndDesktops::{
    CloseDesktop, CreateDesktopW, DESKTOP_CONTROL_FLAGS, DESKTOP_CREATEMENU, DESKTOP_CREATEWINDOW,
    DESKTOP_DELETE, DESKTOP_ENUMERATE, DESKTOP_HOOKCONTROL, DESKTOP_JOURNALPLAYBACK,
    DESKTOP_JOURNALRECORD, DESKTOP_READ_CONTROL, DESKTOP_READOBJECTS, DESKTOP_SWITCHDESKTOP,
    DESKTOP_WRITE_DAC, DESKTOP_WRITE_OWNER, DESKTOP_WRITEOBJECTS, HDESK,
};
use windows::Win32::System::SystemServices::{
    ACCESS_ALLOWED_ACE_TYPE, ACCESS_DENIED_ACE_TYPE, SE_GROUP_LOGON_ID,
};
use windows::Win32::System::Threading::{
    CREATE_NO_WINDOW, CREATE_SUSPENDED, CREATE_UNICODE_ENVIRONMENT, CreateMutexW,
    CreateProcessAsUserW, CreateProcessW, DeleteProcThreadAttributeList,
    EXTENDED_STARTUPINFO_PRESENT, GetCurrentProcess, GetCurrentProcessId, GetCurrentThread,
    GetExitCodeProcess, GetProcessTimes, InitializeProcThreadAttributeList,
    LPPROC_THREAD_ATTRIBUTE_LIST, OpenProcess, OpenProcessToken, OpenThreadToken,
    PROC_THREAD_ATTRIBUTE_HANDLE_LIST, PROC_THREAD_ATTRIBUTE_JOB_LIST, PROCESS_ACCESS_RIGHTS,
    PROCESS_INFORMATION, PROCESS_QUERY_LIMITED_INFORMATION, ReleaseMutex, ResumeThread,
    STARTF_USESTDHANDLES, STARTUPINFOEXW, STARTUPINFOW, TerminateProcess,
    UpdateProcThreadAttribute, WaitForSingleObject,
};
use windows::core::{PCWSTR, PWSTR};

use crate::model::EnvironmentEntry;

const SEM_FAILCRITICALERRORS: u32 = 0x0001;
const SEM_NOGPFAULTERRORBOX: u32 = 0x0002;
const SEM_NOOPENFILEERRORBOX: u32 = 0x8000;
const PROCESS_SYNCHRONIZE: u32 = 0x0010_0000;

#[link(name = "kernel32")]
unsafe extern "system" {
    fn SetErrorMode(mode: u32) -> u32;
}

pub fn suppress_system_error_dialogs() {
    unsafe {
        SetErrorMode(SEM_FAILCRITICALERRORS | SEM_NOGPFAULTERRORBOX | SEM_NOOPENFILEERRORBOX);
    }
}

pub fn process_creation_time(pid: u32) -> Result<Option<u64>> {
    let process = match unsafe {
        OpenProcess(
            PROCESS_ACCESS_RIGHTS(PROCESS_QUERY_LIMITED_INFORMATION.0 | PROCESS_SYNCHRONIZE),
            false,
            pid,
        )
    } {
        Ok(process) => process,
        Err(_error)
            if unsafe { GetLastError() } == windows::Win32::Foundation::ERROR_INVALID_PARAMETER =>
        {
            return Ok(None);
        }
        Err(error) => {
            return Err(error).with_context(|| format!("OpenProcess({pid}) for identity"));
        }
    };
    let process = OwnedHandle::new(process, "process identity")?;
    let mut creation = FILETIME::default();
    let mut exit = FILETIME::default();
    let mut kernel = FILETIME::default();
    let mut user = FILETIME::default();
    unsafe {
        GetProcessTimes(
            process.raw(),
            &mut creation,
            &mut exit,
            &mut kernel,
            &mut user,
        )
        .with_context(|| format!("GetProcessTimes({pid})"))?;
    }
    Ok(Some(
        (u64::from(creation.dwHighDateTime) << 32) | u64::from(creation.dwLowDateTime),
    ))
}

pub struct OwnedHandle(HANDLE);

impl OwnedHandle {
    pub fn new(handle: HANDLE, label: &str) -> Result<Self> {
        if handle == INVALID_HANDLE_VALUE || handle.is_invalid() {
            return Err(anyhow!("{label}: {}", io::Error::last_os_error()));
        }
        Ok(Self(handle))
    }

    pub fn raw(&self) -> HANDLE {
        self.0
    }

    pub fn into_file(self) -> std::fs::File {
        let raw = self.0.0 as RawHandle;
        std::mem::forget(self);
        unsafe { std::fs::File::from_raw_handle(raw) }
    }

    pub fn try_clone(&self, label: &str) -> Result<Self> {
        let mut duplicate = HANDLE::default();
        unsafe {
            DuplicateHandle(
                GetCurrentProcess(),
                self.0,
                GetCurrentProcess(),
                &mut duplicate,
                0,
                false,
                DUPLICATE_SAME_ACCESS,
            )
            .with_context(|| format!("DuplicateHandle({label})"))?;
        }
        Self::new(duplicate, label)
    }
}

unsafe impl Send for OwnedHandle {}
unsafe impl Sync for OwnedHandle {}

impl Drop for OwnedHandle {
    fn drop(&mut self) {
        unsafe {
            let _ = CloseHandle(self.0);
        }
    }
}

pub struct LocalSid(PSID);

impl LocalSid {
    pub fn from_string(value: &str) -> Result<Self> {
        let wide = wide(value);
        let mut sid = PSID::default();
        unsafe {
            ConvertStringSidToSidW(PCWSTR(wide.as_ptr()), &mut sid)
                .with_context(|| format!("ConvertStringSidToSidW({value})"))?;
        }
        Ok(Self(sid))
    }

    pub fn raw(&self) -> PSID {
        self.0
    }
}

impl Drop for LocalSid {
    fn drop(&mut self) {
        unsafe {
            let _ = LocalFree(Some(HLOCAL(self.0.0)));
        }
    }
}

pub struct LocalSecurityDescriptor(PSECURITY_DESCRIPTOR);

impl LocalSecurityDescriptor {
    fn from_sddl(value: &str) -> Result<Self> {
        let wide = wide(value);
        let mut descriptor = PSECURITY_DESCRIPTOR::default();
        unsafe {
            ConvertStringSecurityDescriptorToSecurityDescriptorW(
                PCWSTR(wide.as_ptr()),
                SDDL_REVISION_1,
                &mut descriptor,
                None,
            )
            .with_context(|| {
                format!("ConvertStringSecurityDescriptorToSecurityDescriptorW({value})")
            })?;
        }
        Ok(Self(descriptor))
    }
}

impl Drop for LocalSecurityDescriptor {
    fn drop(&mut self) {
        unsafe {
            let _ = LocalFree(Some(HLOCAL(self.0.0)));
        }
    }
}

pub fn wide(value: &str) -> Vec<u16> {
    value.encode_utf16().chain(std::iter::once(0)).collect()
}

fn token_information(token: HANDLE, class: TOKEN_INFORMATION_CLASS) -> Result<Vec<u8>> {
    unsafe {
        let mut length = 0u32;
        let _ = GetTokenInformation(token, class, None, 0, &mut length);
        if length == 0 {
            bail!("GetTokenInformation({class:?}) returned an empty size");
        }
        let mut buffer = vec![0u8; length as usize];
        GetTokenInformation(
            token,
            class,
            Some(buffer.as_mut_ptr() as *mut c_void),
            length,
            &mut length,
        )
        .with_context(|| format!("GetTokenInformation({class:?})"))?;
        Ok(buffer)
    }
}

pub fn sid_to_string(sid: PSID) -> Result<String> {
    let mut value = PWSTR::null();
    unsafe {
        ConvertSidToStringSidW(sid, &mut value).context("ConvertSidToStringSidW")?;
        let result = value.to_string().context("decode SID string")?;
        let _ = LocalFree(Some(HLOCAL(value.0 as *mut c_void)));
        Ok(result)
    }
}

pub fn current_token() -> Result<OwnedHandle> {
    unsafe {
        let mut handle = HANDLE::default();
        OpenProcessToken(GetCurrentProcess(), TOKEN_ALL_ACCESS, &mut handle)
            .context("OpenProcessToken(current)")?;
        OwnedHandle::new(handle, "current token")
    }
}

pub fn token_user_sid(token: HANDLE) -> Result<String> {
    let buffer = token_information(token, TokenUser)?;
    let user = unsafe { &*(buffer.as_ptr() as *const TOKEN_USER) };
    sid_to_string(user.User.Sid)
}

fn token_logon_sid_bytes(token: HANDLE) -> Result<Vec<u8>> {
    let buffer = token_information(token, TokenGroups)?;
    unsafe {
        let groups = &*(buffer.as_ptr() as *const TOKEN_GROUPS);
        for group in std::slice::from_raw_parts(groups.Groups.as_ptr(), groups.GroupCount as usize)
        {
            if group.Attributes & SE_GROUP_LOGON_ID as u32 == SE_GROUP_LOGON_ID as u32 {
                let length = GetLengthSid(group.Sid) as usize;
                if length == 0 {
                    bail!("GetLengthSid(logon SID) returned zero");
                }
                return Ok(std::slice::from_raw_parts(group.Sid.0 as *const u8, length).to_vec());
            }
        }
    }
    bail!("sandbox runner token has no logon SID")
}

fn token_restricted_sid_strings(token: HANDLE) -> Result<Vec<String>> {
    let buffer = token_information(token, TokenRestrictedSids)?;
    unsafe {
        let groups = &*(buffer.as_ptr() as *const TOKEN_GROUPS);
        std::slice::from_raw_parts(groups.Groups.as_ptr(), groups.GroupCount as usize)
            .iter()
            .map(|group| sid_to_string(group.Sid))
            .collect()
    }
}

fn set_token_default_dacl(token: HANDLE, sids: &[&LocalSid]) -> Result<()> {
    let entries: Vec<EXPLICIT_ACCESS_W> = sids
        .iter()
        .map(|sid| EXPLICIT_ACCESS_W {
            grfAccessPermissions: GENERIC_ALL.0,
            grfAccessMode: GRANT_ACCESS,
            grfInheritance: Default::default(),
            Trustee: TRUSTEE_W {
                pMultipleTrustee: null_mut(),
                MultipleTrusteeOperation: NO_MULTIPLE_TRUSTEE,
                TrusteeForm: TRUSTEE_IS_SID,
                TrusteeType: TRUSTEE_IS_UNKNOWN,
                ptstrName: PWSTR(sid.raw().0 as *mut u16),
            },
        })
        .collect();
    let mut dacl = null_mut();
    let code = unsafe { SetEntriesInAclW(Some(&entries), None, &mut dacl) };
    if code != ERROR_SUCCESS {
        if !dacl.is_null() {
            unsafe {
                let _ = LocalFree(Some(HLOCAL(dacl.cast())));
            }
        }
        bail!("SetEntriesInAclW(token default DACL) failed with {code:?}");
    }
    if dacl.is_null() {
        bail!("SetEntriesInAclW(token default DACL) returned no ACL");
    }
    let info = TOKEN_DEFAULT_DACL { DefaultDacl: dacl };
    let result = unsafe {
        SetTokenInformation(
            token,
            TokenDefaultDacl,
            &info as *const TOKEN_DEFAULT_DACL as *const c_void,
            size_of::<TOKEN_DEFAULT_DACL>() as u32,
        )
    }
    .context("SetTokenInformation(TokenDefaultDacl)");
    unsafe {
        let _ = LocalFree(Some(HLOCAL(dacl.cast())));
    }
    result
}

fn token_default_dacl_aces(token: HANDLE) -> Result<Vec<(String, u32)>> {
    let buffer = token_information(token, TokenDefaultDacl)?;
    let info = unsafe { &*(buffer.as_ptr() as *const TOKEN_DEFAULT_DACL) };
    if info.DefaultDacl.is_null() {
        bail!("restricted token has no default DACL");
    }
    let acl = unsafe { &*info.DefaultDacl };
    let mut result = Vec::with_capacity(acl.AceCount as usize);
    for index in 0..u32::from(acl.AceCount) {
        let mut raw_ace = null_mut();
        unsafe {
            GetAce(info.DefaultDacl, index, &mut raw_ace)
                .with_context(|| format!("GetAce(TokenDefaultDacl, {index})"))?;
        }
        let header = unsafe { &*(raw_ace as *const windows::Win32::Security::ACE_HEADER) };
        if u32::from(header.AceType) != ACCESS_ALLOWED_ACE_TYPE {
            continue;
        }
        let ace = unsafe { &*(raw_ace as *const windows::Win32::Security::ACCESS_ALLOWED_ACE) };
        result.push((
            sid_to_string(PSID((&ace.SidStart as *const u32).cast_mut().cast()))?,
            ace.Mask,
        ));
    }
    Ok(result)
}

fn enable_change_notify_privilege(token: HANDLE) -> Result<()> {
    let mut privileges = TOKEN_PRIVILEGES::default();
    let name = wide("SeChangeNotifyPrivilege");
    unsafe {
        LookupPrivilegeValueW(
            None,
            PCWSTR(name.as_ptr()),
            &mut privileges.Privileges[0].Luid,
        )
        .context("LookupPrivilegeValueW(SeChangeNotifyPrivilege)")?;
    }
    privileges.PrivilegeCount = 1;
    privileges.Privileges[0].Attributes = SE_PRIVILEGE_ENABLED;
    unsafe {
        SetLastError(ERROR_SUCCESS);
        AdjustTokenPrivileges(token, false, Some(&privileges), 0, None, None)
            .context("AdjustTokenPrivileges(SeChangeNotifyPrivilege)")?;
        let code = GetLastError();
        if code != ERROR_SUCCESS {
            bail!("AdjustTokenPrivileges(SeChangeNotifyPrivilege) failed with {code:?}");
        }
    }
    Ok(())
}

pub fn current_logon_sid() -> Result<String> {
    let token = current_token()?;
    let bytes = token_logon_sid_bytes(token.raw())?;
    sid_to_string(PSID(bytes.as_ptr() as *mut c_void))
}

pub fn protect_current_process(host_sid: &str) -> Result<()> {
    let host = LocalSid::from_string(host_sid)?;
    let canonical_host_sid = sid_to_string(host.raw())?;
    let descriptor = LocalSecurityDescriptor::from_sddl(&format!(
        "D:P(D;;GA;;;S-1-3-4)(A;;GA;;;SY)(A;;GA;;;{canonical_host_sid})"
    ))?;
    unsafe {
        SetKernelObjectSecurity(
            GetCurrentProcess(),
            DACL_SECURITY_INFORMATION | PROTECTED_DACL_SECURITY_INFORMATION,
            descriptor.0,
        )
        .context("SetKernelObjectSecurity(current runner)")
    }
}

pub fn verify_protected_runner_process(
    pid: u32,
    host_sid: &str,
    sandbox_user_sid: &str,
) -> Result<()> {
    let process = unsafe { OpenProcess(PROCESS_ACCESS_RIGHTS(READ_CONTROL.0), false, pid) }
        .context("OpenProcess(runner DACL readback)")?;
    let process = OwnedHandle::new(process, "runner DACL readback")?;
    let mut owner = PSID::default();
    let mut dacl: *mut ACL = null_mut();
    let mut descriptor = PSECURITY_DESCRIPTOR::default();
    let code = unsafe {
        GetSecurityInfo(
            process.raw(),
            SE_KERNEL_OBJECT,
            DACL_SECURITY_INFORMATION | OWNER_SECURITY_INFORMATION,
            Some(&mut owner),
            None,
            Some(&mut dacl),
            None,
            Some(&mut descriptor),
        )
    };
    if code != ERROR_SUCCESS {
        if !descriptor.0.is_null() {
            unsafe {
                let _ = LocalFree(Some(HLOCAL(descriptor.0)));
            }
        }
        bail!("GetSecurityInfo(runner) failed with {code:?}");
    }
    let _descriptor = LocalSecurityDescriptor(descriptor);
    if owner.0.is_null() || dacl.is_null() {
        bail!("runner process returned an incomplete security descriptor");
    }
    if !sid_to_string(owner)?.eq_ignore_ascii_case(sandbox_user_sid) {
        bail!("runner process owner changed before authentication");
    }
    let expected_host = LocalSid::from_string(host_sid)?;
    let expected_host = sid_to_string(expected_host.raw())?;
    let mut owner_rights_deny = false;
    let mut host_allow = false;
    let mut system_allow = false;
    let acl = unsafe { &*dacl };
    const OWNER_CONTROL_MASK: u32 = 0x0004_0000 | 0x0008_0000; // WRITE_DAC | WRITE_OWNER
    for index in 0..u32::from(acl.AceCount) {
        let mut raw = null_mut();
        unsafe { GetAce(dacl, index, &mut raw) }
            .with_context(|| format!("GetAce(runner, {index})"))?;
        if raw.is_null() {
            bail!("runner process DACL returned a null ACE");
        }
        let header = unsafe { &*(raw as *const windows::Win32::Security::ACE_HEADER) };
        if header.AceType != ACCESS_ALLOWED_ACE_TYPE as u8
            && header.AceType != ACCESS_DENIED_ACE_TYPE as u8
        {
            continue;
        }
        let ace = unsafe { &*(raw as *const windows::Win32::Security::ACCESS_ALLOWED_ACE) };
        let sid = sid_to_string(PSID((&ace.SidStart as *const u32).cast_mut().cast()))?;
        if header.AceType == ACCESS_DENIED_ACE_TYPE as u8
            && sid == "S-1-3-4"
            && ace.Mask & OWNER_CONTROL_MASK == OWNER_CONTROL_MASK
        {
            owner_rights_deny = true;
        }
        if header.AceType == ACCESS_ALLOWED_ACE_TYPE as u8
            && ace.Mask & OWNER_CONTROL_MASK == OWNER_CONTROL_MASK
        {
            host_allow |= sid.eq_ignore_ascii_case(&expected_host);
            system_allow |= sid == "S-1-5-18";
        }
    }
    if !owner_rights_deny || !host_allow || !system_allow {
        bail!("runner process DACL did not preserve its host/SYSTEM/OWNER RIGHTS boundary");
    }
    Ok(())
}

fn policy_restrictions(
    capabilities: &[LocalSid],
    account: &LocalSid,
    logon: &LocalSid,
    everyone: &LocalSid,
) -> Vec<SID_AND_ATTRIBUTES> {
    capabilities
        .iter()
        .chain([account, logon, everyone])
        .map(|sid| SID_AND_ATTRIBUTES {
            Sid: sid.raw(),
            Attributes: 0,
        })
        .collect()
}

pub fn restricted_policy_token(
    policy_capability_sid: &str,
    filesystem_capability_sids: &[String],
) -> Result<OwnedHandle> {
    let base = current_token()?;
    let mut capability_sid_strings = Vec::with_capacity(filesystem_capability_sids.len() + 1);
    capability_sid_strings.push(policy_capability_sid.to_owned());
    capability_sid_strings.extend(filesystem_capability_sids.iter().cloned());
    let capabilities = capability_sid_strings
        .iter()
        .map(|sid| LocalSid::from_string(sid))
        .collect::<Result<Vec<_>>>()?;
    let policy_capability = capabilities
        .first()
        .ok_or_else(|| anyhow!("restricted policy token omitted its policy capability"))?;
    let account_sid = token_user_sid(base.raw())?;
    let account = LocalSid::from_string(&account_sid)?;
    let logon_sid = current_logon_sid()?;
    let logon = LocalSid::from_string(&logon_sid)?;
    let everyone_sid = "S-1-1-0";
    let everyone = LocalSid::from_string(everyone_sid)?;
    // Windows loader/IPC compatibility requires the same identity SIDs used by
    // Codex. Filesystem roots compensate explicitly: every read-only root
    // carries a stable deny-write clause in the restricted access pass.
    let restrictions = policy_restrictions(&capabilities, &account, &logon, &everyone);
    let mut restricted = HANDLE::default();
    unsafe {
        CreateRestrictedToken(
            base.raw(),
            DISABLE_MAX_PRIVILEGE | LUA_TOKEN | WRITE_RESTRICTED,
            None,
            None,
            Some(&restrictions),
            &mut restricted,
        )
        .context("CreateRestrictedToken(policy capability)")?;
    }
    let restricted = OwnedHandle::new(restricted, "restricted policy token")?;
    let observed_restrictions = token_restricted_sid_strings(restricted.raw())?;
    let expected_restrictions = capability_sid_strings
        .iter()
        .cloned()
        .chain([account_sid, logon_sid.clone(), everyone_sid.to_owned()])
        .collect::<Vec<_>>();
    if observed_restrictions != expected_restrictions {
        bail!("restricted policy token did not preserve its policy capability boundary");
    }
    set_token_default_dacl(restricted.raw(), &[&logon, &everyone, policy_capability])?;
    let expected_default_dacl = [
        (logon_sid, GENERIC_ALL.0),
        (everyone_sid.to_owned(), GENERIC_ALL.0),
        (policy_capability_sid.to_owned(), GENERIC_ALL.0),
    ];
    if token_default_dacl_aces(restricted.raw())? != expected_default_dacl {
        bail!("restricted policy token did not preserve its safe default DACL");
    }
    enable_change_notify_privilege(restricted.raw())?;
    let mut primary = HANDLE::default();
    unsafe {
        DuplicateTokenEx(
            restricted.raw(),
            TOKEN_ALL_ACCESS,
            None,
            SecurityImpersonation,
            TokenPrimary,
            &mut primary,
        )
        .context("DuplicateTokenEx(policy primary)")?;
    }
    let primary = OwnedHandle::new(primary, "restricted policy primary token")?;
    if token_restricted_sid_strings(primary.raw())? != expected_restrictions {
        bail!("restricted policy primary token changed its restricting SID boundary");
    }
    if token_default_dacl_aces(primary.raw())? != expected_default_dacl {
        bail!("restricted policy primary token changed its safe default DACL");
    }
    Ok(primary)
}

/// Grants the policy capability access to the Windows null device.
///
/// Node opens `NUL` for descendants whose stdio is `ignore`. Keep this exact
/// account ACE as a setup/readback contract even though the restricted token
/// also carries the Windows loader-compatibility SIDs.
pub fn ensure_null_device_access(sandbox_sid: &str) -> Result<()> {
    let sandbox = LocalSid::from_string(sandbox_sid)?;
    let nul = wide(r"\\.\NUL");
    let handle = unsafe {
        CreateFileW(
            PCWSTR(nul.as_ptr()),
            READ_CONTROL.0 | WRITE_DAC.0,
            FILE_SHARE_READ | FILE_SHARE_WRITE,
            None,
            OPEN_EXISTING,
            FILE_ATTRIBUTE_NORMAL,
            None,
        )
    }
    .context("open NUL security descriptor")?;
    let handle = OwnedHandle::new(handle, "NUL security descriptor")?;
    let mut descriptor = PSECURITY_DESCRIPTOR::default();
    let mut old_dacl: *mut ACL = null_mut();
    let query = unsafe {
        GetSecurityInfo(
            handle.raw(),
            SE_KERNEL_OBJECT,
            DACL_SECURITY_INFORMATION,
            None,
            None,
            Some(&mut old_dacl),
            None,
            Some(&mut descriptor),
        )
    };
    if query != ERROR_SUCCESS {
        if !descriptor.0.is_null() {
            unsafe {
                let _ = LocalFree(Some(HLOCAL(descriptor.0)));
            }
        }
        bail!("GetSecurityInfo(NUL) failed with {query:?}");
    }
    let _descriptor = LocalSecurityDescriptor(descriptor);
    if old_dacl.is_null() {
        bail!("NUL has an unsupported null DACL");
    }
    let entry = EXPLICIT_ACCESS_W {
        grfAccessPermissions: FILE_GENERIC_READ.0 | FILE_GENERIC_WRITE.0 | FILE_GENERIC_EXECUTE.0,
        grfAccessMode: GRANT_ACCESS,
        grfInheritance: Default::default(),
        Trustee: TRUSTEE_W {
            pMultipleTrustee: null_mut(),
            MultipleTrusteeOperation: NO_MULTIPLE_TRUSTEE,
            TrusteeForm: TRUSTEE_IS_SID,
            TrusteeType: TRUSTEE_IS_UNKNOWN,
            ptstrName: PWSTR(sandbox.raw().0 as *mut u16),
        },
    };
    let mut new_dacl = null_mut();
    let update = unsafe { SetEntriesInAclW(Some(&[entry]), Some(old_dacl), &mut new_dacl) };
    if update != ERROR_SUCCESS {
        if !new_dacl.is_null() {
            unsafe {
                let _ = LocalFree(Some(HLOCAL(new_dacl.cast())));
            }
        }
        bail!("SetEntriesInAclW(NUL) failed with {update:?}");
    }
    if new_dacl.is_null() {
        bail!("SetEntriesInAclW(NUL) returned no DACL");
    }
    let set = unsafe {
        SetSecurityInfo(
            handle.raw(),
            SE_KERNEL_OBJECT,
            DACL_SECURITY_INFORMATION,
            None,
            None,
            Some(new_dacl),
            None,
        )
    };
    unsafe {
        let _ = LocalFree(Some(HLOCAL(new_dacl.cast())));
    }
    if set != ERROR_SUCCESS {
        bail!("SetSecurityInfo(NUL) failed with {set:?}");
    }
    Ok(())
}

pub fn verify_null_device_access(sandbox_sid: &str) -> Result<()> {
    let nul = wide(r"\\.\NUL");
    let handle = unsafe {
        CreateFileW(
            PCWSTR(nul.as_ptr()),
            READ_CONTROL.0,
            FILE_SHARE_READ | FILE_SHARE_WRITE,
            None,
            OPEN_EXISTING,
            FILE_ATTRIBUTE_NORMAL,
            None,
        )
    }
    .context("open NUL for verification")?;
    let handle = OwnedHandle::new(handle, "NUL verification")?;
    let mut descriptor = PSECURITY_DESCRIPTOR::default();
    let mut dacl: *mut ACL = null_mut();
    let query = unsafe {
        GetSecurityInfo(
            handle.raw(),
            SE_KERNEL_OBJECT,
            DACL_SECURITY_INFORMATION,
            None,
            None,
            Some(&mut dacl),
            None,
            Some(&mut descriptor),
        )
    };
    if query != ERROR_SUCCESS {
        if !descriptor.0.is_null() {
            unsafe {
                let _ = LocalFree(Some(HLOCAL(descriptor.0)));
            }
        }
        bail!("GetSecurityInfo(NUL verification) failed with {query:?}");
    }
    let _descriptor = LocalSecurityDescriptor(descriptor);
    if dacl.is_null() {
        bail!("NUL has an unsupported null DACL");
    }
    let expected_mask = FILE_GENERIC_READ.0 | FILE_GENERIC_WRITE.0 | FILE_GENERIC_EXECUTE.0;
    let acl = unsafe { &*dacl };
    let mut exact_aces = 0u16;
    for index in 0..u32::from(acl.AceCount) {
        let mut raw = null_mut();
        unsafe { GetAce(dacl, index, &mut raw) }
            .with_context(|| format!("GetAce(NUL, {index})"))?;
        if raw.is_null() {
            bail!("NUL DACL returned a null ACE");
        }
        let header = unsafe { &*(raw as *const windows::Win32::Security::ACE_HEADER) };
        if header.AceType != ACCESS_ALLOWED_ACE_TYPE as u8
            && header.AceType != ACCESS_DENIED_ACE_TYPE as u8
        {
            continue;
        }
        let ace = unsafe { &*(raw as *const windows::Win32::Security::ACCESS_ALLOWED_ACE) };
        let sid = sid_to_string(PSID((&ace.SidStart as *const u32).cast_mut().cast()))?;
        if sid.eq_ignore_ascii_case(sandbox_sid) {
            if header.AceType != ACCESS_ALLOWED_ACE_TYPE as u8 || ace.Mask != expected_mask {
                bail!("NUL sandbox-account ACE is not the exact compatibility grant");
            }
            exact_aces += 1;
        }
    }
    if exact_aces != 1 {
        bail!("NUL sandbox-account ACE is missing or duplicated");
    }
    Ok(())
}

pub struct NamedPipeServer {
    pub name: String,
    handle: OwnedHandle,
    _descriptor: LocalSecurityDescriptor,
}

pub struct NamedPipeServers {
    pub runner_events: NamedPipeServer,
    pub runner_control: NamedPipeServer,
    pub session_nonce: String,
}

impl NamedPipeServers {
    pub fn create(host_sid: &str, sandbox_sid: &str) -> Result<Self> {
        let session_nonce = uuid::Uuid::new_v4().simple().to_string();
        let unique = format!("{}-{session_nonce}", unsafe { GetCurrentProcessId() });
        let runner_events = NamedPipeServer::create(
            format!(r"\\.\pipe\kodax-sandbox-v2-{unique}-r2h"),
            host_sid,
            sandbox_sid,
            // SetNamedPipeHandleState requires write access even when changing
            // the read-side wait mode. Keep this dedicated transport logically
            // runner-to-host; no production code writes through the server end.
            PIPE_ACCESS_DUPLEX,
            "GRGW",
            0,
            256 * 1024,
        )?;
        let runner_control = NamedPipeServer::create(
            format!(r"\\.\pipe\kodax-sandbox-v2-{unique}-h2r"),
            host_sid,
            sandbox_sid,
            PIPE_ACCESS_OUTBOUND,
            "GRGW",
            256 * 1024,
            0,
        )?;
        Ok(Self {
            runner_events,
            runner_control,
            session_nonce,
        })
    }
}

impl NamedPipeServer {
    #[allow(clippy::too_many_arguments)]
    fn create(
        name: String,
        host_sid: &str,
        sandbox_sid: &str,
        access: windows::Win32::Storage::FileSystem::FILE_FLAGS_AND_ATTRIBUTES,
        sandbox_access: &str,
        output_buffer_bytes: u32,
        input_buffer_bytes: u32,
    ) -> Result<Self> {
        let descriptor = LocalSecurityDescriptor::from_sddl(&format!(
            "D:P(A;;GA;;;SY)(A;;GA;;;{host_sid})(A;;{sandbox_access};;;{sandbox_sid})"
        ))?;
        let security = SECURITY_ATTRIBUTES {
            nLength: size_of::<SECURITY_ATTRIBUTES>() as u32,
            lpSecurityDescriptor: descriptor.0.0,
            bInheritHandle: false.into(),
        };
        let wide_name = wide(&name);
        let handle = unsafe {
            CreateNamedPipeW(
                PCWSTR(wide_name.as_ptr()),
                access | FILE_FLAG_FIRST_PIPE_INSTANCE,
                PIPE_TYPE_BYTE | PIPE_READMODE_BYTE | PIPE_NOWAIT | PIPE_REJECT_REMOTE_CLIENTS,
                1,
                output_buffer_bytes,
                input_buffer_bytes,
                0,
                Some(&security),
            )
        };
        Ok(Self {
            name,
            handle: OwnedHandle::new(handle, "CreateNamedPipeW")?,
            _descriptor: descriptor,
        })
    }

    pub fn try_connect(self) -> Result<Result<(std::fs::File, u32), Self>> {
        let connected = unsafe { ConnectNamedPipe(self.handle.raw(), None) };
        if let Err(error) = connected {
            let code = unsafe { GetLastError() };
            if code == ERROR_PIPE_LISTENING || code == ERROR_NO_DATA {
                return Ok(Err(self));
            }
            if code != ERROR_PIPE_CONNECTED {
                return Err(error).context("ConnectNamedPipe");
            }
        }
        let mode = PIPE_READMODE_BYTE | PIPE_WAIT;
        unsafe {
            SetNamedPipeHandleState(self.handle.raw(), Some(&mode), None, None)
                .context("SetNamedPipeHandleState(blocking)")?;
        }
        let mut pid = 0u32;
        unsafe {
            GetNamedPipeClientProcessId(self.handle.raw(), &mut pid)
                .context("GetNamedPipeClientProcessId")?;
        }
        Ok(Ok((self.handle.into_file(), pid)))
    }
}

fn connect_named_pipe(name: &str, access: u32, label: &str) -> Result<(std::fs::File, u32)> {
    let wide_name = wide(name);
    let handle = unsafe {
        CreateFileW(
            PCWSTR(wide_name.as_ptr()),
            access,
            FILE_SHARE_MODE(0),
            None,
            OPEN_EXISTING,
            FILE_ATTRIBUTE_NORMAL,
            None,
        )
    }
    .with_context(|| format!("connect named pipe {name}"))?;
    let handle = OwnedHandle::new(handle, label)?;
    let mut server_pid = 0u32;
    unsafe {
        windows::Win32::System::Pipes::GetNamedPipeServerProcessId(handle.raw(), &mut server_pid)
            .context("GetNamedPipeServerProcessId")?;
    }
    Ok((handle.into_file(), server_pid))
}

pub fn connect_named_pipe_reader(name: &str) -> Result<(std::fs::File, u32)> {
    connect_named_pipe(name, GENERIC_READ.0, "named pipe reader")
}

pub fn connect_named_pipe_writer(name: &str) -> Result<(std::fs::File, u32)> {
    connect_named_pipe(name, GENERIC_WRITE.0, "named pipe writer")
}

pub fn connect_controller_pipe(name: &str, timeout: Duration) -> Result<(std::fs::File, u32)> {
    let wide_name = wide(name);
    let started = std::time::Instant::now();
    let handle = loop {
        match unsafe {
            CreateFileW(
                PCWSTR(wide_name.as_ptr()),
                FILE_GENERIC_READ.0 | FILE_GENERIC_WRITE.0,
                FILE_SHARE_MODE(0),
                None,
                OPEN_EXISTING,
                FILE_ATTRIBUTE_NORMAL,
                None,
            )
        } {
            Ok(handle) => break handle,
            Err(error) => {
                let code = unsafe { GetLastError() };
                if code != ERROR_PIPE_BUSY && code != ERROR_FILE_NOT_FOUND {
                    return Err(error).with_context(|| format!("connect controller pipe {name}"));
                }
                let remaining = timeout.saturating_sub(started.elapsed());
                if remaining.is_zero() {
                    return Err(error)
                        .with_context(|| format!("controller pipe {name} remained busy"));
                }
                let wait_ms = u32::try_from(remaining.as_millis().min(100))
                    .unwrap_or(100)
                    .max(1);
                let _ = unsafe { WaitNamedPipeW(PCWSTR(wide_name.as_ptr()), wait_ms) };
            }
        }
    };
    let handle = OwnedHandle::new(handle, "controller pipe client")?;
    let mode = PIPE_READMODE_BYTE | PIPE_NOWAIT;
    unsafe {
        SetNamedPipeHandleState(handle.raw(), Some(&mode), None, None)
            .context("SetNamedPipeHandleState(controller nonblocking)")?;
    }
    let mut server_pid = 0u32;
    unsafe {
        windows::Win32::System::Pipes::GetNamedPipeServerProcessId(handle.raw(), &mut server_pid)
            .context("GetNamedPipeServerProcessId(controller)")?;
    }
    Ok((handle.into_file(), server_pid))
}

fn create_controller_pipe_instance(
    name: &str,
    descriptor: &LocalSecurityDescriptor,
    first: bool,
) -> Result<OwnedHandle> {
    let security = SECURITY_ATTRIBUTES {
        nLength: size_of::<SECURITY_ATTRIBUTES>() as u32,
        lpSecurityDescriptor: descriptor.0.0,
        bInheritHandle: false.into(),
    };
    let wide_name = wide(name);
    let access = if first {
        PIPE_ACCESS_DUPLEX | FILE_FLAG_FIRST_PIPE_INSTANCE
    } else {
        PIPE_ACCESS_DUPLEX
    };
    let handle = unsafe {
        CreateNamedPipeW(
            PCWSTR(wide_name.as_ptr()),
            access,
            PIPE_TYPE_BYTE | PIPE_READMODE_BYTE | PIPE_NOWAIT | PIPE_REJECT_REMOTE_CLIENTS,
            255,
            4 * 1024,
            4 * 1024,
            0,
            Some(&security),
        )
    };
    OwnedHandle::new(handle, "CreateNamedPipeW(controller)")
}

fn controller_pipe_security_descriptor(host_sid: &str) -> Result<LocalSecurityDescriptor> {
    LocalSecurityDescriptor::from_sddl(&format!("O:{host_sid}D:P(A;;GA;;;SY)(A;;GA;;;{host_sid})"))
}

enum ControllerPipeState {
    Listening,
    Connected,
    Retire,
}

fn controller_pipe_state(handle: &OwnedHandle) -> Result<ControllerPipeState> {
    let connected = unsafe { ConnectNamedPipe(handle.raw(), None) };
    if connected.is_ok() {
        let mode = PIPE_READMODE_BYTE | PIPE_WAIT;
        unsafe {
            SetNamedPipeHandleState(handle.raw(), Some(&mode), None, None)
                .context("SetNamedPipeHandleState(controller blocking)")?;
        }
        return Ok(ControllerPipeState::Connected);
    }
    let code = unsafe { GetLastError() };
    if code == ERROR_PIPE_CONNECTED {
        let mode = PIPE_READMODE_BYTE | PIPE_WAIT;
        unsafe {
            SetNamedPipeHandleState(handle.raw(), Some(&mode), None, None)
                .context("SetNamedPipeHandleState(controller blocking)")?;
        }
        return Ok(ControllerPipeState::Connected);
    }
    if code == ERROR_PIPE_LISTENING {
        return Ok(ControllerPipeState::Listening);
    }
    if code == ERROR_NO_DATA {
        return Ok(ControllerPipeState::Retire);
    }
    connected.context("ConnectNamedPipe(controller)")?;
    unreachable!()
}

fn verify_controller_pipe_security(handle: &OwnedHandle, host_sid: &str) -> Result<()> {
    let mut owner = PSID::default();
    let mut dacl: *mut ACL = null_mut();
    let mut descriptor = PSECURITY_DESCRIPTOR::default();
    let code = unsafe {
        GetSecurityInfo(
            handle.raw(),
            SE_KERNEL_OBJECT,
            DACL_SECURITY_INFORMATION | OWNER_SECURITY_INFORMATION,
            Some(&mut owner),
            None,
            Some(&mut dacl),
            None,
            Some(&mut descriptor),
        )
    };
    if code != ERROR_SUCCESS {
        bail!("GetSecurityInfo(controller pipe) failed with {code:?}");
    }
    let _descriptor = LocalSecurityDescriptor(descriptor);
    if owner.0.is_null() || dacl.is_null() || !sid_to_string(owner)?.eq_ignore_ascii_case(host_sid)
    {
        bail!("Controller pipe is not owned by the exact host SID");
    }
    let mut control = 0u16;
    let mut revision = 0u32;
    unsafe { GetSecurityDescriptorControl(descriptor, &mut control, &mut revision) }
        .context("GetSecurityDescriptorControl(controller pipe)")?;
    if control & SE_DACL_PROTECTED.0 == 0 {
        bail!("Controller pipe DACL is not protected");
    }
    let acl = unsafe { &*dacl };
    if acl.AceCount != 2 {
        bail!("Controller pipe DACL is not host/SYSTEM-only");
    }
    let mut host_allow = false;
    let mut system_allow = false;
    for index in 0..u32::from(acl.AceCount) {
        let mut raw = null_mut();
        unsafe { GetAce(dacl, index, &mut raw) }
            .with_context(|| format!("GetAce(controller pipe, {index})"))?;
        let header = unsafe { &*(raw as *const windows::Win32::Security::ACE_HEADER) };
        if header.AceType != ACCESS_ALLOWED_ACE_TYPE as u8 {
            bail!("Controller pipe DACL contains a non-allow ACE");
        }
        let ace = unsafe { &*(raw as *const windows::Win32::Security::ACCESS_ALLOWED_ACE) };
        if ace.Mask != FILE_ALL_ACCESS.0 {
            bail!("Controller pipe DACL contains a non-full-control ACE");
        }
        let sid = sid_to_string(PSID((&ace.SidStart as *const u32).cast_mut().cast()))?;
        host_allow |= sid.eq_ignore_ascii_case(host_sid);
        system_allow |= sid == "S-1-5-18";
    }
    if !host_allow || !system_allow {
        bail!("Controller pipe DACL omitted host or SYSTEM");
    }
    Ok(())
}

fn controller_pipe_client_alive(handle: &OwnedHandle) -> bool {
    unsafe { PeekNamedPipe(handle.raw(), None, 0, None, None, None).is_ok() }
}

pub fn run_controller_pipe_server(broker_pid: u32) -> Result<()> {
    if broker_pid == 0 || broker_pid == unsafe { GetCurrentProcessId() } {
        bail!("Windows sandbox controller broker PID is invalid");
    }
    let token = current_token()?;
    if !token_restricted_sid_strings(token.raw())?.is_empty() {
        bail!("Windows sandbox controller must run under the trusted host token");
    }
    let host_sid = token_user_sid(token.raw())?;
    let broker = unsafe {
        OpenProcess(
            PROCESS_ACCESS_RIGHTS(PROCESS_SYNCHRONIZE),
            false,
            broker_pid,
        )
    }
    .context("OpenProcess(controller broker)")?;
    let broker = OwnedHandle::new(broker, "controller broker")?;
    let descriptor = controller_pipe_security_descriptor(&host_sid)?;
    let name = format!(
        r"\\.\pipe\kodax-v2-{}-{}",
        unsafe { GetCurrentProcessId() },
        uuid::Uuid::new_v4(),
    );
    const PENDING_INSTANCES: usize = 8;
    let mut listeners = Vec::with_capacity(PENDING_INSTANCES);
    listeners.push(create_controller_pipe_instance(&name, &descriptor, true)?);
    verify_controller_pipe_security(&listeners[0], &host_sid)?;
    while listeners.len() < PENDING_INSTANCES {
        listeners.push(create_controller_pipe_instance(&name, &descriptor, false)?);
    }
    let mut clients: Vec<OwnedHandle> = Vec::new();
    let (stdin_done, stdin_status) = mpsc::channel();
    thread::spawn(move || {
        let result = io::copy(&mut io::stdin(), &mut io::sink());
        let _ = stdin_done.send(result);
    });
    println!("{name}");
    io::stdout().flush().context("flush controller readiness")?;

    loop {
        match stdin_status.try_recv() {
            Ok(Ok(_)) => break,
            Ok(Err(error)) => return Err(error).context("read controller lifetime stdin"),
            Err(mpsc::TryRecvError::Disconnected) => {
                bail!("Controller lifetime stdin monitor stopped unexpectedly")
            }
            Err(mpsc::TryRecvError::Empty) => {}
        }
        match unsafe { WaitForSingleObject(broker.raw(), 0) } {
            WAIT_OBJECT_0 => break,
            WAIT_TIMEOUT => {}
            other => bail!("Controller broker wait failed with {other:?}"),
        }
        let mut pending = Vec::with_capacity(PENDING_INSTANCES);
        for listener in listeners.drain(..) {
            match controller_pipe_state(&listener)? {
                ControllerPipeState::Listening => pending.push(listener),
                ControllerPipeState::Connected => clients.push(listener),
                ControllerPipeState::Retire => {}
            }
        }
        while pending.len() < PENDING_INSTANCES {
            pending.push(create_controller_pipe_instance(&name, &descriptor, false)?);
        }
        listeners = pending;
        clients.retain(controller_pipe_client_alive);
        thread::sleep(Duration::from_millis(10));
    }
    Ok(())
}

pub fn named_pipe_available_bytes(pipe: &std::fs::File) -> Result<u32> {
    let mut available = 0u32;
    unsafe {
        PeekNamedPipe(
            HANDLE(pipe.as_raw_handle()),
            None,
            0,
            None,
            Some(&mut available),
            None,
        )
        .context("PeekNamedPipe(controller)")?;
    }
    Ok(available)
}

struct ImpersonationGuard;

impl Drop for ImpersonationGuard {
    fn drop(&mut self) {
        unsafe {
            let _ = RevertToSelf();
        }
    }
}

pub fn named_pipe_client_identity(pipe: &std::fs::File) -> Result<(String, String, bool)> {
    let handle = HANDLE(pipe.as_raw_handle());
    unsafe {
        ImpersonateNamedPipeClient(handle).context("ImpersonateNamedPipeClient")?;
    }
    let _guard = ImpersonationGuard;
    let mut token = HANDLE::default();
    unsafe {
        OpenThreadToken(GetCurrentThread(), TOKEN_QUERY, true, &mut token)
            .context("OpenThreadToken(named pipe client)")?;
    }
    let token = OwnedHandle::new(token, "named pipe client token")?;
    let sid = token_user_sid(token.raw())?;
    let logon_bytes = token_logon_sid_bytes(token.raw())?;
    let logon_sid = sid_to_string(PSID(logon_bytes.as_ptr() as *mut c_void))?;
    Ok((
        sid,
        logon_sid,
        !token_restricted_sid_strings(token.raw())?.is_empty(),
    ))
}

pub fn process_is_descendant_of(pid: u32, ancestor_pid: u32) -> Result<bool> {
    let snapshot = unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) }
        .context("CreateToolhelp32Snapshot(processes)")?;
    let snapshot = OwnedHandle::new(snapshot, "process snapshot")?;
    let mut entry: PROCESSENTRY32W = unsafe { zeroed() };
    entry.dwSize = size_of::<PROCESSENTRY32W>() as u32;
    let mut parents = BTreeMap::new();
    let mut present = unsafe { Process32FirstW(snapshot.raw(), &mut entry) }.is_ok();
    while present {
        parents.insert(entry.th32ProcessID, entry.th32ParentProcessID);
        present = unsafe { Process32NextW(snapshot.raw(), &mut entry) }.is_ok();
    }
    let mut current = pid;
    for _ in 0..32 {
        let Some(parent) = parents.get(&current).copied() else {
            return Ok(false);
        };
        if parent == ancestor_pid {
            return Ok(true);
        }
        if parent == 0 || parent == current {
            return Ok(false);
        }
        current = parent;
    }
    bail!("pipe client process ancestry exceeded its bound")
}

pub struct KillOnCloseJob(OwnedHandle);

impl KillOnCloseJob {
    pub fn create() -> Result<Self> {
        Self::create_with_limits(JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE)
    }

    fn create_with_limits(limit_flags: JOB_OBJECT_LIMIT) -> Result<Self> {
        let handle = unsafe { CreateJobObjectW(None, None) }.context("CreateJobObjectW")?;
        let handle = OwnedHandle::new(handle, "job")?;
        let mut information: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = unsafe { zeroed() };
        information.BasicLimitInformation.LimitFlags = limit_flags;
        unsafe {
            SetInformationJobObject(
                handle.raw(),
                JobObjectExtendedLimitInformation,
                &information as *const _ as *const c_void,
                size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
            )
            .context("SetInformationJobObject(KILL_ON_JOB_CLOSE)")?;
        }
        Ok(Self(handle))
    }

    pub fn terminate(&self, code: u32) -> Result<()> {
        unsafe { TerminateJobObject(self.raw(), code) }.context("TerminateJobObject")
    }

    pub fn active_processes(&self) -> Result<u32> {
        let mut information: JOBOBJECT_BASIC_ACCOUNTING_INFORMATION = unsafe { zeroed() };
        unsafe {
            QueryInformationJobObject(
                Some(self.raw()),
                JobObjectBasicAccountingInformation,
                &mut information as *mut _ as *mut c_void,
                size_of::<JOBOBJECT_BASIC_ACCOUNTING_INFORMATION>() as u32,
                None,
            )
            .context("QueryInformationJobObject(BasicAccounting)")?;
        }
        Ok(information.ActiveProcesses)
    }

    pub fn terminate_and_drain(&self, code: u32, timeout: std::time::Duration) -> Result<()> {
        if self.active_processes()? != 0 {
            self.terminate(code)?;
        }
        let deadline = std::time::Instant::now() + timeout;
        loop {
            if self.active_processes()? == 0 {
                return Ok(());
            }
            if std::time::Instant::now() >= deadline {
                bail!("sandbox Job process tree did not drain before its deadline");
            }
            std::thread::sleep(std::time::Duration::from_millis(10));
        }
    }

    pub fn raw(&self) -> HANDLE {
        self.0.raw()
    }
}

struct ProcThreadAttributes {
    buffer: Vec<u8>,
    list: LPPROC_THREAD_ATTRIBUTE_LIST,
}

impl ProcThreadAttributes {
    fn new(count: u32) -> Result<Self> {
        let mut bytes = 0usize;
        unsafe {
            let _ = InitializeProcThreadAttributeList(None, count, None, &mut bytes);
        }
        if bytes == 0 {
            bail!("InitializeProcThreadAttributeList returned an empty size");
        }
        let mut buffer = vec![0u8; bytes];
        let list = LPPROC_THREAD_ATTRIBUTE_LIST(buffer.as_mut_ptr() as *mut c_void);
        unsafe {
            InitializeProcThreadAttributeList(Some(list), count, None, &mut bytes)
                .context("InitializeProcThreadAttributeList")?;
        }
        Ok(Self { buffer, list })
    }

    fn set_handles(&mut self, handles: &mut [HANDLE]) -> Result<()> {
        unsafe {
            UpdateProcThreadAttribute(
                self.list,
                0,
                PROC_THREAD_ATTRIBUTE_HANDLE_LIST as usize,
                Some(handles.as_mut_ptr() as *const c_void),
                size_of_val(handles),
                None,
                None,
            )
            .context("UpdateProcThreadAttribute(HANDLE_LIST)")
        }
    }

    fn set_job(&mut self, job: &mut HANDLE) -> Result<()> {
        unsafe {
            UpdateProcThreadAttribute(
                self.list,
                0,
                PROC_THREAD_ATTRIBUTE_JOB_LIST as usize,
                Some(job as *mut HANDLE as *const c_void),
                size_of::<HANDLE>(),
                None,
                None,
            )
            .context("UpdateProcThreadAttribute(JOB_LIST)")
        }
    }
}

impl Drop for ProcThreadAttributes {
    fn drop(&mut self) {
        unsafe {
            DeleteProcThreadAttributeList(self.list);
        }
        let _ = &self.buffer;
    }
}

pub struct PipePair {
    pub parent: OwnedHandle,
    pub child: OwnedHandle,
}

pub fn child_stdin_pipe() -> Result<PipePair> {
    create_pipe(false)
}

pub fn child_output_pipe() -> Result<PipePair> {
    create_pipe(true)
}

fn create_pipe(child_writes: bool) -> Result<PipePair> {
    let security = SECURITY_ATTRIBUTES {
        nLength: size_of::<SECURITY_ATTRIBUTES>() as u32,
        lpSecurityDescriptor: null_mut(),
        bInheritHandle: true.into(),
    };
    let mut read = HANDLE::default();
    let mut write = HANDLE::default();
    unsafe {
        windows::Win32::System::Pipes::CreatePipe(
            &mut read,
            &mut write,
            Some(&security),
            64 * 1024,
        )
        .context("CreatePipe")?;
    }
    let (parent, child) = if child_writes {
        (read, write)
    } else {
        (write, read)
    };
    unsafe {
        SetHandleInformation(parent, HANDLE_FLAG_INHERIT.0, Default::default())
            .context("SetHandleInformation(parent non-inheritable)")?;
    }
    Ok(PipePair {
        parent: OwnedHandle::new(parent, "parent pipe")?,
        child: OwnedHandle::new(child, "child pipe")?,
    })
}

pub struct SpawnedTarget {
    pub process: OwnedHandle,
    thread: OwnedHandle,
    job: KillOnCloseJob,
    pub pid: u32,
    stdin: Option<std::fs::File>,
    stdout: Option<std::fs::File>,
    stderr: Option<std::fs::File>,
}

const DESKTOP_ALL_ACCESS: u32 = DESKTOP_READOBJECTS.0
    | DESKTOP_CREATEWINDOW.0
    | DESKTOP_CREATEMENU.0
    | DESKTOP_HOOKCONTROL.0
    | DESKTOP_JOURNALRECORD.0
    | DESKTOP_JOURNALPLAYBACK.0
    | DESKTOP_ENUMERATE.0
    | DESKTOP_WRITEOBJECTS.0
    | DESKTOP_SWITCHDESKTOP.0
    | DESKTOP_DELETE.0
    | DESKTOP_READ_CONTROL.0
    | DESKTOP_WRITE_DAC.0
    | DESKTOP_WRITE_OWNER.0;
const DESKTOP_TARGET_ACCESS: u32 = DESKTOP_READOBJECTS.0
    | DESKTOP_CREATEWINDOW.0
    | DESKTOP_CREATEMENU.0
    | DESKTOP_ENUMERATE.0
    | DESKTOP_WRITEOBJECTS.0
    | DESKTOP_READ_CONTROL.0;

pub struct PrivateDesktop {
    handle: HDESK,
}

impl PrivateDesktop {
    pub fn create(
        host_sid: &str,
        sandbox_group_sid: &str,
        policy_capability_sid: &str,
        session_nonce: &str,
    ) -> Result<Self> {
        let name = private_desktop_name(session_nonce)?;
        // A restricted target must pass AccessCheck twice: once through its
        // normal sandbox-group SID and once through its policy capability in
        // the restricting set. The shared account SID is deliberately absent,
        // so a target from another policy cannot open this desktop.
        let descriptor = LocalSecurityDescriptor::from_sddl(&format!(
            "D:P(A;;0x{DESKTOP_ALL_ACCESS:x};;;SY)(A;;0x{DESKTOP_ALL_ACCESS:x};;;{host_sid})(A;;0x{DESKTOP_TARGET_ACCESS:x};;;{sandbox_group_sid})(A;;0x{DESKTOP_TARGET_ACCESS:x};;;{policy_capability_sid})"
        ))?;
        let attributes = SECURITY_ATTRIBUTES {
            nLength: size_of::<SECURITY_ATTRIBUTES>() as u32,
            lpSecurityDescriptor: descriptor.0.0,
            bInheritHandle: false.into(),
        };
        let name_wide = wide(&name);
        let handle = unsafe {
            CreateDesktopW(
                PCWSTR(name_wide.as_ptr()),
                PCWSTR::null(),
                None,
                DESKTOP_CONTROL_FLAGS::default(),
                DESKTOP_ALL_ACCESS,
                Some(&attributes),
            )
        }
        .context("CreateDesktopW(private sandbox desktop)")?;
        Ok(Self { handle })
    }
}

fn private_desktop_name(session_nonce: &str) -> Result<String> {
    let nonce = uuid::Uuid::parse_str(session_nonce)
        .context("parse authenticated sandbox desktop nonce")?;
    Ok(format!("KodaXSandboxDesktop-{}", nonce.simple()))
}

fn private_desktop_startup_name(session_nonce: &str) -> Result<Vec<u16>> {
    Ok(wide(&format!(
        "Winsta0\\{}",
        private_desktop_name(session_nonce)?,
    )))
}

impl Drop for PrivateDesktop {
    fn drop(&mut self) {
        unsafe {
            let _ = CloseDesktop(self.handle);
        }
    }
}

pub struct SpawnedHostChild {
    pub process: OwnedHandle,
    pub pid: u32,
    thread: OwnedHandle,
    launch_stdin: Option<std::fs::File>,
    diagnostics: Option<std::fs::File>,
    diagnostic_thread: Option<std::thread::JoinHandle<()>>,
}

impl SpawnedHostChild {
    pub fn abort_process(&self) -> Result<OwnedHandle> {
        self.process.try_clone("ASRT launcher abort")
    }

    pub fn resume(&self) -> Result<()> {
        let previous = unsafe { ResumeThread(self.thread.raw()) };
        if previous != 1 {
            return Err(anyhow!(
                "ResumeThread(ASRT) returned suspend count {previous}: {}",
                if previous == u32::MAX {
                    io::Error::last_os_error().to_string()
                } else {
                    "expected exactly one creation-time suspension".into()
                }
            ));
        }
        Ok(())
    }

    pub fn start_diagnostic_pump(&mut self) {
        let Some(mut diagnostics) = self.diagnostics.take() else {
            return;
        };
        self.diagnostic_thread = Some(std::thread::spawn(move || {
            let mut buffer = [0u8; 8192];
            loop {
                let count = match std::io::Read::read(&mut diagnostics, &mut buffer) {
                    Ok(0) => return,
                    Ok(count) => count,
                    Err(error) if error.kind() == std::io::ErrorKind::Interrupted => continue,
                    Err(_) => return,
                };
                let mut output = std::io::stderr().lock();
                if output.write_all(&buffer[..count]).is_err() || output.flush().is_err() {
                    return;
                }
            }
        }));
    }

    pub fn close_launch_stdin(&mut self) {
        drop(self.launch_stdin.take());
    }

    pub fn wait(&self, timeout_ms: u32) -> Result<Option<u32>> {
        let result = unsafe { WaitForSingleObject(self.process.raw(), timeout_ms) };
        if result == WAIT_OBJECT_0 {
            let mut code = 0u32;
            unsafe {
                GetExitCodeProcess(self.process.raw(), &mut code)
                    .context("GetExitCodeProcess(ASRT)")?;
            }
            return Ok(Some(code));
        }
        if result == windows::Win32::Foundation::WAIT_TIMEOUT {
            return Ok(None);
        }
        bail!("WaitForSingleObject(ASRT) returned 0x{:x}", result.0)
    }
}

impl Drop for SpawnedHostChild {
    fn drop(&mut self) {
        drop(self.launch_stdin.take());
        unsafe {
            let _ = TerminateProcess(self.process.raw(), 1);
        }
        // A cross-logon runner may inherit ASRT's diagnostic handle. Never make
        // trusted-host unwind depend on that untrusted descendant closing it.
        if let Some(thread) = self.diagnostic_thread.take() {
            drop(thread);
        }
    }
}

pub fn spawn_asrt_launcher(
    executable: &str,
    args: &[String],
    cwd: &str,
) -> Result<SpawnedHostChild> {
    // ASRT's launcher treats an already-closed stdin as an aborted execution.
    // Keep this infrastructure-only pipe open until the authenticated runner
    // connects; target stdin is carried later by the KodaX framed protocol.
    let launch_stdin = child_stdin_pipe()?;
    let diagnostics = child_output_pipe()?;
    let mut handles = [launch_stdin.child.raw(), diagnostics.child.raw()];
    let mut attributes = ProcThreadAttributes::new(1)?;
    attributes.set_handles(&mut handles)?;
    let mut startup: STARTUPINFOEXW = unsafe { zeroed() };
    startup.StartupInfo.cb = size_of::<STARTUPINFOEXW>() as u32;
    startup.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
    startup.StartupInfo.hStdInput = launch_stdin.child.raw();
    startup.StartupInfo.hStdOutput = diagnostics.child.raw();
    startup.StartupInfo.hStdError = diagnostics.child.raw();
    startup.lpAttributeList = attributes.list;
    let executable_wide = wide(executable);
    let full_argv = std::iter::once(executable.to_owned())
        .chain(args.iter().cloned())
        .collect::<Vec<_>>();
    let mut command_line = wide(&command_line(&full_argv));
    let cwd_wide = wide(cwd);
    let mut information: PROCESS_INFORMATION = unsafe { zeroed() };
    unsafe {
        CreateProcessW(
            PCWSTR(executable_wide.as_ptr()),
            Some(PWSTR(command_line.as_mut_ptr())),
            None,
            None,
            true,
            CREATE_SUSPENDED
                | CREATE_UNICODE_ENVIRONMENT
                | EXTENDED_STARTUPINFO_PRESENT
                | CREATE_NO_WINDOW,
            None,
            PCWSTR(cwd_wide.as_ptr()),
            &startup.StartupInfo as *const STARTUPINFOW,
            &mut information,
        )
        .with_context(|| format!("CreateProcessW({executable})"))?;
    }
    let process = OwnedHandle::new(information.hProcess, "ASRT process")?;
    let thread = OwnedHandle::new(information.hThread, "ASRT thread")?;
    drop(diagnostics.child);
    drop(launch_stdin.child);
    Ok(SpawnedHostChild {
        process,
        pid: information.dwProcessId,
        thread,
        launch_stdin: Some(launch_stdin.parent.into_file()),
        diagnostics: Some(diagnostics.parent.into_file()),
        diagnostic_thread: None,
    })
}

pub fn terminate_process(process: &OwnedHandle, code: u32) -> Result<()> {
    unsafe { TerminateProcess(process.raw(), code) }.context("TerminateProcess(ASRT launcher)")
}

pub fn disconnect_named_pipe(pipe: &std::fs::File) -> Result<()> {
    unsafe { DisconnectNamedPipe(HANDLE(pipe.as_raw_handle())) }
        .context("DisconnectNamedPipe(runner)")
}

impl SpawnedTarget {
    pub fn take_stdin(&mut self) -> Result<std::fs::File> {
        self.stdin
            .take()
            .ok_or_else(|| anyhow!("target stdin was already taken"))
    }

    pub fn take_stdout(&mut self) -> Result<std::fs::File> {
        self.stdout
            .take()
            .ok_or_else(|| anyhow!("target stdout was already taken"))
    }

    pub fn take_stderr(&mut self) -> Result<std::fs::File> {
        self.stderr
            .take()
            .ok_or_else(|| anyhow!("target stderr was already taken"))
    }

    pub fn resume(&self) -> Result<()> {
        let previous = unsafe { ResumeThread(self.thread.raw()) };
        if previous != 1 {
            return Err(anyhow!(
                "ResumeThread(target) returned suspend count {previous}: {}",
                if previous == u32::MAX {
                    io::Error::last_os_error().to_string()
                } else {
                    "expected exactly one creation-time suspension".into()
                }
            ));
        }
        Ok(())
    }

    pub fn terminate(&self, code: u32) -> Result<()> {
        self.job.terminate(code)
    }

    pub fn terminate_and_drain(&self, code: u32, timeout: std::time::Duration) -> Result<()> {
        self.job.terminate_and_drain(code, timeout)
    }

    pub fn try_wait(&self) -> Result<Option<u32>> {
        let result = unsafe { WaitForSingleObject(self.process.raw(), 0) };
        if result == windows::Win32::Foundation::WAIT_TIMEOUT {
            return Ok(None);
        }
        if result != WAIT_OBJECT_0 {
            bail!("WaitForSingleObject(target) returned 0x{:x}", result.0);
        }
        let mut code = 0u32;
        unsafe {
            windows::Win32::System::Threading::GetExitCodeProcess(self.process.raw(), &mut code)
                .context("GetExitCodeProcess(target)")?;
        }
        Ok(Some(code))
    }
}

impl Drop for SpawnedTarget {
    fn drop(&mut self) {
        if unsafe { WaitForSingleObject(self.process.raw(), 0) } != WAIT_OBJECT_0 {
            let _ = self.terminate(1);
        }
    }
}

#[allow(clippy::too_many_arguments)] // All launch authorities stay explicit at this security boundary.
pub fn spawn_target_suspended(
    token: HANDLE,
    argv: &[String],
    cwd: &str,
    environment_overrides: &[EnvironmentEntry],
    host_sid: &str,
    logon_sid: &str,
    capability_sid: &str,
    session_nonce: &str,
) -> Result<SpawnedTarget> {
    let executable = argv
        .first()
        .ok_or_else(|| anyhow!("target argv is empty"))?;
    let stdin = child_stdin_pipe()?;
    let stdout = child_output_pipe()?;
    let stderr = child_output_pipe()?;
    for standard in [
        windows::Win32::System::Console::STD_INPUT_HANDLE,
        windows::Win32::System::Console::STD_OUTPUT_HANDLE,
        windows::Win32::System::Console::STD_ERROR_HANDLE,
    ] {
        if let Ok(handle) = unsafe { GetStdHandle(standard) }
            && !handle.is_invalid()
        {
            unsafe {
                SetHandleInformation(handle, HANDLE_FLAG_INHERIT.0, Default::default())
                    .context("clear inherited runner standard-handle flag")?;
            }
        }
    }
    let job = KillOnCloseJob::create()?;
    let mut inherited_handles = [stdin.child.raw(), stdout.child.raw(), stderr.child.raw()];
    let mut job_handle = job.raw();
    let mut attributes = ProcThreadAttributes::new(2)?;
    attributes.set_handles(&mut inherited_handles)?;
    attributes.set_job(&mut job_handle)?;
    let mut startup: STARTUPINFOEXW = unsafe { zeroed() };
    startup.StartupInfo.cb = size_of::<STARTUPINFOEXW>() as u32;
    startup.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
    startup.StartupInfo.hStdInput = stdin.child.raw();
    startup.StartupInfo.hStdOutput = stdout.child.raw();
    startup.StartupInfo.hStdError = stderr.child.raw();
    startup.lpAttributeList = attributes.list;
    // Restricted-token processes can fail during loader initialization when
    // lpDesktop is null. A per-command private desktop both satisfies that
    // Windows requirement and avoids exposing the interactive desktop.
    let mut desktop_name = private_desktop_startup_name(session_nonce)?;
    startup.StartupInfo.lpDesktop = PWSTR(desktop_name.as_mut_ptr());
    let mut information: PROCESS_INFORMATION = unsafe { zeroed() };
    let executable_wide = wide(executable);
    let mut command_line = wide(&target_command_line(argv));
    let cwd_wide = wide(cwd);
    let environment = target_environment_block(environment_overrides)?;
    // Keep the process and primary thread controllable only by trusted
    // identities and this policy. The token's Codex-compatible default DACL
    // remains unmodified for loader/IPC objects created after startup.
    let process_descriptor = LocalSecurityDescriptor::from_sddl(&format!(
        "D:P(D;;WDWO;;;S-1-3-4)(A;;GA;;;SY)(A;;GA;;;{host_sid})(A;;GA;;;{logon_sid})(A;;GA;;;{capability_sid})"
    ))?;
    let process_security = SECURITY_ATTRIBUTES {
        nLength: size_of::<SECURITY_ATTRIBUTES>() as u32,
        lpSecurityDescriptor: process_descriptor.0.0,
        bInheritHandle: false.into(),
    };
    let thread_descriptor = LocalSecurityDescriptor::from_sddl(&format!(
        "D:P(D;;WDWO;;;S-1-3-4)(A;;GA;;;SY)(A;;GA;;;{host_sid})(A;;GA;;;{logon_sid})(A;;GA;;;{capability_sid})"
    ))?;
    let thread_security = SECURITY_ATTRIBUTES {
        nLength: size_of::<SECURITY_ATTRIBUTES>() as u32,
        lpSecurityDescriptor: thread_descriptor.0.0,
        bInheritHandle: false.into(),
    };
    unsafe {
        CreateProcessAsUserW(
            Some(token),
            PCWSTR(executable_wide.as_ptr()),
            Some(PWSTR(command_line.as_mut_ptr())),
            Some(&process_security),
            Some(&thread_security),
            true,
            CREATE_SUSPENDED
                | CREATE_UNICODE_ENVIRONMENT
                | EXTENDED_STARTUPINFO_PRESENT
                | CREATE_NO_WINDOW,
            Some(environment.as_ptr().cast::<c_void>()),
            PCWSTR(cwd_wide.as_ptr()),
            &startup.StartupInfo as *const STARTUPINFOW,
            &mut information,
        )
        .with_context(|| format!("CreateProcessAsUserW({executable})"))?;
    }
    let process = OwnedHandle::new(information.hProcess, "target process")?;
    let thread = OwnedHandle::new(information.hThread, "target thread")?;
    let mut in_job = false.into();
    unsafe {
        IsProcessInJob(process.raw(), Some(job.raw()), &mut in_job)
            .context("IsProcessInJob(target, command v2 job)")?;
    }
    if !in_job.as_bool() {
        unsafe {
            let _ = TerminateProcess(process.raw(), 1);
        }
        bail!("target was created outside the Windows sandbox v2 command Job");
    }
    drop(stdin.child);
    drop(stdout.child);
    drop(stderr.child);
    Ok(SpawnedTarget {
        process,
        thread,
        job,
        pid: information.dwProcessId,
        stdin: Some(stdin.parent.into_file()),
        stdout: Some(stdout.parent.into_file()),
        stderr: Some(stderr.parent.into_file()),
    })
}

fn target_environment_block(overrides: &[EnvironmentEntry]) -> Result<Vec<u16>> {
    let mut entries = BTreeMap::<String, (String, String)>::new();
    for entry in overrides {
        let name = &entry.name;
        let value = &entry.value;
        if name.is_empty() || name.contains('=') || name.contains('\0') || value.contains('\0') {
            bail!("Windows sandbox target environment contains an invalid entry");
        }
        let key = name.to_uppercase();
        if entries.insert(key, (name.clone(), value.clone())).is_some() {
            bail!("Windows sandbox target environment contains ambiguous names");
        }
    }
    let mut block = Vec::new();
    for (_, (name, value)) in entries {
        block.extend(name.encode_utf16());
        block.push(b'=' as u16);
        block.extend(value.encode_utf16());
        block.push(0);
    }
    block.push(0);
    if block.len() == 1 {
        block.push(0);
    }
    if block.len() > 30_000 {
        bail!("Windows sandbox target environment exceeds its UTF-16 bound");
    }
    Ok(block)
}

pub fn command_line(argv: &[String]) -> String {
    argv.iter()
        .map(|value| quote_windows_arg(value))
        .collect::<Vec<_>>()
        .join(" ")
}

fn target_command_line(argv: &[String]) -> String {
    let Some(executable) = argv.first() else {
        return String::new();
    };
    let is_cmd = Path::new(executable)
        .file_name()
        .and_then(|name| name.to_str())
        .is_some_and(|name| {
            name.eq_ignore_ascii_case("cmd.exe") || name.eq_ignore_ascii_case("cmd")
        });
    let has_strip_semantics = argv
        .iter()
        .skip(1)
        .any(|argument| argument.eq_ignore_ascii_case("/s"));
    if is_cmd
        && has_strip_semantics
        && let Some(command_index) =
            argv.iter()
                .enumerate()
                .skip(1)
                .find_map(|(index, argument)| {
                    ((argument.eq_ignore_ascii_case("/c") || argument.eq_ignore_ascii_case("/k"))
                        && index + 2 == argv.len())
                    .then_some(index)
                })
    {
        return format!(
            "{} \"{}\"",
            command_line(&argv[..=command_index]),
            argv[command_index + 1],
        );
    }
    command_line(argv)
}

fn quote_windows_arg(value: &str) -> String {
    if !value.is_empty()
        && !value
            .bytes()
            .any(|byte| byte == b' ' || byte == b'\t' || byte == b'"')
    {
        return value.to_owned();
    }
    let mut result = String::from("\"");
    let mut slashes = 0usize;
    for character in value.chars() {
        match character {
            '\\' => slashes += 1,
            '"' => {
                result.push_str(&"\\".repeat(slashes * 2 + 1));
                result.push('"');
                slashes = 0;
            }
            _ => {
                result.push_str(&"\\".repeat(slashes));
                slashes = 0;
                result.push(character);
            }
        }
    }
    result.push_str(&"\\".repeat(slashes * 2));
    result.push('"');
    result
}

const ACL_NAMESPACE_BOUNDARY: &str = "KodaX-Sandbox-ACL-Boundary-v2";
const ACL_NAMESPACE_ALIAS: &str = "KodaXSandboxAclV2";

#[link(name = "kernel32")]
unsafe extern "system" {
    fn AddSIDToBoundaryDescriptor(boundary: *mut *mut c_void, sid: *mut c_void) -> i32;
    fn ClosePrivateNamespace(handle: *mut c_void, flags: u32) -> i32;
    fn CreateBoundaryDescriptorW(name: *const u16, flags: u32) -> *mut c_void;
    fn CreatePrivateNamespaceW(
        attributes: *const SECURITY_ATTRIBUTES,
        boundary: *const c_void,
        alias: *const u16,
    ) -> *mut c_void;
    fn DeleteBoundaryDescriptor(boundary: *mut c_void);
    fn OpenPrivateNamespaceW(boundary: *const c_void, alias: *const u16) -> *mut c_void;
}

struct HostPrivateNamespace {
    raw: *mut c_void,
    boundary: *mut c_void,
    _user_sid: LocalSid,
    user_sid_text: String,
}

unsafe impl Send for HostPrivateNamespace {}
unsafe impl Sync for HostPrivateNamespace {}

impl HostPrivateNamespace {
    fn open() -> Result<Self> {
        let token = current_token()?;
        let user_sid_text = token_user_sid(token.raw())?;
        let user_sid = LocalSid::from_string(&user_sid_text)?;
        let boundary_name = wide(ACL_NAMESPACE_BOUNDARY);
        let mut boundary = unsafe { CreateBoundaryDescriptorW(boundary_name.as_ptr(), 0) };
        if boundary.is_null() {
            bail!(
                "CreateBoundaryDescriptorW(ACL namespace): {}",
                io::Error::last_os_error()
            );
        }
        if unsafe { AddSIDToBoundaryDescriptor(&mut boundary, user_sid.raw().0) } == 0 {
            unsafe { DeleteBoundaryDescriptor(boundary) };
            bail!(
                "AddSIDToBoundaryDescriptor(ACL namespace): {}",
                io::Error::last_os_error()
            );
        }
        let descriptor = LocalSecurityDescriptor::from_sddl(&format!(
            "D:P(A;;GA;;;SY)(A;;GA;;;{user_sid_text})"
        ))?;
        let attributes = SECURITY_ATTRIBUTES {
            nLength: size_of::<SECURITY_ATTRIBUTES>() as u32,
            lpSecurityDescriptor: descriptor.0.0,
            bInheritHandle: false.into(),
        };
        let alias = wide(ACL_NAMESPACE_ALIAS);
        let mut raw = unsafe { CreatePrivateNamespaceW(&attributes, boundary, alias.as_ptr()) };
        let create_error = unsafe { GetLastError() };
        if raw.is_null() && create_error == ERROR_ALREADY_EXISTS {
            raw = unsafe { OpenPrivateNamespaceW(boundary, alias.as_ptr()) };
        }
        if raw.is_null() {
            let error = io::Error::last_os_error();
            unsafe { DeleteBoundaryDescriptor(boundary) };
            return Err(error).context("open host ACL private namespace");
        }
        Ok(Self {
            raw,
            boundary,
            _user_sid: user_sid,
            user_sid_text,
        })
    }
}

impl Drop for HostPrivateNamespace {
    fn drop(&mut self) {
        unsafe {
            let _ = ClosePrivateNamespace(self.raw, 0);
            DeleteBoundaryDescriptor(self.boundary);
        }
    }
}

static ACL_NAMESPACE: OnceLock<HostPrivateNamespace> = OnceLock::new();
static ACL_NAMESPACE_INIT: Mutex<()> = Mutex::new(());

fn host_acl_namespace() -> Result<&'static HostPrivateNamespace> {
    if let Some(namespace) = ACL_NAMESPACE.get() {
        return Ok(namespace);
    }
    let _initialization = ACL_NAMESPACE_INIT
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    if let Some(namespace) = ACL_NAMESPACE.get() {
        return Ok(namespace);
    }
    ACL_NAMESPACE
        .set(HostPrivateNamespace::open()?)
        .map_err(|_| anyhow!("ACL private namespace initialization raced"))?;
    ACL_NAMESPACE
        .get()
        .ok_or_else(|| anyhow!("ACL private namespace was not published"))
}

pub struct NamedMutex(OwnedHandle);

impl NamedMutex {
    pub fn acquire(name: &str, timeout_ms: u32) -> Result<Self> {
        if name.is_empty() || name.contains(['\\', '/']) {
            bail!("Windows sandbox ACL mutex name is invalid");
        }
        let namespace = host_acl_namespace()?;
        let descriptor = LocalSecurityDescriptor::from_sddl(&format!(
            "D:P(A;;GA;;;SY)(A;;GA;;;{})",
            namespace.user_sid_text
        ))?;
        let security = SECURITY_ATTRIBUTES {
            nLength: size_of::<SECURITY_ATTRIBUTES>() as u32,
            lpSecurityDescriptor: descriptor.0.0,
            bInheritHandle: false.into(),
        };
        let name = wide(&format!("{ACL_NAMESPACE_ALIAS}\\{name}"));
        let handle = unsafe { CreateMutexW(Some(&security), false, PCWSTR(name.as_ptr())) }
            .context("CreateMutexW(ACL transaction)")?;
        let handle = OwnedHandle::new(handle, "ACL transaction mutex")?;
        let result = unsafe { WaitForSingleObject(handle.raw(), timeout_ms) };
        match result {
            WAIT_OBJECT_0 | WAIT_ABANDONED => Ok(Self(handle)),
            WAIT_TIMEOUT => bail!("Windows sandbox ACL transaction mutex timed out"),
            _ => bail!(
                "Windows sandbox ACL transaction mutex wait returned 0x{:x}",
                result.0
            ),
        }
    }
}

impl Drop for NamedMutex {
    fn drop(&mut self) {
        unsafe {
            let _ = ReleaseMutex(self.0.raw());
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn windows_command_line_quoting_preserves_spaces_quotes_and_trailing_slashes() {
        assert_eq!(
            command_line(&[
                r"C:\Program Files\node.exe".into(),
                "plain".into(),
                "say \"hi\"".into(),
                r"C:\tail\".into(),
                "".into(),
            ]),
            r#""C:\Program Files\node.exe" plain "say \"hi\"" C:\tail\ """#,
        );
    }

    #[test]
    fn cmd_target_keeps_the_command_tail_raw_inside_outer_quotes() {
        assert_eq!(
            target_command_line(&[
                r"C:\Windows\System32\cmd.exe".into(),
                "/d".into(),
                "/s".into(),
                "/c".into(),
                r#"node "C:\Program Files\fixture.cjs" "participant a" 2"#.into(),
            ]),
            r#"C:\Windows\System32\cmd.exe /d /s /c "node "C:\Program Files\fixture.cjs" "participant a" 2""#,
        );
    }

    #[test]
    fn cmd_strip_semantics_preserve_empty_quoted_and_metacharacter_tails() {
        assert_eq!(
            target_command_line(&[
                r"C:\Program Files\cmd.exe".into(),
                "/s".into(),
                "/c".into(),
                String::new(),
            ]),
            r#""C:\Program Files\cmd.exe" /s /c """#,
        );
        assert_eq!(
            target_command_line(&[
                "cmd.exe".into(),
                "/s".into(),
                "/c".into(),
                r#""C:\Program Files\node.exe" "fixture a.cjs" & echo done"#.into(),
            ]),
            r#"cmd.exe /s /c ""C:\Program Files\node.exe" "fixture a.cjs" & echo done""#,
        );
    }

    #[test]
    fn cmd_without_strip_semantics_keeps_regular_windows_argv_quoting() {
        let argv = [
            "cmd.exe".into(),
            "/c".into(),
            r#"node "C:\Program Files\fixture.cjs""#.into(),
        ];
        assert_eq!(target_command_line(&argv), command_line(&argv));
    }

    #[test]
    fn current_process_has_a_sid_and_logon_sid() {
        let token = current_token().unwrap();
        assert!(token_user_sid(token.raw()).unwrap().starts_with("S-1-"));
        assert!(current_logon_sid().unwrap().starts_with("S-1-"));
    }

    #[test]
    fn controller_pipe_is_created_with_the_exact_host_owner() {
        let host_sid = token_user_sid(current_token().unwrap().raw()).unwrap();
        let descriptor = controller_pipe_security_descriptor(&host_sid).unwrap();
        let name = format!(
            r"\\.\pipe\kodax-owner-test-{}-{}",
            unsafe { GetCurrentProcessId() },
            uuid::Uuid::new_v4(),
        );
        let pipe = create_controller_pipe_instance(&name, &descriptor, true).unwrap();

        verify_controller_pipe_security(&pipe, &host_sid).unwrap();
    }

    #[test]
    fn policy_restrictions_match_the_loader_compatibility_identity_set() {
        let capability = LocalSid::from_string("S-1-5-21-101-102-103-104").unwrap();
        let account = LocalSid::from_string("S-1-5-21-201-202-203-204").unwrap();
        let logon = LocalSid::from_string("S-1-5-5-1-2").unwrap();
        let everyone = LocalSid::from_string("S-1-1-0").unwrap();
        let capabilities = [capability];
        let restrictions = policy_restrictions(&capabilities, &account, &logon, &everyone);

        assert_eq!(
            restrictions
                .iter()
                .map(|entry| sid_to_string(entry.Sid).unwrap())
                .collect::<Vec<_>>(),
            [
                "S-1-5-21-101-102-103-104",
                "S-1-5-21-201-202-203-204",
                "S-1-5-5-1-2",
                "S-1-1-0",
            ]
        );
    }

    #[test]
    fn policy_capability_can_create_a_restricted_primary_token() {
        let capability = "S-1-5-21-101-102-103-104";
        let filesystem_capability = "S-1-5-21-201-202-203-204".to_owned();
        let token =
            restricted_policy_token(capability, std::slice::from_ref(&filesystem_capability))
                .unwrap();
        let restrictions = token_restricted_sid_strings(token.raw()).unwrap();
        assert_eq!(restrictions.first().map(String::as_str), Some(capability));
        assert!(restrictions.contains(&filesystem_capability));
        assert!(restrictions.contains(&token_user_sid(current_token().unwrap().raw()).unwrap()));
        assert!(restrictions.contains(&current_logon_sid().unwrap()));
        assert!(restrictions.iter().any(|sid| sid == "S-1-1-0"));
        let default_dacl = token_default_dacl_aces(token.raw()).unwrap();
        assert!(default_dacl.contains(&(capability.to_owned(), GENERIC_ALL.0)));
        assert!(default_dacl.contains(&(current_logon_sid().unwrap(), GENERIC_ALL.0)));
        assert!(default_dacl.iter().any(|(sid, _)| sid == "S-1-1-0"));
    }

    #[test]
    fn private_desktop_name_is_derived_only_from_an_authenticated_uuid_nonce() {
        assert_eq!(
            private_desktop_name("d9428888-122b-11e1-b85c-61cd3cbb3210").unwrap(),
            "KodaXSandboxDesktop-d9428888122b11e1b85c61cd3cbb3210",
        );
        assert!(private_desktop_name("..\\Default").is_err());
        assert!(private_desktop_name("").is_err());
    }

    #[test]
    fn target_environment_is_complete_unicode_and_double_nul_terminated() {
        assert_eq!(target_environment_block(&[]).unwrap(), vec![0, 0]);
        let block = target_environment_block(&[
            EnvironmentEntry {
                name: "Path".into(),
                value: r"C:\bin".into(),
            },
            EnvironmentEntry {
                name: "\u{73af}\u{5883}".into(),
                value: "\u{503c}".into(),
            },
        ])
        .unwrap();
        assert!(block.ends_with(&[0, 0]));
        let decoded = String::from_utf16_lossy(&block);
        assert!(decoded.contains("Path=C:\\bin\0"));
        assert!(decoded.contains("\u{73af}\u{5883}=\u{503c}\0"));
        assert!(!decoded.contains("RUSTUP_HOME="));
    }

    #[test]
    fn acl_mutex_is_owner_scoped_and_recovers_abandonment() {
        let name = format!(
            "test-{}-{}",
            unsafe { GetCurrentProcessId() },
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        );
        let (owned_tx, owned_rx) = std::sync::mpsc::channel();
        let owner_name = name.clone();
        std::thread::spawn(move || {
            let mutex = NamedMutex::acquire(&owner_name, 1_000).unwrap();
            owned_tx.send(()).unwrap();
            std::mem::forget(mutex);
        })
        .join()
        .unwrap();
        owned_rx.recv().unwrap();

        let recovered = NamedMutex::acquire(&name, 1_000).unwrap();
        drop(recovered);
    }
}
