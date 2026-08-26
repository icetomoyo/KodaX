use serde::Serialize;

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ResourceState {
    Missing,
    Present,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
pub struct TextSnapshot {
    pub state: ResourceState,
    pub content: String,
    pub revision: String,
    pub slot_id: String,
    pub canonical_path: String,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
pub struct CommitReceipt {
    pub slot_id: String,
    pub pre_state: ResourceState,
    pub pre_content: String,
    pub pre_revision: String,
    pub post_revision: String,
    pub abandoned_lock: bool,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(tag = "status", rename_all = "snake_case")]
pub enum CommitOutcome {
    Written(CommitReceipt),
    Stale {
        current_revision: String,
    },
    CommittedUncertain {
        receipt: CommitReceipt,
        message: String,
    },
}
