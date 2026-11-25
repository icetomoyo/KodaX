//! Protected native artifact cache writer. Replaces the PowerShell provision and
//! control scripts: a script host that decodes an executable into LocalAppData
//! is exactly what antivirus behavior rules quarantine, and the published image
//! then vanishes before KodaX can verify it.
//!
//! Every cache component is created by NtCreateFile with its final protected
//! DACL and OBJ_DONT_REPARSE, so no path-based ACL mutation or reparse point is
//! ever followed. Existing components are verified, never repaired.

use std::collections::BTreeSet;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::ptr::null;
use std::time::{Duration, SystemTime};

use anyhow::{Context, Result, anyhow, bail, ensure};
use base64::{Engine as _, engine::general_purpose::STANDARD};
use serde::Deserialize;
use sha2::{Digest, Sha256};
use windows::Win32::Foundation::NTSTATUS;
use windows::Win32::Security::{
    CONTAINER_INHERIT_ACE, DACL_SECURITY_INFORMATION, GetSecurityDescriptorControl, INHERITED_ACE,
    OBJECT_INHERIT_ACE, PROTECTED_DACL_SECURITY_INFORMATION, SE_DACL_PROTECTED,
    SetKernelObjectSecurity,
};
use windows::Win32::Storage::FileSystem::{
    DELETE, FILE_GENERIC_WRITE, FILE_LIST_DIRECTORY, FILE_READ_ATTRIBUTES, FILE_READ_DATA,
    FILE_SHARE_DELETE, FILE_SHARE_READ, FILE_SHARE_WRITE, MOVEFILE_WRITE_THROUGH, MoveFileExW,
    READ_CONTROL, SYNCHRONIZE, WRITE_DAC,
};
use windows::core::PCWSTR;

use crate::acl::{
    AclMode, AclTarget, FILE_CREATE, FILE_DIRECTORY_FILE, FILE_NON_DIRECTORY_FILE,
    FILE_WRITE_THROUGH, STATUS_OBJECT_NAME_COLLISION, STATUS_OBJECT_NAME_NOT_FOUND,
    STATUS_OBJECT_PATH_NOT_FOUND, inspect_opened_acl_target, nt_create_file, raw_dacl,
    validate_acl_path, verify_open_control_directory_boundary,
};
use crate::win::{LocalSecurityDescriptor, LocalSid, current_token, sid_to_string, token_user_sid, wide};

const FILE_OPEN: u32 = 1;
const MAX_PROVISION_PAYLOAD_BYTES: u64 = 90_000_000;
const MAX_ARTIFACT_BYTES: usize = 64 * 1024 * 1024;
const MAX_CONTROL_REQUEST_BYTES: u64 = 64 * 1024;
const MAX_CONTROL_ENTRY_BYTES: u64 = 1024 * 1024;
const SYSTEM_SID: &str = "S-1-5-18";
const USERS_SID: &str = "S-1-5-32-545";
const FULL_CONTROL: u32 = 0x001F_01FF;
// ReadAndExecute plus Synchronize, the mask .NET writes for an Allow rule.
const READ_EXECUTE: u32 = 0x0012_00A9;
const STATUS_VIRUS_INFECTED: NTSTATUS = NTSTATUS(0xC000_0906_u32 as i32);
const STATUS_VIRUS_DELETED: NTSTATUS = NTSTATUS(0xC000_0907_u32 as i32);
const ERROR_FILE_NOT_FOUND: i32 = 2;
const ERROR_VIRUS_INFECTED: i32 = 225;
const ERROR_VIRUS_DELETED: i32 = 226;
const SHARE_ALL: u32 = FILE_SHARE_READ.0 | FILE_SHARE_WRITE.0 | FILE_SHARE_DELETE.0;

/// Exit code for an image that this process wrote and verified the inputs of,
/// but that disappeared or became unreadable before publication completed.
pub const ARTIFACT_REMOVED_EXIT_CODE: u32 = 3;

/// The image this process wrote was removed or blocked by another party,
/// almost always real-time antivirus. Retrying reproduces it.
#[derive(Debug)]
pub struct ArtifactRemoved(String);

impl std::fmt::Display for ArtifactRemoved {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            formatter,
            "native artifact disappeared after provisioning (possibly removed by security software): {}",
            self.0,
        )
    }
}

impl std::error::Error for ArtifactRemoved {}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProvisionRequest {
    cache_root: String,
    anchor: String,
    destination_directory: String,
    file: String,
    sha256: String,
    bytes: String,
    #[serde(default)]
    sandbox_read_sid: String,
    #[serde(default)]
    local_users_read_execute: bool,
    #[serde(default = "default_allow_create")]
    allow_create: bool,
}

fn default_allow_create() -> bool {
    true
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ControlRequest {
    cache_root: String,
    control_root: String,
}

pub fn run_provision() -> Result<u32> {
    let mut payload = Vec::new();
    std::io::stdin()
        .take(MAX_PROVISION_PAYLOAD_BYTES + 1)
        .read_to_end(&mut payload)
        .context("read artifact provisioning request")?;
    ensure!(
        payload.len() as u64 <= MAX_PROVISION_PAYLOAD_BYTES,
        "artifact provisioning request exceeds its bound"
    );
    let request: ProvisionRequest =
        serde_json::from_slice(&payload).context("decode artifact provisioning request")?;
    drop(payload);
    let host_sid = current_host_sid()?;
    match provision(&request, &host_sid) {
        Ok(destination) => {
            print!("{destination}");
            std::io::stdout().flush()?;
            Ok(0)
        }
        Err(error) if error.chain().any(|cause| cause.is::<ArtifactRemoved>()) => {
            eprintln!("{error:#}");
            Ok(ARTIFACT_REMOVED_EXIT_CODE)
        }
        Err(error) => Err(error),
    }
}

pub fn run_control(action: &str) -> Result<u32> {
    let request: ControlRequest =
        serde_json::from_reader(std::io::stdin().take(MAX_CONTROL_REQUEST_BYTES))
            .context("decode native shell control request")?;
    let host_sid = current_host_sid()?;
    let control = control_directory(
        action,
        Path::new(&request.cache_root),
        Path::new(&request.control_root),
        &host_sid,
    )?;
    print!("{control}");
    std::io::stdout().flush()?;
    Ok(0)
}

fn current_host_sid() -> Result<String> {
    let token = current_token()?;
    token_user_sid(token.raw())
}

fn is_missing(status: NTSTATUS) -> bool {
    status == STATUS_OBJECT_NAME_NOT_FOUND || status == STATUS_OBJECT_PATH_NOT_FOUND
}

fn is_removed(status: NTSTATUS) -> bool {
    is_missing(status) || status == STATUS_VIRUS_INFECTED || status == STATUS_VIRUS_DELETED
}

fn long_path(path: &str) -> Vec<u16> {
    wide(&format!(r"\\?\{path}"))
}

fn strictly_inside<'a>(parent: &str, child: &'a str) -> Option<&'a str> {
    let prefix = parent.trim_end_matches('\\');
    let rest = child.get(prefix.len()..)?;
    (child[..prefix.len()].eq_ignore_ascii_case(prefix) && rest.starts_with('\\'))
        .then(|| rest.trim_start_matches('\\'))
        .filter(|rest| !rest.is_empty())
}

struct ArtifactShape {
    directory_sddl: String,
    file_sddl: String,
    directory_allows: Vec<(String, u32)>,
    file_allows: Vec<(String, u32)>,
}

impl ArtifactShape {
    fn new(host_sid: &str, sandbox_read_sid: Option<&str>, local_users: bool) -> Self {
        let file_reader = if local_users {
            Some(USERS_SID)
        } else {
            sandbox_read_sid
        };
        let mut file_sddl = format!("O:{host_sid}D:P(A;;FA;;;{host_sid})(A;;FA;;;SY)");
        let mut file_allows = vec![
            (host_sid.to_owned(), FULL_CONTROL),
            (SYSTEM_SID.to_owned(), FULL_CONTROL),
        ];
        if let Some(reader) = file_reader {
            file_sddl.push_str(&format!("(A;;0x1200a9;;;{reader})"));
            file_allows.push((reader.to_owned(), READ_EXECUTE));
        }
        Self {
            directory_sddl: format!(
                "O:{host_sid}D:P(A;OICI;FA;;;{host_sid})(A;OICI;FA;;;SY)(A;OICI;0x1200a9;;;BU)"
            ),
            file_sddl,
            directory_allows: vec![
                (host_sid.to_owned(), FULL_CONTROL),
                (SYSTEM_SID.to_owned(), FULL_CONTROL),
                (USERS_SID.to_owned(), READ_EXECUTE),
            ],
            file_allows,
        }
    }
}

/// Verify the exact protected ALLOW surface. Existing DENY ACEs may be legacy
/// KodaX state or administrator policy; a DENY cannot widen access, so it is
/// retained rather than rewritten.
fn assert_artifact_acl(target: &AclTarget, host_sid: &str, allows: &[(String, u32)]) -> Result<()> {
    let path = &target.canonical_path;
    let ace_count = {
        let raw = raw_dacl(target.handle.raw())?;
        let owner = sid_to_string(raw.owner)?;
        let mut control = 0u16;
        let mut revision = 0u32;
        unsafe { GetSecurityDescriptorControl(raw.descriptor, &mut control, &mut revision) }
            .context("read artifact ACL protection")?;
        ensure!(
            control & SE_DACL_PROTECTED.0 != 0 && owner.eq_ignore_ascii_case(host_sid),
            "artifact ACL is not protected and host-owned: {path}"
        );
        usize::from(unsafe { (*raw.dacl).AceCount })
    };
    let snapshot = target.read_aces()?;
    ensure!(
        snapshot.aces.len() == ace_count,
        "artifact ACL contains an unsupported ACE type: {path}"
    );
    let flags = if target.directory {
        (OBJECT_INHERIT_ACE | CONTAINER_INHERIT_ACE).0 as u8
    } else {
        0
    };
    let mut observed = BTreeSet::new();
    for ace in &snapshot.aces {
        ensure!(
            ace.flags & INHERITED_ACE.0 as u8 == 0,
            "artifact ACL contains an inherited rule: {path}"
        );
        if ace.mode == AclMode::Deny {
            continue;
        }
        let sid = ace.sid.to_ascii_uppercase();
        let expected = allows.iter().find(|(allowed, _)| allowed.eq_ignore_ascii_case(&sid));
        let Some((_, mask)) = expected.filter(|_| observed.insert(sid.clone())) else {
            bail!("artifact ACL contains an unexpected allow rule for {sid} at {path}");
        };
        ensure!(ace.mask == *mask, "artifact ACL allow mask is invalid for {sid} at {path}");
        ensure!(ace.flags == flags, "artifact ACL inheritance is invalid at {path}");
    }
    ensure!(
        observed.len() == allows.len(),
        "artifact ACL is missing a required allow rule: {path}"
    );
    Ok(())
}

/// Open `path` as a directory, creating it with `sddl` when absent. Returns
/// `None` when it is missing and `sddl` is `None`.
fn open_or_create_directory(
    path: &Path,
    access: u32,
    sddl: Option<&str>,
) -> Result<Option<AclTarget>> {
    let open = || nt_create_file(path, access, SHARE_ALL, FILE_OPEN, FILE_DIRECTORY_FILE, null());
    let handle = match open() {
        Ok(handle) => handle,
        Err(failure) if is_missing(failure.status) => {
            let Some(sddl) = sddl else { return Ok(None) };
            let descriptor = LocalSecurityDescriptor::from_sddl(sddl)?;
            let created = nt_create_file(
                path,
                access,
                SHARE_ALL,
                FILE_CREATE,
                FILE_DIRECTORY_FILE,
                descriptor.raw().0,
            );
            match created {
                Ok(handle) => handle,
                Err(failure) if failure.status == STATUS_OBJECT_NAME_COLLISION => {
                    open().map_err(|failure| failure.error)?
                }
                Err(failure) => return Err(failure.error),
            }
        }
        Err(failure) => return Err(failure.error),
    };
    inspect_opened_acl_target(path, handle).map(Some)
}

fn ensure_protected_directory(
    path: &Path,
    allow_create: bool,
    host_sid: &str,
    shape: &ArtifactShape,
) -> Result<()> {
    let access = READ_CONTROL.0 | FILE_READ_ATTRIBUTES.0 | SYNCHRONIZE.0;
    let sddl = allow_create.then_some(shape.directory_sddl.as_str());
    let target = open_or_create_directory(path, access, sddl)?
        .ok_or_else(|| anyhow!("protected artifact directory is missing: {}", path.display()))?;
    assert_artifact_acl(&target, host_sid, &shape.directory_allows)
}

struct ValidatedProvision {
    destination_directory: String,
    destination: String,
    bytes: Vec<u8>,
    sha256: String,
}

fn validate_provision(request: &ProvisionRequest, host_sid: &str) -> Result<ValidatedProvision> {
    let anchor = validate_acl_path(Path::new(&request.anchor))?.dos;
    let cache_root = validate_acl_path(Path::new(&request.cache_root))?.dos;
    let destination_directory = validate_acl_path(Path::new(&request.destination_directory))?.dos;
    ensure!(
        strictly_inside(&anchor, &cache_root).is_some(),
        "cache root escaped host LocalAppData"
    );
    ensure!(
        strictly_inside(&cache_root, &destination_directory).is_some(),
        "destination escaped cache root"
    );
    ensure!(
        !request.file.is_empty() && !request.file.contains(['\\', '/', ':']),
        "artifact file name is invalid"
    );
    let destination =
        validate_acl_path(&Path::new(&destination_directory).join(&request.file))?.dos;
    ensure!(
        request.sha256.len() == 64 && request.sha256.bytes().all(|byte| byte.is_ascii_hexdigit()),
        "artifact digest is invalid"
    );
    if !request.sandbox_read_sid.is_empty() {
        LocalSid::from_string(&request.sandbox_read_sid)?;
        ensure!(
            !request.sandbox_read_sid.eq_ignore_ascii_case(host_sid),
            "artifact sandbox-read SID must not be the host"
        );
    }
    let bytes = STANDARD.decode(&request.bytes).context("decode artifact bytes")?;
    ensure!(
        !bytes.is_empty() && bytes.len() <= MAX_ARTIFACT_BYTES,
        "artifact has an invalid size"
    );
    let sha256 = format!("{:x}", Sha256::digest(&bytes));
    ensure!(
        sha256.eq_ignore_ascii_case(&request.sha256),
        "provisioning payload hash mismatch"
    );
    Ok(ValidatedProvision { destination_directory, destination, bytes, sha256 })
}

/// Publish one content-addressed image and return its path. Concurrent
/// provisioners race only on the final no-replace move; the loser verifies the
/// winner's identical bytes.
pub fn provision(request: &ProvisionRequest, host_sid: &str) -> Result<String> {
    let validated = validate_provision(request, host_sid)?;
    let sandbox_sid = Some(request.sandbox_read_sid.as_str()).filter(|sid| !sid.is_empty());
    let shape = ArtifactShape::new(host_sid, sandbox_sid, request.local_users_read_execute);
    let anchor = validate_acl_path(Path::new(&request.anchor))?.dos;
    let anchor_target = crate::acl::inspect_acl_target(Path::new(&anchor))
        .context("open host LocalAppData without following links")?;
    ensure!(anchor_target.directory, "host LocalAppData is not a directory");
    let relative = strictly_inside(&anchor, &validated.destination_directory)
        .ok_or_else(|| anyhow!("destination escaped host LocalAppData"))?;
    let mut current = PathBuf::from(&anchor);
    for part in relative.split('\\') {
        current.push(part);
        ensure_protected_directory(&current, request.allow_create, host_sid, &shape)?;
    }
    let temporary = format!(
        "{}\\.{}.tmp",
        validated.destination_directory,
        &uuid::Uuid::new_v4().simple().to_string()[..12],
    );
    let published = publish_and_verify(&validated, &temporary, request.allow_create, host_sid, &shape);
    let cleanup = remove_if_present(&temporary);
    let destination = published?;
    cleanup?;
    Ok(destination)
}

fn publish_and_verify(
    validated: &ValidatedProvision,
    temporary: &str,
    allow_create: bool,
    host_sid: &str,
    shape: &ArtifactShape,
) -> Result<String> {
    let destination = Path::new(&validated.destination);
    let probe = nt_create_file(
        destination,
        FILE_READ_ATTRIBUTES.0 | SYNCHRONIZE.0,
        SHARE_ALL,
        FILE_OPEN,
        FILE_NON_DIRECTORY_FILE,
        null(),
    );
    match probe {
        Ok(_) => {}
        Err(failure) if is_missing(failure.status) => {
            ensure!(allow_create, "protected artifact is missing");
            write_staged_image(temporary, &validated.bytes, &shape.file_sddl)?;
            publish_staged_image(temporary, &validated.destination)?;
        }
        Err(failure) => return Err(failure.error),
    }
    verify_published_image(validated, host_sid, shape)?;
    Ok(validated.destination.clone())
}

fn write_staged_image(temporary: &str, bytes: &[u8], file_sddl: &str) -> Result<()> {
    let descriptor = LocalSecurityDescriptor::from_sddl(file_sddl)?;
    let handle = nt_create_file(
        Path::new(temporary),
        FILE_GENERIC_WRITE.0 | DELETE.0 | SYNCHRONIZE.0,
        0,
        FILE_CREATE,
        FILE_NON_DIRECTORY_FILE | FILE_WRITE_THROUGH,
        descriptor.raw().0,
    )
    .map_err(|failure| failure.error)?;
    let mut file = handle.into_file();
    file.write_all(bytes).context("write staged native artifact")?;
    file.sync_all().context("flush staged native artifact")
}

fn publish_staged_image(temporary: &str, destination: &str) -> Result<()> {
    let source = long_path(temporary);
    let target = long_path(destination);
    let moved = unsafe {
        MoveFileExW(PCWSTR(source.as_ptr()), PCWSTR(target.as_ptr()), MOVEFILE_WRITE_THROUGH)
    };
    let Err(error) = moved else { return Ok(()) };
    // A concurrent provisioner may have published the same content first.
    if Path::new(&format!(r"\\?\{destination}")).exists() {
        return Ok(());
    }
    let code = error.code().0 & 0xFFFF;
    if !Path::new(&format!(r"\\?\{temporary}")).exists()
        || matches!(code, ERROR_FILE_NOT_FOUND | ERROR_VIRUS_INFECTED | ERROR_VIRUS_DELETED)
    {
        return Err(anyhow::Error::new(ArtifactRemoved(format!(
            "staged image vanished before publication to {destination}"
        ))));
    }
    Err(anyhow::Error::new(error)).context("publish protected native artifact")
}

fn verify_published_image(
    validated: &ValidatedProvision,
    host_sid: &str,
    shape: &ArtifactShape,
) -> Result<()> {
    let destination = Path::new(&validated.destination);
    // A sibling Runtime may already execute this content-addressed image, so
    // verification shares read/delete and denies only writers.
    let handle = nt_create_file(
        destination,
        READ_CONTROL.0 | FILE_READ_DATA.0 | FILE_READ_ATTRIBUTES.0 | SYNCHRONIZE.0,
        FILE_SHARE_READ.0 | FILE_SHARE_DELETE.0,
        FILE_OPEN,
        FILE_NON_DIRECTORY_FILE,
        null(),
    )
    .map_err(|failure| {
        if is_removed(failure.status) {
            anyhow::Error::new(ArtifactRemoved(validated.destination.clone()))
        } else {
            failure.error
        }
    })?;
    let reader = handle.try_clone("published native artifact")?.into_file();
    let target = inspect_opened_acl_target(destination, handle)?;
    assert_artifact_acl(&target, host_sid, &shape.file_allows)?;
    let mut published = Vec::new();
    reader
        .take(MAX_ARTIFACT_BYTES as u64 + 1)
        .read_to_end(&mut published)
        .context("read published native artifact")?;
    let digest = format!("{:x}", Sha256::digest(&published));
    ensure!(digest == validated.sha256, "published artifact hash mismatch");
    Ok(())
}

fn remove_if_present(path: &str) -> Result<()> {
    match std::fs::remove_file(format!(r"\\?\{path}")) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error).with_context(|| format!("remove staged native artifact {path}")),
    }
}

fn control_sddl(host_sid: &str) -> String {
    format!("O:{host_sid}D:P(A;OICI;FA;;;{host_sid})(A;OICI;FA;;;SY)")
}

/// Verify, create, or repair the host/SYSTEM-only control directory that sits
/// directly under the artifact cache root.
pub fn control_directory(
    action: &str,
    cache_root: &Path,
    control_root: &Path,
    host_sid: &str,
) -> Result<String> {
    let cache = validate_acl_path(cache_root)?.dos;
    let control = validate_acl_path(control_root)?.dos;
    ensure!(
        strictly_inside(&cache, &control).is_some_and(|rest| !rest.contains('\\')),
        "control directory escaped native cache root"
    );
    let cache_target = crate::acl::inspect_acl_target(Path::new(&cache))
        .context("protected native cache root is unavailable")?;
    ensure!(cache_target.directory, "protected native cache root is unavailable");
    let control_path = Path::new(&control);
    let inspect = READ_CONTROL.0 | FILE_READ_ATTRIBUTES.0 | SYNCHRONIZE.0;
    let sddl = control_sddl(host_sid);
    let target = match action {
        "verify" => open_or_create_directory(control_path, inspect, None)?.ok_or_else(|| {
            anyhow!("protected native shell control state is not initialized; run kodax sandbox setup")
        })?,
        "ensure" => open_or_create_directory(control_path, inspect, Some(&sddl))?
            .ok_or_else(|| anyhow!("protected native shell control state could not be created"))?,
        "repair" => repair_control_directory(control_path, host_sid, &sddl)?,
        _ => bail!("invalid native shell control state action"),
    };
    verify_open_control_directory_boundary(&target, host_sid)?;
    Ok(control)
}

fn repair_control_directory(control: &Path, host_sid: &str, sddl: &str) -> Result<AclTarget> {
    let access = READ_CONTROL.0 | WRITE_DAC.0 | FILE_LIST_DIRECTORY.0 | FILE_READ_ATTRIBUTES.0 | SYNCHRONIZE.0;
    let existing = open_or_create_directory(control, access, None)?;
    let Some(target) = existing else {
        return open_or_create_directory(control, access, Some(sddl))?
            .ok_or_else(|| anyhow!("protected native shell control state could not be created"));
    };
    let owner = sid_to_string(raw_dacl(target.handle.raw())?.owner)?;
    ensure!(
        owner.eq_ignore_ascii_case(host_sid),
        "refusing to repair native shell control state not owned by the host"
    );
    remove_proven_stale_control_entries(control)?;
    let not_empty = std::fs::read_dir(control)
        .context("enumerate native shell control state")?
        .next()
        .is_some();
    ensure!(
        !not_empty,
        "refusing to repair non-empty native shell control state; close KodaX and remove the directory manually"
    );
    let descriptor = LocalSecurityDescriptor::from_sddl(sddl)?;
    unsafe {
        SetKernelObjectSecurity(
            target.handle.raw(),
            DACL_SECURITY_INFORMATION | PROTECTED_DACL_SECURITY_INFORMATION,
            descriptor.raw(),
        )
    }
    .context("repair native shell control state ACL")?;
    Ok(target)
}

#[derive(Debug, PartialEq, Eq)]
enum ControlEntry {
    /// Protocol-9 warmup diagnostic; a dead creator proves nobody appends.
    Warmup { pid: u32 },
    /// Atomic publication staging file; carries no authority.
    Staging { pid: u32 },
    /// Owner record of one Runtime operation.
    Record { kind: String, pid: u32 },
}

fn take_pid(value: &str) -> Option<(u32, &str)> {
    let end = value.find(|character: char| !character.is_ascii_digit())?;
    let pid = value[..end].parse::<u64>().ok().filter(|pid| *pid > 0)?;
    Some((u32::try_from(pid).ok()?, &value[end..]))
}

fn take_uuid(value: &str) -> Option<&str> {
    let (uuid, rest) = (value.get(..36)?, value.get(36..)?);
    uuid.bytes()
        .all(|byte| byte.is_ascii_hexdigit() || byte == b'-')
        .then_some(rest)
}

fn is_staging_tail(value: &str) -> Option<u32> {
    let (pid, rest) = take_pid(value.strip_prefix('.')?)?;
    let hex = rest.strip_prefix('.')?.strip_suffix(".tmp")?;
    (hex.len() == 32 && hex.bytes().all(|byte| byte.is_ascii_hexdigit())).then_some(pid)
}

fn classify_control_entry(name: &str) -> Option<ControlEntry> {
    if let Some(rest) = name.strip_prefix("windows-read-warmup-") {
        let (pid, rest) = take_pid(rest)?;
        return (take_uuid(rest.strip_prefix('-')?)? == ".log").then_some(ControlEntry::Warmup { pid });
    }
    if let Some(rest) = name.strip_prefix("windows-deny-") {
        return is_staging_tail(take_uuid(rest)?).map(|pid| ControlEntry::Staging { pid });
    }
    let rest = name.strip_prefix("windows-")?;
    let (kind, rest) = rest.split_once('-')?;
    if !matches!(kind, "shell" | "network" | "resume" | "started" | "terminal") {
        return None;
    }
    let (owner, rest) = take_pid(rest)?;
    let tail = take_uuid(rest.strip_prefix('-')?)?;
    if tail == ".json" {
        return Some(ControlEntry::Record { kind: kind.to_owned(), pid: owner });
    }
    let staging = matches!(kind, "resume" | "started").then(|| is_staging_tail(tail)).flatten()?;
    Some(ControlEntry::Staging { pid: staging })
}

fn process_is_dead(pid: u32) -> bool {
    // Only a definite "no such process" proves death; any other failure
    // (for example access denied) keeps the entry.
    matches!(crate::win::process_creation_time(pid), Ok(None))
}

fn record_is_retired(kind: &str, path: &Path, older_than_a_minute: bool) -> bool {
    match kind {
        "resume" | "started" => true,
        "network" => older_than_a_minute,
        _ => {
            let Ok(text) = std::fs::read_to_string(path) else { return false };
            let Ok(record) = serde_json::from_str::<serde_json::Value>(&text) else { return false };
            if kind == "shell" {
                let deadline = match &record["operationDeadlineUnixMs"] {
                    serde_json::Value::Number(value) => value.as_i64(),
                    serde_json::Value::String(value) => value.parse::<i64>().ok(),
                    _ => None,
                };
                let now = SystemTime::now()
                    .duration_since(SystemTime::UNIX_EPOCH)
                    .map_or(0, |elapsed| elapsed.as_millis() as i64);
                deadline.is_some_and(|deadline| deadline < now)
            } else {
                record["jobDrained"] == serde_json::Value::Bool(true)
            }
        }
    }
}

fn remove_proven_stale_control_entries(control: &Path) -> Result<()> {
    use std::os::windows::fs::MetadataExt;
    const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x400;
    let minute_ago = SystemTime::now() - Duration::from_secs(60);
    for entry in std::fs::read_dir(control).context("enumerate native shell control state")? {
        let entry = entry.context("read native shell control entry")?;
        let path = entry.path();
        let metadata = match std::fs::symlink_metadata(&path) {
            Ok(metadata) => metadata,
            // Another setup or owner may retire a converged entry after enumeration.
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
            Err(error) => return Err(error).context("inspect native shell control entry"),
        };
        if metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0
            || metadata.is_dir()
            || metadata.len() > MAX_CONTROL_ENTRY_BYTES
        {
            continue;
        }
        let Some(classified) = entry.file_name().to_str().and_then(classify_control_entry) else {
            continue;
        };
        let old = metadata.modified().is_ok_and(|modified| modified < minute_ago);
        let retire = match &classified {
            ControlEntry::Warmup { pid } => process_is_dead(*pid),
            ControlEntry::Staging { pid } => old && process_is_dead(*pid),
            ControlEntry::Record { kind, pid } => {
                process_is_dead(*pid) && record_is_retired(kind, &path, old)
            }
        };
        if retire {
            match std::fs::remove_file(&path) {
                Ok(()) => {}
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                Err(error) => return Err(error).context("retire stale native shell control entry"),
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::process::Command;

    const DEAD_PID: u32 = 4_294_967_292;

    /// Removes one fixture tree on drop; remove_dir_all never follows the junction fixture.
    struct Fixture(PathBuf);

    impl Drop for Fixture {
        fn drop(&mut self) {
            if let Err(error) = std::fs::remove_dir_all(&self.0) {
                eprintln!("artifact store fixture cleanup failed for {}: {error}", self.0.display());
            }
        }
    }

    impl std::ops::Deref for Fixture {
        type Target = PathBuf;
        fn deref(&self) -> &PathBuf {
            &self.0
        }
    }

    fn temporary_anchor(label: &str) -> Fixture {
        let base = std::env::var_os("KODAX_NATIVE_TEST_TEMP")
            .map(PathBuf::from)
            .unwrap_or_else(std::env::temp_dir);
        std::fs::create_dir_all(&base).unwrap();
        // Keep fixture paths short: icacls, used to inject drift, has no long-path support.
        let nonce = uuid::Uuid::new_v4().simple().to_string();
        let path = base.join(format!("kas-{label}-{}", &nonce[..8]));
        std::fs::create_dir(&path).unwrap();
        // Canonicalize to the long path: 8.3 temp components are path aliases.
        let canonical = std::fs::canonicalize(&path).unwrap();
        Fixture(PathBuf::from(canonical.to_string_lossy().trim_start_matches(r"\\?\")))
    }

    fn host() -> String {
        current_host_sid().unwrap()
    }

    fn request(anchor: &Path, bytes: &[u8], sandbox: &str, local_users: bool) -> ProvisionRequest {
        let cache_root = anchor.join("KodaXNativeArtifactsV3");
        let sha256 = format!("{:x}", Sha256::digest(bytes));
        let directory = cache_root.join("v2").join("win32-x64").join("shellSandbox").join("host-only").join(&sha256);
        ProvisionRequest {
            cache_root: cache_root.to_string_lossy().into_owned(),
            anchor: anchor.to_string_lossy().into_owned(),
            destination_directory: directory.to_string_lossy().into_owned(),
            file: "kodax-windows-sandbox.exe".to_owned(),
            sha256,
            bytes: STANDARD.encode(bytes),
            sandbox_read_sid: sandbox.to_owned(),
            local_users_read_execute: local_users,
            allow_create: true,
        }
    }

    fn icacls(path: &str, args: &[&str]) {
        let status = Command::new("icacls").arg(path).args(args).output().unwrap();
        assert!(status.status.success(), "icacls {args:?}: {}", String::from_utf8_lossy(&status.stdout));
    }

    fn directory_entries(path: &str) -> Vec<String> {
        std::fs::read_dir(path)
            .unwrap()
            .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
            .collect()
    }

    #[test]
    fn provisions_protected_directories_and_image_then_reuses_them() {
        let anchor = temporary_anchor("cold");
        let request = request(&anchor, b"MZ provisioned image", "", false);
        let host_sid = host();
        let destination = provision(&request, &host_sid).unwrap();
        assert!(destination.ends_with(r"\kodax-windows-sandbox.exe"));
        assert_eq!(std::fs::read(&destination).unwrap(), b"MZ provisioned image");
        let shape = ArtifactShape::new(&host_sid, None, false);
        let file = crate::acl::inspect_acl_target(Path::new(&destination)).unwrap();
        assert_artifact_acl(&file, &host_sid, &shape.file_allows).unwrap();
        assert_eq!(file.read_aces().unwrap().aces.len(), 2);
        let directory = crate::acl::inspect_acl_target(Path::new(&request.cache_root)).unwrap();
        assert_artifact_acl(&directory, &host_sid, &shape.directory_allows).unwrap();
        // A warm call verifies and returns the same image without rewriting it.
        assert_eq!(provision(&request, &host_sid).unwrap(), destination);
        assert_eq!(directory_entries(&request.destination_directory), vec!["kodax-windows-sandbox.exe"]);
    }

    #[test]
    fn file_acl_grants_exactly_the_requested_reader() {
        let anchor = temporary_anchor("reader");
        let host_sid = host();
        let sandbox = request(&anchor, b"MZ sandbox reader", "S-1-5-21-11-12-13-14", false);
        let path = provision(&sandbox, &host_sid).unwrap();
        let aces = crate::acl::inspect_acl_target(Path::new(&path)).unwrap().read_aces().unwrap().aces;
        assert!(aces.iter().any(|ace| ace.sid == "S-1-5-21-11-12-13-14" && ace.mask == READ_EXECUTE));
        assert_eq!(aces.len(), 3);

        let users = request(&anchor, b"MZ local users", "", true);
        let path = provision(&users, &host_sid).unwrap();
        let aces = crate::acl::inspect_acl_target(Path::new(&path)).unwrap().read_aces().unwrap().aces;
        assert!(aces.iter().any(|ace| ace.sid == USERS_SID && ace.mask == READ_EXECUTE && ace.flags == 0));
        assert_eq!(aces.len(), 3);
    }

    #[test]
    fn rejects_hash_mismatch_escape_and_acl_drift_without_repairing() {
        let anchor = temporary_anchor("reject");
        let host_sid = host();
        let mut mismatch = request(&anchor, b"MZ mismatch", "", false);
        mismatch.sha256 = "0".repeat(64);
        assert!(provision(&mismatch, &host_sid).unwrap_err().to_string().contains("hash mismatch"));

        let mut escaped = request(&anchor, b"MZ escaped", "", false);
        escaped.destination_directory = anchor.join("elsewhere").to_string_lossy().into_owned();
        assert!(provision(&escaped, &host_sid).unwrap_err().to_string().contains("escaped"));

        let valid = request(&anchor, b"MZ drift", "", false);
        let destination = provision(&valid, &host_sid).unwrap();
        icacls(&destination, &["/grant", "*S-1-1-0:(R)"]);
        let error = provision(&valid, &host_sid).unwrap_err().to_string();
        assert!(error.contains("unexpected allow rule for S-1-1-0"), "{error}");
    }

    #[test]
    fn existing_deny_aces_are_preserved() {
        let anchor = temporary_anchor("deny");
        let host_sid = host();
        let valid = request(&anchor, b"MZ deny", "", false);
        provision(&valid, &host_sid).unwrap();
        icacls(&valid.cache_root, &["/deny", "*S-1-5-32-546:(OI)(CI)(W)"]);
        let other = request(&anchor, b"MZ deny second", "", false);
        provision(&other, &host_sid).unwrap();
        let aces = crate::acl::inspect_acl_target(Path::new(&valid.cache_root)).unwrap().read_aces().unwrap().aces;
        assert!(aces.iter().any(|ace| ace.mode == AclMode::Deny && ace.sid == "S-1-5-32-546"));
    }

    #[test]
    fn rejects_reparse_points_in_the_cache_path() {
        let anchor = temporary_anchor("reparse");
        let target = temporary_anchor("reparse-target");
        let link = anchor.join("KodaXNativeArtifactsV3");
        let output = Command::new("cmd")
            .args(["/c", "mklink", "/J"])
            .arg(&link)
            .arg(target.as_path())
            .output()
            .unwrap();
        assert!(output.status.success());
        let error = provision(&request(&anchor, b"MZ reparse", "", false), &host()).unwrap_err();
        assert!(format!("{error:#}").contains("reparse"), "{error:#}");
        assert!(directory_entries(&target.to_string_lossy()).is_empty());
    }

    #[test]
    fn concurrent_provisioners_publish_one_image_and_leave_no_staging_files() {
        let anchor = temporary_anchor("race");
        let host_sid = host();
        let bytes = vec![0x5Au8; 2 * 1024 * 1024];
        let results = std::thread::scope(|scope| {
            let workers = (0..6)
                .map(|_| scope.spawn(|| provision(&request(&anchor, &bytes, "", false), &host_sid)))
                .collect::<Vec<_>>();
            workers.into_iter().map(|worker| worker.join().unwrap()).collect::<Vec<_>>()
        });
        let directory = request(&anchor, &bytes, "", false).destination_directory;
        for result in results {
            assert_eq!(result.unwrap(), format!(r"{directory}\kodax-windows-sandbox.exe"));
        }
        assert_eq!(directory_entries(&directory), vec!["kodax-windows-sandbox.exe"]);
    }

    #[test]
    fn missing_image_without_create_permission_fails_hard() {
        let anchor = temporary_anchor("nocreate");
        let mut missing = request(&anchor, b"MZ missing", "", false);
        missing.allow_create = false;
        let error = provision(&missing, &host()).unwrap_err().to_string();
        assert!(error.contains("missing"), "{error}");
    }

    #[test]
    fn control_directory_is_created_verified_and_repaired_to_the_exact_boundary() {
        let anchor = temporary_anchor("control");
        let host_sid = host();
        let cache = anchor.join("KodaXNativeArtifactsV3");
        let control = cache.join("control-v1");
        let verify_missing = control_directory("verify", &cache, &control, &host_sid);
        assert!(verify_missing.is_err());
        std::fs::create_dir(&cache).unwrap();
        let error = control_directory("verify", &cache, &control, &host_sid).unwrap_err();
        assert!(error.to_string().contains("run kodax sandbox setup"));
        let created = control_directory("ensure", &cache, &control, &host_sid).unwrap();
        assert_eq!(created, control.to_string_lossy());
        assert_eq!(control_directory("verify", &cache, &control, &host_sid).unwrap(), created);

        icacls(&created, &["/grant", "*S-1-1-0:(OI)(CI)(R)"]);
        let drift = control_directory("verify", &cache, &control, &host_sid).unwrap_err();
        assert!(format!("{drift:#}").contains("host/SYSTEM"), "{drift:#}");
        let stale = control.join(format!("windows-resume-{DEAD_PID}-{}.json", uuid::Uuid::new_v4()));
        std::fs::write(&stale, b"{}").unwrap();
        let live = control.join(format!("windows-shell-{}-{}.json", std::process::id(), uuid::Uuid::new_v4()));
        std::fs::write(&live, b"{\"operationDeadlineUnixMs\":0}").unwrap();
        let refused = control_directory("repair", &cache, &control, &host_sid).unwrap_err();
        assert!(refused.to_string().contains("non-empty"));
        assert!(!stale.exists());
        std::fs::remove_file(&live).unwrap();
        control_directory("repair", &cache, &control, &host_sid).unwrap();
        assert!(control_directory("verify", &cache, &control, &host_sid).is_ok());
        let escaped = control_directory("ensure", &cache, &cache.join("a").join("b"), &host_sid);
        assert!(escaped.unwrap_err().to_string().contains("escaped"));
    }

    #[test]
    fn classifies_only_proven_stale_control_entry_names() {
        let uuid = "0123abcd-0000-4000-8000-00000000abcd";
        let hex = "0123456789abcdef0123456789abcdef";
        assert_eq!(
            classify_control_entry(&format!("windows-read-warmup-12-{uuid}.log")),
            Some(ControlEntry::Warmup { pid: 12 })
        );
        assert_eq!(
            classify_control_entry(&format!("windows-started-12-{uuid}.34.{hex}.tmp")),
            Some(ControlEntry::Staging { pid: 34 })
        );
        assert_eq!(
            classify_control_entry(&format!("windows-deny-{uuid}.56.{hex}.tmp")),
            Some(ControlEntry::Staging { pid: 56 })
        );
        assert_eq!(
            classify_control_entry(&format!("windows-terminal-7-{uuid}.json")),
            Some(ControlEntry::Record { kind: "terminal".to_owned(), pid: 7 })
        );
        for rejected in [
            format!("windows-shell-0-{uuid}.json"),
            format!("windows-shell-99999999999-{uuid}.json"),
            format!("windows-setup-7-{uuid}.json"),
            format!("windows-shell-7-{uuid}.34.{hex}.tmp"),
            format!("windows-deny-{uuid}.56.{hex}.json"),
            "windows-shell-7-short.json".to_owned(),
        ] {
            assert_eq!(classify_control_entry(&rejected), None, "{rejected}");
        }
    }
}
