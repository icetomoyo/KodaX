use std::collections::{BTreeMap, BTreeSet};
use std::ffi::c_void;
use std::fs::{self, OpenOptions};
use std::io::Read;
#[cfg(test)]
use std::io::Write;
use std::mem::{size_of, zeroed};
use std::os::windows::ffi::OsStrExt;
use std::os::windows::fs::{MetadataExt, OpenOptionsExt};
use std::path::{Path, PathBuf};
use std::ptr::{null, null_mut};
use std::time::{SystemTime, UNIX_EPOCH};

use anyhow::{Context, Result, anyhow, bail, ensure};
use serde::{Deserialize, Serialize};
use windows::Win32::Foundation::{
    ERROR_SUCCESS, HANDLE, HLOCAL, LocalFree, NTSTATUS, OBJ_CASE_INSENSITIVE, OBJ_DONT_REPARSE,
    RtlNtStatusToDosError, UNICODE_STRING,
};
use windows::Win32::Security::Authorization::{
    DENY_ACCESS, EXPLICIT_ACCESS_W, GetSecurityInfo, SE_FILE_OBJECT, SET_ACCESS, SetEntriesInAclW,
    SetSecurityInfo, TRUSTEE_IS_SID, TRUSTEE_IS_UNKNOWN, TRUSTEE_W,
};
use windows::Win32::Security::{
    ACCESS_ALLOWED_ACE, ACE_HEADER, ACL, ACL_REVISION, ACL_SIZE_INFORMATION, AclSizeInformation,
    AddAce, CONTAINER_INHERIT_ACE, DACL_SECURITY_INFORMATION, GENERIC_MAPPING, GetAce,
    GetAclInformation, GetLengthSid, GetSecurityDescriptorControl, INHERIT_ONLY_ACE, INHERITED_ACE,
    InitializeAcl, IsValidSid, MapGenericMask, NO_PROPAGATE_INHERIT_ACE, OBJECT_INHERIT_ACE,
    OWNER_SECURITY_INFORMATION, PSECURITY_DESCRIPTOR, PSID, SE_DACL_PROTECTED,
};
use windows::Win32::Storage::FileSystem::{
    DELETE, FILE_ALL_ACCESS, FILE_ATTRIBUTE_DIRECTORY, FILE_ATTRIBUTE_NORMAL,
    FILE_ATTRIBUTE_REPARSE_POINT, FILE_ATTRIBUTE_TAG_INFO, FILE_CASE_SENSITIVE_INFO,
    FILE_DELETE_CHILD, FILE_GENERIC_EXECUTE, FILE_GENERIC_READ, FILE_GENERIC_WRITE, FILE_ID_INFO,
    FILE_READ_ATTRIBUTES, FILE_SHARE_DELETE, FILE_SHARE_READ, FILE_SHARE_WRITE, FILE_STANDARD_INFO,
    FileAttributeTagInfo, FileCaseSensitiveInfo, FileIdInfo, FileStandardInfo,
    GetFileInformationByHandleEx, GetFinalPathNameByHandleW, GetVolumeInformationByHandleW,
    READ_CONTROL, SYNCHRONIZE, WRITE_DAC,
};
#[cfg(test)]
use windows::Win32::Storage::FileSystem::{MOVEFILE_WRITE_THROUGH, MoveFileExW};
use windows::Win32::System::IO::IO_STATUS_BLOCK;
#[cfg(test)]
use windows::core::PCWSTR;
use windows::core::PWSTR;

use crate::model::{FilesystemCapabilityKind, RunRequest, filesystem_capability_sid};
use crate::win::{
    LocalSid, OwnedHandle, current_token, process_creation_time, sid_to_string, token_user_sid,
};

const PERSISTENT_DENY_SETUP_TIMEOUT_MS: u32 = 15 * 60_000;
const ACL_AUTHORIZATION_PHASE_TIMEOUT_MS: u32 = 15_000;
const SETUP_ACL_TOTAL_TIMEOUT_MS: u64 = 14 * 60_000;
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
// Filesystem capabilities outlive the native wire protocol. Keep this schema
// stable across protocol-only upgrades so ordinary admission never churns ACLs.
const FILESYSTEM_CAPABILITY_SCHEMA_VERSION: u16 = 8;
const BUILTIN_USERS_SID: &str = "S-1-5-32-545";
const AUTHENTICATED_USERS_SID: &str = "S-1-5-11";
const EVERYONE_SID: &str = "S-1-1-0";
const EXECUTION_DENY_RECEIPT_VERSION: u16 = 2;
const MAX_EXECUTION_DENY_RECEIPT_BYTES: u64 = 64 * 1024;

fn operation_deadline_timeout_ms(deadline_unix_ms: u64, stage: &str) -> Result<u32> {
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .context("read Windows sandbox ACL clock")?
        .as_millis();
    ensure!(
        now < u128::from(deadline_unix_ms),
        "Windows sandbox operation deadline expired during {stage}",
    );
    let remaining = u128::from(deadline_unix_ms) - now;
    u32::try_from(remaining.min(u128::from(u32::MAX)))
        .context("convert Windows sandbox ACL deadline")
}

fn acl_phase_deadline_unix_ms(operation_deadline_unix_ms: u64) -> Result<u64> {
    let now = u64::try_from(
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .context("read Windows sandbox ACL phase clock")?
            .as_millis(),
    )
    .context("convert Windows sandbox ACL phase clock")?;
    ensure!(
        now < operation_deadline_unix_ms,
        "Windows sandbox operation deadline expired before ACL authorization",
    );
    Ok(operation_deadline_unix_ms
        .min(now.saturating_add(u64::from(ACL_AUTHORIZATION_PHASE_TIMEOUT_MS))))
}

#[cfg(test)]
fn test_operation_deadline_unix_ms() -> u64 {
    u64::try_from(
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("test clock")
            .as_millis(),
    )
    .expect("test clock fits u64")
        + u64::from(ACL_AUTHORIZATION_PHASE_TIMEOUT_MS)
}

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

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum AccessPass {
    Normal,
    Restricted,
}

#[derive(Clone, Debug, Eq, PartialEq)]
enum PlannedTrustee {
    Sid(String),
    FilesystemCapability(FilesystemCapabilityKind),
}

#[derive(Clone, Debug, Eq, PartialEq)]
struct PlannedAclOperation {
    mode: AclMode,
    path: PathBuf,
    mask: u32,
    trustee: PlannedTrustee,
    inherit: bool,
    pass: AccessPass,
    active_in_token: bool,
}

#[derive(Clone, Debug, Eq, PartialEq)]
struct AclOperation {
    mode: AclMode,
    path: PathBuf,
    mask: u32,
    sid: String,
    inherit: bool,
    pass: AccessPass,
    active_in_token: bool,
}

#[derive(Clone, Debug, Eq, PartialEq)]
struct RequiredAce {
    mode: AclMode,
    sid: String,
    mask: u32,
    inherit: bool,
    pass: AccessPass,
}

impl RequiredAce {
    fn new(mode: AclMode, sid: &str, mask: u32, inherit: bool, pass: AccessPass) -> Self {
        Self {
            mode,
            sid: sid.to_owned(),
            mask,
            inherit,
            pass,
        }
    }

    fn from_operation(operation: &AclOperation) -> Self {
        Self::new(
            operation.mode,
            &operation.sid,
            operation.mask,
            operation.inherit,
            operation.pass,
        )
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
    identity: AclTargetIdentity,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
struct AclTargetIdentity {
    volume_serial: u64,
    file_id: [u8; 16],
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ExecutionDenyTargetReceipt {
    canonical_path: String,
    volume_serial: u64,
    file_id: [u8; 16],
    directory: bool,
    deny_mask: u32,
    deny_flags: u8,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ExecutionDenyReceipt {
    version: u16,
    runner_pid: u32,
    runner_creation_time: u64,
    logon_sid: String,
    targets: Vec<ExecutionDenyTargetReceipt>,
}

pub fn verify_persistent_deny_read(
    paths: &[String],
    sandbox_group_sid: &str,
) -> Result<Vec<String>> {
    let _ = LocalSid::from_string(sandbox_group_sid)?;
    let mut missing = Vec::new();
    for path in normalized_paths(paths.iter().map(PathBuf::from)) {
        let target = inspect_acl_target(&path).with_context(|| {
            format!("verify persistent Windows denyRead path {}", path.display())
        })?;
        if !target
            .read_aces()?
            .has_explicit(AclMode::Deny, sandbox_group_sid, READ_MASK, true)
        {
            missing.push(target.canonical_path);
        }
    }
    Ok(missing)
}

pub fn ensure_persistent_deny_read(
    paths: &[String],
    sandbox_user_sid: &str,
    sandbox_group_sid: &str,
) -> Result<()> {
    let _ = LocalSid::from_string(sandbox_user_sid)?;
    let _ = LocalSid::from_string(sandbox_group_sid)?;
    let targets = normalized_paths(paths.iter().map(PathBuf::from))
        .into_iter()
        .map(|path| {
            open_acl_target(&path).with_context(|| {
                format!("open persistent Windows denyRead path {}", path.display())
            })
        })
        .collect::<Result<Vec<_>>>()?;
    for target in targets {
        let operation = AclOperation {
            mode: AclMode::Deny,
            path: PathBuf::from(&target.canonical_path),
            mask: READ_MASK,
            sid: sandbox_group_sid.to_owned(),
            inherit: true,
            pass: AccessPass::Normal,
            active_in_token: false,
        };
        target
            .apply_and_verify(&[operation], sandbox_user_sid)
            .with_context(|| {
                format!(
                    "install persistent Windows denyRead at {}",
                    target.canonical_path,
                )
            })?;
    }
    ensure!(
        verify_persistent_deny_read(paths, sandbox_group_sid)?.is_empty(),
        "persistent Windows denyRead verification remained incomplete",
    );
    Ok(())
}

pub fn remove_persistent_deny_read(paths: &[String], sandbox_group_sid: &str) -> Result<()> {
    let _ = LocalSid::from_string(sandbox_group_sid)?;
    let targets = normalized_paths(paths.iter().map(PathBuf::from))
        .into_iter()
        .map(|path| {
            open_acl_target(&path)
                .with_context(|| format!("open legacy Windows denyRead path {}", path.display()))
        })
        .collect::<Result<Vec<_>>>()?;
    for target in targets {
        let exact_legacy_ace = target.execution_deny_receipt();
        target
            .remove_execution_deny(sandbox_group_sid, &exact_legacy_ace)
            .with_context(|| {
                format!(
                    "remove legacy persistent Windows denyRead at {}",
                    target.canonical_path,
                )
            })?;
    }
    Ok(())
}

#[derive(Clone, Debug, Eq, PartialEq)]
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
    owner: PSID,
}

struct LocalAcl(*mut ACL);

type OperationsByTrustee = BTreeMap<(u8, String, bool, u8), AclOperation>;
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
    fn exact_execution_deny_count(&self, sid: &str) -> usize {
        let expected_flags = if self.directory {
            (OBJECT_INHERIT_ACE | CONTAINER_INHERIT_ACE).0 as u8
        } else {
            0
        };
        self.aces
            .iter()
            .filter(|ace| {
                ace.mode == AclMode::Deny
                    && ace.sid.eq_ignore_ascii_case(sid)
                    && ace.mask == READ_MASK
                    && ace.flags == expected_flags
            })
            .count()
    }

    fn has_explicit(&self, mode: AclMode, sid: &str, mask: u32, inherit: bool) -> bool {
        let inheritance = (OBJECT_INHERIT_ACE | CONTAINER_INHERIT_ACE).0 as u8;
        let aggregate = self
            .aces
            .iter()
            .filter(|ace| {
                ace.mode == mode
                    && ace.sid == sid
                    && ace.flags & INHERITED_ACE.0 as u8 == 0
                    && (!self.directory
                        || if inherit {
                            ace.flags & inheritance == inheritance
                                && ace.flags & INHERIT_ONLY_ACE.0 as u8 == 0
                                && ace.flags & NO_PROPAGATE_INHERIT_ACE.0 as u8 == 0
                        } else {
                            ace.flags & inheritance == 0
                                && ace.flags & INHERIT_ONLY_ACE.0 as u8 == 0
                        })
            })
            .fold(0u32, |combined, ace| combined | ace.mask);
        aggregate & mask == mask
    }

    fn effective_mask(&self, sids: &[&str], applies: impl Fn(&ObservedAce) -> bool) -> u32 {
        let denied = self
            .aces
            .iter()
            .filter(|ace| {
                ace.mode == AclMode::Deny
                    && applies(ace)
                    && sids.iter().any(|sid| ace.sid.eq_ignore_ascii_case(sid))
            })
            .fold(0u32, |combined, ace| combined | ace.mask);
        let granted = self
            .aces
            .iter()
            .filter(|ace| {
                ace.mode == AclMode::Grant
                    && applies(ace)
                    && sids.iter().any(|sid| ace.sid.eq_ignore_ascii_case(sid))
            })
            .fold(0u32, |combined, ace| combined | ace.mask);
        granted & !denied
    }

    fn pass_grants_without_deny(&self, sids: &[&str], mask: u32, inherit: bool) -> bool {
        let current = self.effective_mask(sids, |ace| ace.flags & INHERIT_ONLY_ACE.0 as u8 == 0);
        if current & mask != mask {
            return false;
        }
        if !self.directory || !inherit {
            return true;
        }
        let inheritance = (OBJECT_INHERIT_ACE | CONTAINER_INHERIT_ACE).0 as u8;
        let inherited = self.effective_mask(sids, |ace| {
            ace.flags & inheritance == inheritance
                && ace.flags & NO_PROPAGATE_INHERIT_ACE.0 as u8 == 0
        });
        inherited & mask == mask
    }

    fn satisfies(&self, required: &RequiredAce, sandbox_user_sid: &str) -> bool {
        if required.mode == AclMode::Grant && required.pass == AccessPass::Normal {
            return self.pass_grants_without_deny(
                &[
                    required.sid.as_str(),
                    sandbox_user_sid,
                    BUILTIN_USERS_SID,
                    AUTHENTICATED_USERS_SID,
                    EVERYONE_SID,
                ],
                required.mask,
                required.inherit,
            );
        }
        if required.mode == AclMode::Grant {
            return match required.pass {
                AccessPass::Normal => unreachable!("normal grants return above"),
                AccessPass::Restricted => self.pass_grants_without_deny(
                    &[required.sid.as_str(), EVERYONE_SID],
                    required.mask,
                    required.inherit,
                ),
            };
        }
        if self.has_explicit(
            required.mode,
            &required.sid,
            required.mask,
            required.inherit,
        ) {
            return true;
        }
        false
    }

    fn required_aces_are_canonical(
        &self,
        required: &[RequiredAce],
        sandbox_user_sid: &str,
    ) -> bool {
        if !required
            .iter()
            .all(|ace| self.satisfies(ace, sandbox_user_sid))
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

fn stable_root_operations(
    path: PathBuf,
    sandbox_group_sid: &str,
    allow_read_in_token: bool,
    allow_write_in_token: bool,
    deny_write_in_token: bool,
) -> [PlannedAclOperation; 4] {
    [
        PlannedAclOperation {
            mode: AclMode::Deny,
            path: path.clone(),
            mask: DENY_WRITE_MASK,
            trustee: PlannedTrustee::FilesystemCapability(FilesystemCapabilityKind::DenyWrite),
            inherit: true,
            pass: AccessPass::Restricted,
            active_in_token: deny_write_in_token,
        },
        PlannedAclOperation {
            mode: AclMode::Grant,
            path: path.clone(),
            mask: READ_EXECUTE_MASK,
            trustee: PlannedTrustee::FilesystemCapability(FilesystemCapabilityKind::AllowRead),
            inherit: true,
            pass: AccessPass::Restricted,
            active_in_token: allow_read_in_token,
        },
        PlannedAclOperation {
            mode: AclMode::Grant,
            path: path.clone(),
            mask: MODIFY_MASK,
            trustee: PlannedTrustee::Sid(sandbox_group_sid.to_owned()),
            inherit: true,
            pass: AccessPass::Normal,
            active_in_token: false,
        },
        PlannedAclOperation {
            mode: AclMode::Grant,
            path,
            mask: MODIFY_MASK,
            trustee: PlannedTrustee::FilesystemCapability(FilesystemCapabilityKind::AllowWrite),
            inherit: true,
            pass: AccessPass::Restricted,
            active_in_token: allow_write_in_token,
        },
    ]
}

fn filesystem_capability_generation(request: &RunRequest) -> String {
    format!(
        "v{}:{}",
        FILESYSTEM_CAPABILITY_SCHEMA_VERSION,
        request.filesystem_capability_nonce.to_ascii_lowercase(),
    )
}

fn policy_operations(
    request: &RunRequest,
    _runner_directory: &Path,
    _host_sid: &str,
) -> Vec<PlannedAclOperation> {
    let mut roots = BTreeMap::<String, (PathBuf, bool, bool, bool)>::new();
    for path in request.allow_read.iter().map(PathBuf::from) {
        let key = path
            .to_string_lossy()
            .replace('/', "\\")
            .to_ascii_lowercase();
        roots
            .entry(key)
            .and_modify(|entry| entry.1 = true)
            .or_insert((path, true, false, false));
    }
    for path in request.allow_write.iter().map(PathBuf::from) {
        let key = path
            .to_string_lossy()
            .replace('/', "\\")
            .to_ascii_lowercase();
        roots
            .entry(key)
            .and_modify(|entry| entry.2 = true)
            .or_insert((path, false, true, false));
    }
    for path in request.deny_write.iter().map(PathBuf::from) {
        let key = path
            .to_string_lossy()
            .replace('/', "\\")
            .to_ascii_lowercase();
        roots
            .entry(key)
            .and_modify(|entry| entry.3 = true)
            .or_insert((path, false, false, true));
    }
    let mut operations = Vec::new();
    // Every writer for one canonical root publishes the same persistent ACE
    // set. The token alone selects the active capabilities, so concurrent
    // read/write admissions cannot overwrite one another with different DACLs.
    for (_, (path, allow_read, allow_write, deny_write)) in roots {
        operations.extend(stable_root_operations(
            path,
            &request.sandbox_group_sid,
            allow_read && !allow_write,
            allow_write,
            deny_write || (allow_read && !allow_write),
        ));
    }
    operations
}

pub fn ensure_setup_acl_roots(
    read_roots: &[String],
    write_roots: &[String],
    sandbox_group_sid: &str,
    filesystem_capability_nonce: &str,
) -> Result<()> {
    let deadline_unix_ms = u64::try_from(
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .context("read Windows sandbox setup ACL clock")?
            .as_millis(),
    )
    .context("convert Windows sandbox setup ACL clock")?
    .saturating_add(SETUP_ACL_TOTAL_TIMEOUT_MS);
    ensure_setup_acl_roots_until(
        read_roots,
        write_roots,
        sandbox_group_sid,
        filesystem_capability_nonce,
        deadline_unix_ms,
    )
}

fn ensure_setup_acl_roots_until(
    read_roots: &[String],
    write_roots: &[String],
    sandbox_group_sid: &str,
    filesystem_capability_nonce: &str,
    deadline_unix_ms: u64,
) -> Result<()> {
    let _ = LocalSid::from_string(sandbox_group_sid)?;
    let capability_generation = format!(
        "v{}:{}",
        FILESYSTEM_CAPABILITY_SCHEMA_VERSION,
        filesystem_capability_nonce.to_ascii_lowercase(),
    );
    let roots = normalized_paths(read_roots.iter().chain(write_roots).map(PathBuf::from));
    let operations = roots
        .into_iter()
        .flat_map(|path| stable_root_operations(path, sandbox_group_sid, false, false, false))
        .collect::<Vec<_>>();
    operation_deadline_timeout_ms(deadline_unix_ms, "setup ACL preflight")?;
    let targets = open_grouped_operations(operations, &capability_generation, sandbox_group_sid)?;
    operation_deadline_timeout_ms(deadline_unix_ms, "setup ACL preflight")?;
    for (inspected, operations) in targets {
        operation_deadline_timeout_ms(deadline_unix_ms, "setup ACL authorization")?;
        if target_satisfies_operations(&inspected, &operations, sandbox_group_sid)? {
            continue;
        }
        let target = open_acl_target(Path::new(&inspected.canonical_path)).with_context(|| {
            format!(
                "reopen setup ACL target {} without reparse traversal",
                inspected.canonical_path,
            )
        })?;
        if !target_satisfies_operations(&target, &operations, sandbox_group_sid)? {
            target
                .apply_and_verify(&operations, sandbox_group_sid)
                .with_context(|| format!("prepare setup ACLs at {}", target.canonical_path))?;
        }
        operation_deadline_timeout_ms(deadline_unix_ms, "setup ACL authorization")?;
    }
    Ok(())
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

fn open_acl_target_with_access(path: &Path, desired_access: u32) -> Result<AclTarget> {
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
            desired_access,
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
    let mut identity: FILE_ID_INFO = unsafe { zeroed() };
    unsafe {
        GetFileInformationByHandleEx(
            handle.raw(),
            FileIdInfo,
            &mut identity as *mut FILE_ID_INFO as *mut c_void,
            size_of::<FILE_ID_INFO>() as u32,
        )
        .context("inspect Windows sandbox ACL target identity")?;
    }
    let canonical_path = canonical_dos_path(handle.raw())?;
    ensure!(
        canonical_path.eq_ignore_ascii_case(&validated.dos),
        "Windows sandbox ACL target resolved through a path alias",
    );
    Ok(AclTarget {
        handle,
        canonical_path,
        directory,
        identity: AclTargetIdentity {
            volume_serial: identity.VolumeSerialNumber,
            file_id: identity.FileId.Identifier,
        },
    })
}

fn open_acl_target(path: &Path) -> Result<AclTarget> {
    open_acl_target_with_access(
        path,
        READ_CONTROL.0 | WRITE_DAC.0 | FILE_READ_ATTRIBUTES.0 | SYNCHRONIZE.0,
    )
}

fn inspect_acl_target(path: &Path) -> Result<AclTarget> {
    open_acl_target_with_access(
        path,
        READ_CONTROL.0 | FILE_READ_ATTRIBUTES.0 | SYNCHRONIZE.0,
    )
}

fn raw_dacl(handle: HANDLE) -> Result<RawDacl> {
    let mut descriptor = PSECURITY_DESCRIPTOR::default();
    let mut dacl = null_mut();
    let mut owner = PSID::default();
    let code = unsafe {
        GetSecurityInfo(
            handle,
            SE_FILE_OBJECT,
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
        bail!("GetSecurityInfo failed with {code:?}");
    }
    ensure!(
        !descriptor.0.is_null(),
        "GetSecurityInfo returned no descriptor"
    );
    let result = RawDacl {
        descriptor,
        dacl,
        owner,
    };
    ensure!(
        !result.dacl.is_null(),
        "null DACL is unsupported for sandbox ACL targets"
    );
    ensure!(
        !result.owner.0.is_null(),
        "Windows sandbox ACL target returned no owner"
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
    fn execution_deny_flags(&self) -> u8 {
        if self.directory {
            (OBJECT_INHERIT_ACE | CONTAINER_INHERIT_ACE).0 as u8
        } else {
            0
        }
    }

    fn execution_deny_receipt(&self) -> ExecutionDenyTargetReceipt {
        ExecutionDenyTargetReceipt {
            canonical_path: self.canonical_path.clone(),
            volume_serial: self.identity.volume_serial,
            file_id: self.identity.file_id,
            directory: self.directory,
            deny_mask: READ_MASK,
            deny_flags: self.execution_deny_flags(),
        }
    }

    fn verify_execution_deny_identity(&self, expected: &ExecutionDenyTargetReceipt) -> Result<()> {
        ensure!(
            self.canonical_path
                .eq_ignore_ascii_case(&expected.canonical_path)
                && self.identity.volume_serial == expected.volume_serial
                && self.identity.file_id == expected.file_id
                && self.directory == expected.directory,
            "Windows execution deny target identity changed: {}",
            expected.canonical_path,
        );
        Ok(())
    }

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

    fn apply_and_verify(&self, operations: &[AclOperation], sandbox_user_sid: &str) -> Result<()> {
        let required = operations
            .iter()
            .map(RequiredAce::from_operation)
            .collect::<Vec<_>>();
        let before = self.read_aces()?;
        let missing = operations
            .iter()
            .filter(|operation| {
                !before.satisfies(&RequiredAce::from_operation(operation), sandbox_user_sid)
            })
            .collect::<Vec<_>>();
        if !missing.is_empty() {
            let sids = missing
                .iter()
                .map(|operation| LocalSid::from_string(&operation.sid))
                .collect::<Result<Vec<_>>>()?;
            let entries = missing
                .iter()
                .zip(&sids)
                .map(|(operation, sid)| EXPLICIT_ACCESS_W {
                    grfAccessPermissions: operation.mask,
                    grfAccessMode: match operation.mode {
                        AclMode::Deny => DENY_ACCESS,
                        AclMode::Grant => SET_ACCESS,
                    },
                    grfInheritance: if self.directory && operation.inherit {
                        OBJECT_INHERIT_ACE | CONTAINER_INHERIT_ACE
                    } else {
                        Default::default()
                    },
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
            after.required_aces_are_canonical(&required, sandbox_user_sid),
            "Windows sandbox ACL read-back verification failed for {}",
            self.canonical_path,
        );
        Ok(())
    }

    fn remove_execution_deny(
        &self,
        logon_sid: &str,
        expected: &ExecutionDenyTargetReceipt,
    ) -> Result<()> {
        let before = self.read_aces()?;
        let owned = before
            .aces
            .iter()
            .filter(|ace| {
                ace.mode == AclMode::Deny
                    && ace.sid.eq_ignore_ascii_case(logon_sid)
                    && ace.mask == expected.deny_mask
                    && ace.flags == expected.deny_flags
            })
            .map(|ace| ace.index)
            .collect::<Vec<_>>();
        match owned.as_slice() {
            [] => return Ok(()),
            [_] => {}
            _ => bail!(
                "Windows sandbox execution deny ownership is ambiguous for {}",
                self.canonical_path,
            ),
        }
        let remove_index = owned[0];
        let old = raw_dacl(self.handle.raw())?;
        let mut info: ACL_SIZE_INFORMATION = unsafe { zeroed() };
        unsafe {
            GetAclInformation(
                old.dacl,
                &mut info as *mut _ as *mut c_void,
                size_of::<ACL_SIZE_INFORMATION>() as u32,
                AclSizeInformation,
            )
            .context("GetAclInformation(execution deny cleanup)")?;
        }
        let acl_bytes = usize::try_from(info.AclBytesInUse)
            .context("execution deny ACL size overflow")?
            .max(size_of::<ACL>());
        let mut storage = vec![0u32; acl_bytes.div_ceil(size_of::<u32>())];
        let new_acl = storage.as_mut_ptr().cast::<ACL>();
        unsafe {
            InitializeAcl(
                new_acl,
                u32::try_from(storage.len() * size_of::<u32>())?,
                ACL_REVISION,
            )
            .context("InitializeAcl(execution deny cleanup)")?;
        }
        for index in 0..u32::from(unsafe { (*old.dacl).AceCount }) {
            if index == remove_index {
                continue;
            }
            let mut raw = null_mut();
            unsafe { GetAce(old.dacl, index, &mut raw) }
                .with_context(|| format!("GetAce(execution deny cleanup, {index})"))?;
            let header = unsafe { &*(raw as *const ACE_HEADER) };
            unsafe {
                AddAce(
                    new_acl,
                    ACL_REVISION,
                    u32::MAX,
                    raw,
                    u32::from(header.AceSize),
                )
                .with_context(|| format!("AddAce(execution deny cleanup, {index})"))?;
            }
        }
        let code = unsafe {
            SetSecurityInfo(
                self.handle.raw(),
                SE_FILE_OBJECT,
                DACL_SECURITY_INFORMATION,
                None,
                None,
                Some(new_acl),
                None,
            )
        };
        ensure!(
            code == ERROR_SUCCESS,
            "SetSecurityInfo(execution deny cleanup) failed for {} with {code:?}",
            self.canonical_path,
        );
        let after = self.read_aces()?;
        ensure!(
            after.exact_execution_deny_count(logon_sid) == 0,
            "Windows sandbox execution deny cleanup read-back failed for {}",
            self.canonical_path,
        );
        let expected = before
            .aces
            .iter()
            .filter(|ace| ace.index != remove_index)
            .map(|ace| (ace.mode, ace.sid.to_ascii_lowercase(), ace.mask, ace.flags))
            .collect::<Vec<_>>();
        let observed = after
            .aces
            .iter()
            .map(|ace| (ace.mode, ace.sid.to_ascii_lowercase(), ace.mask, ace.flags))
            .collect::<Vec<_>>();
        ensure!(
            observed == expected,
            "Windows sandbox DACL changed outside its owned execution deny at {}",
            self.canonical_path,
        );
        Ok(())
    }
}

fn open_grouped_operations(
    operations: Vec<PlannedAclOperation>,
    generation: &str,
    _sandbox_user_sid: &str,
) -> Result<Vec<(AclTarget, Vec<AclOperation>)>> {
    let mut requested: BTreeMap<String, Vec<PlannedAclOperation>> = BTreeMap::new();
    for operation in operations {
        let path_key = operation
            .path
            .to_string_lossy()
            .replace('/', "\\")
            .to_ascii_lowercase();
        requested.entry(path_key).or_default().push(operation);
    }
    let mut groups: BTreeMap<String, OpenTargetGroup> = BTreeMap::new();
    for operations in requested.into_values() {
        let representative = &operations[0].path;
        let target = inspect_acl_target(representative).with_context(|| {
            format!(
                "validate Windows sandbox ACL path {}",
                representative.display(),
            )
        })?;
        let path_key = target.canonical_path.clone();
        let grouped = &mut groups
            .entry(path_key.clone())
            .or_insert_with(|| (target, BTreeMap::new()))
            .1;
        for operation in operations {
            let sid = match operation.trustee {
                PlannedTrustee::Sid(sid) => sid,
                PlannedTrustee::FilesystemCapability(kind) => {
                    filesystem_capability_sid(generation, &path_key, kind)?
                }
            };
            let operation = AclOperation {
                mode: operation.mode,
                path: PathBuf::from(&path_key),
                mask: operation.mask,
                sid,
                inherit: operation.inherit,
                pass: operation.pass,
                active_in_token: operation.active_in_token,
            };
            let mode_key = match operation.mode {
                AclMode::Deny => 0,
                AclMode::Grant => 1,
            };
            let pass_key = match operation.pass {
                AccessPass::Normal => 0,
                AccessPass::Restricted => 1,
            };
            grouped
                .entry((mode_key, operation.sid.clone(), operation.inherit, pass_key))
                .and_modify(|existing| {
                    existing.mask |= operation.mask;
                    existing.active_in_token |= operation.active_in_token;
                })
                .or_insert(operation);
        }
    }
    Ok(groups
        .into_values()
        .map(|(target, operations)| (target, operations.into_values().collect()))
        .collect())
}

fn target_satisfies_operations(
    target: &AclTarget,
    operations: &[AclOperation],
    sandbox_user_sid: &str,
) -> Result<bool> {
    let required = operations
        .iter()
        .map(RequiredAce::from_operation)
        .collect::<Vec<_>>();
    let snapshot = target.read_aces()?;
    Ok(snapshot.required_aces_are_canonical(&required, sandbox_user_sid))
}

fn apply_operations(
    operations: Vec<PlannedAclOperation>,
    generation: &str,
    sandbox_user_sid: &str,
    operation_deadline_unix_ms: u64,
) -> Result<Vec<String>> {
    let targets = open_grouped_operations(operations, generation, sandbox_user_sid)?;
    let acl_phase_deadline = acl_phase_deadline_unix_ms(operation_deadline_unix_ms)?;
    let mut filesystem_capability_sids = BTreeSet::new();
    for (_, operations) in &targets {
        for operation in operations {
            let _ = LocalSid::from_string(&operation.sid)?;
            if operation.pass == AccessPass::Restricted && operation.active_in_token {
                filesystem_capability_sids.insert(operation.sid.clone());
            }
        }
    }
    operation_deadline_timeout_ms(acl_phase_deadline, "policy ACL authorization commit")?;
    for (inspected, operations) in targets {
        if target_satisfies_operations(&inspected, &operations, sandbox_user_sid)? {
            continue;
        }
        let target = open_acl_target(Path::new(&inspected.canonical_path)).with_context(|| {
            format!(
                "open Windows sandbox ACL path for update {}",
                inspected.canonical_path,
            )
        })?;
        if target_satisfies_operations(&target, &operations, sandbox_user_sid)? {
            continue;
        }
        // Match Codex's admission model: current roots converge through
        // additive, read-back-verified updates without a cross-process mutex.
        for attempt in 0..3 {
            operation_deadline_timeout_ms(acl_phase_deadline, "policy ACL authorization commit")?;
            match target.apply_and_verify(&operations, sandbox_user_sid) {
                Ok(()) => break,
                Err(_error) if attempt < 2 => {
                    std::thread::yield_now();
                    continue;
                }
                Err(error) => {
                    return Err(error).with_context(|| {
                        format!("apply verified ACLs to {}", target.canonical_path)
                    });
                }
            }
        }
    }
    Ok(filesystem_capability_sids.into_iter().collect())
}

fn satisfied_policy_capability_sids(
    operations: Vec<PlannedAclOperation>,
    generation: &str,
    sandbox_user_sid: &str,
) -> Result<Option<Vec<String>>> {
    let targets = open_grouped_operations(operations, generation, sandbox_user_sid)?;
    let mut filesystem_capability_sids = BTreeSet::new();
    for (target, operations) in &targets {
        if !target_satisfies_operations(target, operations, sandbox_user_sid)? {
            return Ok(None);
        }
        for operation in operations {
            let _ = LocalSid::from_string(&operation.sid)?;
            if operation.pass == AccessPass::Restricted && operation.active_in_token {
                filesystem_capability_sids.insert(operation.sid.clone());
            }
        }
    }
    Ok(Some(filesystem_capability_sids.into_iter().collect()))
}

fn canonical_path_is_same_or_inside(parent: &str, candidate: &str) -> bool {
    if parent.eq_ignore_ascii_case(candidate) {
        return true;
    }
    let mut prefix = parent.trim_end_matches('\\').to_owned();
    prefix.push('\\');
    candidate
        .get(..prefix.len())
        .is_some_and(|value| value.eq_ignore_ascii_case(&prefix))
}

fn canonical_paths_overlap(left: &str, right: &str) -> bool {
    canonical_path_is_same_or_inside(left, right) || canonical_path_is_same_or_inside(right, left)
}

fn canonical_path_is_strictly_inside(parent: &str, candidate: &str) -> bool {
    !parent.eq_ignore_ascii_case(candidate) && canonical_path_is_same_or_inside(parent, candidate)
}

fn canonicalize_policy_paths(values: &[String]) -> Result<Vec<String>> {
    let mut canonical = BTreeMap::new();
    for value in values {
        let target = inspect_acl_target(Path::new(value))
            .with_context(|| format!("validate Windows sandbox policy root {value}"))?;
        canonical
            .entry(target.canonical_path.to_ascii_lowercase())
            .or_insert(target.canonical_path);
    }
    Ok(canonical.into_values().collect())
}

fn canonical_policy_request(request: &RunRequest) -> Result<RunRequest> {
    let mut canonical = request.clone();
    canonical.allow_read = canonicalize_policy_paths(&request.allow_read)?;
    canonical.preinstalled_read_roots =
        canonicalize_policy_paths(&request.preinstalled_read_roots)?;
    canonical.allow_write = canonicalize_policy_paths(&request.allow_write)?;
    canonical.deny_read = canonicalize_policy_paths(&request.deny_read)?;
    canonical.deny_write = canonicalize_policy_paths(&request.deny_write)?;
    Ok(canonical)
}

fn validate_explicit_allows_do_not_override_inherited_denies(request: &RunRequest) -> Result<()> {
    for allowed in &request.allow_read {
        if let Some(denied) = request
            .deny_read
            .iter()
            .find(|denied| canonical_path_is_strictly_inside(denied, allowed))
        {
            bail!(
                "Windows sandbox allowRead root {allowed} is nested below denyRead root {denied}",
            );
        }
    }
    for allowed in &request.allow_write {
        if let Some(denied) = request
            .deny_write
            .iter()
            .find(|denied| canonical_path_is_strictly_inside(denied, allowed))
        {
            bail!(
                "Windows sandbox allowWrite root {allowed} is nested below denyWrite root {denied}",
            );
        }
    }
    Ok(())
}

#[cfg(test)]
fn move_file_write_through(source: &Path, destination: &Path) -> Result<()> {
    let source = source
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect::<Vec<_>>();
    let destination = destination
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect::<Vec<_>>();
    unsafe {
        MoveFileExW(
            PCWSTR(source.as_ptr()),
            PCWSTR(destination.as_ptr()),
            MOVEFILE_WRITE_THROUGH,
        )
    }
    .context("publish Windows execution deny receipt with write-through")
}

#[cfg(test)]
fn write_execution_deny_receipt(path: &Path, receipt: &ExecutionDenyReceipt) -> Result<()> {
    let payload = serde_json::to_vec(receipt).context("encode Windows execution deny receipt")?;
    ensure!(
        payload.len() <= MAX_EXECUTION_DENY_RECEIPT_BYTES as usize,
        "Windows execution deny receipt exceeded its bound",
    );
    let temporary = execution_deny_receipt_temporary_path(path);
    let result = (|| {
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temporary)
            .context("create Windows execution deny receipt")?;
        file.write_all(&payload)
            .context("write Windows execution deny receipt")?;
        file.sync_all()
            .context("flush Windows execution deny receipt")?;
        drop(file);
        move_file_write_through(&temporary, path)?;
        let published = read_execution_deny_receipt(path)
            .context("read back published Windows execution deny receipt")?;
        ensure!(
            published == *receipt,
            "published Windows execution deny receipt changed during publication",
        );
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result
}

#[cfg(test)]
fn execution_deny_receipt_temporary_path(path: &Path) -> PathBuf {
    path.with_extension(format!(
        "{}.{}.tmp",
        std::process::id(),
        uuid::Uuid::new_v4().simple()
    ))
}

fn read_execution_deny_receipt(path: &Path) -> Result<ExecutionDenyReceipt> {
    let mut file = OpenOptions::new()
        .read(true)
        // Receipts are immutable after their atomic CreateNew publication.
        // Readers must not serialize unrelated admissions or prevent the exact
        // owner/recovery path from retiring a receipt that is already open.
        .share_mode(FILE_SHARE_READ.0 | FILE_SHARE_DELETE.0)
        .custom_flags(windows::Win32::Storage::FileSystem::FILE_FLAG_OPEN_REPARSE_POINT.0)
        .open(path)
        .with_context(|| format!("open Windows execution deny receipt {}", path.display()))?;
    let metadata = file
        .metadata()
        .context("inspect opened Windows execution deny receipt")?;
    ensure!(
        metadata.is_file()
            && metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT.0 == 0
            && metadata.len() <= MAX_EXECUTION_DENY_RECEIPT_BYTES,
        "Windows execution deny receipt is not a bounded regular file",
    );
    let mut payload = Vec::with_capacity(metadata.len() as usize);
    file.read_to_end(&mut payload)
        .context("read Windows execution deny receipt")?;
    let receipt: ExecutionDenyReceipt =
        serde_json::from_slice(&payload).context("decode Windows execution deny receipt")?;
    ensure!(
        receipt.version == EXECUTION_DENY_RECEIPT_VERSION
            && receipt.runner_pid != 0
            && receipt.runner_creation_time != 0
            && !receipt.targets.is_empty()
            && receipt.targets.len() <= 4_096,
        "Windows execution deny receipt is invalid",
    );
    let _ = LocalSid::from_string(&receipt.logon_sid)?;
    for target in &receipt.targets {
        let expected_flags = if target.directory {
            (OBJECT_INHERIT_ACE | CONTAINER_INHERIT_ACE).0 as u8
        } else {
            0
        };
        ensure!(
            !target.canonical_path.is_empty()
                && target.deny_mask == READ_MASK
                && target.deny_flags == expected_flags,
            "Windows execution deny receipt target metadata is invalid",
        );
    }
    Ok(receipt)
}

fn read_execution_deny_receipt_if_present(path: &Path) -> Result<Option<ExecutionDenyReceipt>> {
    match read_execution_deny_receipt(path) {
        Ok(receipt) => Ok(Some(receipt)),
        Err(error)
            if error.chain().any(|cause| {
                cause
                    .downcast_ref::<std::io::Error>()
                    .is_some_and(|io_error| io_error.kind() == std::io::ErrorKind::NotFound)
            }) =>
        {
            Ok(None)
        }
        Err(error) => Err(error),
    }
}

fn open_execution_deny_targets(receipt: &ExecutionDenyReceipt) -> Result<Vec<AclTarget>> {
    let mut targets = Vec::with_capacity(receipt.targets.len());
    for expected in &receipt.targets {
        let target = open_acl_target(Path::new(&expected.canonical_path)).with_context(|| {
            format!(
                "Windows execution deny target identity could not be reopened: {}",
                expected.canonical_path,
            )
        })?;
        target.verify_execution_deny_identity(expected)?;
        targets.push(target);
    }
    Ok(targets)
}

fn cleanup_execution_denies(
    receipt_path: &Path,
    receipt: &ExecutionDenyReceipt,
    targets: &[AclTarget],
    operation_deadline_unix_ms: Option<u64>,
) -> Result<()> {
    ensure!(
        targets.len() == receipt.targets.len(),
        "Windows execution deny target identity set is incomplete",
    );
    for (target, expected) in targets.iter().zip(&receipt.targets) {
        if let Some(deadline) = operation_deadline_unix_ms {
            operation_deadline_timeout_ms(deadline, "denyRead cleanup commit")?;
        }
        target.verify_execution_deny_identity(expected)?;
        target.remove_execution_deny(&receipt.logon_sid, expected)?;
    }
    match fs::remove_file(receipt_path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error).with_context(|| {
            format!(
                "remove Windows execution deny receipt {}",
                receipt_path.display()
            )
        }),
    }
}

pub fn recover_stale_execution_denies_until(
    control_directory: &Path,
    operation_deadline_unix_ms: u64,
) -> Result<()> {
    let mut entries = match fs::read_dir(control_directory) {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(error).context("scan Windows execution deny receipts"),
    };
    let has_receipts = entries.try_fold(false, |found, entry| {
        let entry = entry.context("enumerate Windows execution deny receipt")?;
        let name = entry.file_name();
        let name = name
            .to_str()
            .ok_or_else(|| anyhow!("Windows execution deny receipt name is not Unicode"))?;
        Ok::<_, anyhow::Error>(
            found || (name.starts_with("windows-deny-") && name.ends_with(".json")),
        )
    })?;
    if !has_receipts {
        return Ok(());
    }
    for entry in fs::read_dir(control_directory).context("scan Windows execution deny receipts")? {
        operation_deadline_timeout_ms(operation_deadline_unix_ms, "stale denyRead recovery")?;
        let entry = entry.context("enumerate Windows execution deny receipt")?;
        let name = entry.file_name();
        let name = name
            .to_str()
            .ok_or_else(|| anyhow!("Windows execution deny receipt name is not Unicode"))?;
        if !name.starts_with("windows-deny-") || !name.ends_with(".json") {
            continue;
        }
        let receipt_path = entry.path();
        let Some(receipt) = read_execution_deny_receipt_if_present(&receipt_path)? else {
            continue;
        };
        if process_creation_time(receipt.runner_pid)? == Some(receipt.runner_creation_time) {
            continue;
        }
        let targets = open_execution_deny_targets(&receipt)?;
        operation_deadline_timeout_ms(
            operation_deadline_unix_ms,
            "stale denyRead recovery commit",
        )?;
        let cleanup = cleanup_execution_denies(
            &receipt_path,
            &receipt,
            &targets,
            Some(operation_deadline_unix_ms),
        );
        if let Err(error) = cleanup {
            match receipt_path.try_exists() {
                Ok(false) => {}
                Ok(true) => return Err(error),
                Err(probe_error) => {
                    return Err(anyhow!(
                        "stale denyRead cleanup failed: {error:#}; receipt completion could not be verified: {probe_error}"
                    ));
                }
            }
        }
    }
    Ok(())
}

pub fn recover_stale_execution_denies(control_directory: &Path) -> Result<()> {
    let deadline = u64::try_from(
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .context("read Windows sandbox recovery clock")?
            .as_millis(),
    )
    .context("convert Windows sandbox recovery clock")?
        + u64::from(PERSISTENT_DENY_SETUP_TIMEOUT_MS);
    recover_stale_execution_denies_until(control_directory, deadline)
}

fn verify_open_control_directory_boundary(control: &AclTarget, host_sid: &str) -> Result<()> {
    ensure!(
        control.directory,
        "Windows sandbox control state is not a directory"
    );
    {
        let raw = raw_dacl(control.handle.raw())?;
        let owner = sid_to_string(raw.owner)?;
        ensure!(
            owner.eq_ignore_ascii_case(host_sid),
            "Windows sandbox control directory is not host-owned"
        );
        let mut descriptor_control = 0u16;
        let mut revision = 0u32;
        unsafe {
            GetSecurityDescriptorControl(raw.descriptor, &mut descriptor_control, &mut revision)
                .context("read Windows sandbox control directory protection")?;
        }
        ensure!(
            descriptor_control & SE_DACL_PROTECTED.0 != 0,
            "Windows sandbox control directory DACL is not protected"
        );
        let ace_count = unsafe { (*raw.dacl).AceCount };
        ensure!(
            ace_count == 2,
            "Windows sandbox control directory DACL is not host/SYSTEM-only"
        );
    }
    let snapshot = control.read_aces()?;
    let inheritance = (OBJECT_INHERIT_ACE | CONTAINER_INHERIT_ACE).0 as u8;
    ensure!(
        snapshot.aces.len() == 2
            && snapshot.aces.iter().all(|ace| {
                ace.mode == AclMode::Grant
                    && (ace.sid.eq_ignore_ascii_case(host_sid) || ace.sid == "S-1-5-18")
                    && ace.mask == FILE_ALL_ACCESS.0
                    && ace.flags == inheritance
            })
            && snapshot
                .aces
                .iter()
                .filter(|ace| ace.sid.eq_ignore_ascii_case(host_sid))
                .count()
                == 1
            && snapshot
                .aces
                .iter()
                .filter(|ace| ace.sid == "S-1-5-18")
                .count()
                == 1,
        "Windows sandbox control directory DACL is not the exact host/SYSTEM boundary"
    );
    Ok(())
}

pub fn verify_setup_control_directory_boundary(
    control_directory: &Path,
    host_sid: &str,
) -> Result<()> {
    let control = open_acl_target(control_directory)
        .context("open protected Windows sandbox control directory")?;
    verify_open_control_directory_boundary(&control, host_sid)
}

pub fn verify_control_directory_boundary(
    request: &RunRequest,
    control_directory: &Path,
    host_sid: &str,
) -> Result<()> {
    let control = open_acl_target(control_directory)
        .context("open protected Windows sandbox control directory")?;
    verify_open_control_directory_boundary(&control, host_sid)?;
    let artifact_cache_directory = control_directory
        .parent()
        .context("protected Windows sandbox control directory has no artifact cache parent")?;
    let artifact_cache = open_acl_target(artifact_cache_directory)
        .context("open protected Windows native artifact cache directory")?;
    for policy_root in &request.allow_read {
        let target = open_acl_target(Path::new(policy_root))
            .with_context(|| format!("validate Windows sandbox read root {policy_root}"))?;
        ensure!(
            !canonical_path_is_same_or_inside(
                &artifact_cache.canonical_path,
                &target.canonical_path,
            ),
            "Windows sandbox allow policy overlaps protected native shell control state: {}",
            target.canonical_path,
        );
    }
    for policy_root in &request.allow_write {
        let target = open_acl_target(Path::new(policy_root))
            .with_context(|| format!("validate Windows sandbox write root {policy_root}"))?;
        ensure!(
            !canonical_paths_overlap(&artifact_cache.canonical_path, &target.canonical_path),
            "Windows sandbox write policy overlaps protected native shell control state: {}",
            target.canonical_path,
        );
    }
    for policy_root in request.deny_read.iter().chain(&request.deny_write) {
        let target = open_acl_target(Path::new(policy_root))
            .with_context(|| format!("validate Windows sandbox deny root {policy_root}"))?;
        ensure!(
            !canonical_path_is_same_or_inside(
                &artifact_cache.canonical_path,
                &target.canonical_path,
            ),
            "Windows sandbox deny policy targets protected native shell control state: {}",
            target.canonical_path,
        );
    }
    Ok(())
}

pub fn ensure_policy_aces_until(
    request: &RunRequest,
    runner_directory: &Path,
    operation_deadline_unix_ms: u64,
) -> Result<Vec<String>> {
    let canonical_request = canonical_policy_request(request)?;
    validate_explicit_allows_do_not_override_inherited_denies(&canonical_request)?;
    let host = current_token()?;
    let host_sid = token_user_sid(host.raw())?;
    let capability_generation = filesystem_capability_generation(&canonical_request);
    let setup_owned_roots = canonical_request
        .preinstalled_read_roots
        .iter()
        .map(|path| path.to_ascii_lowercase())
        .collect::<BTreeSet<_>>();
    ensure!(
        setup_owned_roots.iter().all(|path| canonical_request
            .allow_read
            .iter()
            .any(|allowed| allowed.eq_ignore_ascii_case(path))),
        "Windows sandbox preinstalledReadRoots must also be allowRead roots",
    );
    let (setup_owned_operations, mutable_operations): (Vec<_>, Vec<_>) =
        policy_operations(&canonical_request, runner_directory, &host_sid)
            .into_iter()
            .partition(|operation| {
                setup_owned_roots.contains(&operation.path.to_string_lossy().to_ascii_lowercase())
            });
    let mut capability_sids = BTreeSet::new();

    if !setup_owned_operations.is_empty() {
        let installed = satisfied_policy_capability_sids(
            setup_owned_operations,
            &capability_generation,
            &canonical_request.sandbox_user_sid,
        )?
        .ok_or_else(|| {
            anyhow::anyhow!(
                "[windows_v2_setup_required] A setup-owned Windows sandbox read capability is missing; run \"kodax sandbox setup\""
            )
        })?;
        capability_sids.extend(installed);
    }

    if !mutable_operations.is_empty() {
        let mutable_capability_sids = match satisfied_policy_capability_sids(
            mutable_operations.clone(),
            &capability_generation,
            &canonical_request.sandbox_user_sid,
        )? {
            Some(sids) => sids,
            None => apply_operations(
                mutable_operations,
                &capability_generation,
                &canonical_request.sandbox_user_sid,
                operation_deadline_unix_ms,
            )?,
        };
        capability_sids.extend(mutable_capability_sids);
    }

    let mut capability_sids = capability_sids.into_iter().collect::<Vec<_>>();
    capability_sids
        .retain(|sid| !sid.eq_ignore_ascii_case(&canonical_request.policy_capability_sid));
    Ok(capability_sids)
}

#[cfg(test)]
fn ensure_policy_aces(request: &RunRequest, runner_directory: &Path) -> Result<Vec<String>> {
    ensure_policy_aces_until(request, runner_directory, test_operation_deadline_unix_ms())
}

#[cfg(test)]
mod tests {
    use std::fs;
    use std::time::{SystemTime, UNIX_EPOCH};

    use super::*;
    use crate::model::capability_sid;

    #[test]
    fn split_object_and_container_inheritance_does_not_prove_recursive_access() {
        let sid = "S-1-5-21-1-2-3-9999";
        let snapshot = AceSnapshot {
            directory: true,
            aces: vec![
                ObservedAce {
                    index: 0,
                    mode: AclMode::Grant,
                    sid: sid.into(),
                    mask: READ_EXECUTE_MASK,
                    flags: 0,
                },
                ObservedAce {
                    index: 1,
                    mode: AclMode::Grant,
                    sid: sid.into(),
                    mask: READ_EXECUTE_MASK,
                    flags: OBJECT_INHERIT_ACE.0 as u8,
                },
                ObservedAce {
                    index: 2,
                    mode: AclMode::Grant,
                    sid: sid.into(),
                    mask: READ_EXECUTE_MASK,
                    flags: CONTAINER_INHERIT_ACE.0 as u8,
                },
            ],
        };

        assert!(!snapshot.satisfies(
            &RequiredAce::new(
                AclMode::Grant,
                sid,
                READ_EXECUTE_MASK,
                true,
                AccessPass::Restricted,
            ),
            sid,
        ));
    }

    #[test]
    fn canonical_control_path_overlap_is_bidirectional_and_component_bounded() {
        assert!(canonical_paths_overlap(
            r"C:\Users\host\AppData\Local\KodaXNativeArtifactsV3\control-v1",
            r"c:\users\HOST\AppData\Local\KodaXNativeArtifactsV3",
        ));
        assert!(canonical_paths_overlap(
            r"C:\Users\host\AppData\Local\KodaXNativeArtifactsV3\control-v1",
            r"C:\Users\host\AppData\Local\KodaXNativeArtifactsV3\control-v1\request.json",
        ));
        assert!(!canonical_paths_overlap(
            r"C:\state\control-v1",
            r"C:\state\control-v10",
        ));
    }

    #[test]
    fn nested_allows_cannot_override_inherited_denies() {
        let root = temporary_directory("nested-deny");
        let child = root.join("child");
        fs::create_dir(&child).unwrap();

        let mut read_request = request(&root);
        read_request.allow_read = vec![child.to_string_lossy().into_owned()];
        read_request.allow_write.clear();
        read_request.deny_read = vec![root.to_string_lossy().into_owned()];
        read_request.deny_write.clear();
        assert!(
            ensure_policy_aces(&read_request, &root)
                .unwrap_err()
                .to_string()
                .contains("nested below denyRead")
        );

        let mut write_request = request(&root);
        write_request.allow_read.clear();
        write_request.allow_write = vec![child.to_string_lossy().into_owned()];
        write_request.deny_read.clear();
        write_request.deny_write = vec![root.to_string_lossy().into_owned()];
        assert!(
            ensure_policy_aces(&write_request, &root)
                .unwrap_err()
                .to_string()
                .contains("nested below denyWrite")
        );

        fs::remove_dir_all(root).unwrap();
    }

    fn request(root: &Path) -> RunRequest {
        let fingerprint = "0".repeat(64);
        RunRequest {
            protocol: crate::protocol::PROTOCOL_VERSION,
            generation: "generation".into(),
            filesystem_capability_nonce: "00000000-0000-4000-8000-000000000003".into(),
            sandbox_user_sid: "S-1-5-21-1-2-3-9999".into(),
            sandbox_group_sid: "S-1-5-21-1-2-3-9998".into(),
            asrt_executable: "srt-win.exe".into(),
            asrt_prefix_args: vec!["exec".into(), "--".into()],
            target_argv: vec!["cmd.exe".into()],
            cwd: root.to_string_lossy().into_owned(),
            policy_fingerprint: fingerprint.clone(),
            policy_capability_sid: capability_sid(&fingerprint).unwrap(),
            allow_read: vec![root.to_string_lossy().into_owned()],
            preinstalled_read_roots: vec![],
            allow_write: vec![root.to_string_lossy().into_owned()],
            deny_read: vec![],
            deny_write: vec![root.to_string_lossy().into_owned()],
            controller_pipe: r"\\.\pipe\kodax-v2-1234-12345678-1234-1234-1234-123456789abc".into(),
            terminal_record_path: root.join("terminal.json").to_string_lossy().into_owned(),
            terminal_nonce: "12345678-1234-1234-1234-123456789abc".into(),
            operation_deadline_unix_ms: 1,
            setup_marker_path: r"C:\control\windows-v2-cutover.json".into(),
            setup_marker_sha256: "0".repeat(64),
        }
    }

    fn temporary_directory(label: &str) -> PathBuf {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let base = std::env::var_os("KODAX_NATIVE_TEST_TEMP")
            .map(PathBuf::from)
            .unwrap_or_else(std::env::temp_dir);
        fs::create_dir_all(&base).unwrap();
        let path = base.join(format!(
            "kodax-windows-sandbox-v2-{label}-{}-{nonce}",
            std::process::id(),
        ));
        fs::create_dir(&path).unwrap();
        path
    }

    #[test]
    fn persistent_deny_read_is_additive_idempotent_and_verified_from_the_dacl() {
        let root = temporary_directory("persistent-deny");
        let paths = vec![root.to_string_lossy().into_owned()];
        let user_sid = "S-1-5-21-1-2-3-9998";
        let group_sid = "S-1-5-21-1-2-3-9997";

        assert_eq!(
            verify_persistent_deny_read(&paths, group_sid).unwrap(),
            paths,
        );
        ensure_persistent_deny_read(&paths, user_sid, group_sid).unwrap();
        ensure_persistent_deny_read(&paths, user_sid, group_sid).unwrap();

        assert!(
            verify_persistent_deny_read(&paths, group_sid)
                .unwrap()
                .is_empty()
        );
        let target = inspect_acl_target(&root).unwrap();
        assert_eq!(
            target
                .read_aces()
                .unwrap()
                .aces
                .iter()
                .filter(|ace| {
                    ace.mode == AclMode::Deny
                        && ace.sid == group_sid
                        && ace.flags & INHERITED_ACE.0 as u8 == 0
                })
                .count(),
            1,
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn persistent_deny_read_removal_is_exact_idempotent_and_reconciles_reinstallation() {
        let root = temporary_directory("persistent-deny-remove");
        let child = root.join("existing-child");
        fs::create_dir(&child).unwrap();
        let paths = vec![root.to_string_lossy().into_owned()];
        let user_sid = "S-1-5-21-1-2-3-9998";
        let legacy_group_sid = "S-1-5-21-1-2-3-9997";
        let unrelated_group_sid = "S-1-5-21-1-2-3-9996";

        ensure_persistent_deny_read(&paths, user_sid, legacy_group_sid).unwrap();
        ensure_persistent_deny_read(&paths, user_sid, unrelated_group_sid).unwrap();
        remove_persistent_deny_read(&paths, legacy_group_sid).unwrap();
        remove_persistent_deny_read(&paths, legacy_group_sid).unwrap();

        // A concurrently running pre-upgrade KodaX can reinstall this exact
        // legacy ACE after an upgraded process removed it. The next admission
        // must be able to perform the same precise cleanup again.
        ensure_persistent_deny_read(&paths, user_sid, legacy_group_sid).unwrap();
        assert!(
            verify_persistent_deny_read(&paths, legacy_group_sid)
                .unwrap()
                .is_empty()
        );
        remove_persistent_deny_read(&paths, legacy_group_sid).unwrap();

        assert_eq!(
            verify_persistent_deny_read(&paths, legacy_group_sid).unwrap(),
            paths,
        );
        assert!(
            verify_persistent_deny_read(&paths, unrelated_group_sid)
                .unwrap()
                .is_empty()
        );
        let child_aces = inspect_acl_target(&child).unwrap().read_aces().unwrap();
        assert!(!child_aces.aces.iter().any(|ace| {
            ace.mode == AclMode::Deny
                && ace.sid.eq_ignore_ascii_case(legacy_group_sid)
                && ace.mask == READ_MASK
        }));
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn acl_plan_is_root_only_and_policy_scoped() {
        let root = temporary_directory("plan");
        let request = request(&root);
        let host = current_token().unwrap();
        let host_sid = token_user_sid(host.raw()).unwrap();
        let operations = policy_operations(&request, &root, &host_sid);
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
                && operation.trustee
                    == PlannedTrustee::FilesystemCapability(FilesystemCapabilityKind::AllowWrite)
                && operation.mask == MODIFY_MASK
        }));
        assert!(operations.iter().any(|operation| {
            operation.mode == AclMode::Grant
                && operation.trustee
                    == PlannedTrustee::FilesystemCapability(FilesystemCapabilityKind::AllowRead)
                && operation.mask == READ_EXECUTE_MASK
        }));
        assert!(!operations.iter().any(|operation| {
            operation.mode == AclMode::Deny
                && operation.trustee == PlannedTrustee::Sid(request.policy_capability_sid.clone())
                && operation.mask == READ_MASK
        }));
        assert!(operations.iter().any(|operation| {
            operation.mode == AclMode::Deny
                && operation.trustee
                    == PlannedTrustee::FilesystemCapability(FilesystemCapabilityKind::DenyWrite)
                && operation.mask == DENY_WRITE_MASK
        }));
        assert_eq!(
            operations
                .iter()
                .filter(|operation| {
                    operation.mode == AclMode::Grant
                        && operation.trustee
                            == PlannedTrustee::Sid(request.sandbox_group_sid.clone())
                        && operation
                            .path
                            .to_string_lossy()
                            .eq_ignore_ascii_case(&root.to_string_lossy())
                        && operation.mask == MODIFY_MASK
                })
                .count(),
            1,
        );
        assert_eq!(
            operations
                .iter()
                .filter(|operation| {
                    operation.mode == AclMode::Grant
                        && operation.trustee
                            == PlannedTrustee::Sid(request.sandbox_group_sid.clone())
                        && operation.mask == READ_EXECUTE_MASK
                })
                .count(),
            0,
        );
        assert_eq!(operations.len(), 4);
        assert!(operations.iter().all(|operation| operation.path == root));
        fs::remove_dir_all(root).unwrap();
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
        let capability_sids = ensure_policy_aces(&request, &root).unwrap();
        assert_eq!(
            ensure_policy_aces(&request, &root).unwrap(),
            capability_sids,
        );
        let canonical_root = open_acl_target(&root).unwrap().canonical_path;
        let capability_generation = filesystem_capability_generation(&request);
        let allow_write_sid = filesystem_capability_sid(
            &capability_generation,
            &canonical_root,
            FilesystemCapabilityKind::AllowWrite,
        )
        .unwrap();
        let deny_write_sid = filesystem_capability_sid(
            &capability_generation,
            &canonical_root,
            FilesystemCapabilityKind::DenyWrite,
        )
        .unwrap();
        let mut expected_capability_sids = vec![allow_write_sid.clone(), deny_write_sid.clone()];
        expected_capability_sids.sort();
        assert_eq!(capability_sids, expected_capability_sids);

        let target = open_acl_target(&root).unwrap();
        let before_denies = target.read_aces().unwrap();
        assert!(before_denies.satisfies(
            &RequiredAce::new(
                AclMode::Grant,
                &request.sandbox_group_sid,
                MODIFY_MASK,
                true,
                AccessPass::Normal,
            ),
            &request.sandbox_user_sid,
        ));
        assert!(before_denies.has_explicit(AclMode::Grant, &allow_write_sid, MODIFY_MASK, true,));
        assert_eq!(
            before_denies
                .aces
                .iter()
                .filter(|ace| {
                    ace.mode == AclMode::Grant
                        && ace.sid == allow_write_sid
                        && ace.flags & INHERITED_ACE.0 as u8 == 0
                })
                .count(),
            1,
            "idempotent append must not grow duplicate capability ACEs",
        );

        let after_denies = target.read_aces().unwrap();
        assert!(after_denies.has_explicit(AclMode::Deny, &deny_write_sid, DENY_WRITE_MASK, true,));
        assert!(after_denies.required_aces_are_canonical(
            &[
                RequiredAce::new(
                    AclMode::Deny,
                    &deny_write_sid,
                    DENY_WRITE_MASK,
                    true,
                    AccessPass::Restricted,
                ),
                RequiredAce::new(
                    AclMode::Grant,
                    &request.sandbox_group_sid,
                    MODIFY_MASK,
                    true,
                    AccessPass::Normal,
                ),
                RequiredAce::new(
                    AclMode::Grant,
                    &allow_write_sid,
                    MODIFY_MASK,
                    true,
                    AccessPass::Restricted,
                ),
            ],
            &request.sandbox_user_sid,
        ));

        drop(target);
        fs::remove_dir(root).unwrap();
    }

    #[test]
    fn concurrent_read_and_write_policies_preserve_the_write_capability() {
        let root = temporary_directory("cold-heterogeneous-policy");
        let mut read_request = request(&root);
        read_request.allow_write.clear();
        read_request.deny_read.clear();
        read_request.deny_write.clear();
        let mut write_request = request(&root);
        write_request.allow_read.clear();
        write_request.deny_read.clear();
        write_request.deny_write.clear();

        let (read_result, write_result) = std::thread::scope(|scope| {
            let read = scope.spawn(|| ensure_policy_aces(&read_request, &root));
            let write = scope.spawn(|| ensure_policy_aces(&write_request, &root));
            (read.join().unwrap(), write.join().unwrap())
        });
        assert!(read_result.is_ok(), "read policy failed: {read_result:?}");
        assert!(
            write_result.is_ok(),
            "write policy failed: {write_result:?}"
        );

        let generation = filesystem_capability_generation(&write_request);
        let host = current_token().unwrap();
        let host_sid = token_user_sid(host.raw()).unwrap();
        assert!(
            satisfied_policy_capability_sids(
                policy_operations(&write_request, &root, &host_sid),
                &generation,
                &write_request.sandbox_user_sid,
            )
            .unwrap()
            .is_some(),
            "concurrent read policy replaced the write capability",
        );
        fs::remove_dir(root).unwrap();
    }

    #[test]
    fn read_and_write_policies_share_one_persistent_root_acl() {
        let root = temporary_directory("stable-heterogeneous-policy");
        let mut read_request = request(&root);
        read_request.allow_write.clear();
        read_request.deny_write.clear();
        let mut write_request = request(&root);
        write_request.allow_read.clear();
        write_request.deny_write.clear();
        let generation = filesystem_capability_generation(&read_request);
        let host = current_token().unwrap();
        let host_sid = token_user_sid(host.raw()).unwrap();

        let inspect = |request: &RunRequest| {
            let groups = open_grouped_operations(
                policy_operations(request, &root, &host_sid),
                &generation,
                &request.sandbox_user_sid,
            )
            .unwrap();
            assert_eq!(groups.len(), 1);
            let operations = &groups[0].1;
            let persistent = operations
                .iter()
                .map(|operation| {
                    (
                        match operation.mode {
                            AclMode::Deny => 0,
                            AclMode::Grant => 1,
                        },
                        operation.sid.clone(),
                        operation.mask,
                        operation.inherit,
                        match operation.pass {
                            AccessPass::Normal => 0,
                            AccessPass::Restricted => 1,
                        },
                    )
                })
                .collect::<Vec<_>>();
            let active = operations
                .iter()
                .filter(|operation| operation.active_in_token)
                .map(|operation| operation.sid.clone())
                .collect::<Vec<_>>();
            (persistent, active)
        };

        let (read_persistent, read_active) = inspect(&read_request);
        let (write_persistent, write_active) = inspect(&write_request);
        assert_eq!(read_persistent, write_persistent);
        assert_eq!(read_active.len(), 2);
        assert_eq!(write_active.len(), 1);
        assert!(read_active.iter().all(|sid| !write_active.contains(sid)));

        fs::remove_dir(root).unwrap();
    }

    #[test]
    fn cold_policy_skips_the_already_satisfied_shared_root() {
        let common = temporary_directory("cold-partial-common");
        let fresh = temporary_directory("cold-partial-fresh");
        let mut warm = request(&common);
        warm.deny_read.clear();
        warm.deny_write.clear();
        ensure_policy_aces(&warm, &common).unwrap();

        let mut cold = warm.clone();
        cold.cwd = fresh.to_string_lossy().into_owned();
        cold.allow_read.push(fresh.to_string_lossy().into_owned());
        cold.allow_write.push(fresh.to_string_lossy().into_owned());
        let deadline = u64::try_from(
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_millis(),
        )
        .unwrap()
            + 500;

        let result = std::thread::scope(|scope| {
            scope
                .spawn(|| ensure_policy_aces_until(&cold, &fresh, deadline))
                .join()
                .unwrap()
        });
        assert!(
            result.is_ok(),
            "cold admission waited on an already-satisfied shared root: {result:?}",
        );
        fs::remove_dir(common).unwrap();
        fs::remove_dir(fresh).unwrap();
    }

    #[test]
    fn warm_read_only_roots_are_not_acl_transaction_targets() {
        let readable = temporary_directory("read-policy-only");
        let writable = temporary_directory("read-policy-write-root");
        let mut request = request(&writable);
        request.allow_read = vec![readable.to_string_lossy().into_owned()];
        request.allow_write = vec![writable.to_string_lossy().into_owned()];
        request.deny_read.clear();
        request.deny_write.clear();
        ensure_setup_acl_roots(
            &request.allow_read,
            &[],
            &request.sandbox_group_sid,
            &request.filesystem_capability_nonce,
        )
        .unwrap();

        let readable_target = open_acl_target(&readable).unwrap();
        let before = readable_target.read_aces().unwrap().aces;
        let deadline = u64::try_from(
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_millis(),
        )
        .unwrap()
            + 500;

        let result = std::thread::scope(|scope| {
            scope
                .spawn(|| ensure_policy_aces_until(&request, &writable, deadline))
                .join()
                .unwrap()
        });
        assert!(
            result.is_ok(),
            "read-only policy root entered ACL admission: {result:?}",
        );
        assert_eq!(
            open_acl_target(&readable)
                .unwrap()
                .read_aces()
                .unwrap()
                .aces,
            before,
            "read-only policy root ACL changed during admission",
        );
        fs::remove_dir(readable).unwrap();
        fs::remove_dir(writable).unwrap();
    }

    #[test]
    fn setup_owned_read_root_is_verify_only_during_admission() {
        let root = temporary_directory("setup-owned-read-root");
        let root_text = root.to_string_lossy().into_owned();
        let mut request = request(&root);
        request.allow_read = vec![root_text.clone()];
        request.preinstalled_read_roots = vec![root_text.clone()];
        request.allow_write.clear();
        request.deny_read.clear();
        request.deny_write.clear();

        let before = open_acl_target(&root).unwrap().read_aces().unwrap().aces;
        let missing = ensure_policy_aces(&request, &root);
        let after_missing = open_acl_target(&root).unwrap().read_aces().unwrap().aces;
        if missing.is_err() && before == after_missing {
            ensure_setup_acl_roots(
                &request.allow_read,
                &[],
                &request.sandbox_group_sid,
                &request.filesystem_capability_nonce,
            )
            .unwrap();
            let installed = open_acl_target(&root).unwrap().read_aces().unwrap().aces;
            for _ in 0..100 {
                let capabilities = ensure_policy_aces(&request, &root).unwrap();
                assert_eq!(capabilities.len(), 2);
            }
            let after_admission = open_acl_target(&root).unwrap().read_aces().unwrap().aces;
            assert_eq!(after_admission, installed);
        }
        fs::remove_dir_all(&root).unwrap();

        let diagnostic = format!("{:#}", missing.unwrap_err());
        assert!(diagnostic.contains("[windows_v2_setup_required]"));
        assert_eq!(after_missing, before);
    }

    #[test]
    fn setup_acl_authorization_obeys_an_expired_overall_deadline() {
        let root = temporary_directory("setup-acl-deadline");
        let deadline = u64::try_from(
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_millis(),
        )
        .unwrap()
        .saturating_sub(1);
        let root_text = root.to_string_lossy().into_owned();
        let started = std::time::Instant::now();
        let result = std::thread::scope(|scope| {
            scope
                .spawn(|| {
                    ensure_setup_acl_roots_until(
                        &[root_text],
                        &[],
                        "S-1-5-21-1-2-3-9998",
                        "00000000-0000-4000-8000-000000000003",
                        deadline,
                    )
                })
                .join()
                .unwrap()
        });
        let diagnostic = format!("{:#}", result.unwrap_err());
        assert!(diagnostic.contains("deadline expired"));
        assert!(started.elapsed() < std::time::Duration::from_secs(1));
        fs::remove_dir(root).unwrap();
    }

    #[test]
    fn filesystem_capability_generation_is_independent_of_protocol_and_account() {
        let root = temporary_directory("capability-schema");
        let mut request = request(&root);
        let current = filesystem_capability_generation(&request);
        request.protocol = request.protocol.saturating_add(1);
        request.sandbox_user_sid = "S-1-5-21-4-5-6-9999".into();
        request.sandbox_group_sid = "S-1-5-32-545".into();

        assert_eq!(filesystem_capability_generation(&request), current);
        request.filesystem_capability_nonce = "00000000-0000-4000-8000-000000000004".into();
        assert_ne!(filesystem_capability_generation(&request), current);
        fs::remove_dir(root).unwrap();
    }

    #[test]
    fn native_rebuild_reuses_the_installed_accounts_filesystem_capabilities() {
        let root = temporary_directory("stable-account-capabilities");
        let mut request = request(&root);
        request.generation = "trusted-artifacts-a".into();
        let first = ensure_policy_aces(&request, &root).unwrap();

        request.generation = "trusted-artifacts-b".into();
        let second = ensure_policy_aces(&request, &root).unwrap();

        request.sandbox_group_sid = "S-1-5-32-545".into();
        let rotated_account = ensure_policy_aces(&request, &root).unwrap();

        fs::remove_dir(root).unwrap();
        assert_eq!(second, first);
        assert_eq!(rotated_account, first);
    }

    #[test]
    fn disappearing_enumerated_execution_receipt_is_already_converged() {
        let root = temporary_directory("execution-deny-enumeration-race");
        let missing = root.join("windows-deny-gone.json");

        assert!(
            read_execution_deny_receipt_if_present(&missing)
                .unwrap()
                .is_none()
        );

        fs::remove_dir(root).unwrap();
    }

    #[test]
    fn execution_receipt_staging_names_the_native_writer_process() {
        let root = temporary_directory("execution-deny-staging-writer");
        let receipt = root.join("windows-deny-receipt.json");
        let temporary = execution_deny_receipt_temporary_path(&receipt);
        let suffix = temporary.file_name().unwrap().to_string_lossy();

        assert!(suffix.contains(&format!(".{}.", std::process::id())));
        assert!(suffix.ends_with(".tmp"));

        fs::remove_dir(root).unwrap();
    }

    #[test]
    fn opened_execution_receipt_does_not_block_exact_owner_retirement() {
        let root = temporary_directory("execution-deny-shared-reader");
        let receipt_path = root.join("windows-deny-shared.json");
        let receipt = ExecutionDenyReceipt {
            version: EXECUTION_DENY_RECEIPT_VERSION,
            runner_pid: std::process::id(),
            runner_creation_time: process_creation_time(std::process::id())
                .unwrap()
                .expect("current native process has a creation time"),
            logon_sid: "S-1-5-5-72334-94556".into(),
            targets: vec![ExecutionDenyTargetReceipt {
                canonical_path: root.to_string_lossy().into_owned(),
                volume_serial: 1,
                file_id: [7; 16],
                directory: true,
                deny_mask: READ_MASK,
                deny_flags: (OBJECT_INHERIT_ACE | CONTAINER_INHERIT_ACE).0 as u8,
            }],
        };
        write_execution_deny_receipt(&receipt_path, &receipt).unwrap();

        let mut reader = OpenOptions::new()
            .read(true)
            .share_mode(FILE_SHARE_READ.0 | FILE_SHARE_DELETE.0)
            .open(&receipt_path)
            .unwrap();
        fs::remove_file(&receipt_path).unwrap();
        let mut payload = Vec::new();
        reader.read_to_end(&mut payload).unwrap();
        assert_eq!(
            serde_json::from_slice::<ExecutionDenyReceipt>(&payload).unwrap(),
            receipt,
        );
        assert!(!receipt_path.exists());

        drop(reader);
        fs::remove_dir(root).unwrap();
    }

    fn write_stale_legacy_execution_receipt(
        control_directory: &Path,
        denied: &Path,
        logon_sid: &str,
    ) -> PathBuf {
        let target = open_acl_target(denied).unwrap();
        target
            .apply_and_verify(
                &[AclOperation {
                    mode: AclMode::Deny,
                    path: denied.to_path_buf(),
                    mask: READ_MASK,
                    sid: logon_sid.to_owned(),
                    inherit: true,
                    pass: AccessPass::Normal,
                    active_in_token: false,
                }],
                "S-1-5-21-1-2-3-9999",
            )
            .unwrap();
        let receipt = ExecutionDenyReceipt {
            version: EXECUTION_DENY_RECEIPT_VERSION,
            runner_pid: std::process::id(),
            runner_creation_time: 1,
            logon_sid: logon_sid.to_owned(),
            targets: vec![target.execution_deny_receipt()],
        };
        let receipt_path = control_directory.join("windows-deny-legacy.json");
        write_execution_deny_receipt(&receipt_path, &receipt).unwrap();
        receipt_path
    }

    #[test]
    fn setup_recovery_removes_a_pre_cutover_execution_deny() {
        let root = temporary_directory("execution-deny-legacy-recovery");
        let denied = root.join("denied");
        fs::create_dir(&denied).unwrap();
        let logon_sid = "S-1-5-5-62334-84556";
        let receipt_path = write_stale_legacy_execution_receipt(&root, &denied, logon_sid);

        recover_stale_execution_denies(&root).unwrap();

        assert!(!receipt_path.exists());
        assert_eq!(
            open_acl_target(&denied)
                .unwrap()
                .read_aces()
                .unwrap()
                .exact_execution_deny_count(logon_sid),
            0,
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn stale_execution_receipt_stays_fail_closed_when_its_original_path_is_gone() {
        let root = temporary_directory("execution-deny-missing");
        let denied = root.join("denied");
        fs::create_dir(&denied).unwrap();
        let receipt_path =
            write_stale_legacy_execution_receipt(&root, &denied, "S-1-5-5-22334-44556");
        fs::remove_dir(&denied).unwrap();

        let error = recover_stale_execution_denies(&root).unwrap_err();
        assert!(
            format!("{error:#}").contains("identity"),
            "missing recovery identity error: {error:#}",
        );
        assert!(receipt_path.exists());
        fs::remove_file(receipt_path).unwrap();
        fs::remove_dir(root).unwrap();
    }

    #[test]
    fn stale_execution_receipt_stays_fail_closed_when_path_is_replaced() {
        let root = temporary_directory("execution-deny-replaced");
        let denied = root.join("denied");
        let moved = root.join("moved");
        fs::create_dir(&denied).unwrap();
        let receipt_path =
            write_stale_legacy_execution_receipt(&root, &denied, "S-1-5-5-33445-55667");
        fs::rename(&denied, &moved).unwrap();
        fs::create_dir(&denied).unwrap();

        let error = recover_stale_execution_denies(&root).unwrap_err();
        assert!(
            format!("{error:#}").contains("identity changed"),
            "missing replaced-target identity error: {error:#}",
        );
        assert!(receipt_path.exists());

        fs::remove_file(receipt_path).unwrap();
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn read_only_policy_uses_read_and_deny_write_capabilities() {
        let root = temporary_directory("read-only-capability");
        let mut request = request(&root);
        request.allow_write.clear();
        request.deny_read.clear();
        request.deny_write.clear();

        let capabilities = ensure_policy_aces(&request, &root).unwrap();
        assert_eq!(capabilities.len(), 2);
        let target = open_acl_target(&root).unwrap();
        let generation = filesystem_capability_generation(&request);
        assert!(
            capabilities.contains(
                &filesystem_capability_sid(
                    &generation,
                    &target.canonical_path,
                    FilesystemCapabilityKind::AllowRead,
                )
                .unwrap()
            )
        );
        assert!(
            capabilities.contains(
                &filesystem_capability_sid(
                    &generation,
                    &target.canonical_path,
                    FilesystemCapabilityKind::DenyWrite,
                )
                .unwrap()
            )
        );
        assert!(target.read_aces().unwrap().satisfies(
            &RequiredAce::new(
                AclMode::Grant,
                &request.sandbox_group_sid,
                READ_EXECUTE_MASK,
                true,
                AccessPass::Normal,
            ),
            &request.sandbox_user_sid,
        ));

        drop(target);
        fs::remove_dir(root).unwrap();
    }

    #[test]
    fn ordinary_policy_plan_never_encodes_unsupported_deny_read() {
        let root = temporary_directory("deny-read-policy-capability");
        let mut request = request(&root);
        request.deny_read = vec![root.to_string_lossy().into_owned()];
        let host = current_token().unwrap();
        let host_sid = token_user_sid(host.raw()).unwrap();

        assert!(
            policy_operations(&request, &root, &host_sid)
                .iter()
                .all(|operation| {
                    operation.mode != AclMode::Deny
                        || operation.trustee
                            != PlannedTrustee::Sid(request.policy_capability_sid.clone())
                })
        );

        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn legacy_shared_account_write_ace_does_not_block_exact_capability_installation() {
        let root = temporary_directory("legacy-user-ace");
        let request = request(&root);
        let target = open_acl_target(&root).unwrap();
        target
            .apply_and_verify(
                &[AclOperation {
                    mode: AclMode::Grant,
                    path: root.clone(),
                    mask: MODIFY_MASK,
                    sid: request.sandbox_user_sid.clone(),
                    inherit: true,
                    pass: AccessPass::Normal,
                    active_in_token: false,
                }],
                &request.sandbox_user_sid,
            )
            .unwrap();

        let capabilities = ensure_policy_aces(&request, &root).unwrap();
        let canonical_root = target.canonical_path.clone();
        let capability_generation = filesystem_capability_generation(&request);
        let allow_write_sid = filesystem_capability_sid(
            &capability_generation,
            &canonical_root,
            FilesystemCapabilityKind::AllowWrite,
        )
        .unwrap();
        assert!(capabilities.contains(&allow_write_sid));
        let after = target.read_aces().unwrap();
        assert!(after.has_explicit(AclMode::Grant, &allow_write_sid, MODIFY_MASK, true,));

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

        assert!(ensure_policy_aces(&request, &root).is_err());
        let target = open_acl_target(&valid).unwrap();
        assert!(!target.read_aces().unwrap().has_explicit(
            AclMode::Grant,
            &request.sandbox_group_sid,
            MODIFY_MASK,
            true,
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
