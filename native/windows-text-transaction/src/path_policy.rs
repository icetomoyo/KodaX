use crate::{TextTransactionError, TextTransactionErrorCode};

#[cfg(windows)]
use std::ffi::OsStr;
#[cfg(windows)]
use std::os::windows::ffi::OsStrExt;
#[cfg(windows)]
use windows_sys::Wdk::System::SystemServices::RtlUpcaseUnicodeString;
#[cfg(windows)]
use windows_sys::Win32::Foundation::UNICODE_STRING;

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ValidatedWindowsTarget {
    pub relative_components: Vec<String>,
    pub normalized_relative: String,
}

#[derive(Clone, Debug)]
struct ScreenedAbsolutePath {
    drive: char,
    components: Vec<String>,
}

pub fn validate_windows_target(
    trusted_root: &str,
    target: &str,
) -> Result<ValidatedWindowsTarget, TextTransactionError> {
    let root = screen_absolute_path(trusted_root)?;
    let target = screen_absolute_path(target)?;
    if !root.drive.eq_ignore_ascii_case(&target.drive)
        || target.components.len() <= root.components.len()
        || !root
            .components
            .iter()
            .zip(target.components.iter())
            .all(|(left, right)| windows_namespace_key(left) == windows_namespace_key(right))
    {
        return Err(TextTransactionError::new(
            TextTransactionErrorCode::UnauthorizedPath,
            "text mutation target is outside the trusted root",
        ));
    }
    let relative_components = target.components[root.components.len()..].to_vec();
    if relative_components
        .iter()
        .any(|component| windows_namespace_key(component) == ".GIT")
    {
        return Err(TextTransactionError::new(
            TextTransactionErrorCode::UnauthorizedPath,
            "trusted text mutation denied protected Git metadata",
        ));
    }
    let normalized_relative = relative_components
        .iter()
        .map(|component| windows_namespace_key(component))
        .collect::<Vec<_>>()
        .join("\\");
    Ok(ValidatedWindowsTarget {
        relative_components,
        normalized_relative,
    })
}

fn screen_absolute_path(value: &str) -> Result<ScreenedAbsolutePath, TextTransactionError> {
    if value.is_empty() || value.contains('\0') {
        return Err(TextTransactionError::invalid_path(
            "Windows text mutation path is empty or contains NUL",
        ));
    }
    let normalized = value.replace('/', "\\");
    if normalized.encode_utf16().count() > 32_767 {
        return Err(TextTransactionError::invalid_path(
            "Windows text mutation path exceeds the NT namespace length bound",
        ));
    }
    let lower = normalized.to_ascii_lowercase();
    if normalized.starts_with("\\\\")
        || lower.starts_with("\\??\\")
        || lower.starts_with("\\device\\")
        || lower.starts_with("\\global??\\")
        || lower.starts_with("globalroot\\")
    {
        return Err(TextTransactionError::invalid_path(
            "UNC and Windows device namespaces are not accepted",
        ));
    }
    let bytes = normalized.as_bytes();
    if bytes.len() < 3 || !bytes[0].is_ascii_alphabetic() || bytes[1] != b':' || bytes[2] != b'\\' {
        return Err(TextTransactionError::invalid_path(
            "Windows text mutation path must be drive-absolute",
        ));
    }
    if normalized[2..].contains(':') {
        return Err(TextTransactionError::invalid_path(
            "NTFS alternate data stream syntax is not accepted",
        ));
    }
    let remainder = &normalized[3..];
    if remainder.contains("\\\\") {
        return Err(TextTransactionError::invalid_path(
            "empty Windows path components are not accepted",
        ));
    }
    let mut components = Vec::new();
    for component in remainder
        .split('\\')
        .filter(|component| !component.is_empty())
    {
        screen_component(component)?;
        components.push(component.to_owned());
    }
    Ok(ScreenedAbsolutePath {
        drive: normalized.chars().next().expect("validated drive path"),
        components,
    })
}

fn screen_component(component: &str) -> Result<(), TextTransactionError> {
    if component.encode_utf16().count() > 255 {
        return Err(TextTransactionError::invalid_path(
            "Windows path component exceeds the filesystem namespace bound",
        ));
    }
    if component == "." || component == ".." {
        return Err(TextTransactionError::invalid_path(
            "relative Windows path components are not accepted",
        ));
    }
    if component.ends_with(['.', ' ']) {
        return Err(TextTransactionError::invalid_path(
            "Windows path components may not end in a dot or space",
        ));
    }
    if component
        .chars()
        .any(|character| character < ' ' || matches!(character, '<' | '>' | '"' | '|' | '?' | '*'))
    {
        return Err(TextTransactionError::invalid_path(
            "Windows path contains a reserved character",
        ));
    }
    if has_short_name_ambiguity(component) || is_dos_device(component) {
        return Err(TextTransactionError::invalid_path(
            "Windows path contains an ambiguous or reserved component",
        ));
    }
    Ok(())
}

fn has_short_name_ambiguity(component: &str) -> bool {
    let chars = component.chars().collect::<Vec<_>>();
    chars
        .windows(2)
        .any(|pair| pair[0] == '~' && matches!(pair[1], '0'..='9' | '¹' | '²' | '³'))
}

fn is_dos_device(component: &str) -> bool {
    let stem = component.split('.').next().unwrap_or(component);
    let upper = windows_namespace_key(stem);
    matches!(
        upper.as_str(),
        "CON" | "PRN" | "AUX" | "NUL" | "CONIN$" | "CONOUT$"
    ) || is_numbered_device(&upper, "COM")
        || is_numbered_device(&upper, "LPT")
}

#[cfg(windows)]
pub(crate) fn windows_namespace_key(value: &str) -> String {
    let mut source_units = OsStr::new(value).encode_wide().collect::<Vec<_>>();
    let mut destination_units = vec![0u16; source_units.len()];
    let source = UNICODE_STRING {
        Length: (source_units.len() * 2) as u16,
        MaximumLength: (source_units.len() * 2) as u16,
        Buffer: source_units.as_mut_ptr(),
    };
    let mut destination = UNICODE_STRING {
        Length: 0,
        MaximumLength: (destination_units.len() * 2) as u16,
        Buffer: destination_units.as_mut_ptr(),
    };
    let status = unsafe { RtlUpcaseUnicodeString(&mut destination, &source, false) };
    assert!(status >= 0, "kernel namespace upcase failed: 0x{status:x}");
    destination_units.truncate(destination.Length as usize / 2);
    String::from_utf16(&destination_units).expect("kernel upcase preserves valid UTF-16")
}

#[cfg(not(windows))]
pub(crate) fn windows_namespace_key(value: &str) -> String {
    value.to_uppercase()
}

fn is_numbered_device(value: &str, prefix: &str) -> bool {
    let suffix = value.strip_prefix(prefix);
    matches!(
        suffix,
        Some("1" | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9" | "¹" | "²" | "³")
    )
}
