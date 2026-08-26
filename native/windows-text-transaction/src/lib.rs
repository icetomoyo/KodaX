mod error;
mod model;
mod path_policy;

#[cfg(all(any(windows, unix), feature = "node-api"))]
mod node_api;
#[cfg(unix)]
mod unix_transaction;
#[cfg(windows)]
mod windows_transaction;

pub use error::{TextTransactionError, TextTransactionErrorCode};
pub use model::{CommitOutcome, CommitReceipt, ResourceState, TextSnapshot};
pub use path_policy::{ValidatedWindowsTarget, validate_windows_target};
#[cfg(unix)]
pub use unix_transaction::TrustedRoot;
#[cfg(windows)]
pub use windows_transaction::TrustedRoot;
