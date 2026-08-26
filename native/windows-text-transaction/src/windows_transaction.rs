use std::ffi::{OsStr, c_void};
use std::mem::{size_of, zeroed};
use std::os::windows::ffi::OsStrExt;
use std::ptr::{null, null_mut};
use std::sync::{Mutex, OnceLock};

use sha2::{Digest, Sha256};
use uuid::Uuid;
use windows_sys::Wdk::Foundation::OBJECT_ATTRIBUTES;
use windows_sys::Wdk::Storage::FileSystem::{
    FILE_CREATE, FILE_DIRECTORY_FILE, FILE_NON_DIRECTORY_FILE, FILE_OPEN, FILE_OPEN_REPARSE_POINT,
    FILE_OPEN_REQUIRING_OPLOCK, FILE_RENAME_IGNORE_READONLY_ATTRIBUTE, FILE_RENAME_INFORMATION,
    FILE_RENAME_POSIX_SEMANTICS, FILE_RENAME_REPLACE_IF_EXISTS, FILE_STREAM_INFORMATION,
    FILE_SYNCHRONOUS_IO_NONALERT, FileRenameInformationEx, FileStreamInformation, NtCreateFile,
    NtQueryInformationFile, NtSetInformationFile,
};
use windows_sys::Win32::Foundation::{
    CloseHandle, ERROR_ALREADY_EXISTS, ERROR_FILE_NOT_FOUND, ERROR_INSUFFICIENT_BUFFER,
    ERROR_IO_PENDING, ERROR_PATH_NOT_FOUND, GetLastError, HANDLE, INVALID_HANDLE_VALUE, LocalFree,
    OBJ_CASE_INSENSITIVE, RtlNtStatusToDosError, UNICODE_STRING, WAIT_ABANDONED, WAIT_OBJECT_0,
    WAIT_TIMEOUT,
};
use windows_sys::Win32::Security::Authorization::{
    ConvertSidToStringSidW, ConvertStringSecurityDescriptorToSecurityDescriptorW, GetSecurityInfo,
    SDDL_REVISION_1, SE_FILE_OBJECT, SetSecurityInfo,
};
use windows_sys::Win32::Security::{
    ACL, ACL_SIZE_INFORMATION, ATTRIBUTE_SECURITY_INFORMATION, AclSizeInformation,
    DACL_SECURITY_INFORMATION, EqualSid, GROUP_SECURITY_INFORMATION, GetAclInformation,
    GetSecurityDescriptorControl, GetTokenInformation, LABEL_SECURITY_INFORMATION,
    OWNER_SECURITY_INFORMATION, PROTECTED_DACL_SECURITY_INFORMATION, PSECURITY_DESCRIPTOR,
    SCOPE_SECURITY_INFORMATION, SE_DACL_PROTECTED, SECURITY_ATTRIBUTES, TOKEN_QUERY, TOKEN_USER,
    TokenUser, UNPROTECTED_DACL_SECURITY_INFORMATION,
};
use windows_sys::Win32::Storage::FileSystem::{
    CreateFileW, DELETE, FILE_ATTRIBUTE_COMPRESSED, FILE_ATTRIBUTE_ENCRYPTED,
    FILE_ATTRIBUTE_INTEGRITY_STREAM, FILE_ATTRIBUTE_NO_SCRUB_DATA, FILE_ATTRIBUTE_NORMAL,
    FILE_ATTRIBUTE_OFFLINE, FILE_ATTRIBUTE_RECALL_ON_DATA_ACCESS, FILE_ATTRIBUTE_REPARSE_POINT,
    FILE_ATTRIBUTE_SPARSE_FILE, FILE_ATTRIBUTE_TAG_INFO, FILE_BASIC_INFO, FILE_CASE_SENSITIVE_INFO,
    FILE_DISPOSITION_FLAG_DELETE, FILE_DISPOSITION_FLAG_IGNORE_READONLY_ATTRIBUTE,
    FILE_DISPOSITION_FLAG_POSIX_SEMANTICS, FILE_DISPOSITION_INFO_EX, FILE_FLAG_BACKUP_SEMANTICS,
    FILE_FLAG_OPEN_REPARSE_POINT, FILE_ID_INFO, FILE_READ_ATTRIBUTES, FILE_READ_DATA,
    FILE_SHARE_READ, FILE_SHARE_WRITE, FILE_STANDARD_INFO, FILE_WRITE_ATTRIBUTES, FILE_WRITE_DATA,
    FileAttributeTagInfo, FileBasicInfo, FileCaseSensitiveInfo, FileDispositionInfoEx, FileIdInfo,
    FileStandardInfo, FlushFileBuffers, GetDriveTypeW, GetFileInformationByHandleEx,
    GetFinalPathNameByHandleW, GetVolumeInformationByHandleW, OPEN_EXISTING, READ_CONTROL,
    ReadFile, SYNCHRONIZE, SetFileInformationByHandle, WRITE_DAC, WRITE_OWNER, WriteFile,
};
use windows_sys::Win32::System::IO::{
    DeviceIoControl, GetOverlappedResult, IO_STATUS_BLOCK, OVERLAPPED,
};
use windows_sys::Win32::System::Ioctl::{
    FSCTL_REQUEST_OPLOCK, OPLOCK_LEVEL_CACHE_HANDLE, OPLOCK_LEVEL_CACHE_READ,
    OPLOCK_LEVEL_CACHE_WRITE, REQUEST_OPLOCK_CURRENT_VERSION, REQUEST_OPLOCK_INPUT_BUFFER,
    REQUEST_OPLOCK_INPUT_FLAG_REQUEST, REQUEST_OPLOCK_OUTPUT_BUFFER,
};
use windows_sys::Win32::System::Threading::{
    AddSIDToBoundaryDescriptor, ClosePrivateNamespace, CreateBoundaryDescriptorW, CreateEventW,
    CreateMutexW, CreatePrivateNamespaceW, DeleteBoundaryDescriptor, GetCurrentProcess, INFINITE,
    OpenPrivateNamespaceW, OpenProcessToken, ReleaseMutex, ResetEvent, WaitForSingleObject,
};

use crate::path_policy::windows_namespace_key;
use crate::{
    CommitOutcome, CommitReceipt, ResourceState, TextSnapshot, TextTransactionError,
    TextTransactionErrorCode, ValidatedWindowsTarget, validate_windows_target,
};

const DRIVE_REMOTE: u32 = 4;
const FILE_CS_FLAG_CASE_SENSITIVE_DIR: u32 = 1;
const MAX_TEXT_BYTES: usize = 64 * 1024 * 1024;
const TEXT_TRANSACTION_NAMESPACE_ALIAS: &str = "KodaXTextTxV2";
const TEXT_TRANSACTION_BOUNDARY_NAME: &str = "KodaX-TextTx-Boundary-v2";

#[cfg(test)]
thread_local! {
    static FAIL_AFTER_ATOMIC_RENAME: std::cell::Cell<bool> = const { std::cell::Cell::new(false) };
}

#[cfg(test)]
fn take_fail_after_atomic_rename() -> bool {
    FAIL_AFTER_ATOMIC_RENAME.with(|flag| flag.replace(false))
}

#[derive(Debug)]
struct OwnedHandle(HANDLE);

impl OwnedHandle {
    fn raw(&self) -> HANDLE {
        self.0
    }
}

impl Drop for OwnedHandle {
    fn drop(&mut self) {
        if !self.0.is_null() && self.0 != INVALID_HANDLE_VALUE {
            unsafe { CloseHandle(self.0) };
        }
    }
}

unsafe impl Send for OwnedHandle {}
unsafe impl Sync for OwnedHandle {}

#[derive(Clone, Copy, Eq, PartialEq)]
struct FileIdentity {
    volume: u64,
    file_id: [u8; 16],
}

struct OplockedTemp {
    // Drop the file before the event and pending buffers. Closing the handle is
    // the documented implicit acknowledgement for any outstanding break.
    file: OwnedHandle,
    _event: OwnedHandle,
    _overlapped: Box<OVERLAPPED>,
    _output: Box<REQUEST_OPLOCK_OUTPUT_BUFFER>,
}

impl OplockedTemp {
    fn request(file: OwnedHandle) -> Result<Self, TextTransactionError> {
        let event = unsafe { CreateEventW(null(), 1, 0, null()) };
        if event.is_null() {
            return Err(last_io("cannot create text transaction oplock event"));
        }
        let event = OwnedHandle(event);
        let input = REQUEST_OPLOCK_INPUT_BUFFER {
            StructureVersion: REQUEST_OPLOCK_CURRENT_VERSION as u16,
            StructureLength: size_of::<REQUEST_OPLOCK_INPUT_BUFFER>() as u16,
            RequestedOplockLevel: OPLOCK_LEVEL_CACHE_READ
                | OPLOCK_LEVEL_CACHE_WRITE
                | OPLOCK_LEVEL_CACHE_HANDLE,
            Flags: REQUEST_OPLOCK_INPUT_FLAG_REQUEST,
        };
        let mut output = Box::new(REQUEST_OPLOCK_OUTPUT_BUFFER {
            StructureVersion: REQUEST_OPLOCK_CURRENT_VERSION as u16,
            StructureLength: size_of::<REQUEST_OPLOCK_OUTPUT_BUFFER>() as u16,
            ..Default::default()
        });
        let mut overlapped = Box::<OVERLAPPED>::default();
        overlapped.hEvent = event.raw();
        let granted = unsafe {
            DeviceIoControl(
                file.raw(),
                FSCTL_REQUEST_OPLOCK,
                (&input as *const REQUEST_OPLOCK_INPUT_BUFFER).cast(),
                size_of::<REQUEST_OPLOCK_INPUT_BUFFER>() as u32,
                (&mut *output as *mut REQUEST_OPLOCK_OUTPUT_BUFFER).cast(),
                size_of::<REQUEST_OPLOCK_OUTPUT_BUFFER>() as u32,
                null_mut(),
                &mut *overlapped,
            )
        };
        let code = unsafe { GetLastError() };
        if granted != 0 || code != ERROR_IO_PENDING {
            return Err(TextTransactionError::os(
                TextTransactionErrorCode::Contended,
                "cannot acquire the text transaction namespace oplock",
                code,
            ));
        }
        let result = Self {
            file,
            _event: event,
            _overlapped: overlapped,
            _output: output,
        };
        result.ensure_held()?;
        Ok(result)
    }

    fn raw(&self) -> HANDLE {
        self.file.raw()
    }

    fn ensure_held(&self) -> Result<(), TextTransactionError> {
        match unsafe { WaitForSingleObject(self._event.raw(), 0) } {
            WAIT_TIMEOUT => Ok(()),
            WAIT_OBJECT_0 => Err(TextTransactionError::new(
                TextTransactionErrorCode::Contended,
                "text transaction namespace changed before atomic replacement",
            )),
            _ => Err(last_io("cannot inspect text transaction namespace oplock")),
        }
    }
}

pub struct TrustedRoot {
    root: OwnedHandle,
    root_text: String,
    identity: FileIdentity,
}

unsafe impl Send for TrustedRoot {}
unsafe impl Sync for TrustedRoot {}

impl TrustedRoot {
    pub fn open(root_path: &str) -> Result<Self, TextTransactionError> {
        // Reuse the complete lexical screen without allowing the root itself as a mutation target.
        let sentinel = format!(
            "{}\\.__kodax_root_probe__",
            root_path.trim_end_matches(['\\', '/'])
        );
        validate_windows_target(root_path, &sentinel)?;
        let drive = &root_path[..3];
        let drive_wide = wide_nul(drive);
        if unsafe { GetDriveTypeW(drive_wide.as_ptr()) } == DRIVE_REMOTE {
            return Err(TextTransactionError::new(
                TextTransactionErrorCode::RemoteFilesystem,
                "remote filesystems are not supported for trusted text transactions",
            ));
        }
        let wide = wide_nul(root_path);
        let raw = unsafe {
            CreateFileW(
                wide.as_ptr(),
                FILE_READ_ATTRIBUTES | SYNCHRONIZE,
                FILE_SHARE_READ | FILE_SHARE_WRITE,
                null(),
                OPEN_EXISTING,
                FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT,
                null_mut(),
            )
        };
        if raw == INVALID_HANDLE_VALUE {
            return Err(last_io("cannot open trusted text root"));
        }
        let root = OwnedHandle(raw);
        reject_reparse(root.raw())?;
        reject_case_sensitive_directory(root.raw())?;
        require_supported_filesystem(root.raw())?;
        let identity = file_identity(root.raw())?;
        let canonical_root = canonical_dos_path(root.raw())?;
        Ok(Self {
            root,
            root_text: canonical_root,
            identity,
        })
    }

    pub fn snapshot(&self, target: &str) -> Result<TextSnapshot, TextTransactionError> {
        self.ensure_root_location()?;
        let validated = validate_windows_target(&self.root_text, target)?;
        let canonical_path = self.canonical_target(&validated);
        let slot_id = self.slot_id(&canonical_path);
        let Some((parents, leaf)) = self.open_parent(&validated, false)? else {
            return Ok(TextSnapshot {
                state: ResourceState::Missing,
                content: String::new(),
                revision: format!("missing:{slot_id}"),
                slot_id,
                canonical_path,
            });
        };
        let parent = parents.last().unwrap_or(&self.root);
        self.ensure_target_location(parent.raw(), leaf, &validated)?;
        read_snapshot(parent.raw(), leaf, &slot_id, &canonical_path)
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
        let validated = validate_windows_target(&self.root_text, target)?;
        let canonical_path = self.canonical_target(&validated);
        let slot_id = self.slot_id(&canonical_path);
        let mutex = TransactionMutex::acquire(&slot_id, timeout_ms)?;
        self.ensure_root_location()?;
        let (parents, leaf) = self
            .open_parent(&validated, create_parents)?
            .ok_or_else(|| {
                TextTransactionError::new(
                    TextTransactionErrorCode::Io,
                    "target parent directory does not exist",
                )
            })?;
        let parent = parents.last().unwrap_or(&self.root);
        self.ensure_target_location(parent.raw(), leaf, &validated)?;
        let before = read_snapshot(parent.raw(), leaf, &slot_id, &canonical_path)?;
        if before.revision != expected_revision {
            return Ok(CommitOutcome::Stale {
                current_revision: before.revision,
            });
        }

        let temp_name = format!(".kodax-tx-{}.tmp", Uuid::new_v4().simple());
        let temp = open_relative(
            parent.raw(),
            &temp_name,
            DELETE
                | FILE_WRITE_DATA
                | FILE_WRITE_ATTRIBUTES
                | FILE_READ_ATTRIBUTES
                | READ_CONTROL
                | WRITE_DAC
                | WRITE_OWNER
                | SYNCHRONIZE,
            0,
            FILE_CREATE,
            FILE_NON_DIRECTORY_FILE | FILE_OPEN_REPARSE_POINT | FILE_OPEN_REQUIRING_OPLOCK,
        )?
        .ok_or_else(|| {
            TextTransactionError::new(
                TextTransactionErrorCode::Io,
                "temporary file creation returned missing",
            )
        })?;
        // No filesystem operation may occur between the zero-byte create and this
        // Windows 7 RWH oplock request. Until the grant, the temp contains no payload.
        let temp = OplockedTemp::request(temp)?;
        let mut committed_receipt = None;
        let result = (|| {
            self.revalidate_transaction_location(
                &parents,
                parent.raw(),
                leaf,
                &validated,
                temp.raw(),
                &temp_name,
            )?;
            if before.state == ResourceState::Present {
                let existing = open_existing_for_metadata(parent.raw(), leaf)?;
                reject_non_default_streams(existing.raw())?;
                // Apply the final owner/DACL and attributes before the first payload byte.
                // A crash can therefore leave only a non-shareable, correctly protected temp.
                copy_metadata(existing.raw(), temp.raw())?;
            }
            temp.ensure_held()?;
            write_all(temp.raw(), content.as_bytes())?;
            if unsafe { FlushFileBuffers(temp.raw()) } == 0 {
                return Err(last_io("cannot flush text transaction temporary file"));
            }
            temp.ensure_held()?;

            // Re-open and re-hash while the slot mutex is held. An uncooperative shell writer
            // that changed the resource before this point turns the commit into a stale result.
            let final_check = read_snapshot(parent.raw(), leaf, &slot_id, &canonical_path)?;
            if final_check.revision != before.revision {
                return Ok(CommitOutcome::Stale {
                    current_revision: final_check.revision,
                });
            }
            // Revalidate the handle-backed namespace at the commit point. This catches
            // a parent/root rename between authorization and replacement; the handle walk
            // never follows a replacement junction at the original lexical path.
            self.revalidate_transaction_location(
                &parents,
                parent.raw(),
                leaf,
                &validated,
                temp.raw(),
                &temp_name,
            )?;
            temp.ensure_held()?;
            let temp_identity = file_identity(temp.raw())?;
            let receipt = CommitReceipt {
                slot_id: slot_id.clone(),
                pre_state: before.state,
                pre_content: before.content.clone(),
                pre_revision: before.revision.clone(),
                post_revision: present_revision(&slot_id, temp_identity, content.as_bytes()),
                abandoned_lock: mutex.abandoned,
            };
            atomic_rename(
                temp.raw(),
                parent.raw(),
                leaf,
                before.state == ResourceState::Present,
            )?;
            // The replacement is the commit point. The temporary file was flushed and its
            // identity captured before this call, so no fallible operation belongs after it.
            // Keep the receipt outside the closure to make future post-commit failures safe.
            committed_receipt = Some(receipt.clone());
            #[cfg(test)]
            if take_fail_after_atomic_rename() {
                return Err(TextTransactionError::new(
                    TextTransactionErrorCode::Io,
                    "injected failure after atomic replacement",
                ));
            }
            Ok(CommitOutcome::Written(receipt))
        })();
        match result {
            Ok(CommitOutcome::Written(receipt)) => Ok(CommitOutcome::Written(receipt)),
            Ok(CommitOutcome::CommittedUncertain { receipt, message }) => {
                Ok(CommitOutcome::CommittedUncertain { receipt, message })
            }
            Ok(stale @ CommitOutcome::Stale { .. }) => {
                delete_by_handle(temp.raw())?;
                Ok(stale)
            }
            Err(mut primary) => {
                if let Some(receipt) = committed_receipt {
                    return Ok(CommitOutcome::CommittedUncertain {
                        receipt,
                        message: format!(
                            "atomic replacement completed but finalization was not proven: {}",
                            primary.message
                        ),
                    });
                }
                if let Err(cleanup) = delete_by_handle(temp.raw()) {
                    primary.message = format!(
                        "{}; temporary cleanup also failed: {}",
                        primary.message, cleanup.message
                    );
                }
                Err(primary)
            }
        }
    }

    fn slot_id(&self, canonical_path: &str) -> String {
        let mut hash = Sha256::new();
        hash.update(b"kodax-text-slot-v2\0");
        hash.update(self.identity.volume.to_le_bytes());
        hash.update(windows_namespace_key(canonical_path).as_bytes());
        format!("{:x}", hash.finalize())
    }

    fn canonical_target(&self, target: &ValidatedWindowsTarget) -> String {
        format!(
            "{}\\{}",
            self.root_text,
            target.relative_components.join("\\")
        )
    }

    fn ensure_root_location(&self) -> Result<(), TextTransactionError> {
        if file_identity(self.root.raw())? != self.identity {
            return Err(TextTransactionError::new(
                TextTransactionErrorCode::UnauthorizedPath,
                "trusted text root identity changed after authorization",
            ));
        }
        let current = canonical_dos_path(self.root.raw())?;
        if windows_path_key(&current) != windows_path_key(&self.root_text) {
            return Err(TextTransactionError::new(
                TextTransactionErrorCode::UnauthorizedPath,
                "trusted text root moved after authorization",
            ));
        }
        Ok(())
    }

    fn revalidate_transaction_location(
        &self,
        parents: &[OwnedHandle],
        parent: HANDLE,
        leaf: &str,
        expected: &ValidatedWindowsTarget,
        temp: HANDLE,
        temp_name: &str,
    ) -> Result<(), TextTransactionError> {
        self.ensure_root_location()?;
        reject_reparse(self.root.raw())?;
        for ancestor in parents {
            reject_reparse(ancestor.raw())?;
            reject_case_sensitive_directory(ancestor.raw())?;
        }
        self.ensure_target_location(parent, leaf, expected)?;
        let expected_temp = format!("{}\\{temp_name}", canonical_dos_path(parent)?);
        if windows_path_key(&canonical_dos_path(temp)?) != windows_path_key(&expected_temp) {
            return Err(TextTransactionError::new(
                TextTransactionErrorCode::UnauthorizedPath,
                "text transaction temporary file moved outside its authorized parent",
            ));
        }
        Ok(())
    }

    fn ensure_target_location(
        &self,
        parent: HANDLE,
        leaf: &str,
        expected: &ValidatedWindowsTarget,
    ) -> Result<(), TextTransactionError> {
        let parent_path = canonical_dos_path(parent)?;
        let actual_path = format!("{}\\{leaf}", parent_path.trim_end_matches('\\'));
        let actual = validate_windows_target(&self.root_text, &actual_path)?;
        if actual.normalized_relative != expected.normalized_relative {
            return Err(TextTransactionError::new(
                TextTransactionErrorCode::UnauthorizedPath,
                "trusted text target moved after authorization",
            ));
        }
        Ok(())
    }

    fn open_parent<'a>(
        &self,
        target: &'a ValidatedWindowsTarget,
        create: bool,
    ) -> Result<Option<(Vec<OwnedHandle>, &'a str)>, TextTransactionError> {
        let (leaf, directories) = target
            .relative_components
            .split_last()
            .expect("validated target has a leaf");
        let mut handles = Vec::with_capacity(directories.len());
        let mut current = self.root.raw();
        for component in directories {
            let opened = open_relative(
                current,
                component,
                FILE_READ_ATTRIBUTES | SYNCHRONIZE,
                FILE_SHARE_READ | FILE_SHARE_WRITE,
                FILE_OPEN,
                FILE_DIRECTORY_FILE | FILE_OPEN_REPARSE_POINT | FILE_SYNCHRONOUS_IO_NONALERT,
            )?;
            let handle = match opened {
                Some(handle) => handle,
                None if create => match open_relative(
                    current,
                    component,
                    FILE_READ_ATTRIBUTES | SYNCHRONIZE,
                    FILE_SHARE_READ | FILE_SHARE_WRITE,
                    FILE_CREATE,
                    FILE_DIRECTORY_FILE | FILE_OPEN_REPARSE_POINT | FILE_SYNCHRONOUS_IO_NONALERT,
                ) {
                    Ok(Some(handle)) => handle,
                    Err(error) if matches!(error.os_code, Some(80 | 183)) => open_relative(
                        current,
                        component,
                        FILE_READ_ATTRIBUTES | SYNCHRONIZE,
                        FILE_SHARE_READ | FILE_SHARE_WRITE,
                        FILE_OPEN,
                        FILE_DIRECTORY_FILE
                            | FILE_OPEN_REPARSE_POINT
                            | FILE_SYNCHRONOUS_IO_NONALERT,
                    )?
                    .ok_or_else(|| {
                        TextTransactionError::new(
                            TextTransactionErrorCode::Io,
                            "concurrently-created parent disappeared",
                        )
                    })?,
                    Ok(None) => {
                        return Err(TextTransactionError::new(
                            TextTransactionErrorCode::Io,
                            "directory creation returned missing",
                        ));
                    }
                    Err(error) => return Err(error),
                },
                None => return Ok(None),
            };
            reject_reparse(handle.raw())?;
            reject_case_sensitive_directory(handle.raw())?;
            current = handle.raw();
            handles.push(handle);
        }
        Ok(Some((handles, leaf)))
    }
}

struct CurrentUserSid {
    _token_information: Vec<usize>,
    raw: *mut c_void,
    string: String,
}

impl CurrentUserSid {
    fn load() -> Result<Self, TextTransactionError> {
        let mut token: HANDLE = null_mut();
        if unsafe { OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token) } == 0 {
            return Err(last_io(
                "cannot open host token for text transaction namespace",
            ));
        }
        let token = OwnedHandle(token);
        let mut byte_count = 0u32;
        unsafe {
            GetTokenInformation(token.raw(), TokenUser, null_mut(), 0, &mut byte_count);
        }
        if byte_count == 0 || unsafe { GetLastError() } != ERROR_INSUFFICIENT_BUFFER {
            return Err(last_io(
                "cannot size host SID for text transaction namespace",
            ));
        }
        let word_count = (byte_count as usize).div_ceil(size_of::<usize>());
        let mut token_information = vec![0usize; word_count];
        if unsafe {
            GetTokenInformation(
                token.raw(),
                TokenUser,
                token_information.as_mut_ptr().cast(),
                byte_count,
                &mut byte_count,
            )
        } == 0
        {
            return Err(last_io(
                "cannot read host SID for text transaction namespace",
            ));
        }
        let token_user = unsafe { &*(token_information.as_ptr().cast::<TOKEN_USER>()) };
        if token_user.User.Sid.is_null() {
            return Err(TextTransactionError::new(
                TextTransactionErrorCode::Io,
                "host token returned an empty SID",
            ));
        }
        let raw = token_user.User.Sid;
        let mut string_sid = null_mut();
        if unsafe { ConvertSidToStringSidW(raw, &mut string_sid) } == 0 {
            return Err(last_io(
                "cannot format host SID for text transaction namespace",
            ));
        }
        let string = unsafe {
            let mut length = 0usize;
            while *string_sid.add(length) != 0 {
                length += 1;
            }
            let value = String::from_utf16_lossy(std::slice::from_raw_parts(string_sid, length));
            LocalFree(string_sid.cast());
            value
        };
        Ok(Self {
            _token_information: token_information,
            raw,
            string,
        })
    }
}

struct BoundaryDescriptor {
    raw: HANDLE,
    _user_sid: CurrentUserSid,
}

impl BoundaryDescriptor {
    fn for_current_user() -> Result<Self, TextTransactionError> {
        let user_sid = CurrentUserSid::load()?;
        let name = wide_nul(TEXT_TRANSACTION_BOUNDARY_NAME);
        let mut raw = unsafe { CreateBoundaryDescriptorW(name.as_ptr(), 0) };
        if raw.is_null() {
            return Err(last_io(
                "cannot create text transaction boundary descriptor",
            ));
        }
        if unsafe { AddSIDToBoundaryDescriptor(&mut raw, user_sid.raw) } == 0 {
            unsafe { DeleteBoundaryDescriptor(raw) };
            return Err(last_io("cannot bind host SID to text transaction boundary"));
        }
        Ok(Self {
            raw,
            _user_sid: user_sid,
        })
    }
}

impl Drop for BoundaryDescriptor {
    fn drop(&mut self) {
        unsafe { DeleteBoundaryDescriptor(self.raw) };
    }
}

struct PrivateNamespace {
    raw: HANDLE,
    boundary: BoundaryDescriptor,
}

unsafe impl Send for PrivateNamespace {}
unsafe impl Sync for PrivateNamespace {}

impl PrivateNamespace {
    fn open() -> Result<Self, TextTransactionError> {
        let boundary = BoundaryDescriptor::for_current_user()?;
        let sddl = wide_nul(&format!(
            "D:P(A;;GA;;;SY)(A;;GA;;;{})",
            boundary._user_sid.string
        ));
        let mut descriptor: PSECURITY_DESCRIPTOR = null_mut();
        if unsafe {
            ConvertStringSecurityDescriptorToSecurityDescriptorW(
                sddl.as_ptr(),
                SDDL_REVISION_1,
                &mut descriptor,
                null_mut(),
            )
        } == 0
        {
            return Err(last_io(
                "cannot build text transaction namespace security descriptor",
            ));
        }
        let attributes = SECURITY_ATTRIBUTES {
            nLength: size_of::<SECURITY_ATTRIBUTES>() as u32,
            lpSecurityDescriptor: descriptor,
            bInheritHandle: 0,
        };
        let alias = wide_nul(TEXT_TRANSACTION_NAMESPACE_ALIAS);
        let mut raw = unsafe {
            CreatePrivateNamespaceW(&attributes, boundary.raw.cast_const(), alias.as_ptr())
        };
        let create_error = unsafe { GetLastError() };
        unsafe { LocalFree(descriptor) };
        if raw.is_null() && create_error == ERROR_ALREADY_EXISTS {
            raw = unsafe { OpenPrivateNamespaceW(boundary.raw.cast_const(), alias.as_ptr()) };
        }
        if raw.is_null() {
            let code = if create_error == ERROR_ALREADY_EXISTS {
                unsafe { GetLastError() }
            } else {
                create_error
            };
            return Err(TextTransactionError::os(
                TextTransactionErrorCode::Io,
                "cannot open host text transaction private namespace",
                code,
            ));
        }
        Ok(Self { raw, boundary })
    }
}

impl Drop for PrivateNamespace {
    fn drop(&mut self) {
        unsafe {
            ClosePrivateNamespace(self.raw, 0);
        }
    }
}

static TEXT_TRANSACTION_NAMESPACE: OnceLock<PrivateNamespace> = OnceLock::new();
static TEXT_TRANSACTION_NAMESPACE_INIT: Mutex<()> = Mutex::new(());

fn host_private_namespace() -> Result<&'static PrivateNamespace, TextTransactionError> {
    if let Some(namespace) = TEXT_TRANSACTION_NAMESPACE.get() {
        return Ok(namespace);
    }
    let _initialization = TEXT_TRANSACTION_NAMESPACE_INIT
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    if let Some(namespace) = TEXT_TRANSACTION_NAMESPACE.get() {
        return Ok(namespace);
    }
    let namespace = PrivateNamespace::open()?;
    TEXT_TRANSACTION_NAMESPACE.set(namespace).map_err(|_| {
        TextTransactionError::new(
            TextTransactionErrorCode::Io,
            "text transaction namespace initialization raced unexpectedly",
        )
    })?;
    TEXT_TRANSACTION_NAMESPACE.get().ok_or_else(|| {
        TextTransactionError::new(
            TextTransactionErrorCode::Io,
            "text transaction namespace initialization did not publish a handle",
        )
    })
}

struct TransactionMutex {
    handle: OwnedHandle,
    abandoned: bool,
}

impl TransactionMutex {
    fn acquire(slot_id: &str, timeout_ms: u32) -> Result<Self, TextTransactionError> {
        let namespace = host_private_namespace()?;
        let name = wide_nul(&format!("{TEXT_TRANSACTION_NAMESPACE_ALIAS}\\{slot_id}"));
        let sddl = wide_nul(&format!(
            "D:P(A;;GA;;;SY)(A;;GA;;;{})",
            namespace.boundary._user_sid.string
        ));
        let mut descriptor: PSECURITY_DESCRIPTOR = null_mut();
        if unsafe {
            ConvertStringSecurityDescriptorToSecurityDescriptorW(
                sddl.as_ptr(),
                SDDL_REVISION_1,
                &mut descriptor,
                null_mut(),
            )
        } == 0
        {
            return Err(last_io(
                "cannot build text transaction mutex security descriptor",
            ));
        }
        let attributes = SECURITY_ATTRIBUTES {
            nLength: size_of::<SECURITY_ATTRIBUTES>() as u32,
            lpSecurityDescriptor: descriptor,
            bInheritHandle: 0,
        };
        let raw = unsafe { CreateMutexW(&attributes, 0, name.as_ptr()) };
        let create_error = unsafe { GetLastError() };
        unsafe { LocalFree(descriptor) };
        if raw.is_null() {
            return Err(TextTransactionError::os(
                TextTransactionErrorCode::Io,
                "cannot create text transaction kernel mutex",
                create_error,
            ));
        }
        let handle = OwnedHandle(raw);
        let wait = unsafe { WaitForSingleObject(handle.raw(), timeout_ms) };
        match wait {
            WAIT_OBJECT_0 => Ok(Self {
                handle,
                abandoned: false,
            }),
            WAIT_ABANDONED => Ok(Self {
                handle,
                abandoned: true,
            }),
            WAIT_TIMEOUT => Err(TextTransactionError::new(
                TextTransactionErrorCode::Contended,
                "text transaction slot is held by another runtime",
            )),
            _ => Err(last_io("cannot acquire text transaction kernel mutex")),
        }
    }
}

impl Drop for TransactionMutex {
    fn drop(&mut self) {
        unsafe { ReleaseMutex(self.handle.raw()) };
    }
}

fn open_relative(
    parent: HANDLE,
    name: &str,
    access: u32,
    share: u32,
    disposition: u32,
    options: u32,
) -> Result<Option<OwnedHandle>, TextTransactionError> {
    let mut name_wide: Vec<u16> = OsStr::new(name).encode_wide().collect();
    let unicode = UNICODE_STRING {
        Length: (name_wide.len() * 2) as u16,
        MaximumLength: (name_wide.len() * 2) as u16,
        Buffer: name_wide.as_mut_ptr(),
    };
    let attributes = OBJECT_ATTRIBUTES {
        Length: size_of::<OBJECT_ATTRIBUTES>() as u32,
        RootDirectory: parent,
        ObjectName: &unicode,
        Attributes: OBJ_CASE_INSENSITIVE,
        SecurityDescriptor: null(),
        SecurityQualityOfService: null(),
    };
    let mut handle: HANDLE = null_mut();
    let mut status_block: IO_STATUS_BLOCK = unsafe { zeroed() };
    let status = unsafe {
        NtCreateFile(
            &mut handle,
            access,
            &attributes,
            &mut status_block,
            null(),
            FILE_ATTRIBUTE_NORMAL,
            share,
            disposition,
            options,
            null(),
            0,
        )
    };
    if status >= 0 {
        return Ok(Some(OwnedHandle(handle)));
    }
    let os_code = unsafe { RtlNtStatusToDosError(status) };
    if os_code == ERROR_FILE_NOT_FOUND || os_code == ERROR_PATH_NOT_FOUND {
        return Ok(None);
    }
    let code = if os_code == 32 || os_code == 33 {
        TextTransactionErrorCode::Contended
    } else {
        TextTransactionErrorCode::Io
    };
    Err(TextTransactionError::os(
        code,
        format!("handle-relative file open failed for {name}"),
        os_code,
    ))
}

fn read_snapshot(
    parent: HANDLE,
    leaf: &str,
    slot_id: &str,
    canonical_path: &str,
) -> Result<TextSnapshot, TextTransactionError> {
    let Some(handle) = open_relative(
        parent,
        leaf,
        FILE_READ_DATA | FILE_READ_ATTRIBUTES | SYNCHRONIZE,
        FILE_SHARE_READ,
        FILE_OPEN,
        FILE_NON_DIRECTORY_FILE | FILE_OPEN_REPARSE_POINT | FILE_SYNCHRONOUS_IO_NONALERT,
    )?
    else {
        return Ok(TextSnapshot {
            state: ResourceState::Missing,
            content: String::new(),
            revision: format!("missing:{slot_id}"),
            slot_id: slot_id.to_owned(),
            canonical_path: canonical_path.to_owned(),
        });
    };
    reject_reparse(handle.raw())?;
    reject_non_default_streams(handle.raw())?;
    let standard: FILE_STANDARD_INFO = query_info(handle.raw(), FileStandardInfo)?;
    if standard.NumberOfLinks != 1 {
        return Err(TextTransactionError::new(
            TextTransactionErrorCode::HardLink,
            "multi-link files are not accepted by trusted text transactions",
        ));
    }
    if standard.EndOfFile < 0 || standard.EndOfFile as usize > MAX_TEXT_BYTES {
        return Err(TextTransactionError::new(
            TextTransactionErrorCode::Io,
            "text file exceeds the 64 MiB bound",
        ));
    }
    let mut bytes = vec![0u8; standard.EndOfFile as usize];
    let mut offset = 0;
    while offset < bytes.len() {
        let mut read = 0;
        if unsafe {
            ReadFile(
                handle.raw(),
                bytes[offset..].as_mut_ptr(),
                (bytes.len() - offset).min(u32::MAX as usize) as u32,
                &mut read,
                null_mut(),
            )
        } == 0
        {
            return Err(last_io("cannot read text transaction target"));
        }
        if read == 0 {
            break;
        }
        offset += read as usize;
    }
    bytes.truncate(offset);
    let content = String::from_utf8(bytes.clone()).map_err(|_| {
        TextTransactionError::new(
            TextTransactionErrorCode::Io,
            "text transaction target is not valid UTF-8",
        )
    })?;
    let identity = file_identity(handle.raw())?;
    Ok(TextSnapshot {
        state: ResourceState::Present,
        content,
        revision: present_revision(slot_id, identity, &bytes),
        slot_id: slot_id.to_owned(),
        canonical_path: canonical_path.to_owned(),
    })
}

fn write_all(handle: HANDLE, bytes: &[u8]) -> Result<(), TextTransactionError> {
    let event = unsafe { CreateEventW(null(), 1, 0, null()) };
    if event.is_null() {
        return Err(last_io("cannot create text transaction write event"));
    }
    let event = OwnedHandle(event);
    let mut offset = 0;
    while offset < bytes.len() {
        if unsafe { ResetEvent(event.raw()) } == 0 {
            return Err(last_io("cannot reset text transaction write event"));
        }
        let file_offset = offset as u64;
        let mut overlapped = OVERLAPPED {
            hEvent: event.raw(),
            ..Default::default()
        };
        overlapped.Anonymous.Anonymous.Offset = file_offset as u32;
        overlapped.Anonymous.Anonymous.OffsetHigh = (file_offset >> 32) as u32;
        let mut written = 0;
        let completed = unsafe {
            WriteFile(
                handle,
                bytes[offset..].as_ptr(),
                (bytes.len() - offset).min(u32::MAX as usize) as u32,
                &mut written,
                &mut overlapped,
            )
        };
        if completed == 0 {
            let code = unsafe { GetLastError() };
            if code != ERROR_IO_PENDING {
                return Err(TextTransactionError::os(
                    TextTransactionErrorCode::Io,
                    "cannot write text transaction temporary file",
                    code,
                ));
            }
            if unsafe { WaitForSingleObject(event.raw(), INFINITE) } != WAIT_OBJECT_0 {
                return Err(last_io("cannot wait for text transaction write completion"));
            }
            if unsafe { GetOverlappedResult(handle, &overlapped, &mut written, 0) } == 0 {
                return Err(last_io("cannot complete text transaction temporary write"));
            }
        }
        if written == 0 {
            return Err(TextTransactionError::new(
                TextTransactionErrorCode::Io,
                "zero-byte write to transaction temporary file",
            ));
        }
        offset += written as usize;
    }
    Ok(())
}

fn open_existing_for_metadata(
    parent: HANDLE,
    leaf: &str,
) -> Result<OwnedHandle, TextTransactionError> {
    open_relative(
        parent,
        leaf,
        FILE_READ_ATTRIBUTES | READ_CONTROL | SYNCHRONIZE,
        FILE_SHARE_READ,
        FILE_OPEN,
        FILE_NON_DIRECTORY_FILE | FILE_OPEN_REPARSE_POINT | FILE_SYNCHRONOUS_IO_NONALERT,
    )?
    .ok_or_else(|| {
        TextTransactionError::new(
            TextTransactionErrorCode::Stale,
            "text target disappeared before metadata capture",
        )
    })
}

fn copy_metadata(source: HANDLE, destination: HANDLE) -> Result<(), TextTransactionError> {
    let mut basic: FILE_BASIC_INFO = query_info(source, FileBasicInfo)?;
    let unsupported_attributes = FILE_ATTRIBUTE_COMPRESSED
        | FILE_ATTRIBUTE_ENCRYPTED
        | FILE_ATTRIBUTE_SPARSE_FILE
        | FILE_ATTRIBUTE_INTEGRITY_STREAM
        | FILE_ATTRIBUTE_NO_SCRUB_DATA
        | FILE_ATTRIBUTE_OFFLINE
        | FILE_ATTRIBUTE_RECALL_ON_DATA_ACCESS;
    if basic.FileAttributes & unsupported_attributes != 0 {
        return Err(TextTransactionError::new(
            TextTransactionErrorCode::MetadataPreservation,
            "compressed, encrypted, sparse, integrity, or offline files require a metadata-aware writer",
        ));
    }
    // Preserve stable creation metadata and attributes. Last-write/access/change times must
    // reflect this write, so zero leaves those fields under filesystem control.
    basic.LastAccessTime = 0;
    basic.LastWriteTime = 0;
    basic.ChangeTime = 0;
    if unsafe {
        SetFileInformationByHandle(
            destination,
            FileBasicInfo,
            (&basic as *const FILE_BASIC_INFO).cast(),
            size_of::<FILE_BASIC_INFO>() as u32,
        )
    } == 0
    {
        return Err(metadata_error(
            "cannot preserve text file timestamps and attributes",
        ));
    }

    // Full audit SACL preservation still requires SeSecurityPrivilege. The ordinary host
    // preserves the security fields Windows exposes through READ_CONTROL/WRITE_DAC/
    // WRITE_OWNER and fails closed on a Central Access Policy (SCOPE), which it cannot set.
    let mut scope = null_mut();
    let mut scope_descriptor: PSECURITY_DESCRIPTOR = null_mut();
    let scope_status = unsafe {
        GetSecurityInfo(
            source,
            SE_FILE_OBJECT,
            SCOPE_SECURITY_INFORMATION,
            null_mut(),
            null_mut(),
            null_mut(),
            &mut scope,
            &mut scope_descriptor,
        )
    };
    if scope_status != 0 {
        return Err(TextTransactionError::os(
            TextTransactionErrorCode::MetadataPreservation,
            "cannot inspect the text file Central Access Policy",
            scope_status,
        ));
    }
    let has_scope = !scope.is_null() && unsafe { (*scope).AceCount } != 0;
    unsafe { LocalFree(scope_descriptor) };
    if has_scope {
        return Err(TextTransactionError::new(
            TextTransactionErrorCode::MetadataPreservation,
            "files governed by a Central Access Policy are not replaced",
        ));
    }

    let mut owner = null_mut();
    let mut group = null_mut();
    let mut dacl = null_mut();
    let mut label_and_attributes = null_mut();
    let mut descriptor: PSECURITY_DESCRIPTOR = null_mut();
    let security_information = OWNER_SECURITY_INFORMATION
        | GROUP_SECURITY_INFORMATION
        | DACL_SECURITY_INFORMATION
        | LABEL_SECURITY_INFORMATION
        | ATTRIBUTE_SECURITY_INFORMATION;
    let status = unsafe {
        GetSecurityInfo(
            source,
            SE_FILE_OBJECT,
            security_information,
            &mut owner,
            &mut group,
            &mut dacl,
            &mut label_and_attributes,
            &mut descriptor,
        )
    };
    if status != 0 {
        return Err(TextTransactionError::os(
            TextTransactionErrorCode::MetadataPreservation,
            "cannot read existing text file security metadata",
            status,
        ));
    }
    let dacl_protected = match security_descriptor_control(descriptor) {
        Ok(control) => control & SE_DACL_PROTECTED != 0,
        Err(error) => {
            unsafe { LocalFree(descriptor) };
            return Err(error);
        }
    };
    let set_information = security_information
        | if dacl_protected {
            PROTECTED_DACL_SECURITY_INFORMATION
        } else {
            UNPROTECTED_DACL_SECURITY_INFORMATION
        };
    let set_status = unsafe {
        SetSecurityInfo(
            destination,
            SE_FILE_OBJECT,
            set_information,
            owner,
            group,
            dacl,
            label_and_attributes,
        )
    };
    if set_status != 0 {
        unsafe { LocalFree(descriptor) };
        return Err(TextTransactionError::os(
            TextTransactionErrorCode::MetadataPreservation,
            "cannot preserve existing text file security metadata",
            set_status,
        ));
    }

    let mut destination_owner = null_mut();
    let mut destination_group = null_mut();
    let mut destination_dacl = null_mut();
    let mut destination_label_and_attributes = null_mut();
    let mut destination_descriptor: PSECURITY_DESCRIPTOR = null_mut();
    let destination_status = unsafe {
        GetSecurityInfo(
            destination,
            SE_FILE_OBJECT,
            security_information,
            &mut destination_owner,
            &mut destination_group,
            &mut destination_dacl,
            &mut destination_label_and_attributes,
            &mut destination_descriptor,
        )
    };
    if destination_status != 0 {
        unsafe { LocalFree(descriptor) };
        return Err(TextTransactionError::os(
            TextTransactionErrorCode::MetadataPreservation,
            "cannot verify temporary text file security metadata",
            destination_status,
        ));
    }
    let verified = (|| {
        Ok(same_sid(owner, destination_owner)
            && same_sid(group, destination_group)
            && same_acl(dacl, destination_dacl)?
            && same_acl(label_and_attributes, destination_label_and_attributes)?
            && (security_descriptor_control(destination_descriptor)? & SE_DACL_PROTECTED != 0)
                == dacl_protected)
    })();
    unsafe { LocalFree(destination_descriptor) };
    unsafe { LocalFree(descriptor) };
    if !verified? {
        return Err(TextTransactionError::new(
            TextTransactionErrorCode::MetadataPreservation,
            "temporary text file security metadata did not match the source",
        ));
    }
    Ok(())
}

fn same_sid(left: *mut c_void, right: *mut c_void) -> bool {
    if left.is_null() || right.is_null() {
        return left == right;
    }
    unsafe { EqualSid(left, right) != 0 }
}

fn same_acl(left: *mut ACL, right: *mut ACL) -> Result<bool, TextTransactionError> {
    if left.is_null() || right.is_null() {
        return Ok(left == right);
    }
    let bytes = |acl: *mut ACL| -> Result<Vec<u8>, TextTransactionError> {
        let mut information = ACL_SIZE_INFORMATION::default();
        if unsafe {
            GetAclInformation(
                acl,
                (&mut information as *mut ACL_SIZE_INFORMATION).cast(),
                size_of::<ACL_SIZE_INFORMATION>() as u32,
                AclSizeInformation,
            )
        } == 0
        {
            return Err(metadata_error("cannot inspect text file ACL metadata"));
        }
        Ok(unsafe {
            std::slice::from_raw_parts(acl.cast::<u8>(), information.AclBytesInUse as usize)
        }
        .to_vec())
    };
    Ok(bytes(left)? == bytes(right)?)
}

fn security_descriptor_control(
    descriptor: PSECURITY_DESCRIPTOR,
) -> Result<u16, TextTransactionError> {
    let mut control = 0u16;
    let mut revision = 0u32;
    if unsafe { GetSecurityDescriptorControl(descriptor, &mut control, &mut revision) } == 0 {
        return Err(metadata_error(
            "cannot inspect text file security descriptor control",
        ));
    }
    Ok(control)
}

fn reject_non_default_streams(handle: HANDLE) -> Result<(), TextTransactionError> {
    let mut capacity = 4 * 1024usize;
    loop {
        let mut buffer = vec![0u8; capacity];
        let mut status_block: IO_STATUS_BLOCK = unsafe { zeroed() };
        let status = unsafe {
            NtQueryInformationFile(
                handle,
                &mut status_block,
                buffer.as_mut_ptr().cast(),
                buffer.len() as u32,
                FileStreamInformation,
            )
        };
        if status == windows_sys::Win32::Foundation::STATUS_BUFFER_OVERFLOW
            || status == windows_sys::Win32::Foundation::STATUS_BUFFER_TOO_SMALL
            || status == windows_sys::Win32::Foundation::STATUS_INFO_LENGTH_MISMATCH
        {
            capacity = capacity.checked_mul(2).ok_or_else(|| {
                TextTransactionError::new(
                    TextTransactionErrorCode::MetadataPreservation,
                    "alternate stream metadata exceeds the inspection bound",
                )
            })?;
            if capacity > 4 * 1024 * 1024 {
                return Err(TextTransactionError::new(
                    TextTransactionErrorCode::MetadataPreservation,
                    "alternate stream metadata exceeds the 4 MiB inspection bound",
                ));
            }
            continue;
        }
        if status < 0 {
            let os_code = unsafe { RtlNtStatusToDosError(status) };
            return Err(TextTransactionError::os(
                TextTransactionErrorCode::MetadataPreservation,
                "cannot enumerate alternate data streams before atomic replacement",
                os_code,
            ));
        }
        let used = status_block.Information.min(buffer.len());
        let mut offset = 0usize;
        while offset < used {
            let header_size = std::mem::offset_of!(FILE_STREAM_INFORMATION, StreamName);
            if used - offset < header_size {
                return Err(TextTransactionError::new(
                    TextTransactionErrorCode::MetadataPreservation,
                    "filesystem returned malformed alternate stream metadata",
                ));
            }
            let entry = unsafe {
                std::ptr::read_unaligned(
                    buffer
                        .as_ptr()
                        .add(offset)
                        .cast::<FILE_STREAM_INFORMATION>(),
                )
            };
            let name_bytes = entry.StreamNameLength as usize;
            if !name_bytes.is_multiple_of(2) || header_size + name_bytes > used - offset {
                return Err(TextTransactionError::new(
                    TextTransactionErrorCode::MetadataPreservation,
                    "filesystem returned malformed alternate stream name metadata",
                ));
            }
            let name_start = offset + header_size;
            let (name_pairs, remainder) =
                buffer[name_start..name_start + name_bytes].as_chunks::<2>();
            debug_assert!(remainder.is_empty());
            let name = name_pairs
                .iter()
                .map(|pair| u16::from_le_bytes([pair[0], pair[1]]))
                .collect::<Vec<_>>();
            if !String::from_utf16_lossy(&name).eq_ignore_ascii_case("::$DATA") {
                return Err(TextTransactionError::new(
                    TextTransactionErrorCode::MetadataPreservation,
                    "files with non-default alternate data streams are not replaced",
                ));
            }
            if entry.NextEntryOffset == 0 {
                break;
            }
            let next = entry.NextEntryOffset as usize;
            if next < header_size || next > used - offset {
                return Err(TextTransactionError::new(
                    TextTransactionErrorCode::MetadataPreservation,
                    "filesystem returned an invalid alternate stream entry offset",
                ));
            }
            offset += next;
        }
        return Ok(());
    }
}

fn atomic_rename(
    temp: HANDLE,
    parent: HANDLE,
    leaf: &str,
    replace: bool,
) -> Result<(), TextTransactionError> {
    let name: Vec<u16> = OsStr::new(leaf).encode_wide().collect();
    // Keep one extra UTF-16 NUL in the backing buffer. FileNameLength excludes it, but
    // several Windows filesystem drivers validate that the variable structure has room.
    let mut storage =
        vec![0u8; size_of::<FILE_RENAME_INFORMATION>() + name.len() * size_of::<u16>()];
    let info = storage.as_mut_ptr().cast::<FILE_RENAME_INFORMATION>();
    unsafe {
        if replace {
            (*info).Anonymous.Flags = FILE_RENAME_REPLACE_IF_EXISTS
                | FILE_RENAME_POSIX_SEMANTICS
                | FILE_RENAME_IGNORE_READONLY_ATTRIBUTE;
        } else {
            (*info).Anonymous.Flags = 0;
        }
        (*info).RootDirectory = parent;
        (*info).FileNameLength = (name.len() * 2) as u32;
        std::ptr::copy_nonoverlapping(name.as_ptr(), (*info).FileName.as_mut_ptr(), name.len());
        let mut status_block = IO_STATUS_BLOCK::default();
        let status = NtSetInformationFile(
            temp,
            &mut status_block,
            info.cast(),
            storage.len() as u32,
            FileRenameInformationEx,
        );
        if status < 0 {
            return Err(TextTransactionError::os(
                TextTransactionErrorCode::Io,
                "atomic text transaction replace failed",
                RtlNtStatusToDosError(status),
            ));
        }
    }
    Ok(())
}

fn delete_by_handle(handle: HANDLE) -> Result<(), TextTransactionError> {
    let info = FILE_DISPOSITION_INFO_EX {
        Flags: FILE_DISPOSITION_FLAG_DELETE
            | FILE_DISPOSITION_FLAG_POSIX_SEMANTICS
            | FILE_DISPOSITION_FLAG_IGNORE_READONLY_ATTRIBUTE,
    };
    if unsafe {
        SetFileInformationByHandle(
            handle,
            FileDispositionInfoEx,
            (&info as *const FILE_DISPOSITION_INFO_EX).cast(),
            size_of::<FILE_DISPOSITION_INFO_EX>() as u32,
        )
    } == 0
    {
        return Err(last_io(
            "cannot remove failed text transaction temporary file",
        ));
    }
    Ok(())
}

fn reject_reparse(handle: HANDLE) -> Result<(), TextTransactionError> {
    let info: FILE_ATTRIBUTE_TAG_INFO = query_info(handle, FileAttributeTagInfo)?;
    if info.FileAttributes & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
        return Err(TextTransactionError::new(
            TextTransactionErrorCode::ReparsePoint,
            "reparse points are not accepted by trusted text transactions",
        ));
    }
    Ok(())
}

fn reject_case_sensitive_directory(handle: HANDLE) -> Result<(), TextTransactionError> {
    let info: FILE_CASE_SENSITIVE_INFO = query_info(handle, FileCaseSensitiveInfo)?;
    if info.Flags & FILE_CS_FLAG_CASE_SENSITIVE_DIR != 0 {
        return Err(TextTransactionError::new(
            TextTransactionErrorCode::UnsupportedFilesystem,
            "case-sensitive Windows directories are not supported by the stable slot namespace",
        ));
    }
    Ok(())
}

fn file_identity(handle: HANDLE) -> Result<FileIdentity, TextTransactionError> {
    let info: FILE_ID_INFO = query_info(handle, FileIdInfo)?;
    Ok(FileIdentity {
        volume: info.VolumeSerialNumber,
        file_id: info.FileId.Identifier,
    })
}

fn query_info<T: Default>(handle: HANDLE, class: i32) -> Result<T, TextTransactionError> {
    let mut value = T::default();
    if unsafe {
        GetFileInformationByHandleEx(
            handle,
            class,
            (&mut value as *mut T).cast::<c_void>(),
            size_of::<T>() as u32,
        )
    } == 0
    {
        return Err(last_io(
            "cannot query trusted text transaction file identity",
        ));
    }
    Ok(value)
}

fn present_revision(slot_id: &str, identity: FileIdentity, bytes: &[u8]) -> String {
    let mut hash = Sha256::new();
    hash.update(b"kodax-text-revision-v1\0");
    hash.update(slot_id.as_bytes());
    hash.update(identity.volume.to_le_bytes());
    hash.update(identity.file_id);
    hash.update(bytes);
    format!("present:{:x}", hash.finalize())
}

fn wide_nul(value: &str) -> Vec<u16> {
    OsStr::new(value).encode_wide().chain(Some(0)).collect()
}

fn canonical_dos_path(handle: HANDLE) -> Result<String, TextTransactionError> {
    let required = unsafe { GetFinalPathNameByHandleW(handle, null_mut(), 0, 0) };
    if required == 0 {
        return Err(last_io("cannot resolve the trusted root canonical path"));
    }
    let mut buffer = vec![0u16; required as usize + 1];
    let written =
        unsafe { GetFinalPathNameByHandleW(handle, buffer.as_mut_ptr(), buffer.len() as u32, 0) };
    if written == 0 || written as usize >= buffer.len() {
        return Err(last_io("cannot read the trusted root canonical path"));
    }
    let raw = String::from_utf16(&buffer[..written as usize]).map_err(|_| {
        TextTransactionError::new(
            TextTransactionErrorCode::UnsupportedFilesystem,
            "trusted root canonical path is not valid UTF-16",
        )
    })?;
    if raw.to_ascii_lowercase().starts_with("\\\\?\\unc\\") {
        return Err(TextTransactionError::new(
            TextTransactionErrorCode::RemoteFilesystem,
            "remote filesystems are not supported for trusted text transactions",
        ));
    }
    let Some(dos) = raw.strip_prefix("\\\\?\\") else {
        return Err(TextTransactionError::new(
            TextTransactionErrorCode::UnsupportedFilesystem,
            "trusted root did not resolve to a local DOS path",
        ));
    };
    let sentinel = format!("{}\\.__kodax_canonical_probe__", dos.trim_end_matches('\\'));
    validate_windows_target(dos, &sentinel)?;
    Ok(dos.trim_end_matches('\\').to_owned())
}

fn windows_path_key(value: &str) -> String {
    windows_namespace_key(value.trim_end_matches('\\'))
}

fn require_supported_filesystem(handle: HANDLE) -> Result<(), TextTransactionError> {
    let mut filesystem = vec![0u16; 32];
    if unsafe {
        GetVolumeInformationByHandleW(
            handle,
            null_mut(),
            0,
            null_mut(),
            null_mut(),
            null_mut(),
            filesystem.as_mut_ptr(),
            filesystem.len() as u32,
        )
    } == 0
    {
        return Err(last_io("cannot identify the trusted root filesystem"));
    }
    let length = filesystem
        .iter()
        .position(|character| *character == 0)
        .unwrap_or(filesystem.len());
    let name = String::from_utf16_lossy(&filesystem[..length]);
    if !name.eq_ignore_ascii_case("NTFS") && !name.eq_ignore_ascii_case("ReFS") {
        return Err(TextTransactionError::new(
            TextTransactionErrorCode::UnsupportedFilesystem,
            format!("trusted text transactions require NTFS or ReFS, not {name}"),
        ));
    }
    Ok(())
}

fn last_io(message: &str) -> TextTransactionError {
    let code = unsafe { GetLastError() };
    TextTransactionError::os(TextTransactionErrorCode::Io, message, code)
}

fn metadata_error(message: &str) -> TextTransactionError {
    let code = unsafe { GetLastError() };
    TextTransactionError::os(
        TextTransactionErrorCode::MetadataPreservation,
        message,
        code,
    )
}

#[cfg(test)]
mod tests {
    use std::fs;
    use std::os::windows::ffi::OsStrExt;
    use std::sync::mpsc;
    use std::time::{Duration, Instant};

    use super::*;

    fn test_tempdir() -> tempfile::TempDir {
        let base = std::env::var_os("KODAX_NATIVE_TEST_TEMP")
            .map(std::path::PathBuf::from)
            .unwrap_or_else(|| std::env::current_dir().expect("native test current directory"));
        fs::create_dir_all(&base).expect("native test temporary base");
        tempfile::Builder::new()
            .prefix("kodax-text-")
            .tempdir_in(base)
            .expect("native test temporary directory")
    }

    fn test_dacl(path: &std::path::Path) -> Vec<u8> {
        use windows_sys::Win32::Security::GetFileSecurityW;

        let wide = path
            .as_os_str()
            .encode_wide()
            .chain(Some(0))
            .collect::<Vec<_>>();
        let mut required = 0;
        unsafe {
            GetFileSecurityW(
                wide.as_ptr(),
                DACL_SECURITY_INFORMATION,
                null_mut(),
                0,
                &mut required,
            )
        };
        assert!(required > 0);
        let mut descriptor = vec![0u8; required as usize];
        assert_ne!(
            unsafe {
                GetFileSecurityW(
                    wide.as_ptr(),
                    DACL_SECURITY_INFORMATION,
                    descriptor.as_mut_ptr().cast(),
                    descriptor.len() as u32,
                    &mut required,
                )
            },
            0
        );
        descriptor
    }

    #[test]
    fn public_mutex_precreation_cannot_contend_a_host_text_slot() {
        let slot_id = format!("precreate-{}", Uuid::new_v4().simple());
        let public_name = wide_nul(&format!("Global\\KodaX-TextTx-v1-{slot_id}"));
        let (ready_tx, ready_rx) = mpsc::channel();
        let (release_tx, release_rx) = mpsc::channel();
        let hostile = std::thread::spawn(move || {
            let raw = unsafe { CreateMutexW(null(), 1, public_name.as_ptr()) };
            assert!(!raw.is_null());
            let handle = OwnedHandle(raw);
            ready_tx.send(()).unwrap();
            release_rx.recv().unwrap();
            unsafe { ReleaseMutex(handle.raw()) };
        });
        ready_rx.recv_timeout(Duration::from_secs(2)).unwrap();

        let acquired = TransactionMutex::acquire(&slot_id, 0);

        release_tx.send(()).unwrap();
        hostile.join().unwrap();
        assert!(
            acquired.is_ok(),
            "a public named-object squatter blocked the trusted text transaction"
        );
    }

    #[test]
    fn host_private_namespace_still_serializes_the_same_slot() {
        let slot_id = format!("same-slot-{}", Uuid::new_v4().simple());
        let held_slot = slot_id.clone();
        let (ready_tx, ready_rx) = mpsc::channel();
        let (release_tx, release_rx) = mpsc::channel();
        let holder = std::thread::spawn(move || {
            let _held = TransactionMutex::acquire(&held_slot, INFINITE).unwrap();
            ready_tx.send(()).unwrap();
            release_rx.recv().unwrap();
        });
        ready_rx.recv_timeout(Duration::from_secs(2)).unwrap();

        let error = match TransactionMutex::acquire(&slot_id, 0) {
            Ok(_) => panic!("same-slot text transaction was not serialized"),
            Err(error) => error,
        };

        release_tx.send(()).unwrap();
        holder.join().unwrap();
        assert_eq!(
            error.code,
            TextTransactionErrorCode::Contended,
            "unexpected same-slot acquisition error: {error:?}"
        );
    }

    #[test]
    #[ignore]
    fn crash_private_mutex_holder() {
        let Ok(slot_id) = std::env::var("KODAX_TEXT_TX_TEST_PRIVATE_SLOT") else {
            return;
        };
        let ready = std::env::var("KODAX_TEXT_TX_TEST_PRIVATE_READY").unwrap();
        let _held = TransactionMutex::acquire(&slot_id, INFINITE).unwrap();
        fs::write(ready, "ready").unwrap();
        std::thread::sleep(Duration::from_secs(60));
    }

    #[test]
    #[ignore]
    fn crash_at_atomic_boundary_holder() {
        let Ok(root_path) = std::env::var("KODAX_TEXT_TX_CRASH_ROOT") else {
            return;
        };
        let target = std::env::var("KODAX_TEXT_TX_CRASH_TARGET").unwrap();
        let content = std::env::var("KODAX_TEXT_TX_CRASH_CONTENT").unwrap();
        let stage = std::env::var("KODAX_TEXT_TX_CRASH_STAGE").unwrap();
        let ready = std::env::var("KODAX_TEXT_TX_CRASH_READY").unwrap();

        let root = TrustedRoot::open(&root_path).unwrap();
        let validated = validate_windows_target(&root.root_text, &target).unwrap();
        let canonical_path = root.canonical_target(&validated);
        let slot_id = root.slot_id(&canonical_path);
        let (parents, leaf) = root.open_parent(&validated, false).unwrap().unwrap();
        let parent = parents.last().unwrap_or(&root.root);
        root.ensure_target_location(parent.raw(), leaf, &validated)
            .unwrap();
        let before = read_snapshot(parent.raw(), leaf, &slot_id, &canonical_path).unwrap();

        let temp_name = format!(".kodax-tx-{}.tmp", Uuid::new_v4().simple());
        let temp = open_relative(
            parent.raw(),
            &temp_name,
            DELETE
                | FILE_WRITE_DATA
                | FILE_WRITE_ATTRIBUTES
                | FILE_READ_ATTRIBUTES
                | READ_CONTROL
                | WRITE_DAC
                | WRITE_OWNER
                | SYNCHRONIZE,
            0,
            FILE_CREATE,
            FILE_NON_DIRECTORY_FILE | FILE_OPEN_REPARSE_POINT | FILE_OPEN_REQUIRING_OPLOCK,
        )
        .unwrap()
        .unwrap();
        let temp = OplockedTemp::request(temp).unwrap();
        root.revalidate_transaction_location(
            &parents,
            parent.raw(),
            leaf,
            &validated,
            temp.raw(),
            &temp_name,
        )
        .unwrap();
        if before.state == ResourceState::Present {
            let existing = open_existing_for_metadata(parent.raw(), leaf).unwrap();
            reject_non_default_streams(existing.raw()).unwrap();
            copy_metadata(existing.raw(), temp.raw()).unwrap();
        }
        temp.ensure_held().unwrap();
        write_all(temp.raw(), content.as_bytes()).unwrap();
        assert_ne!(unsafe { FlushFileBuffers(temp.raw()) }, 0);
        temp.ensure_held().unwrap();

        match stage.as_str() {
            "before-rename" => {}
            "after-rename" => {
                atomic_rename(
                    temp.raw(),
                    parent.raw(),
                    leaf,
                    before.state == ResourceState::Present,
                )
                .unwrap();
                // The parent kills this process while it is parked immediately
                // after the namespace commit point. Production has no fallible
                // operation after a successful rename.
            }
            other => panic!("unknown atomic crash stage: {other}"),
        }
        fs::write(ready, "ready").unwrap();
        std::thread::sleep(Duration::from_secs(60));
    }

    #[test]
    fn private_mutex_is_abandoned_when_its_owner_process_dies() {
        let directory = test_tempdir();
        let ready = directory.path().join("ready");
        let slot_id = format!("crash-{}", Uuid::new_v4().simple());
        let mut child = std::process::Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "windows_transaction::tests::crash_private_mutex_holder",
                "--ignored",
            ])
            .env("KODAX_TEXT_TX_TEST_PRIVATE_SLOT", &slot_id)
            .env("KODAX_TEXT_TX_TEST_PRIVATE_READY", &ready)
            .spawn()
            .unwrap();
        let deadline = Instant::now() + Duration::from_secs(5);
        while !ready.exists() && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(10));
        }
        assert!(
            ready.exists(),
            "child never acquired the private kernel slot"
        );

        // Open the same production object before killing its owner. Keeping a
        // waiter handle alive makes Windows report WAIT_ABANDONED instead of
        // deleting the object and letting a later creator acquire a fresh one.
        let _namespace = host_private_namespace().unwrap();
        let name = wide_nul(&format!("{TEXT_TRANSACTION_NAMESPACE_ALIAS}\\{slot_id}"));
        let waiter = OwnedHandle(unsafe { CreateMutexW(null(), 0, name.as_ptr()) });
        assert!(!waiter.raw().is_null());
        assert_eq!(unsafe { GetLastError() }, ERROR_ALREADY_EXISTS);
        child.kill().unwrap();
        child.wait().unwrap();

        assert_eq!(
            unsafe { WaitForSingleObject(waiter.raw(), 5_000) },
            WAIT_ABANDONED,
            "Windows did not abandon the dead owner's private mutex"
        );
        unsafe { ReleaseMutex(waiter.raw()) };
        drop(waiter);
        assert!(TransactionMutex::acquire(&slot_id, 5_000).is_ok());
    }

    #[test]
    fn public_commit_rereads_after_a_mutex_owner_process_dies() {
        let directory = test_tempdir();
        let target = directory.path().join("after-crash.txt");
        let root = TrustedRoot::open(&directory.path().to_string_lossy()).unwrap();
        let snapshot = root.snapshot(&target.to_string_lossy()).unwrap();
        let ready = directory.path().join("owner-ready");
        let mut child = std::process::Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "windows_transaction::tests::crash_private_mutex_holder",
                "--ignored",
            ])
            .env("KODAX_TEXT_TX_TEST_PRIVATE_SLOT", &snapshot.slot_id)
            .env("KODAX_TEXT_TX_TEST_PRIVATE_READY", &ready)
            .spawn()
            .unwrap();
        let deadline = Instant::now() + Duration::from_secs(5);
        while !ready.exists() && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(10));
        }
        assert!(ready.exists(), "child never acquired the production slot");

        let _namespace = host_private_namespace().unwrap();
        let name = wide_nul(&format!(
            "{TEXT_TRANSACTION_NAMESPACE_ALIAS}\\{}",
            snapshot.slot_id
        ));
        let waiter = OwnedHandle(unsafe { CreateMutexW(null(), 0, name.as_ptr()) });
        assert!(!waiter.raw().is_null());
        assert_eq!(unsafe { GetLastError() }, ERROR_ALREADY_EXISTS);
        child.kill().unwrap();
        child.wait().unwrap();

        let outcome = root
            .commit(
                &target.to_string_lossy(),
                &snapshot.revision,
                "recovered",
                false,
                5_000,
            )
            .unwrap();
        let CommitOutcome::Written(receipt) = outcome else {
            panic!("abandoned production slot did not commit");
        };
        assert!(receipt.abandoned_lock);
        assert_eq!(fs::read_to_string(target).unwrap(), "recovered");
        drop(waiter);
    }

    #[test]
    fn failure_after_atomic_rename_never_deletes_the_committed_target() {
        let directory = test_tempdir();
        let target = directory.path().join("post-commit-failure.txt");
        fs::write(&target, "before").unwrap();
        let root = TrustedRoot::open(&directory.path().to_string_lossy()).unwrap();
        let snapshot = root.snapshot(&target.to_string_lossy()).unwrap();
        FAIL_AFTER_ATOMIC_RENAME.with(|flag| flag.set(true));

        let outcome = root
            .commit(
                &target.to_string_lossy(),
                &snapshot.revision,
                "after",
                false,
                5_000,
            )
            .unwrap();
        let CommitOutcome::CommittedUncertain { receipt, message } = outcome else {
            panic!("post-commit failure did not preserve an uncertain receipt");
        };
        assert_eq!(receipt.pre_content, "before");
        assert!(message.contains("finalization was not proven"));
        assert_eq!(fs::read_to_string(&target).unwrap(), "after");
        assert!(matches!(
            root.commit(
                &target.to_string_lossy(),
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
    #[allow(clippy::permissions_set_readonly_false)]
    fn process_crash_on_either_side_of_atomic_rename_exposes_only_old_or_new_content() {
        // The handle-relative rename is the single visibility linearization point.
        // Every earlier production phase writes only the private temp; every later
        // phase observes an already renamed, pre-flushed complete file.
        for target_existed in [false, true] {
            for (stage, expected) in [("before-rename", "old"), ("after-rename", "new")] {
                let directory = test_tempdir();
                let target = directory.path().join("atomic-crash.txt");
                if target_existed {
                    fs::write(&target, "old").unwrap();
                    let mut permissions = fs::metadata(&target).unwrap().permissions();
                    permissions.set_readonly(true);
                    fs::set_permissions(&target, permissions).unwrap();
                }
                let dacl_before = target_existed.then(|| test_dacl(&target));
                let ready = directory.path().join("ready");
                let mut child = std::process::Command::new(std::env::current_exe().unwrap())
                    .args([
                        "--exact",
                        "windows_transaction::tests::crash_at_atomic_boundary_holder",
                        "--ignored",
                    ])
                    .env("KODAX_TEXT_TX_CRASH_ROOT", directory.path())
                    .env("KODAX_TEXT_TX_CRASH_TARGET", &target)
                    .env("KODAX_TEXT_TX_CRASH_CONTENT", "new")
                    .env("KODAX_TEXT_TX_CRASH_STAGE", stage)
                    .env("KODAX_TEXT_TX_CRASH_READY", &ready)
                    .spawn()
                    .unwrap();
                let deadline = Instant::now() + Duration::from_secs(5);
                while !ready.exists() && Instant::now() < deadline {
                    std::thread::sleep(Duration::from_millis(10));
                }
                assert!(
                    ready.exists(),
                    "child did not reach {stage} for existing={target_existed}"
                );
                child.kill().unwrap();
                child.wait().unwrap();

                if target_existed || stage == "after-rename" {
                    assert_eq!(fs::read_to_string(&target).unwrap(), expected);
                    let root = TrustedRoot::open(&directory.path().to_string_lossy()).unwrap();
                    let snapshot = root.snapshot(&target.to_string_lossy()).unwrap();
                    assert_eq!(snapshot.state, ResourceState::Present);
                    assert_eq!(snapshot.content, expected);
                    if let Some(dacl_before) = &dacl_before {
                        use std::os::windows::fs::MetadataExt;

                        assert_eq!(test_dacl(&target), *dacl_before);
                        assert_ne!(fs::metadata(&target).unwrap().file_attributes() & 1, 0);
                    }
                } else {
                    assert!(!target.exists());
                }
                if target.exists() {
                    let mut permissions = fs::metadata(&target).unwrap().permissions();
                    permissions.set_readonly(false);
                    fs::set_permissions(&target, permissions).unwrap();
                }
            }
        }
    }

    #[test]
    fn rwh_oplock_blocks_an_ancestor_rename_until_the_temp_handle_closes() {
        let directory = test_tempdir();
        let authorized = directory.path().join("authorized");
        let moved = directory.path().join("moved");
        fs::create_dir(&authorized).unwrap();
        let root = TrustedRoot::open(&authorized.to_string_lossy()).unwrap();
        let temp_name = ".kodax-oplock-test.tmp";
        let temp = open_relative(
            root.root.raw(),
            temp_name,
            DELETE | FILE_WRITE_DATA | FILE_READ_ATTRIBUTES | SYNCHRONIZE,
            0,
            FILE_CREATE,
            FILE_NON_DIRECTORY_FILE | FILE_OPEN_REPARSE_POINT | FILE_OPEN_REQUIRING_OPLOCK,
        )
        .unwrap()
        .unwrap();
        let temp = OplockedTemp::request(temp).unwrap();
        let (started_tx, started_rx) = mpsc::channel();
        let (finished_tx, finished_rx) = mpsc::channel();
        let rename = std::thread::spawn(move || {
            started_tx.send(()).unwrap();
            let result = fs::rename(authorized, moved);
            finished_tx.send(result).unwrap();
        });
        started_rx.recv_timeout(Duration::from_secs(2)).unwrap();

        let deadline = Instant::now() + Duration::from_secs(2);
        while temp.ensure_held().is_ok() && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(10));
        }
        assert!(
            temp.ensure_held().is_err(),
            "ancestor rename did not break the RWH oplock"
        );
        assert!(
            finished_rx.try_recv().is_err(),
            "ancestor rename bypassed oplock acknowledgement"
        );

        drop(temp);
        finished_rx
            .recv_timeout(Duration::from_secs(2))
            .expect("ancestor rename stayed blocked after oplock close")
            .unwrap();
        rename.join().unwrap();
    }
}
