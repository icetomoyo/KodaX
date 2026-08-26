use serde::Serialize;
use thiserror::Error;

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum TextTransactionErrorCode {
    InvalidPath,
    UnauthorizedPath,
    ReparsePoint,
    HardLink,
    RemoteFilesystem,
    UnsupportedFilesystem,
    Contended,
    Stale,
    MetadataPreservation,
    Io,
    UnsupportedPlatform,
}

#[derive(Debug, Error, Serialize)]
#[error("{message}")]
pub struct TextTransactionError {
    pub code: TextTransactionErrorCode,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub os_code: Option<u32>,
}

impl TextTransactionError {
    pub(crate) fn new(code: TextTransactionErrorCode, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
            os_code: None,
        }
    }

    pub(crate) fn invalid_path(message: impl Into<String>) -> Self {
        Self::new(TextTransactionErrorCode::InvalidPath, message)
    }

    pub(crate) fn os(
        code: TextTransactionErrorCode,
        message: impl Into<String>,
        os_code: u32,
    ) -> Self {
        Self {
            code,
            message: message.into(),
            os_code: Some(os_code),
        }
    }
}
