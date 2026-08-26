use std::collections::{BTreeMap, BTreeSet};
use std::ffi::c_void;
use std::mem::{size_of, zeroed};
use std::os::windows::ffi::OsStrExt;
use std::path::{Path, PathBuf};
use std::ptr::{null, null_mut};

use anyhow::{Context, Result, anyhow, bail, ensure};
use windows::Win32::Foundation::{
    ERROR_SUCCESS, HANDLE, HLOCAL, LocalFree, NTSTATUS, OBJ_CASE_INSENSITIVE, OBJ_DONT_REPARSE,
    RtlNtStatusToDosError, UNICODE_STRING,
};
use windows::Win32::Security::Authorization::{
    DENY_ACCESS, EXPLICIT_ACCESS_W, GRANT_ACCESS, GetSecurityInfo, SE_FILE_OBJECT,
    SetEntriesInAclW, SetSecurityInfo, TRUSTEE_IS_SID, TRUSTEE_IS_UNKNOWN, TRUSTEE_W,
};
use windows::Win32::Security::{
    ACCESS_ALLOWED_ACE, ACE_HEADER, ACL, ACL_SIZE_INFORMATION, AclSizeInformation,
    CONTAINER_INHERIT_ACE, DACL_SECURITY_INFORMATION, GENERIC_MAPPING, GetAce, GetAclInformation,
    GetLengthSid, INHERIT_ONLY_ACE, INHERITED_ACE, IsValidSid, MapGenericMask,
    NO_PROPAGATE_INHERIT_ACE, OBJECT_INHERIT_ACE, PSECURITY_DESCRIPTOR, PSID,
};
use windows::Win32::Storage::FileSystem::{
    DELETE, FILE_ALL_ACCESS, FILE_APPEND_DATA, FILE_ATTRIBUTE_DIRECTORY, FILE_ATTRIBUTE_NORMAL,
    FILE_ATTRIBUTE_REPARSE_POINT, FILE_ATTRIBUTE_TAG_INFO, FILE_CASE_SENSITIVE_INFO,
    FILE_DELETE_CHILD, FILE_GENERIC_EXECUTE, FILE_GENERIC_READ, FILE_GENERIC_WRITE,
    FILE_READ_ATTRIBUTES, FILE_SHARE_DELETE, FILE_SHARE_READ, FILE_SHARE_WRITE, FILE_STANDARD_INFO,
    FILE_WRITE_ATTRIBUTES, FILE_WRITE_DATA, FILE_WRITE_EA, FileAttributeTagInfo,
    FileCaseSensitiveInfo, FileStandardInfo, GetFileInformationByHandleEx,
    GetFinalPathNameByHandleW, GetVolumeInformationByHandleW, READ_CONTROL, SYNCHRONIZE, WRITE_DAC,
};
use windows::Win32::System::IO::IO_STATUS_BLOCK;
use windows::core::PWSTR;

use crate::model::RunRequest;
use crate::win::{LocalSid, NamedMutex, OwnedHandle, sid_to_string};

const ACL_MUTEX: &str = "AclTransaction";
const ACL_MUTEX_TIMEOUT_MS: u32 = 30_000;
const FILE_OPEN: u32 = 1;
const FILE_SYNCHRONOUS_IO_NONALERT: u32 = 0x20;
const FILE_OPEN_FOR_BACKUP_INTENT: u32 = 0x4000;
const STATUS_REPARSE_POINT_ENCOUNTERED: NTSTATUS = NTSTATUS(0xC000_050B_u32 as i32);
const ACCESS_ALLOWED_ACE_TYPE: u8 = 0;
const ACCESS_DENIED_ACE_TYPE: u8 = 1;
const FILE_CS_FLAG_CASE_SENSITIVE_DIR: u32 = 1;

const READ_MASK: u32 = FILE_GENERIC_READ.0;
const READ_EXECUTE_MASK: u32 = FILE_GENERIC_READ.0 | FILE_GENERIC_EXECUTE.0;
const MODIFY_MASK: u32 =
    FILE_GENERIC_READ.0 | FILE_GENERIC_WRITE.0 | FILE_GENERIC_EXECUTE.0 | DELETE.0;
const DENY_WRITE_MASK: u32 = FILE_GENERIC_WRITE.0 | DELETE.0 | FILE_DELETE_CHILD.0;
const WRITE_EFFECT_MASK: u32 = FILE_WRITE_DATA.0
    | FILE_APPEND_DATA.0
    | FILE_WRITE_EA.0
    | FILE_WRITE_ATTRIBUTES.0
    | DELETE.0
    | FILE_DELETE_CHILD.0;

#[repr(C)]
struct ObjectAttributes {
    length: u32,
    root_directory: HANDLE,
    object_name: *const UNICODE_STRING,
    attributes: u32,
    security_descriptor: *const c_void,
    security_quality_of_service: *const c_void,
}

#[link(name = "ntdll")]
unsafe extern "system" {
    fn NtCreateFile(
        file_handle: *mut HANDLE,
        desired_access: u32,
        object_attributes: *const ObjectAttributes,
        io_status_block: *mut IO_STATUS_BLOCK,
        allocation_size: *const i64,
        file_attributes: u32,
        share_access: u32,
        create_disposition: u32,
        create_options: u32,
        ea_buffer: *const c_void,
        ea_length: u32,
    ) -> NTSTATUS;
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum AclMode {
    Deny,
    Grant,
}

#[derive(Clone, Debug, Eq, PartialEq)]
struct AclOperation {
    mode: AclMode,
    path: PathBuf,
    mask: u32,
    sid: String,
}

#[derive(Clone, Debug, Eq, PartialEq)]
struct RequiredAce {
    mode: AclMode,
    sid: String,
    mask: u32,
}

impl RequiredAce {
    fn new(mode: AclMode, sid: &str, mask: u32) -> Self {
        Self {
            mode,
            sid: sid.to_owned(),
            mask,
        }
    }
}

#[derive(Debug)]
struct ValidatedAclPath {
    dos: String,
    nt: Vec<u16>,
}

struct AclTarget {
    handle: OwnedHandle,
    canonical_path: String,
    directory: bool,
}

#[derive(Clone, Debug)]
struct ObservedAce {
    index: u32,
    mode: AclMode,
    sid: String,
    mask: u32,
    flags: u8,
}

struct AceSnapshot {
    aces: Vec<ObservedAce>,
    directory: bool,
}

struct RawDacl {
    descriptor: PSECURITY_DESCRIPTOR,
    dacl: *mut ACL,
}

struct LocalAcl(*mut ACL);

type OperationsByTrustee = BTreeMap<(u8, String), AclOperation>;
type OpenTargetGroup = (AclTarget, OperationsByTrustee);

impl Drop for RawDacl {
    fn drop(&mut self) {
        unsafe {
            let _ = LocalFree(Some(HLOCAL(self.descriptor.0)));
        }
    }
}

impl Drop for LocalAcl {
    fn drop(&mut self) {
        if !self.0.is_null() {
            unsafe {
                let _ = LocalFree(Some(HLOCAL(self.0 as *mut c_void)));
            }
        }
    }
}

impl AceSnapshot {
    fn grants_any(&self, sid: &str, mask: u32) -> bool {
        self.aces
            .iter()
            .any(|ace| ace.mode == AclMode::Grant && ace.sid == sid && ace.mask & mask != 0)
    }

    fn has_explicit(&self, mode: AclMode, sid: &str, mask: u32) -> bool {
        let inheritance = (OBJECT_INHERIT_ACE | CONTAINER_INHERIT_ACE).0 as u8;
        let aggregate = self
            .aces
            .iter()
            .filter(|ace| {
                ace.mode == mode
                    && ace.sid == sid
                    && ace.flags & INHERITED_ACE.0 as u8 == 0
                    && ace.flags & INHERIT_ONLY_ACE.0 as u8 == 0
                    && (!self.directory
                        || (ace.flags & inheritance == inheritance
                            && ace.flags & NO_PROPAGATE_INHERIT_ACE.0 as u8 == 0))
            })
            .fold(0u32, |combined, ace| combined | ace.mask);
        aggregate & mask == mask
    }

    fn required_aces_are_canonical(&self, required: &[RequiredAce]) -> bool {
        if !required
            .iter()
            .all(|ace| self.has_explicit(ace.mode, &ace.sid, ace.mask))
        {
            return false;
        }
        let relevant = |observed: &&ObservedAce, mode: AclMode| {
            observed.mode == mode
                && observed.flags & INHERITED_ACE.0 as u8 == 0
                && required
                    .iter()
                    .any(|required| required.mode == mode && required.sid == observed.sid)
        };
        let last_deny = self
            .aces
            .iter()
            .filter(|ace| relevant(ace, AclMode::Deny))
            .map(|ace| ace.index)
            .max();
        let first_grant = self
            .aces
            .iter()
            .filter(|ace| relevant(ace, AclMode::Grant))
            .map(|ace| ace.index)
            .min();
        match (last_deny, first_grant) {
            (Some(deny), Some(grant)) => deny < grant,
            _ => true,
        }
    }
}

fn normalized_paths(values: impl IntoIterator<Item = PathBuf>) -> Vec<PathBuf> {
    let mut unique = BTreeMap::new();
    for value in values {
        unique
            .entry(value.to_string_lossy().replace('/', "\\"))
            .or_insert(value);
    }
    unique.into_values().collect()
}

fn policy_operations(
    request: &RunRequest,
    _runner_directory: &Path,
    logon_sid: Option<&str>,
) -> Vec<AclOperation> {
    let allow_read = normalized_paths(request.allow_read.iter().map(PathBuf::from));
    let allow_write = normalized_paths(request.allow_write.iter().map(PathBuf::from));
    let deny_read = normalized_paths(request.deny_read.iter().map(PathBuf::from));
    let deny_write = normalized_paths(request.deny_write.iter().map(PathBuf::from));
    let mut operations = Vec::new();
    if let Some(logon_sid) = logon_sid {
        for path in deny_read {
            operations.push(AclOperation {
                mode: AclMode::Deny,
                path,
                mask: READ_MASK,
                sid: logon_sid.to_owned(),
            });
        }
        for path in deny_write {
            operations.push(AclOperation {
                mode: AclMode::Deny,
                path: path.clone(),
                mask: DENY_WRITE_MASK,
                sid: logon_sid.to_owned(),
            });
            operations.push(AclOperation {
                mode: AclMode::Deny,
                path,
                mask: DENY_WRITE_MASK,
                sid: request.policy_capability_sid.clone(),
            });
        }
    }
    for path in allow_read {
        operations.push(AclOperation {
            mode: AclMode::Grant,
            path,
            mask: READ_EXECUTE_MASK,
            sid: request.sandbox_group_sid.clone(),
        });
    }
    for path in allow_write {
        operations.push(AclOperation {
            mode: AclMode::Grant,
            path: path.clone(),
            mask: MODIFY_MASK,
            sid: request.sandbox_group_sid.clone(),
        });
        operations.push(AclOperation {
            mode: AclMode::Grant,
            path,
            mask: MODIFY_MASK,
            sid: request.policy_capability_sid.clone(),
        });
    }
    operations
}

fn is_dos_device_alias(value: &str) -> bool {
    let stem = value
        .split('.')
        .next()
        .unwrap_or(value)
        .to_ascii_uppercase();
    matches!(
        stem.as_str(),
        "CON" | "PRN" | "AUX" | "NUL" | "CONIN$" | "CONOUT$" | "CLOCK$"
    ) || stem
        .strip_prefix("COM")
        .or_else(|| stem.strip_prefix("LPT"))
        .is_some_and(|suffix| {
            matches!(
                suffix,
                "1" | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9" | "¹" | "²" | "³"
            )
        })
}

fn validate_acl_path(path: &Path) -> Result<ValidatedAclPath> {
    use std::path::{Component, Prefix};

    let mut components = path.components();
    let drive = match components.next() {
        Some(Component::Prefix(prefix)) => match prefix.kind() {
            Prefix::Disk(drive) => drive.to_ascii_uppercase() as char,
            _ => bail!("Windows sandbox ACL paths must use a local DOS drive"),
        },
        _ => bail!("Windows sandbox ACL path must be absolute"),
    };
    ensure!(
        matches!(components.next(), Some(Component::RootDir)),
        "Windows sandbox ACL path must be drive-absolute",
    );
    let mut segments = Vec::new();
    for component in components {
        let Component::Normal(value) = component else {
            bail!("Windows sandbox ACL path contains dot traversal");
        };
        let value = value
            .to_str()
            .ok_or_else(|| anyhow!("Windows sandbox ACL path is not valid Unicode"))?;
        if value.is_empty()
            || value.ends_with(['.', ' '])
            || value.contains(':')
            || value.chars().any(|character| {
                character < ' ' || matches!(character, '<' | '>' | '"' | '|' | '?' | '*')
            })
            || is_dos_device_alias(value)
        {
            bail!("Windows sandbox ACL path contains an unsafe component");
        }
        segments.push(value.to_owned());
    }
    let dos = if segments.is_empty() {
        format!("{drive}:\\")
    } else {
        format!("{drive}:\\{}", segments.join("\\"))
    };
    let mut nt = std::ffi::OsStr::new(&format!(r"\??\{dos}"))
        .encode_wide()
        .collect::<Vec<_>>();
    let name_bytes = nt
        .len()
        .checked_mul(size_of::<u16>())
        .and_then(|length| u16::try_from(length).ok())
        .ok_or_else(|| anyhow!("Windows sandbox ACL path is too long"))?;
    ensure!(name_bytes > 0, "Windows sandbox ACL path is empty");
    nt.push(0);
    Ok(ValidatedAclPath { dos, nt })
}

fn canonical_dos_path(handle: HANDLE) -> Result<String> {
    let mut buffer = vec![0u16; 512];
    loop {
        let written = unsafe { GetFinalPathNameByHandleW(handle, &mut buffer, Default::default()) };
        ensure!(
            written != 0,
            "cannot resolve canonical Windows sandbox ACL path"
        );
        if (written as usize) < buffer.len() {
            let raw = String::from_utf16(&buffer[..written as usize])
                .context("decode canonical Windows sandbox ACL path")?;
            if raw.to_ascii_lowercase().starts_with(r"\\?\unc\") {
                bail!("remote Windows sandbox ACL paths are unsupported");
            }
            let Some(dos) = raw.strip_prefix(r"\\?\") else {
                bail!("Windows sandbox ACL path did not resolve to a local DOS path");
            };
            return Ok(validate_acl_path(Path::new(dos))?.dos);
        }
        buffer.resize(written as usize + 1, 0);
    }
}

fn require_supported_filesystem(handle: HANDLE) -> Result<()> {
    let mut filesystem = vec![0u16; 32];
    unsafe {
        GetVolumeInformationByHandleW(handle, None, None, None, None, Some(&mut filesystem))
            .context("identify Windows sandbox ACL filesystem")?;
    }
    let length = filesystem
        .iter()
        .position(|value| *value == 0)
        .unwrap_or(filesystem.len());
    let name = String::from_utf16(&filesystem[..length])
        .context("decode Windows sandbox ACL filesystem")?;
    ensure!(
        name.eq_ignore_ascii_case("NTFS") || name.eq_ignore_ascii_case("ReFS"),
        "Windows sandbox ACLs require NTFS or ReFS, not {name}",
    );
    Ok(())
}

fn open_acl_target(path: &Path) -> Result<AclTarget> {
    let validated = validate_acl_path(path)?;
    let name_bytes = (validated.nt.len() - 1)
        .checked_mul(size_of::<u16>())
        .and_then(|length| u16::try_from(length).ok())
        .ok_or_else(|| anyhow!("Windows sandbox ACL path is too long"))?;
    let object_name = UNICODE_STRING {
        Length: name_bytes,
        MaximumLength: u16::try_from(validated.nt.len() * size_of::<u16>())
            .context("Windows sandbox ACL path is too long")?,
        Buffer: PWSTR(validated.nt.as_ptr() as *mut u16),
    };
    let attributes = ObjectAttributes {
        length: size_of::<ObjectAttributes>() as u32,
        root_directory: HANDLE::default(),
        object_name: &object_name,
        attributes: (OBJ_CASE_INSENSITIVE | OBJ_DONT_REPARSE).0,
        security_descriptor: null(),
        security_quality_of_service: null(),
    };
    let mut status_block = IO_STATUS_BLOCK::default();
    let mut raw = HANDLE::default();
    let status = unsafe {
        NtCreateFile(
            &mut raw,
            READ_CONTROL.0 | WRITE_DAC.0 | FILE_READ_ATTRIBUTES.0 | SYNCHRONIZE.0,
            &attributes,
            &mut status_block,
            null(),
            FILE_ATTRIBUTE_NORMAL.0,
            (FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE).0,
            FILE_OPEN,
            FILE_SYNCHRONOUS_IO_NONALERT | FILE_OPEN_FOR_BACKUP_INTENT,
            null(),
            0,
        )
    };
    if status.0 < 0 {
        if status == STATUS_REPARSE_POINT_ENCOUNTERED {
            bail!("Windows sandbox ACL path contains a reparse point");
        }
        let code = unsafe { RtlNtStatusToDosError(status) };
        return Err(std::io::Error::from_raw_os_error(code as i32)).with_context(|| {
            format!(
                "open Windows sandbox ACL target without following links: {}",
                path.display(),
            )
        });
    }
    let handle = OwnedHandle::new(raw, "Windows sandbox ACL target")?;
    let mut tag: FILE_ATTRIBUTE_TAG_INFO = unsafe { zeroed() };
    unsafe {
        GetFileInformationByHandleEx(
            handle.raw(),
            FileAttributeTagInfo,
            &mut tag as *mut FILE_ATTRIBUTE_TAG_INFO as *mut c_void,
            size_of::<FILE_ATTRIBUTE_TAG_INFO>() as u32,
        )
        .context("inspect Windows sandbox ACL target")?;
    }
    ensure!(
        tag.FileAttributes & FILE_ATTRIBUTE_REPARSE_POINT.0 == 0,
        "Windows sandbox ACL target is a reparse point",
    );
    let directory = tag.FileAttributes & FILE_ATTRIBUTE_DIRECTORY.0 != 0;
    if directory {
        let mut case_sensitive: FILE_CASE_SENSITIVE_INFO = unsafe { zeroed() };
        unsafe {
            GetFileInformationByHandleEx(
                handle.raw(),
                FileCaseSensitiveInfo,
                &mut case_sensitive as *mut FILE_CASE_SENSITIVE_INFO as *mut c_void,
                size_of::<FILE_CASE_SENSITIVE_INFO>() as u32,
            )
            .context("inspect Windows sandbox ACL directory case sensitivity")?;
        }
        ensure!(
            case_sensitive.Flags & FILE_CS_FLAG_CASE_SENSITIVE_DIR == 0,
            "case-sensitive directories are unsupported sandbox ACL targets",
        );
    } else {
        let mut standard: FILE_STANDARD_INFO = unsafe { zeroed() };
        unsafe {
            GetFileInformationByHandleEx(
                handle.raw(),
                FileStandardInfo,
                &mut standard as *mut FILE_STANDARD_INFO as *mut c_void,
                size_of::<FILE_STANDARD_INFO>() as u32,
            )
            .context("inspect Windows sandbox ACL target link count")?;
        }
        ensure!(
            standard.NumberOfLinks == 1,
            "hard-linked files are unsupported sandbox ACL targets",
        );
    }
    require_supported_filesystem(handle.raw())?;
    let canonical_path = canonical_dos_path(handle.raw())?;
    ensure!(
        canonical_path.eq_ignore_ascii_case(&validated.dos),
        "Windows sandbox ACL target resolved through a path alias",
    );
    Ok(AclTarget {
        handle,
        canonical_path,
        directory,
    })
}

fn raw_dacl(handle: HANDLE) -> Result<RawDacl> {
    let mut descriptor = PSECURITY_DESCRIPTOR::default();
    let mut dacl = null_mut();
    let code = unsafe {
        GetSecurityInfo(
            handle,
            SE_FILE_OBJECT,
            DACL_SECURITY_INFORMATION,
            None,
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
        bail!("GetSecurityInfo failed with {code:?}");
    }
    ensure!(
        !descriptor.0.is_null(),
        "GetSecurityInfo returned no descriptor"
    );
    let result = RawDacl { descriptor, dacl };
    ensure!(
        !result.dacl.is_null(),
        "null DACL is unsupported for sandbox ACL targets"
    );
    Ok(result)
}

fn generic_mapping() -> GENERIC_MAPPING {
    GENERIC_MAPPING {
        GenericRead: FILE_GENERIC_READ.0,
        GenericWrite: FILE_GENERIC_WRITE.0,
        GenericExecute: FILE_GENERIC_EXECUTE.0,
        GenericAll: FILE_ALL_ACCESS.0,
    }
}

impl AclTarget {
    fn read_aces(&self) -> Result<AceSnapshot> {
        let dacl = raw_dacl(self.handle.raw())?;
        let mut information = ACL_SIZE_INFORMATION::default();
        unsafe {
            GetAclInformation(
                dacl.dacl,
                &mut information as *mut ACL_SIZE_INFORMATION as *mut c_void,
                size_of::<ACL_SIZE_INFORMATION>() as u32,
                AclSizeInformation,
            )
            .context("read Windows sandbox ACL size")?;
        }
        let mut aces = Vec::new();
        for index in 0..information.AceCount {
            let mut raw = null_mut();
            unsafe { GetAce(dacl.dacl, index, &mut raw) }
                .with_context(|| format!("read Windows sandbox ACE {index}"))?;
            ensure!(!raw.is_null(), "Windows sandbox DACL returned a null ACE");
            let header = unsafe { &*(raw as *const ACE_HEADER) };
            let mode = match header.AceType {
                ACCESS_ALLOWED_ACE_TYPE => AclMode::Grant,
                ACCESS_DENIED_ACE_TYPE => AclMode::Deny,
                _ => continue,
            };
            ensure!(
                header.AceSize as usize
                    >= size_of::<ACE_HEADER>() + size_of::<u32>() + size_of::<u64>(),
                "Windows sandbox DACL contains a truncated ACE",
            );
            let ace = unsafe { &*(raw as *const ACCESS_ALLOWED_ACE) };
            let sid_offset = size_of::<ACE_HEADER>() + size_of::<u32>();
            let sid = PSID(unsafe { (raw as *mut u8).add(sid_offset) as *mut c_void });
            ensure!(
                unsafe { IsValidSid(sid) }.as_bool(),
                "Windows sandbox DACL contains an invalid SID",
            );
            ensure!(
                sid_offset + unsafe { GetLengthSid(sid) } as usize <= header.AceSize as usize,
                "Windows sandbox DACL contains an out-of-bounds SID",
            );
            let sid = sid_to_string(sid)?;
            let mut mask = ace.Mask;
            unsafe { MapGenericMask(&mut mask, &generic_mapping()) };
            aces.push(ObservedAce {
                index,
                mode,
                sid,
                mask,
                flags: header.AceFlags,
            });
        }
        Ok(AceSnapshot {
            aces,
            directory: self.directory,
        })
    }

    fn apply_and_verify(&self, operations: &[AclOperation]) -> Result<()> {
        let required = operations
            .iter()
            .map(|operation| RequiredAce::new(operation.mode, &operation.sid, operation.mask))
            .collect::<Vec<_>>();
        let before = self.read_aces()?;
        let missing = operations
            .iter()
            .filter(|operation| {
                !before.has_explicit(operation.mode, &operation.sid, operation.mask)
            })
            .collect::<Vec<_>>();
        if !missing.is_empty() {
            let sids = missing
                .iter()
                .map(|operation| LocalSid::from_string(&operation.sid))
                .collect::<Result<Vec<_>>>()?;
            let inheritance = if self.directory {
                OBJECT_INHERIT_ACE | CONTAINER_INHERIT_ACE
            } else {
                Default::default()
            };
            let entries = missing
                .iter()
                .zip(&sids)
                .map(|(operation, sid)| EXPLICIT_ACCESS_W {
                    grfAccessPermissions: operation.mask,
                    grfAccessMode: match operation.mode {
                        AclMode::Deny => DENY_ACCESS,
                        AclMode::Grant => GRANT_ACCESS,
                    },
                    grfInheritance: inheritance,
                    Trustee: TRUSTEE_W {
                        pMultipleTrustee: null_mut(),
                        MultipleTrusteeOperation: Default::default(),
                        TrusteeForm: TRUSTEE_IS_SID,
                        TrusteeType: TRUSTEE_IS_UNKNOWN,
                        ptstrName: PWSTR(sid.raw().0 as *mut u16),
                    },
                })
                .collect::<Vec<_>>();
            let old = raw_dacl(self.handle.raw())?;
            let mut new_dacl = null_mut();
            let code = unsafe { SetEntriesInAclW(Some(&entries), Some(old.dacl), &mut new_dacl) };
            let new_dacl = LocalAcl(new_dacl);
            ensure!(
                code == ERROR_SUCCESS,
                "SetEntriesInAclW failed for {} with {code:?}",
                self.canonical_path,
            );
            ensure!(!new_dacl.0.is_null(), "SetEntriesInAclW returned no DACL");
            let set_code = unsafe {
                SetSecurityInfo(
                    self.handle.raw(),
                    SE_FILE_OBJECT,
                    DACL_SECURITY_INFORMATION,
                    None,
                    None,
                    Some(new_dacl.0),
                    None,
                )
            };
            ensure!(
                set_code == ERROR_SUCCESS,
                "SetSecurityInfo failed for {} with {set_code:?}",
                self.canonical_path,
            );
        }
        let after = self.read_aces()?;
        ensure!(
            after.required_aces_are_canonical(&required),
            "Windows sandbox ACL read-back verification failed for {}",
            self.canonical_path,
        );
        Ok(())
    }
}

fn open_grouped_operations(
    operations: Vec<AclOperation>,
) -> Result<Vec<(AclTarget, Vec<AclOperation>)>> {
    let mut groups: BTreeMap<String, OpenTargetGroup> = BTreeMap::new();
    for operation in operations {
        let target = open_acl_target(&operation.path).with_context(|| {
            format!(
                "validate Windows sandbox ACL path {}",
                operation.path.display(),
            )
        })?;
        let path_key = target.canonical_path.clone();
        let mode_key = match operation.mode {
            AclMode::Deny => 0,
            AclMode::Grant => 1,
        };
        let operations = &mut groups
            .entry(path_key)
            .or_insert_with(|| (target, BTreeMap::new()))
            .1;
        operations
            .entry((mode_key, operation.sid.clone()))
            .and_modify(|existing| existing.mask |= operation.mask)
            .or_insert(operation);
    }
    Ok(groups
        .into_values()
        .map(|(target, operations)| (target, operations.into_values().collect()))
        .collect())
}

fn apply_operations(operations: Vec<AclOperation>, sandbox_user_sid: &str) -> Result<()> {
    let mut sids = BTreeSet::new();
    for operation in &operations {
        sids.insert(operation.sid.clone());
    }
    for sid in sids {
        let _ = LocalSid::from_string(&sid)?;
    }
    let targets = open_grouped_operations(operations)?;
    // A legacy allow ACE for the compatibility account would satisfy the
    // WRITE_RESTRICTED second pass without the policy capability. Preflight
    // every write root before adding any v2 ACE so a failed cutover cannot
    // partially widen another target.
    for (target, operations) in &targets {
        let applies_write_grant = operations.iter().any(|operation| {
            operation.mode == AclMode::Grant && operation.mask & WRITE_EFFECT_MASK != 0
        });
        if applies_write_grant
            && target
                .read_aces()?
                .grants_any(sandbox_user_sid, WRITE_EFFECT_MASK)
        {
            bail!(
                "[windows_v2_legacy_user_ace] Windows sandbox write root {} contains a shared-account write ACE; run `kodax sandbox setup` to rotate the v2 account before execution",
                target.canonical_path,
            );
        }
    }
    for (target, operations) in targets {
        target
            .apply_and_verify(&operations)
            .with_context(|| format!("apply verified ACLs to {}", target.canonical_path))?;
    }
    Ok(())
}

pub fn ensure_allow_aces(request: &RunRequest, runner_directory: &Path) -> Result<()> {
    let _transaction = NamedMutex::acquire(ACL_MUTEX, ACL_MUTEX_TIMEOUT_MS)?;
    apply_operations(
        policy_operations(request, runner_directory, None)
            .into_iter()
            .filter(|operation| operation.mode == AclMode::Grant)
            .collect(),
        &request.sandbox_user_sid,
    )
}

pub fn ensure_execution_denies(
    request: &RunRequest,
    runner_directory: &Path,
    logon_sid: &str,
) -> Result<()> {
    if !logon_sid.starts_with("S-1-") {
        return Err(anyhow!("restricted runner returned an invalid logon SID"));
    }
    let _transaction = NamedMutex::acquire(ACL_MUTEX, ACL_MUTEX_TIMEOUT_MS)?;
    // Re-verify the complete DACL after the execution-unique denies are known.
    // This makes the deny-before-allow ordering a checked property rather than
    // trusting that a previous allow-only transaction remained unchanged.
    apply_operations(
        policy_operations(request, runner_directory, Some(logon_sid)),
        &request.sandbox_user_sid,
    )
}

#[cfg(test)]
mod tests {
    use std::fs;
    use std::time::{SystemTime, UNIX_EPOCH};

    use super::*;
    use crate::model::capability_sid;

    fn request(root: &Path) -> RunRequest {
        let fingerprint = "0".repeat(64);
        RunRequest {
            protocol: crate::protocol::PROTOCOL_VERSION,
            generation: "generation".into(),
            sandbox_user_sid: "S-1-5-21-1-2-3-9999".into(),
            sandbox_group_sid: "S-1-5-21-1-2-3-8888".into(),
            asrt_executable: "srt-win.exe".into(),
            asrt_prefix_args: vec!["exec".into(), "--".into()],
            target_argv: vec!["cmd.exe".into()],
            cwd: root.to_string_lossy().into_owned(),
            policy_fingerprint: fingerprint.clone(),
            policy_capability_sid: capability_sid(&fingerprint).unwrap(),
            allow_read: vec![root.to_string_lossy().into_owned()],
            allow_write: vec![root.to_string_lossy().into_owned()],
            deny_read: vec![root.to_string_lossy().into_owned()],
            deny_write: vec![root.to_string_lossy().into_owned()],
            controller_pipe: r"\\.\pipe\kodax-v2-1234-12345678-1234-1234-1234-123456789abc".into(),
            launch_deadline_unix_ms: 1,
        }
    }

    fn temporary_directory(label: &str) -> PathBuf {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let path = std::env::temp_dir().join(format!(
            "kodax-windows-sandbox-v2-{label}-{}-{nonce}",
            std::process::id(),
        ));
        fs::create_dir(&path).unwrap();
        path
    }

    #[test]
    fn acl_plan_is_canonical_append_only_and_policy_scoped() {
        let root = temporary_directory("plan");
        let request = request(&root);
        let operations = policy_operations(&request, &root, Some("S-1-5-5-100-200"));
        let first_grant = operations
            .iter()
            .position(|operation| operation.mode == AclMode::Grant)
            .unwrap();
        let last_deny = operations
            .iter()
            .rposition(|operation| operation.mode == AclMode::Deny)
            .unwrap();
        assert!(last_deny < first_grant, "deny ACEs must precede allow ACEs");
        assert!(operations.iter().any(|operation| {
            operation.mode == AclMode::Grant
                && operation.sid == request.policy_capability_sid
                && operation.mask == MODIFY_MASK
        }));
        assert!(operations.iter().any(|operation| {
            operation.mode == AclMode::Deny
                && operation.sid == "S-1-5-5-100-200"
                && operation.mask == READ_MASK
        }));
        assert!(operations.iter().any(|operation| {
            operation.mode == AclMode::Deny
                && operation.sid == request.policy_capability_sid
                && operation.mask == DENY_WRITE_MASK
        }));
        assert!(!operations.iter().any(|operation| {
            operation.mode == AclMode::Deny
                && operation.sid == request.policy_capability_sid
                && operation.mask == READ_MASK
        }));
        assert_eq!(
            operations
                .iter()
                .filter(|operation| {
                    operation.mode == AclMode::Grant
                        && operation.sid == request.sandbox_group_sid
                        && operation
                            .path
                            .to_string_lossy()
                            .eq_ignore_ascii_case(&root.to_string_lossy())
                        && operation.mask == READ_EXECUTE_MASK
                })
                .count(),
            1,
        );
        fs::remove_dir(root).unwrap();
    }

    #[test]
    fn lexical_acl_path_screen_rejects_alias_namespaces() {
        for candidate in [
            r"\\server\share\work",
            r"\\?\C:\work",
            r"C:relative",
            r"C:\work\..\escape",
            r"C:\work\file.txt:stream",
            r"C:\work\NUL.txt",
            r"C:\work\CONOUT$",
            r"C:\work\trailing. ",
        ] {
            assert!(
                validate_acl_path(Path::new(candidate)).is_err(),
                "accepted unsafe ACL path {candidate}",
            );
        }
    }

    #[test]
    fn native_acl_transaction_adds_and_verifies_required_aces() {
        let root = temporary_directory("aces");
        let request = request(&root);
        ensure_allow_aces(&request, &root).unwrap();
        ensure_allow_aces(&request, &root).unwrap();

        let target = open_acl_target(&root).unwrap();
        let before_denies = target.read_aces().unwrap();
        assert!(before_denies.has_explicit(
            AclMode::Grant,
            &request.sandbox_group_sid,
            MODIFY_MASK,
        ));
        assert!(!before_denies.grants_any(&request.sandbox_user_sid, WRITE_EFFECT_MASK));
        assert!(before_denies.has_explicit(
            AclMode::Grant,
            &request.policy_capability_sid,
            MODIFY_MASK,
        ));
        assert_eq!(
            before_denies
                .aces
                .iter()
                .filter(|ace| {
                    ace.mode == AclMode::Grant
                        && ace.sid == request.policy_capability_sid
                        && ace.flags & INHERITED_ACE.0 as u8 == 0
                })
                .count(),
            1,
            "idempotent append must not grow duplicate capability ACEs",
        );

        let logon_sid = "S-1-5-5-100-200";
        ensure_execution_denies(&request, &root, logon_sid).unwrap();
        ensure_execution_denies(&request, &root, logon_sid).unwrap();
        let after_denies = target.read_aces().unwrap();
        assert!(after_denies.has_explicit(AclMode::Deny, logon_sid, READ_MASK));
        assert!(after_denies.has_explicit(
            AclMode::Deny,
            &request.policy_capability_sid,
            DENY_WRITE_MASK,
        ));
        assert!(after_denies.required_aces_are_canonical(&[
            RequiredAce::new(AclMode::Deny, logon_sid, READ_MASK),
            RequiredAce::new(
                AclMode::Deny,
                &request.policy_capability_sid,
                DENY_WRITE_MASK,
            ),
            RequiredAce::new(AclMode::Grant, &request.sandbox_group_sid, MODIFY_MASK),
            RequiredAce::new(AclMode::Grant, &request.policy_capability_sid, MODIFY_MASK,),
        ]));

        drop(target);
        fs::remove_dir(root).unwrap();
    }

    #[test]
    fn legacy_shared_account_write_ace_blocks_v2_before_policy_grants() {
        let root = temporary_directory("legacy-user-ace");
        let request = request(&root);
        let target = open_acl_target(&root).unwrap();
        target
            .apply_and_verify(&[AclOperation {
                mode: AclMode::Grant,
                path: root.clone(),
                mask: MODIFY_MASK,
                sid: request.sandbox_user_sid.clone(),
            }])
            .unwrap();

        let error = ensure_allow_aces(&request, &root).unwrap_err();
        assert!(error.to_string().contains("[windows_v2_legacy_user_ace]"));
        let after = target.read_aces().unwrap();
        assert!(!after.has_explicit(AclMode::Grant, &request.policy_capability_sid, MODIFY_MASK,));
        assert!(!after.has_explicit(AclMode::Grant, &request.sandbox_group_sid, MODIFY_MASK,));

        drop(target);
        fs::remove_dir(root).unwrap();
    }

    #[test]
    fn invalid_later_target_fails_before_any_acl_is_applied() {
        let root = temporary_directory("preflight");
        let valid = root.join("a-valid");
        fs::create_dir(&valid).unwrap();
        let mut request = request(&root);
        request.allow_read.clear();
        request.allow_write = vec![
            valid.to_string_lossy().into_owned(),
            root.join("z-missing").to_string_lossy().into_owned(),
        ];

        assert!(ensure_allow_aces(&request, &root).is_err());
        let target = open_acl_target(&valid).unwrap();
        assert!(!target.read_aces().unwrap().has_explicit(
            AclMode::Grant,
            &request.policy_capability_sid,
            MODIFY_MASK,
        ));

        drop(target);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn no_follow_open_rejects_ancestor_junctions() {
        let root = temporary_directory("junction");
        let real = root.join("real");
        let alias = root.join("alias");
        fs::create_dir(&real).unwrap();
        let output = std::process::Command::new("cmd")
            .args(["/C", "mklink", "/J"])
            .arg(&alias)
            .arg(&real)
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "mklink /J failed: {}",
            String::from_utf8_lossy(&output.stderr),
        );
        assert!(open_acl_target(&alias).is_err());
        let child = alias.join("child");
        fs::create_dir(real.join("child")).unwrap();
        assert!(open_acl_target(&child).is_err());

        fs::remove_dir(&alias).unwrap();
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn acl_target_rejects_hard_link_aliases() {
        let root = temporary_directory("hardlink");
        let original = root.join("original.txt");
        let alias = root.join("alias.txt");
        fs::write(&original, "guarded").unwrap();
        fs::hard_link(&original, &alias).unwrap();

        assert!(open_acl_target(&original).is_err());
        assert!(open_acl_target(&alias).is_err());

        fs::remove_file(alias).unwrap();
        fs::remove_file(original).unwrap();
        fs::remove_dir(root).unwrap();
    }
}
