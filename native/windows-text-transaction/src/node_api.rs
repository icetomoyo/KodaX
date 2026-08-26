use std::sync::Arc;

use napi::bindgen_prelude::AsyncTask;
use napi::{Env, Error, Status, Task};
use napi_derive::napi;

use crate::{CommitOutcome, TrustedRoot};

#[napi]
#[allow(dead_code)] // This protocol probe is consumed by the JavaScript loader.
pub fn text_transaction_protocol() -> u32 {
    4
}

#[napi(object)]
pub struct NativeTextSnapshot {
    pub state: String,
    pub content: String,
    pub revision: String,
    pub slot_id: String,
    pub canonical_path: String,
}

#[napi(object)]
pub struct NativeCommitOutcome {
    pub status: String,
    pub slot_id: Option<String>,
    pub current_revision: Option<String>,
    pub pre_content: Option<String>,
    pub pre_revision: Option<String>,
    pub post_revision: Option<String>,
    pub abandoned_lock: Option<bool>,
    pub message: Option<String>,
}

#[napi(js_name = "TrustedTextTransactionRoot")]
pub struct NativeTrustedRoot {
    inner: Arc<TrustedRoot>,
}

#[napi]
impl NativeTrustedRoot {
    #[napi(constructor)]
    pub fn new(root_path: String, state_root: Option<String>) -> napi::Result<Self> {
        Ok(Self {
            inner: Arc::new(
                open_trusted_root(&root_path, state_root.as_deref()).map_err(native_error)?,
            ),
        })
    }

    #[napi]
    pub fn snapshot(&self, target: String) -> AsyncTask<SnapshotTask> {
        AsyncTask::new(SnapshotTask {
            root: self.inner.clone(),
            target,
        })
    }

    #[napi]
    pub fn commit(
        &self,
        target: String,
        expected_revision: String,
        content: String,
        create_parents: bool,
        timeout_ms: u32,
    ) -> AsyncTask<CommitTask> {
        AsyncTask::new(CommitTask {
            root: self.inner.clone(),
            target,
            expected_revision,
            content,
            create_parents,
            timeout_ms,
        })
    }
}

#[cfg(windows)]
fn open_trusted_root(
    root_path: &str,
    _state_root: Option<&str>,
) -> Result<TrustedRoot, crate::TextTransactionError> {
    TrustedRoot::open(root_path)
}

#[cfg(unix)]
fn open_trusted_root(
    root_path: &str,
    state_root: Option<&str>,
) -> Result<TrustedRoot, crate::TextTransactionError> {
    let state_root = state_root.ok_or_else(|| {
        crate::TextTransactionError::invalid_path(
            "Unix trusted text transactions require a protected state root",
        )
    })?;
    TrustedRoot::open(root_path, state_root)
}

pub struct SnapshotTask {
    root: Arc<TrustedRoot>,
    target: String,
}

impl Task for SnapshotTask {
    type Output = crate::TextSnapshot;
    type JsValue = NativeTextSnapshot;

    fn compute(&mut self) -> napi::Result<Self::Output> {
        self.root.snapshot(&self.target).map_err(native_error)
    }

    fn resolve(&mut self, _env: Env, snapshot: Self::Output) -> napi::Result<Self::JsValue> {
        let state = match snapshot.state {
            crate::ResourceState::Missing => "missing",
            crate::ResourceState::Present => "present",
        };
        Ok(NativeTextSnapshot {
            state: state.to_owned(),
            content: snapshot.content,
            revision: snapshot.revision,
            slot_id: snapshot.slot_id,
            canonical_path: snapshot.canonical_path,
        })
    }
}

pub struct CommitTask {
    root: Arc<TrustedRoot>,
    target: String,
    expected_revision: String,
    content: String,
    create_parents: bool,
    timeout_ms: u32,
}

impl Task for CommitTask {
    type Output = CommitOutcome;
    type JsValue = NativeCommitOutcome;

    fn compute(&mut self) -> napi::Result<Self::Output> {
        self.root
            .commit(
                &self.target,
                &self.expected_revision,
                &self.content,
                self.create_parents,
                self.timeout_ms,
            )
            .map_err(native_error)
    }

    fn resolve(&mut self, _env: Env, outcome: Self::Output) -> napi::Result<Self::JsValue> {
        match outcome {
            CommitOutcome::Written(receipt) => Ok(NativeCommitOutcome {
                status: "written".to_owned(),
                slot_id: Some(receipt.slot_id),
                current_revision: None,
                pre_content: Some(receipt.pre_content),
                pre_revision: Some(receipt.pre_revision),
                post_revision: Some(receipt.post_revision),
                abandoned_lock: Some(receipt.abandoned_lock),
                message: None,
            }),
            CommitOutcome::Stale { current_revision } => Ok(NativeCommitOutcome {
                status: "stale".to_owned(),
                slot_id: None,
                current_revision: Some(current_revision),
                pre_content: None,
                pre_revision: None,
                post_revision: None,
                abandoned_lock: None,
                message: None,
            }),
            CommitOutcome::CommittedUncertain { receipt, message } => Ok(NativeCommitOutcome {
                status: "committed_uncertain".to_owned(),
                slot_id: Some(receipt.slot_id),
                current_revision: None,
                pre_content: Some(receipt.pre_content),
                pre_revision: Some(receipt.pre_revision),
                post_revision: Some(receipt.post_revision),
                abandoned_lock: Some(receipt.abandoned_lock),
                message: Some(message),
            }),
        }
    }
}

fn native_error(error: crate::TextTransactionError) -> Error {
    let encoded = match serde_json::to_string(&error) {
        Ok(value) => value,
        Err(serialization_failure) => format!(
            "{{\"code\":\"io\",\"message\":\"native error serialization failed: {}\"}}",
            serialization_failure
        ),
    };
    Error::new(
        Status::GenericFailure,
        format!("KODAX_TEXT_TRANSACTION:{encoded}"),
    )
}
