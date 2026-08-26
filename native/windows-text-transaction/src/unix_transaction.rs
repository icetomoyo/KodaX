#[cfg(target_os = "macos")]
use std::ffi::CStr;
use std::ffi::{CString, OsStr};
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Write};
use std::mem::zeroed;
use std::os::fd::{AsRawFd, FromRawFd, RawFd};
#[cfg(target_os = "macos")]
use std::os::raw::{c_char, c_int, c_void};
use std::os::unix::ffi::OsStrExt;
use std::os::unix::fs::{MetadataExt, OpenOptionsExt, PermissionsExt};
use std::path::{Component, Path, PathBuf};
use std::thread;
use std::time::{Duration, Instant};

use caseless::Caseless;
use sha2::{Digest, Sha256};
use unicode_normalization::UnicodeNormalization;
use uuid::Uuid;

use crate::{
    CommitOutcome, CommitReceipt, ResourceState, TextSnapshot, TextTransactionError,
    TextTransactionErrorCode,
};

const MAX_TEXT_BYTES: usize = 64 * 1024 * 1024;
const MAX_XATTR_BYTES: usize = 64 * 1024 * 1024;
const LOCK_DIRECTORY_NAME: &str = "locks-v1";

#[cfg(test)]
thread_local! {
    static FAIL_NEXT_DIRECTORY_SYNC: std::cell::Cell<bool> = const { std::cell::Cell::new(false) };
    static FAIL_NEXT_TEMPORARY_CLEANUP: std::cell::Cell<bool> = const { std::cell::Cell::new(false) };
}

#[cfg(test)]
fn take_fail_next_directory_sync() -> bool {
    FAIL_NEXT_DIRECTORY_SYNC.with(|flag| flag.replace(false))
}

#[cfg(test)]
fn take_fail_next_temporary_cleanup() -> bool {
    FAIL_NEXT_TEMPORARY_CLEANUP.with(|flag| flag.replace(false))
}

#[derive(Clone, Copy, Eq, PartialEq)]
struct FileIdentity {
    device: u64,
    inode: u64,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
struct MountIdentity(u64);

#[cfg(target_os = "linux")]
fn mount_identity(file: &File) -> Result<MountIdentity, TextTransactionError> {
    let mut stats: libc::statx = unsafe { zeroed() };
    let empty = c"";
    if unsafe {
        libc::statx(
            file.as_raw_fd(),
            empty.as_ptr(),
            libc::AT_EMPTY_PATH | libc::AT_SYMLINK_NOFOLLOW,
            libc::STATX_MNT_ID,
            &mut stats,
        )
    } != 0
    {
        return Err(TextTransactionError::os(
            TextTransactionErrorCode::UnsupportedFilesystem,
            "cannot prove trusted text mount identity",
            std::io::Error::last_os_error()
                .raw_os_error()
                .unwrap_or_default() as u32,
        ));
    }
    if stats.stx_mask & libc::STATX_MNT_ID == 0 {
        return Err(TextTransactionError::new(
            TextTransactionErrorCode::UnsupportedFilesystem,
            "trusted text filesystem does not report mount identity",
        ));
    }
    Ok(MountIdentity(stats.stx_mnt_id))
}

#[cfg(target_os = "macos")]
fn mount_identity(file: &File) -> Result<MountIdentity, TextTransactionError> {
    let metadata = file
        .metadata()
        .map_err(|error| io_error("cannot inspect trusted text mount identity", error))?;
    Ok(MountIdentity(metadata.dev()))
}

impl FileIdentity {
    fn from_metadata(metadata: &fs::Metadata) -> Self {
        Self {
            device: metadata.dev(),
            inode: metadata.ino(),
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
struct FilesystemIdentity {
    label: String,
    case_insensitive: bool,
    canonical_unicode: bool,
}

#[cfg(target_os = "linux")]
fn supported_local_filesystem(file: &File) -> Result<FilesystemIdentity, TextTransactionError> {
    let mut stats: libc::statfs = unsafe { zeroed() };
    if unsafe { libc::fstatfs(file.as_raw_fd(), &mut stats) } != 0 {
        return Err(io_error(
            "cannot inspect trusted text filesystem",
            std::io::Error::last_os_error(),
        ));
    }
    let kind = stats.f_type as u64;
    const LOCAL_FILESYSTEMS: &[u64] = &[
        0x0000_ef53, // ext2/3/4
        0x5846_5342, // XFS
        0x9123_683e, // btrfs
        0x0102_1994, // tmpfs
        0x8584_58f6, // ramfs
        0xf2f5_2010, // f2fs
        0x794c_7630, // overlayfs
    ];
    if !LOCAL_FILESYSTEMS.contains(&kind) {
        return Err(TextTransactionError::new(
            TextTransactionErrorCode::RemoteFilesystem,
            format!("trusted text transactions reject filesystem type 0x{kind:x}"),
        ));
    }
    Ok(FilesystemIdentity {
        label: format!("linux:{kind:x}"),
        case_insensitive: false,
        canonical_unicode: false,
    })
}

#[cfg(target_os = "macos")]
fn supported_local_filesystem(file: &File) -> Result<FilesystemIdentity, TextTransactionError> {
    let mut stats: libc::statfs = unsafe { zeroed() };
    if unsafe { libc::fstatfs(file.as_raw_fd(), &mut stats) } != 0 {
        return Err(io_error(
            "cannot inspect trusted text filesystem",
            std::io::Error::last_os_error(),
        ));
    }
    if stats.f_flags & libc::MNT_LOCAL as u32 == 0 {
        return Err(TextTransactionError::new(
            TextTransactionErrorCode::RemoteFilesystem,
            "trusted text transactions require a local macOS filesystem",
        ));
    }
    let kind = unsafe { CStr::from_ptr(stats.f_fstypename.as_ptr()) }
        .to_string_lossy()
        .into_owned();
    if !matches!(kind.as_str(), "apfs" | "hfs" | "ufs" | "msdos" | "exfat") {
        return Err(TextTransactionError::new(
            TextTransactionErrorCode::UnsupportedFilesystem,
            format!("trusted text transactions reject macOS filesystem {kind}"),
        ));
    }
    let case_sensitive = unsafe { libc::fpathconf(file.as_raw_fd(), libc::_PC_CASE_SENSITIVE) };
    if case_sensitive == -1 {
        return Err(io_error(
            "cannot inspect trusted text filesystem case semantics",
            std::io::Error::last_os_error(),
        ));
    }
    Ok(FilesystemIdentity {
        label: format!("macos:{kind}"),
        case_insensitive: case_sensitive == 0,
        canonical_unicode: true,
    })
}

#[cfg(not(any(target_os = "linux", target_os = "macos")))]
fn supported_local_filesystem(_file: &File) -> Result<FilesystemIdentity, TextTransactionError> {
    Err(TextTransactionError::new(
        TextTransactionErrorCode::UnsupportedPlatform,
        "trusted Unix text transactions support Linux and macOS only",
    ))
}

struct SlotLock {
    file: File,
    directory: File,
    directory_path: PathBuf,
    directory_identity: FileIdentity,
    slot_name: String,
    slot_identity: FileIdentity,
}

impl SlotLock {
    fn acquire(
        directory: &File,
        directory_path: &Path,
        directory_identity: FileIdentity,
        slot_id: &str,
        timeout_ms: u32,
    ) -> Result<Self, TextTransactionError> {
        revalidate_directory_path(directory_path, directory_identity)?;
        let slot_name = format!("{slot_id}.lock");
        let file = openat(
            directory.as_raw_fd(),
            &slot_name,
            libc::O_RDWR | libc::O_CREAT,
            0o600,
        )?;
        let metadata = file
            .metadata()
            .map_err(|error| io_error("cannot inspect trusted text transaction lock", error))?;
        if !metadata.is_file()
            || metadata.nlink() != 1
            || metadata.uid() != unsafe { libc::geteuid() }
            || metadata.mode() & 0o077 != 0
        {
            return Err(TextTransactionError::new(
                TextTransactionErrorCode::Contended,
                "trusted text transaction lock has an unsafe identity",
            ));
        }
        let deadline = Instant::now() + Duration::from_millis(u64::from(timeout_ms));
        loop {
            if unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } == 0 {
                let acquired = Self {
                    file,
                    directory: directory.try_clone().map_err(|error| {
                        io_error("cannot retain trusted text lock directory", error)
                    })?,
                    directory_path: directory_path.to_path_buf(),
                    directory_identity,
                    slot_name,
                    slot_identity: FileIdentity::from_metadata(&metadata),
                };
                acquired.revalidate()?;
                return Ok(acquired);
            }
            let error = std::io::Error::last_os_error();
            if error.kind() == std::io::ErrorKind::Interrupted {
                continue;
            }
            if !matches!(error.raw_os_error(), Some(code) if code == libc::EWOULDBLOCK || code == libc::EAGAIN)
            {
                return Err(io_error(
                    "cannot acquire trusted text transaction lock",
                    error,
                ));
            }
            if Instant::now() >= deadline {
                return Err(TextTransactionError::new(
                    TextTransactionErrorCode::Contended,
                    "trusted text transaction slot is held by another Runtime",
                ));
            }
            thread::sleep(Duration::from_millis(10));
        }
    }

    fn revalidate(&self) -> Result<(), TextTransactionError> {
        revalidate_directory_path(&self.directory_path, self.directory_identity)?;
        let current =
            openat_file(self.directory.as_raw_fd(), &self.slot_name)?.ok_or_else(|| {
                TextTransactionError::new(
                    TextTransactionErrorCode::Contended,
                    "trusted text transaction lock inode was replaced",
                )
            })?;
        let metadata = current
            .metadata()
            .map_err(|error| io_error("cannot revalidate trusted text lock inode", error))?;
        if FileIdentity::from_metadata(&metadata) != self.slot_identity {
            return Err(TextTransactionError::new(
                TextTransactionErrorCode::Contended,
                "trusted text transaction lock inode changed identity",
            ));
        }
        Ok(())
    }
}

impl Drop for SlotLock {
    fn drop(&mut self) {
        unsafe {
            libc::flock(self.file.as_raw_fd(), libc::LOCK_UN);
        }
    }
}

pub struct TrustedRoot {
    root: File,
    authorized_root_path: PathBuf,
    root_path: PathBuf,
    identity: FileIdentity,
    mount: MountIdentity,
    filesystem: FilesystemIdentity,
    lock_directory: File,
    lock_directory_path: PathBuf,
    lock_directory_identity: FileIdentity,
}

unsafe impl Send for TrustedRoot {}
unsafe impl Sync for TrustedRoot {}

impl TrustedRoot {
    pub fn open(root_path: &str, state_root: &str) -> Result<Self, TextTransactionError> {
        let root_path = validate_absolute_path(root_path)?;
        let canonical = fs::canonicalize(&root_path)
            .map_err(|error| io_error("cannot canonicalize trusted text root", error))?;
        let root = open_path_no_follow(&canonical, libc::O_RDONLY | libc::O_DIRECTORY)?;
        let metadata = root
            .metadata()
            .map_err(|error| io_error("cannot inspect trusted text root", error))?;
        if !metadata.is_dir() {
            return Err(TextTransactionError::invalid_path(
                "trusted text root is not a directory",
            ));
        }
        let filesystem = supported_local_filesystem(&root)?;
        let mount = mount_identity(&root)?;
        let (lock_directory, lock_directory_path, lock_directory_identity) =
            open_lock_directory(state_root)?;
        supported_local_filesystem(&lock_directory)?;
        Ok(Self {
            root,
            authorized_root_path: root_path,
            root_path: canonical,
            identity: FileIdentity::from_metadata(&metadata),
            mount,
            filesystem,
            lock_directory,
            lock_directory_path,
            lock_directory_identity,
        })
    }

    pub fn snapshot(&self, target: &str) -> Result<TextSnapshot, TextTransactionError> {
        self.ensure_root_location()?;
        let relative = self.validate_target(target)?;
        let canonical_path = self.root_path.join(&relative);
        let canonical_text = path_text(&canonical_path)?;
        self.snapshot_relative(&relative, &canonical_text)
    }

    fn snapshot_relative(
        &self,
        relative: &Path,
        canonical_text: &str,
    ) -> Result<TextSnapshot, TextTransactionError> {
        let Some((parents, leaf)) = self.open_parent(relative, false)? else {
            let slot_id = self.namespace_slot_id(relative)?;
            return Ok(missing_snapshot(slot_id, canonical_text.to_owned()));
        };
        let parent = parents.last().unwrap_or(&self.root);
        self.ensure_same_filesystem(parent)?;
        let slot_id = self.namespace_slot_id(relative)?;
        read_snapshot(
            parent.as_raw_fd(),
            &leaf,
            &slot_id,
            canonical_text,
            self.mount,
        )
    }

    pub fn commit(
        &self,
        target: &str,
        expected_revision: &str,
        content: &str,
        create_parents: bool,
        timeout_ms: u32,
    ) -> Result<CommitOutcome, TextTransactionError> {
        if content.len() > MAX_TEXT_BYTES {
            return Err(TextTransactionError::new(
                TextTransactionErrorCode::Io,
                "text transaction payload exceeds the 64 MiB bound",
            ));
        }
        let relative = self.validate_target(target)?;
        let canonical_path = self.root_path.join(&relative);
        let canonical_text = path_text(&canonical_path)?;
        let optimistic = self.snapshot_relative(&relative, &canonical_text)?;
        let slot_id = optimistic.slot_id.clone();
        self.ensure_root_location()?;
        let (parents, leaf) = self
            .open_parent(&relative, create_parents)?
            .ok_or_else(|| {
                TextTransactionError::new(
                    TextTransactionErrorCode::Io,
                    "target parent directory does not exist",
                )
            })?;
        let parent = parents.last().unwrap_or(&self.root);
        self.ensure_same_filesystem(parent)?;
        let coordination_slot = self.coordination_slot_id(parent, &leaf)?;
        let lock = SlotLock::acquire(
            &self.lock_directory,
            &self.lock_directory_path,
            self.lock_directory_identity,
            &coordination_slot,
            timeout_ms,
        )?;
        self.ensure_parent_location(&relative, parent)?;
        let namespace_slot = self.namespace_slot_id(&relative)?;
        if namespace_slot != slot_id {
            return Err(TextTransactionError::new(
                TextTransactionErrorCode::Contended,
                "trusted text namespace identity changed while acquiring its transaction lock",
            ));
        }
        let before = read_snapshot(
            parent.as_raw_fd(),
            &leaf,
            &namespace_slot,
            &canonical_text,
            self.mount,
        )?;
        if before.revision != expected_revision {
            return Ok(CommitOutcome::Stale {
                current_revision: before.revision,
            });
        }

        let temporary = format!(".kodax-tx-{}.tmp", Uuid::new_v4().simple());
        let mut temp = openat_create_exclusive(parent.as_raw_fd(), &temporary)?;
        let mut committed_receipt = None;
        let result = (|| {
            self.ensure_same_filesystem(&temp)?;
            lock.revalidate()?;
            self.ensure_parent_location(&relative, parent)?;
            let existing_metadata = if before.state == ResourceState::Present {
                let existing = openat_file(parent.as_raw_fd(), &leaf)?.ok_or_else(|| {
                    TextTransactionError::new(
                        TextTransactionErrorCode::Contended,
                        "text transaction target disappeared during commit",
                    )
                })?;
                let metadata = existing
                    .metadata()
                    .map_err(|error| io_error("cannot inspect text transaction metadata", error))?;
                Some((existing, metadata))
            } else {
                None
            };
            temp.write_all(content.as_bytes())
                .map_err(|error| io_error("cannot write text transaction temporary file", error))?;
            if let Some((existing, metadata)) = &existing_metadata {
                preserve_metadata(&temp, existing, metadata)?;
            }
            temp.sync_all()
                .map_err(|error| io_error("cannot flush text transaction temporary file", error))?;

            let final_check = read_snapshot(
                parent.as_raw_fd(),
                &leaf,
                &namespace_slot,
                &canonical_text,
                self.mount,
            )?;
            if final_check.revision != before.revision {
                return Ok(CommitOutcome::Stale {
                    current_revision: final_check.revision,
                });
            }
            lock.revalidate()?;
            self.ensure_parent_location(&relative, parent)?;
            let temp_metadata = temp.metadata().map_err(|error| {
                io_error("cannot inspect text transaction temporary file", error)
            })?;
            let receipt = CommitReceipt {
                slot_id: namespace_slot.clone(),
                pre_state: before.state,
                pre_content: before.content.clone(),
                pre_revision: before.revision.clone(),
                post_revision: present_revision(
                    &namespace_slot,
                    FileIdentity::from_metadata(&temp_metadata),
                    content.as_bytes(),
                ),
                abandoned_lock: false,
            };
            renameat(parent.as_raw_fd(), &temporary, &leaf)?;
            committed_receipt = Some(receipt.clone());
            if let Err(location_error) = self.ensure_parent_location(&relative, parent) {
                match rollback_after_parent_escape(
                    parent,
                    &leaf,
                    &before,
                    existing_metadata.as_ref(),
                ) {
                    Ok(()) => {
                        committed_receipt = None;
                        return Err(location_error);
                    }
                    Err(rollback_error) => {
                        return Ok(CommitOutcome::CommittedUncertain {
                            receipt,
                            message: format!(
                                "trusted text parent moved after replacement and rollback could not be proven: {}; {}",
                                location_error.message, rollback_error.message,
                            ),
                        });
                    }
                }
            }
            if let Err(sync_error) = sync_directory(parent) {
                return Ok(CommitOutcome::CommittedUncertain {
                    receipt,
                    message: format!(
                        "atomic replacement completed but parent-directory durability could not be proven: {}",
                        sync_error.message
                    ),
                });
            }
            Ok(CommitOutcome::Written(receipt))
        })();
        if committed_receipt.is_some() {
            result
        } else {
            finish_uncommitted_cleanup(parent.as_raw_fd(), &temporary, result)
        }
    }

    fn validate_target(&self, target: &str) -> Result<PathBuf, TextTransactionError> {
        let target = validate_absolute_path(target)?;
        let canonical_relative = target.strip_prefix(&self.root_path).ok();
        let authorized_relative = target.strip_prefix(&self.authorized_root_path).ok();
        let relative = match (canonical_relative, authorized_relative) {
            (Some(canonical), Some(authorized)) if canonical != authorized => {
                return Err(TextTransactionError::new(
                    TextTransactionErrorCode::UnauthorizedPath,
                    "text mutation target has an ambiguous trusted-root spelling",
                ));
            }
            (Some(relative), _) | (_, Some(relative)) => relative,
            (None, None) => {
                return Err(TextTransactionError::new(
                    TextTransactionErrorCode::UnauthorizedPath,
                    "text mutation target is outside the trusted root",
                ));
            }
        };
        if relative.as_os_str().is_empty() {
            return Err(TextTransactionError::new(
                TextTransactionErrorCode::UnauthorizedPath,
                "trusted text root itself is not a file target",
            ));
        }
        for component in relative.components() {
            if !matches!(component, Component::Normal(_)) {
                return Err(TextTransactionError::invalid_path(
                    "trusted text target contains a relative or special component",
                ));
            }
            if let Component::Normal(value) = component
                && path_text(Path::new(value))?.eq_ignore_ascii_case(".git")
            {
                return Err(TextTransactionError::new(
                    TextTransactionErrorCode::UnauthorizedPath,
                    "trusted text mutation denied protected Git metadata",
                ));
            }
        }
        Ok(relative.to_path_buf())
    }

    fn namespace_slot_id(&self, relative: &Path) -> Result<String, TextTransactionError> {
        let mut directory = self
            .root
            .try_clone()
            .map_err(|error| io_error("cannot inspect trusted text namespace", error))?;
        let mut case_insensitive = self.namespace_case_insensitive(&directory)?;
        let mut unresolved = false;
        let mut normalized = normalized_namespace_name(
            &path_text(&self.root_path)?,
            self.filesystem.case_insensitive,
            self.filesystem.canonical_unicode,
        );
        for component in relative.components() {
            let Component::Normal(value) = component else {
                return Err(TextTransactionError::invalid_path(
                    "trusted text namespace contains a special component",
                ));
            };
            let name = path_text(Path::new(value))?;
            normalized.push('/');
            normalized.push_str(&normalized_namespace_name(
                &name,
                case_insensitive,
                self.filesystem.canonical_unicode,
            ));
            if !unresolved {
                if let Some(next) = openat_directory_optional(directory.as_raw_fd(), &name)? {
                    self.ensure_same_filesystem(&next)?;
                    directory = next;
                    case_insensitive = self.namespace_case_insensitive(&directory)?;
                } else {
                    unresolved = true;
                }
            }
        }
        Ok(namespace_slot_id(self.identity.device, &normalized))
    }

    fn namespace_case_insensitive(&self, directory: &File) -> Result<bool, TextTransactionError> {
        if self.filesystem.case_insensitive {
            return Ok(true);
        }
        directory_casefolded(directory)
    }

    fn coordination_slot_id(
        &self,
        parent: &File,
        leaf: &str,
    ) -> Result<String, TextTransactionError> {
        let metadata = parent
            .metadata()
            .map_err(|error| io_error("cannot inspect trusted text parent identity", error))?;
        let normalized = normalized_namespace_name(
            leaf,
            self.namespace_case_insensitive(parent)?,
            self.filesystem.canonical_unicode,
        );
        let mut hash = Sha256::new();
        hash.update(b"kodax-text-coordination-slot-v1\0");
        hash.update(metadata.dev().to_le_bytes());
        hash.update(metadata.ino().to_le_bytes());
        hash.update(normalized.as_bytes());
        Ok(format!("{:x}", hash.finalize()))
    }

    fn ensure_root_location(&self) -> Result<(), TextTransactionError> {
        let current = open_path_no_follow(&self.root_path, libc::O_RDONLY | libc::O_DIRECTORY)
            .map_err(|_| {
                TextTransactionError::new(
                    TextTransactionErrorCode::UnauthorizedPath,
                    "trusted text root moved or changed identity",
                )
            })?;
        let metadata = current
            .metadata()
            .map_err(|error| io_error("cannot revalidate trusted text root", error))?;
        if FileIdentity::from_metadata(&metadata) != self.identity {
            return Err(TextTransactionError::new(
                TextTransactionErrorCode::UnauthorizedPath,
                "trusted text root moved or changed identity",
            ));
        }
        if supported_local_filesystem(&current)? != self.filesystem
            || mount_identity(&current)? != self.mount
        {
            return Err(TextTransactionError::new(
                TextTransactionErrorCode::UnsupportedFilesystem,
                "trusted text root changed filesystem identity",
            ));
        }
        Ok(())
    }

    fn ensure_same_filesystem(&self, file: &File) -> Result<(), TextTransactionError> {
        let metadata = file
            .metadata()
            .map_err(|error| io_error("cannot inspect trusted text filesystem identity", error))?;
        if metadata.dev() != self.identity.device
            || supported_local_filesystem(file)? != self.filesystem
            || mount_identity(file)? != self.mount
        {
            return Err(TextTransactionError::new(
                TextTransactionErrorCode::UnsupportedFilesystem,
                "trusted text transaction crossed a filesystem boundary",
            ));
        }
        Ok(())
    }

    fn open_parent(
        &self,
        relative: &Path,
        create: bool,
    ) -> Result<Option<(Vec<File>, String)>, TextTransactionError> {
        let components = relative
            .components()
            .map(|component| match component {
                Component::Normal(value) => path_text(Path::new(value)),
                _ => Err(TextTransactionError::invalid_path(
                    "invalid Unix text target component",
                )),
            })
            .collect::<Result<Vec<_>, _>>()?;
        let (leaf, directories) = components.split_last().ok_or_else(|| {
            TextTransactionError::invalid_path("trusted text target has no filename")
        })?;
        let mut parents = Vec::with_capacity(directories.len());
        for directory in directories {
            let parent_fd = parents.last().unwrap_or(&self.root).as_raw_fd();
            match openat_directory(parent_fd, directory) {
                Ok(opened) => parents.push(opened),
                Err(error)
                    if error.code == TextTransactionErrorCode::Io
                        && error.os_code == Some(libc::ENOENT as u32) =>
                {
                    if !create {
                        return Ok(None);
                    }
                    mkdirat(parent_fd, directory)?;
                    parents.push(openat_directory(parent_fd, directory)?);
                }
                Err(error) => return Err(error),
            }
        }
        Ok(Some((parents, leaf.clone())))
    }

    fn ensure_parent_location(
        &self,
        relative: &Path,
        held_parent: &File,
    ) -> Result<(), TextTransactionError> {
        self.ensure_root_location()?;
        let Some((parents, _)) = self.open_parent(relative, false)? else {
            return Err(TextTransactionError::new(
                TextTransactionErrorCode::UnauthorizedPath,
                "trusted text parent moved during commit",
            ));
        };
        let current = parents.last().unwrap_or(&self.root);
        let held = held_parent
            .metadata()
            .map_err(|error| io_error("cannot inspect held text parent", error))?;
        let observed = current
            .metadata()
            .map_err(|error| io_error("cannot inspect current text parent", error))?;
        if FileIdentity::from_metadata(&held) != FileIdentity::from_metadata(&observed) {
            return Err(TextTransactionError::new(
                TextTransactionErrorCode::UnauthorizedPath,
                "trusted text parent changed identity during commit",
            ));
        }
        Ok(())
    }
}

fn open_lock_directory(
    state_root: &str,
) -> Result<(File, PathBuf, FileIdentity), TextTransactionError> {
    let uid = unsafe { libc::geteuid() };
    let state_path = validate_absolute_path(state_root)?;
    let canonical_state = fs::canonicalize(&state_path)
        .map_err(|error| io_error("cannot canonicalize protected text state root", error))?;
    let state = open_path_no_follow(&canonical_state, libc::O_RDONLY | libc::O_DIRECTORY)?;
    let state_metadata = state
        .metadata()
        .map_err(|error| io_error("cannot inspect protected text state root", error))?;
    if !state_metadata.is_dir() || state_metadata.uid() != uid || state_metadata.mode() & 0o077 != 0
    {
        return Err(TextTransactionError::new(
            TextTransactionErrorCode::Contended,
            "protected text state root is not private and host-owned",
        ));
    }
    match mkdirat_mode(state.as_raw_fd(), LOCK_DIRECTORY_NAME, 0o700) {
        Ok(()) => {}
        Err(error) if error.os_code == Some(libc::EEXIST as u32) => {}
        Err(error) => return Err(error),
    }
    let handle = openat_directory(state.as_raw_fd(), LOCK_DIRECTORY_NAME)?;
    let metadata = handle
        .metadata()
        .map_err(|error| io_error("cannot inspect text transaction lock directory", error))?;
    if !metadata.is_dir() || metadata.uid() != uid || metadata.mode() & 0o077 != 0 {
        return Err(TextTransactionError::new(
            TextTransactionErrorCode::Contended,
            "trusted text transaction lock directory is not private and host-owned",
        ));
    }
    let directory = canonical_state.join(LOCK_DIRECTORY_NAME);
    let identity = FileIdentity::from_metadata(&metadata);
    revalidate_directory_path(&directory, identity)?;
    Ok((handle, directory, identity))
}

fn revalidate_directory_path(
    path: &Path,
    expected: FileIdentity,
) -> Result<(), TextTransactionError> {
    let current = open_path_no_follow(path, libc::O_RDONLY | libc::O_DIRECTORY).map_err(|_| {
        TextTransactionError::new(
            TextTransactionErrorCode::Contended,
            "trusted text transaction coordination directory moved",
        )
    })?;
    let metadata = current
        .metadata()
        .map_err(|error| io_error("cannot revalidate text transaction coordination", error))?;
    if FileIdentity::from_metadata(&metadata) != expected {
        return Err(TextTransactionError::new(
            TextTransactionErrorCode::Contended,
            "trusted text transaction coordination directory changed identity",
        ));
    }
    Ok(())
}

fn validate_absolute_path(value: &str) -> Result<PathBuf, TextTransactionError> {
    if value.is_empty() || value.contains('\0') {
        return Err(TextTransactionError::invalid_path(
            "Unix text mutation path is empty or contains NUL",
        ));
    }
    let path = PathBuf::from(value);
    if !path.is_absolute() {
        return Err(TextTransactionError::invalid_path(
            "Unix text mutation path must be absolute",
        ));
    }
    for component in path.components() {
        if matches!(component, Component::ParentDir | Component::CurDir) {
            return Err(TextTransactionError::invalid_path(
                "Unix text mutation path contains a relative component",
            ));
        }
    }
    Ok(path)
}

fn open_path_no_follow(path: &Path, flags: i32) -> Result<File, TextTransactionError> {
    OpenOptions::new()
        .read(true)
        .custom_flags(flags | libc::O_CLOEXEC | libc::O_NOFOLLOW)
        .open(path)
        .map_err(|error| no_follow_error("cannot open trusted Unix path", error))
}

fn openat_directory(parent: RawFd, name: &str) -> Result<File, TextTransactionError> {
    openat(parent, name, libc::O_RDONLY | libc::O_DIRECTORY, 0)
}

fn openat_directory_optional(
    parent: RawFd,
    name: &str,
) -> Result<Option<File>, TextTransactionError> {
    match openat_directory(parent, name) {
        Ok(file) => Ok(Some(file)),
        Err(error)
            if error.code == TextTransactionErrorCode::Io
                && error.os_code == Some(libc::ENOENT as u32) =>
        {
            Ok(None)
        }
        Err(error)
            if error.code == TextTransactionErrorCode::ReparsePoint
                && error.os_code == Some(libc::ENOTDIR as u32) =>
        {
            Ok(None)
        }
        Err(error) => Err(error),
    }
}

fn openat_file(parent: RawFd, name: &str) -> Result<Option<File>, TextTransactionError> {
    match openat(parent, name, libc::O_RDONLY, 0) {
        Ok(file) => Ok(Some(file)),
        Err(error)
            if error.code == TextTransactionErrorCode::Io
                && error.os_code == Some(libc::ENOENT as u32) =>
        {
            Ok(None)
        }
        Err(error) => Err(error),
    }
}

fn openat_create_exclusive(parent: RawFd, name: &str) -> Result<File, TextTransactionError> {
    openat(
        parent,
        name,
        libc::O_RDWR | libc::O_CREAT | libc::O_EXCL,
        0o600,
    )
}

fn openat(
    parent: RawFd,
    name: &str,
    flags: i32,
    mode: libc::mode_t,
) -> Result<File, TextTransactionError> {
    let name = c_string(name)?;
    let fd = unsafe {
        libc::openat(
            parent,
            name.as_ptr(),
            flags | libc::O_CLOEXEC | libc::O_NOFOLLOW,
            libc::c_uint::from(mode),
        )
    };
    if fd < 0 {
        return Err(no_follow_error(
            "cannot open trusted Unix path component",
            std::io::Error::last_os_error(),
        ));
    }
    Ok(unsafe { File::from_raw_fd(fd) })
}

fn mkdirat(parent: RawFd, name: &str) -> Result<(), TextTransactionError> {
    mkdirat_mode(parent, name, 0o777)
}

fn mkdirat_mode(parent: RawFd, name: &str, mode: libc::mode_t) -> Result<(), TextTransactionError> {
    let name = c_string(name)?;
    if unsafe { libc::mkdirat(parent, name.as_ptr(), mode) } != 0 {
        let error = std::io::Error::last_os_error();
        if error.kind() != std::io::ErrorKind::AlreadyExists {
            return Err(no_follow_error("cannot create trusted text parent", error));
        }
    }
    Ok(())
}

fn renameat(parent: RawFd, from: &str, to: &str) -> Result<(), TextTransactionError> {
    let from = c_string(from)?;
    let to = c_string(to)?;
    if unsafe { libc::renameat(parent, from.as_ptr(), parent, to.as_ptr()) } != 0 {
        return Err(io_error(
            "cannot atomically replace trusted text target",
            std::io::Error::last_os_error(),
        ));
    }
    Ok(())
}

fn unlinkat(parent: RawFd, name: &str) -> Result<(), TextTransactionError> {
    let name = c_string(name)?;
    if unsafe { libc::unlinkat(parent, name.as_ptr(), 0) } != 0 {
        return Err(io_error(
            "cannot remove text transaction temporary file",
            std::io::Error::last_os_error(),
        ));
    }
    Ok(())
}

fn unlink_temporary_if_exists(parent: RawFd, name: &str) -> Result<(), TextTransactionError> {
    #[cfg(test)]
    if take_fail_next_temporary_cleanup() {
        return Err(TextTransactionError::os(
            TextTransactionErrorCode::Io,
            "text transaction temporary cleanup failed (injected)",
            libc::EACCES as u32,
        ));
    }

    let name = c_string(name)?;
    if unsafe { libc::unlinkat(parent, name.as_ptr(), 0) } == 0 {
        return Ok(());
    }
    let error = std::io::Error::last_os_error();
    if error.kind() == std::io::ErrorKind::NotFound {
        return Ok(());
    }
    Err(io_error("text transaction temporary cleanup failed", error))
}

fn finish_uncommitted_cleanup<T>(
    parent: RawFd,
    temporary: &str,
    result: Result<T, TextTransactionError>,
) -> Result<T, TextTransactionError> {
    let cleanup = unlink_temporary_if_exists(parent, temporary);
    match (result, cleanup) {
        (result, Ok(())) => result,
        (Ok(_), Err(cleanup_error)) => Err(cleanup_error),
        (Err(mut primary_error), Err(cleanup_error)) => {
            primary_error.message = format!(
                "{}; text transaction temporary cleanup also failed: {}",
                primary_error.message, cleanup_error.message,
            );
            if primary_error.os_code.is_none() {
                primary_error.os_code = cleanup_error.os_code;
            }
            Err(primary_error)
        }
    }
}

fn read_snapshot(
    parent: RawFd,
    leaf: &str,
    slot_id: &str,
    canonical_path: &str,
    expected_mount: MountIdentity,
) -> Result<TextSnapshot, TextTransactionError> {
    let Some(mut file) = openat_file(parent, leaf)? else {
        return Ok(missing_snapshot(
            slot_id.to_owned(),
            canonical_path.to_owned(),
        ));
    };
    let metadata = file
        .metadata()
        .map_err(|error| io_error("cannot inspect trusted text target", error))?;
    if mount_identity(&file)? != expected_mount {
        return Err(TextTransactionError::new(
            TextTransactionErrorCode::UnauthorizedPath,
            "trusted text target crossed a mount boundary",
        ));
    }
    if !metadata.is_file() {
        return Err(TextTransactionError::new(
            TextTransactionErrorCode::InvalidPath,
            "trusted text target is not an ordinary file",
        ));
    }
    if metadata.nlink() != 1 {
        return Err(TextTransactionError::new(
            TextTransactionErrorCode::HardLink,
            "trusted text target has multiple hard links",
        ));
    }
    if metadata.len() > MAX_TEXT_BYTES as u64 {
        return Err(TextTransactionError::new(
            TextTransactionErrorCode::Io,
            "trusted text target exceeds the 64 MiB bound",
        ));
    }
    let mut bytes = Vec::with_capacity(metadata.len() as usize);
    file.read_to_end(&mut bytes)
        .map_err(|error| io_error("cannot read trusted text target", error))?;
    let content = String::from_utf8(bytes.clone()).map_err(|_| {
        TextTransactionError::new(
            TextTransactionErrorCode::Io,
            "trusted text target is not UTF-8",
        )
    })?;
    let identity = FileIdentity::from_metadata(&metadata);
    Ok(TextSnapshot {
        state: ResourceState::Present,
        content,
        revision: present_revision(slot_id, identity, &bytes),
        slot_id: slot_id.to_owned(),
        canonical_path: canonical_path.to_owned(),
    })
}

fn missing_snapshot(slot_id: String, canonical_path: String) -> TextSnapshot {
    TextSnapshot {
        state: ResourceState::Missing,
        content: String::new(),
        revision: format!("missing:{slot_id}"),
        slot_id,
        canonical_path,
    }
}

fn preserve_metadata(
    file: &File,
    source: &File,
    metadata: &fs::Metadata,
) -> Result<(), TextTransactionError> {
    if unsafe { libc::fchown(file.as_raw_fd(), metadata.uid(), metadata.gid()) } != 0 {
        return Err(metadata_error(
            "cannot preserve trusted text ownership",
            std::io::Error::last_os_error(),
        ));
    }
    file.set_permissions(fs::Permissions::from_mode(metadata.mode() & 0o7777))
        .map_err(|error| metadata_error("cannot preserve trusted text permissions", error))?;
    copy_extended_acl(source, file)?;
    copy_extended_attributes(source, file)?;
    copy_platform_flags(source, file)?;
    let observed = file
        .metadata()
        .map_err(|error| metadata_error("cannot verify trusted text metadata", error))?;
    if observed.uid() != metadata.uid()
        || observed.gid() != metadata.gid()
        || observed.mode() & 0o7777 != metadata.mode() & 0o7777
    {
        return Err(TextTransactionError::new(
            TextTransactionErrorCode::MetadataPreservation,
            "trusted text ownership or permissions changed during replacement",
        ));
    }
    Ok(())
}

#[cfg(target_os = "linux")]
fn copy_extended_acl(_source: &File, _destination: &File) -> Result<(), TextTransactionError> {
    Ok(())
}

#[cfg(target_os = "macos")]
fn copy_extended_acl(source: &File, destination: &File) -> Result<(), TextTransactionError> {
    if unsafe {
        libc::fcopyfile(
            source.as_raw_fd(),
            destination.as_raw_fd(),
            std::ptr::null_mut(),
            libc::COPYFILE_ACL,
        )
    } != 0
    {
        return Err(metadata_error(
            "cannot preserve trusted text extended ACL",
            std::io::Error::last_os_error(),
        ));
    }
    if extended_acl_text(source)? != extended_acl_text(destination)? {
        return Err(TextTransactionError::new(
            TextTransactionErrorCode::MetadataPreservation,
            "trusted text extended ACL changed during replacement",
        ));
    }
    Ok(())
}

#[cfg(target_os = "macos")]
fn extended_acl_text(file: &File) -> Result<Vec<u8>, TextTransactionError> {
    const ACL_TYPE_EXTENDED: c_int = 0x0000_0100;
    unsafe extern "C" {
        fn acl_get_fd_np(fd: c_int, acl_type: c_int) -> *mut c_void;
        fn acl_to_text(acl: *mut c_void, length: *mut libc::ssize_t) -> *mut c_char;
        fn acl_free(object: *mut c_void) -> c_int;
    }

    let acl = unsafe { acl_get_fd_np(file.as_raw_fd(), ACL_TYPE_EXTENDED) };
    if acl.is_null() {
        return Err(metadata_error(
            "cannot read trusted text extended ACL",
            std::io::Error::last_os_error(),
        ));
    }
    let mut length = 0;
    let text = unsafe { acl_to_text(acl, &mut length) };
    if text.is_null() || length < 0 {
        unsafe { acl_free(acl) };
        return Err(metadata_error(
            "cannot serialize trusted text extended ACL",
            std::io::Error::last_os_error(),
        ));
    }
    let bytes = unsafe { std::slice::from_raw_parts(text.cast::<u8>(), length as usize) }.to_vec();
    unsafe {
        acl_free(text.cast());
        acl_free(acl);
    }
    Ok(bytes)
}

fn rollback_after_parent_escape(
    parent: &File,
    leaf: &str,
    before: &TextSnapshot,
    existing_metadata: Option<&(File, fs::Metadata)>,
) -> Result<(), TextTransactionError> {
    if before.state == ResourceState::Missing {
        unlinkat(parent.as_raw_fd(), leaf)?;
        sync_directory(parent)?;
        return Ok(());
    }
    let (source, metadata) = existing_metadata.ok_or_else(|| {
        TextTransactionError::new(
            TextTransactionErrorCode::MetadataPreservation,
            "trusted text rollback lost the original file metadata handle",
        )
    })?;
    let rollback_name = format!(".kodax-tx-rollback-{}.tmp", Uuid::new_v4().simple());
    let mut rollback = openat_create_exclusive(parent.as_raw_fd(), &rollback_name)?;
    let result = (|| {
        rollback
            .write_all(before.content.as_bytes())
            .map_err(|error| io_error("cannot restore escaped text transaction", error))?;
        preserve_metadata(&rollback, source, metadata)?;
        rollback
            .sync_all()
            .map_err(|error| io_error("cannot flush escaped text rollback", error))?;
        renameat(parent.as_raw_fd(), &rollback_name, leaf)?;
        sync_directory(parent)
    })();
    if result.is_ok() {
        result
    } else {
        finish_uncommitted_cleanup(parent.as_raw_fd(), &rollback_name, result)
    }
}

fn copy_extended_attributes(source: &File, destination: &File) -> Result<(), TextTransactionError> {
    let names = list_extended_attributes(source)?;
    let mut total = 0usize;
    for name in names {
        let value = read_extended_attribute(source, &name)?;
        total = total.checked_add(value.len()).ok_or_else(|| {
            TextTransactionError::new(
                TextTransactionErrorCode::MetadataPreservation,
                "trusted text extended attributes exceed the supported bound",
            )
        })?;
        if total > MAX_XATTR_BYTES {
            return Err(TextTransactionError::new(
                TextTransactionErrorCode::MetadataPreservation,
                "trusted text extended attributes exceed the 64 MiB bound",
            ));
        }
        write_extended_attribute(destination, &name, &value)?;
    }
    let source_names = list_extended_attributes(source)?;
    let destination_names = list_extended_attributes(destination)?;
    if source_names != destination_names {
        return Err(TextTransactionError::new(
            TextTransactionErrorCode::MetadataPreservation,
            "trusted text extended attribute names changed during replacement",
        ));
    }
    for name in source_names {
        if read_extended_attribute(source, &name)? != read_extended_attribute(destination, &name)? {
            return Err(TextTransactionError::new(
                TextTransactionErrorCode::MetadataPreservation,
                "trusted text extended attribute changed during replacement",
            ));
        }
    }
    Ok(())
}

fn list_extended_attributes(file: &File) -> Result<Vec<Vec<u8>>, TextTransactionError> {
    let size = platform_flistxattr(file.as_raw_fd(), std::ptr::null_mut(), 0)?;
    if size > MAX_XATTR_BYTES {
        return Err(TextTransactionError::new(
            TextTransactionErrorCode::MetadataPreservation,
            "trusted text extended attribute names exceed the supported bound",
        ));
    }
    if size == 0 {
        return Ok(Vec::new());
    }
    let mut bytes = vec![0u8; size];
    let observed = platform_flistxattr(file.as_raw_fd(), bytes.as_mut_ptr().cast(), bytes.len())?;
    if observed > bytes.len() {
        return Err(TextTransactionError::new(
            TextTransactionErrorCode::MetadataPreservation,
            "trusted text extended attribute list changed while reading",
        ));
    }
    bytes.truncate(observed);
    let mut names = bytes
        .split(|byte| *byte == 0)
        .filter(|name| !name.is_empty())
        .map(ToOwned::to_owned)
        .collect::<Vec<_>>();
    names.sort();
    names.dedup();
    Ok(names)
}

fn read_extended_attribute(file: &File, name: &[u8]) -> Result<Vec<u8>, TextTransactionError> {
    let name = CString::new(name).map_err(|_| {
        TextTransactionError::new(
            TextTransactionErrorCode::MetadataPreservation,
            "trusted text extended attribute name contains NUL",
        )
    })?;
    let size = platform_fgetxattr(file.as_raw_fd(), name.as_ptr(), std::ptr::null_mut(), 0)?;
    if size > MAX_XATTR_BYTES {
        return Err(TextTransactionError::new(
            TextTransactionErrorCode::MetadataPreservation,
            "trusted text extended attribute exceeds the supported bound",
        ));
    }
    let mut value = vec![0u8; size];
    if size > 0 {
        let observed = platform_fgetxattr(
            file.as_raw_fd(),
            name.as_ptr(),
            value.as_mut_ptr().cast(),
            value.len(),
        )?;
        if observed != value.len() {
            return Err(TextTransactionError::new(
                TextTransactionErrorCode::MetadataPreservation,
                "trusted text extended attribute changed while reading",
            ));
        }
    }
    Ok(value)
}

fn write_extended_attribute(
    file: &File,
    name: &[u8],
    value: &[u8],
) -> Result<(), TextTransactionError> {
    let name = CString::new(name).map_err(|_| {
        TextTransactionError::new(
            TextTransactionErrorCode::MetadataPreservation,
            "trusted text extended attribute name contains NUL",
        )
    })?;
    platform_fsetxattr(file.as_raw_fd(), name.as_ptr(), value)
}

#[cfg(target_os = "linux")]
fn platform_flistxattr(
    fd: RawFd,
    buffer: *mut libc::c_char,
    size: usize,
) -> Result<usize, TextTransactionError> {
    syscall_size(
        unsafe { libc::flistxattr(fd, buffer, size) },
        "cannot list trusted text extended attributes",
    )
}

#[cfg(target_os = "macos")]
fn platform_flistxattr(
    fd: RawFd,
    buffer: *mut libc::c_char,
    size: usize,
) -> Result<usize, TextTransactionError> {
    syscall_size(
        unsafe { libc::flistxattr(fd, buffer, size, 0) },
        "cannot list trusted text extended attributes",
    )
}

#[cfg(target_os = "linux")]
fn platform_fgetxattr(
    fd: RawFd,
    name: *const libc::c_char,
    buffer: *mut libc::c_void,
    size: usize,
) -> Result<usize, TextTransactionError> {
    syscall_size(
        unsafe { libc::fgetxattr(fd, name, buffer, size) },
        "cannot read trusted text extended attribute",
    )
}

#[cfg(target_os = "macos")]
fn platform_fgetxattr(
    fd: RawFd,
    name: *const libc::c_char,
    buffer: *mut libc::c_void,
    size: usize,
) -> Result<usize, TextTransactionError> {
    syscall_size(
        unsafe { libc::fgetxattr(fd, name, buffer, size, 0, 0) },
        "cannot read trusted text extended attribute",
    )
}

#[cfg(target_os = "linux")]
fn platform_fsetxattr(
    fd: RawFd,
    name: *const libc::c_char,
    value: &[u8],
) -> Result<(), TextTransactionError> {
    syscall_zero(
        unsafe { libc::fsetxattr(fd, name, value.as_ptr().cast(), value.len(), 0) },
        "cannot preserve trusted text extended attribute",
    )
}

#[cfg(target_os = "macos")]
fn platform_fsetxattr(
    fd: RawFd,
    name: *const libc::c_char,
    value: &[u8],
) -> Result<(), TextTransactionError> {
    syscall_zero(
        unsafe { libc::fsetxattr(fd, name, value.as_ptr().cast(), value.len(), 0, 0) },
        "cannot preserve trusted text extended attribute",
    )
}

fn syscall_size(value: libc::ssize_t, message: &str) -> Result<usize, TextTransactionError> {
    if value < 0 {
        return Err(metadata_error(message, std::io::Error::last_os_error()));
    }
    usize::try_from(value).map_err(|_| {
        TextTransactionError::new(
            TextTransactionErrorCode::MetadataPreservation,
            "trusted text metadata size is invalid",
        )
    })
}

fn syscall_zero(value: libc::c_int, message: &str) -> Result<(), TextTransactionError> {
    if value != 0 {
        return Err(metadata_error(message, std::io::Error::last_os_error()));
    }
    Ok(())
}

#[cfg(target_os = "linux")]
fn copy_platform_flags(source: &File, destination: &File) -> Result<(), TextTransactionError> {
    const FS_FL_USER_MODIFIABLE: u32 = 0x0003_80ff;

    let source_flags = match linux_file_flags(source) {
        Ok(flags) => flags & FS_FL_USER_MODIFIABLE,
        Err(error) if linux_flags_are_unsupported(&error) => return Ok(()),
        Err(error) => {
            return Err(metadata_error(
                "cannot inspect trusted text file flags",
                error,
            ));
        }
    };
    let destination_flags = linux_file_flags(destination)
        .map_err(|error| metadata_error("cannot inspect replacement text file flags", error))?
        & FS_FL_USER_MODIFIABLE;
    if destination_flags != source_flags {
        if unsafe {
            libc::ioctl(
                destination.as_raw_fd(),
                libc::FS_IOC_SETFLAGS,
                &source_flags,
            )
        } != 0
        {
            return Err(metadata_error(
                "cannot preserve trusted text file flags",
                std::io::Error::last_os_error(),
            ));
        }
    }
    let observed = linux_file_flags(destination)
        .map_err(|error| metadata_error("cannot verify trusted text file flags", error))?
        & FS_FL_USER_MODIFIABLE;
    if observed != source_flags {
        return Err(TextTransactionError::new(
            TextTransactionErrorCode::MetadataPreservation,
            "trusted text file flags changed during replacement",
        ));
    }
    Ok(())
}

#[cfg(target_os = "linux")]
fn linux_file_flags(file: &File) -> std::io::Result<u32> {
    let mut flags = 0u32;
    if unsafe { libc::ioctl(file.as_raw_fd(), libc::FS_IOC_GETFLAGS, &mut flags) } != 0 {
        return Err(std::io::Error::last_os_error());
    }
    Ok(flags)
}

#[cfg(target_os = "linux")]
fn linux_flags_are_unsupported(error: &std::io::Error) -> bool {
    matches!(error.raw_os_error(), Some(libc::ENOTTY | libc::EOPNOTSUPP))
}

#[cfg(target_os = "macos")]
fn copy_platform_flags(source: &File, destination: &File) -> Result<(), TextTransactionError> {
    use std::os::macos::fs::MetadataExt as MacMetadataExt;

    let source_flags = MacMetadataExt::st_flags(
        &source
            .metadata()
            .map_err(|error| metadata_error("cannot inspect trusted text file flags", error))?,
    );
    if unsafe { libc::fchflags(destination.as_raw_fd(), source_flags) } != 0 {
        return Err(metadata_error(
            "cannot preserve trusted text file flags",
            std::io::Error::last_os_error(),
        ));
    }
    let observed = MacMetadataExt::st_flags(
        &destination
            .metadata()
            .map_err(|error| metadata_error("cannot verify trusted text file flags", error))?,
    );
    if observed != source_flags {
        return Err(TextTransactionError::new(
            TextTransactionErrorCode::MetadataPreservation,
            "trusted text file flags changed during replacement",
        ));
    }
    Ok(())
}

fn sync_directory(directory: &File) -> Result<(), TextTransactionError> {
    #[cfg(test)]
    if take_fail_next_directory_sync() {
        return Err(TextTransactionError::new(
            TextTransactionErrorCode::Io,
            "injected parent-directory flush failure",
        ));
    }
    directory
        .sync_all()
        .map_err(|error| io_error("cannot flush trusted text parent directory", error))
}

fn namespace_slot_id(device: u64, normalized_path: &str) -> String {
    let mut hash = Sha256::new();
    hash.update(b"kodax-text-namespace-slot-v1\0");
    hash.update(device.to_le_bytes());
    hash.update(normalized_path.as_bytes());
    format!("{:x}", hash.finalize())
}

fn normalized_namespace_name(
    value: &str,
    case_insensitive: bool,
    canonical_unicode: bool,
) -> String {
    if case_insensitive {
        value.chars().nfd().default_case_fold().nfd().collect()
    } else if canonical_unicode {
        value.nfd().collect()
    } else {
        value.to_owned()
    }
}

#[cfg(target_os = "linux")]
fn directory_casefolded(directory: &File) -> Result<bool, TextTransactionError> {
    const FS_CASEFOLD_FL: u32 = 0x4000_0000;
    match linux_file_flags(directory) {
        Ok(flags) if flags & FS_CASEFOLD_FL != 0 => Err(TextTransactionError::new(
            TextTransactionErrorCode::UnsupportedFilesystem,
            "trusted text transactions reject Linux casefold directories",
        )),
        Ok(_) => Ok(false),
        Err(error) if linux_flags_are_unsupported(&error) => Ok(false),
        Err(error) => Err(io_error(
            "cannot inspect trusted text directory case semantics",
            error,
        )),
    }
}

#[cfg(target_os = "macos")]
fn directory_casefolded(_directory: &File) -> Result<bool, TextTransactionError> {
    Ok(false)
}

fn present_revision(slot_id: &str, identity: FileIdentity, bytes: &[u8]) -> String {
    let mut hash = Sha256::new();
    hash.update(b"kodax-text-revision-v1\0");
    hash.update(slot_id.as_bytes());
    hash.update(identity.device.to_le_bytes());
    hash.update(identity.inode.to_le_bytes());
    hash.update(bytes);
    format!("present:{:x}", hash.finalize())
}

fn path_text(path: &Path) -> Result<String, TextTransactionError> {
    path.to_str().map(str::to_owned).ok_or_else(|| {
        TextTransactionError::invalid_path("trusted text paths must be valid Unicode")
    })
}

fn c_string(value: &str) -> Result<CString, TextTransactionError> {
    CString::new(OsStr::new(value).as_bytes())
        .map_err(|_| TextTransactionError::invalid_path("trusted text path component contains NUL"))
}

fn no_follow_error(message: &str, error: std::io::Error) -> TextTransactionError {
    let code = error.raw_os_error();
    let kind = if matches!(code, Some(value) if value == libc::ELOOP || value == libc::ENOTDIR) {
        TextTransactionErrorCode::ReparsePoint
    } else {
        TextTransactionErrorCode::Io
    };
    TextTransactionError::os(kind, message, code.unwrap_or_default() as u32)
}

fn io_error(message: &str, error: std::io::Error) -> TextTransactionError {
    TextTransactionError::os(
        TextTransactionErrorCode::Io,
        message,
        error.raw_os_error().unwrap_or_default() as u32,
    )
}

fn metadata_error(message: &str, error: std::io::Error) -> TextTransactionError {
    TextTransactionError::os(
        TextTransactionErrorCode::MetadataPreservation,
        message,
        error.raw_os_error().unwrap_or_default() as u32,
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;
    use tempfile::tempdir;

    fn private_tempdir() -> tempfile::TempDir {
        tempfile::Builder::new()
            .permissions(fs::Permissions::from_mode(0o700))
            .tempdir()
            .unwrap()
    }

    #[test]
    fn same_revision_is_committed_once() {
        let directory = tempdir().unwrap();
        let state = private_tempdir();
        let root = TrustedRoot::open(
            directory.path().to_str().unwrap(),
            state.path().to_str().unwrap(),
        )
        .unwrap();
        let target = directory.path().join("hello.md");
        let target = target.to_str().unwrap();
        let snapshot = root.snapshot(target).unwrap();
        let receipt = match root
            .commit(target, &snapshot.revision, "hello", false, 5_000)
            .unwrap()
        {
            CommitOutcome::Written(receipt) => receipt,
            CommitOutcome::Stale { .. } => panic!("first commit unexpectedly became stale"),
            CommitOutcome::CommittedUncertain { .. } => {
                panic!("first commit durability unexpectedly became uncertain")
            }
        };
        assert_eq!(receipt.slot_id, snapshot.slot_id);
        assert_eq!(root.snapshot(target).unwrap().slot_id, snapshot.slot_id);
        assert!(matches!(
            root.commit(target, &snapshot.revision, "lost", false, 5_000)
                .unwrap(),
            CommitOutcome::Stale { .. }
        ));
        assert_eq!(fs::read_to_string(target).unwrap(), "hello");
    }

    #[test]
    fn atomic_replace_keeps_the_namespace_slot() {
        let directory = tempdir().unwrap();
        let state = private_tempdir();
        let target = directory.path().join("existing.md");
        fs::write(&target, "before").unwrap();
        let root = TrustedRoot::open(
            directory.path().to_str().unwrap(),
            state.path().to_str().unwrap(),
        )
        .unwrap();
        let before = root.snapshot(target.to_str().unwrap()).unwrap();
        let receipt = match root
            .commit(
                target.to_str().unwrap(),
                &before.revision,
                "after",
                false,
                5_000,
            )
            .unwrap()
        {
            CommitOutcome::Written(receipt) => receipt,
            CommitOutcome::Stale { .. } => panic!("replacement unexpectedly became stale"),
            CommitOutcome::CommittedUncertain { .. } => {
                panic!("replacement durability unexpectedly became uncertain")
            }
        };
        let after = root.snapshot(target.to_str().unwrap()).unwrap();
        assert_eq!(before.slot_id, receipt.slot_id);
        assert_eq!(before.slot_id, after.slot_id);
        assert_ne!(before.revision, after.revision);
    }

    #[test]
    fn missing_parents_and_overlapping_roots_keep_one_namespace_slot() {
        let directory = tempdir().unwrap();
        let state = private_tempdir();
        let nested_root = directory.path().join("nested");
        fs::create_dir(&nested_root).unwrap();
        let broad = TrustedRoot::open(
            directory.path().to_str().unwrap(),
            state.path().to_str().unwrap(),
        )
        .unwrap();
        let nested = TrustedRoot::open(
            nested_root.to_str().unwrap(),
            state.path().to_str().unwrap(),
        )
        .unwrap();
        let target = nested_root.join("missing").join("child.md");
        let target = target.to_str().unwrap();
        let broad_snapshot = broad.snapshot(target).unwrap();
        let nested_snapshot = nested.snapshot(target).unwrap();
        assert_eq!(broad_snapshot.slot_id, nested_snapshot.slot_id);

        let receipt = match broad
            .commit(target, &broad_snapshot.revision, "created", true, 5_000)
            .unwrap()
        {
            CommitOutcome::Written(receipt) => receipt,
            CommitOutcome::Stale { .. } => panic!("createParents commit unexpectedly became stale"),
            CommitOutcome::CommittedUncertain { .. } => {
                panic!("createParents durability unexpectedly became uncertain")
            }
        };
        assert_eq!(receipt.slot_id, broad_snapshot.slot_id);
        assert_eq!(nested.snapshot(target).unwrap().slot_id, receipt.slot_id);
        assert_eq!(fs::read_to_string(target).unwrap(), "created");
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn atomic_replace_preserves_extended_acl() {
        use std::process::Command;

        let directory = tempdir().unwrap();
        let state = private_tempdir();
        let target = directory.path().join("acl.md");
        fs::write(&target, "before").unwrap();
        assert!(
            Command::new("chmod")
                .args(["+a", "everyone deny delete", target.to_str().unwrap()])
                .status()
                .unwrap()
                .success()
        );
        let source = File::open(&target).unwrap();
        let acl_before = extended_acl_text(&source).unwrap();
        assert!(!acl_before.is_empty());

        let root = TrustedRoot::open(
            directory.path().to_str().unwrap(),
            state.path().to_str().unwrap(),
        )
        .unwrap();
        let snapshot = root.snapshot(target.to_str().unwrap()).unwrap();
        assert!(matches!(
            root.commit(
                target.to_str().unwrap(),
                &snapshot.revision,
                "after",
                false,
                5_000,
            )
            .unwrap(),
            CommitOutcome::Written(_)
        ));
        assert_eq!(
            acl_before,
            extended_acl_text(&File::open(&target).unwrap()).unwrap()
        );
    }

    #[test]
    fn directory_sync_failure_preserves_the_commit_and_its_receipt() {
        let directory = tempdir().unwrap();
        let state = private_tempdir();
        let target = directory.path().join("post-commit-failure.txt");
        fs::write(&target, "before").unwrap();
        let root = TrustedRoot::open(
            directory.path().to_str().unwrap(),
            state.path().to_str().unwrap(),
        )
        .unwrap();
        let snapshot = root.snapshot(target.to_str().unwrap()).unwrap();
        FAIL_NEXT_DIRECTORY_SYNC.with(|flag| flag.set(true));

        let outcome = root
            .commit(
                target.to_str().unwrap(),
                &snapshot.revision,
                "after",
                false,
                5_000,
            )
            .unwrap();
        let CommitOutcome::CommittedUncertain { receipt, message } = outcome else {
            panic!("directory flush failure did not preserve an uncertain receipt");
        };
        assert_eq!(receipt.pre_content, "before");
        assert!(message.contains("durability could not be proven"));
        assert_eq!(fs::read_to_string(&target).unwrap(), "after");
        assert!(matches!(
            root.commit(
                target.to_str().unwrap(),
                &snapshot.revision,
                "must-not-retry",
                false,
                5_000,
            )
            .unwrap(),
            CommitOutcome::Stale { .. }
        ));
        assert_eq!(fs::read_to_string(target).unwrap(), "after");
    }

    #[test]
    fn stale_commit_reports_temporary_cleanup_failure() {
        let directory = tempdir().unwrap();
        let parent = File::open(directory.path()).unwrap();
        let temporary = ".kodax-tx-stale.tmp";
        fs::write(directory.path().join(temporary), "candidate").unwrap();
        FAIL_NEXT_TEMPORARY_CLEANUP.with(|flag| flag.set(true));

        let result = finish_uncommitted_cleanup(
            parent.as_raw_fd(),
            temporary,
            Ok(CommitOutcome::Stale {
                current_revision: "present:peer".into(),
            }),
        )
        .unwrap_err();

        assert_eq!(result.code, TextTransactionErrorCode::Io);
        assert!(result.message.contains("temporary cleanup failed"));
    }

    #[test]
    fn rollback_failure_retains_primary_and_cleanup_evidence() {
        let directory = tempdir().unwrap();
        let parent = File::open(directory.path()).unwrap();
        let temporary = ".kodax-tx-rollback-failed.tmp";
        fs::write(directory.path().join(temporary), "preimage").unwrap();
        FAIL_NEXT_TEMPORARY_CLEANUP.with(|flag| flag.set(true));

        let result: Result<(), TextTransactionError> = finish_uncommitted_cleanup(
            parent.as_raw_fd(),
            temporary,
            Err(TextTransactionError::new(
                TextTransactionErrorCode::MetadataPreservation,
                "injected rollback failure",
            )),
        );
        let error = result.unwrap_err();

        assert_eq!(error.code, TextTransactionErrorCode::MetadataPreservation);
        assert!(error.message.contains("injected rollback failure"));
        assert!(error.message.contains("temporary cleanup also failed"));
    }

    #[test]
    fn symlink_and_hard_link_targets_are_rejected() {
        use std::os::unix::fs::symlink;

        let directory = tempdir().unwrap();
        let outside = tempdir().unwrap();
        let state = private_tempdir();
        symlink(outside.path(), directory.path().join("escape")).unwrap();
        let root = TrustedRoot::open(
            directory.path().to_str().unwrap(),
            state.path().to_str().unwrap(),
        )
        .unwrap();
        let linked = directory.path().join("escape").join("value.txt");
        assert_eq!(
            root.snapshot(linked.to_str().unwrap()).unwrap_err().code,
            TextTransactionErrorCode::ReparsePoint,
        );

        let original = directory.path().join("original.txt");
        let alias = directory.path().join("alias.txt");
        fs::write(&original, "secret").unwrap();
        fs::hard_link(&original, &alias).unwrap();
        assert_eq!(
            root.snapshot(alias.to_str().unwrap()).unwrap_err().code,
            TextTransactionErrorCode::HardLink,
        );
    }

    #[test]
    fn authorized_root_alias_keeps_targets_handle_relative() {
        use std::os::unix::fs::symlink;

        let directory = tempdir().unwrap();
        let state = private_tempdir();
        let actual = directory.path().join("actual");
        let alias = directory.path().join("alias");
        fs::create_dir(&actual).unwrap();
        symlink(&actual, &alias).unwrap();

        let root =
            TrustedRoot::open(alias.to_str().unwrap(), state.path().to_str().unwrap()).unwrap();
        let target = alias.join("hello.md");
        let snapshot = root.snapshot(target.to_str().unwrap()).unwrap();
        assert_eq!(
            snapshot.canonical_path,
            actual.join("hello.md").to_str().unwrap()
        );
        let canonical_snapshot = root
            .snapshot(actual.join("hello.md").to_str().unwrap())
            .unwrap();
        assert_eq!(canonical_snapshot.slot_id, snapshot.slot_id);
        assert_eq!(canonical_snapshot.revision, snapshot.revision);
        assert!(matches!(
            root.commit(
                target.to_str().unwrap(),
                &snapshot.revision,
                "hello",
                false,
                5_000,
            )
            .unwrap(),
            CommitOutcome::Written(_)
        ));
        assert_eq!(
            fs::read_to_string(actual.join("hello.md")).unwrap(),
            "hello"
        );
    }

    #[test]
    fn authorized_root_alias_retargeting_cannot_redirect_an_open_root() {
        use std::os::unix::fs::symlink;

        let directory = tempdir().unwrap();
        let state = private_tempdir();
        let original = directory.path().join("original");
        let replacement = directory.path().join("replacement");
        let alias = directory.path().join("alias");
        fs::create_dir(&original).unwrap();
        fs::create_dir(&replacement).unwrap();
        symlink(&original, &alias).unwrap();
        let root =
            TrustedRoot::open(alias.to_str().unwrap(), state.path().to_str().unwrap()).unwrap();

        fs::remove_file(&alias).unwrap();
        symlink(&replacement, &alias).unwrap();
        let target = alias.join("hello.md");
        let snapshot = root.snapshot(target.to_str().unwrap()).unwrap();
        assert!(matches!(
            root.commit(
                target.to_str().unwrap(),
                &snapshot.revision,
                "original",
                false,
                5_000,
            )
            .unwrap(),
            CommitOutcome::Written(_)
        ));
        assert_eq!(
            fs::read_to_string(original.join("hello.md")).unwrap(),
            "original"
        );
        assert!(!replacement.join("hello.md").exists());
    }

    #[test]
    fn overlapping_root_spellings_with_different_relatives_are_rejected() {
        use std::os::unix::fs::symlink;

        let directory = tempdir().unwrap();
        let state = private_tempdir();
        let actual = directory.path().join("actual");
        let alias = actual.join("alias");
        fs::create_dir(&actual).unwrap();
        symlink(&actual, &alias).unwrap();
        let root =
            TrustedRoot::open(alias.to_str().unwrap(), state.path().to_str().unwrap()).unwrap();

        assert_eq!(
            root.snapshot(alias.join("hello.md").to_str().unwrap())
                .unwrap_err()
                .code,
            TextTransactionErrorCode::UnauthorizedPath,
        );
    }

    #[test]
    fn replaced_coordination_directory_invalidates_the_old_lock_generation() {
        let state = private_tempdir();
        let (old_directory, path, identity) =
            open_lock_directory(state.path().to_str().unwrap()).unwrap();
        let old_lock = SlotLock::acquire(&old_directory, &path, identity, "same", 1_000).unwrap();
        let retired = state.path().join("retired-locks");
        fs::rename(&path, &retired).unwrap();
        fs::create_dir(&path).unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(0o700)).unwrap();

        let (new_directory, new_path, new_identity) =
            open_lock_directory(state.path().to_str().unwrap()).unwrap();
        let _new_lock =
            SlotLock::acquire(&new_directory, &new_path, new_identity, "same", 1_000).unwrap();
        assert_eq!(
            old_lock.revalidate().unwrap_err().code,
            TextTransactionErrorCode::Contended,
        );
    }

    #[test]
    fn case_insensitive_namespace_key_coalesces_case_and_unicode_aliases() {
        assert_eq!(
            normalized_namespace_name("Stra\u{df}e-Caf\u{e9}.MD", true, true),
            normalized_namespace_name("STRASSE-CAFE\u{301}.md", true, true),
        );
        assert_ne!(
            normalized_namespace_name("File.md", false, false),
            normalized_namespace_name("file.md", false, false),
        );
        assert_eq!(
            normalized_namespace_name("Caf\u{e9}.md", false, true),
            normalized_namespace_name("Cafe\u{301}.md", false, true),
        );
    }
}
