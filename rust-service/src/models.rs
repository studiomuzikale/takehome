use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

#[derive(Debug, Clone, Deserialize)]
pub struct ProcessRequest {
    pub user_id: String,
    pub currency: String,
    pub game: String,
    pub game_id: Option<String>,
    #[serde(rename = "finished")]
    pub _finished: Option<bool>,
    pub actions: Option<Vec<ProcessAction>>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "action")]
pub enum ProcessAction {
    #[serde(rename = "bet")]
    Bet { action_id: Uuid, amount: i64 },
    #[serde(rename = "win")]
    Win { action_id: Uuid, amount: i64 },
    #[serde(rename = "rollback")]
    Rollback {
        action_id: Uuid,
        original_action_id: Uuid,
    },
}

impl ProcessAction {
    pub fn action_id(&self) -> Uuid {
        match self {
            Self::Bet { action_id, .. }
            | Self::Win { action_id, .. }
            | Self::Rollback { action_id, .. } => *action_id,
        }
    }
}

#[derive(Debug, Serialize)]
#[serde(untagged)]
pub enum ProcessResponse {
    BalanceOnly {
        balance: i64,
    },
    Actions {
        #[serde(skip_serializing_if = "Option::is_none")]
        game_id: Option<String>,
        transactions: Vec<TransactionResponse>,
        balance: i64,
    },
}

#[derive(Debug, Serialize)]
pub struct TransactionResponse {
    pub action_id: Uuid,
    pub tx_id: Uuid,
}

#[derive(Debug, Clone)]
pub struct ClaimedAction {
    pub tx_id: Uuid,
    pub created_at: DateTime<Utc>,
    pub account_hash: i32,
}

#[derive(Debug)]
pub enum ClaimResult {
    Claimed(ClaimedAction),
    Duplicate { tx_id: Uuid },
}

#[derive(Debug, sqlx::FromRow)]
pub struct ExistingAction {
    pub action_id: Uuid,
    pub user_id: String,
    pub currency: String,
    pub action_type: String,
    pub amount: Option<i64>,
    pub balance_delta: i64,
    pub status: String,
    pub created_at: DateTime<Utc>,
}

#[derive(Debug, Deserialize)]
pub struct ReportQuery {
    pub from: DateTime<Utc>,
    pub to: DateTime<Utc>,
    pub currency: Option<String>,
    pub user_id: Option<String>,
    #[serde(default = "default_limit")]
    pub limit: i64,
    #[serde(default)]
    pub offset: i64,
}

fn default_limit() -> i64 {
    100
}

#[derive(Debug, Serialize, sqlx::FromRow)]
pub struct RtpRow {
    pub user_id: String,
    pub currency: String,
    pub rounds: i64,
    pub total_bet: i64,
    pub total_win: i64,
    pub rollback_count: i64,
    pub rolled_back_bet: i64,
    pub rolled_back_win: i64,
    pub rtp: Option<f64>,
}

#[derive(Debug, Serialize)]
pub struct UserRtpResponse {
    pub items: Vec<RtpRow>,
    pub limit: i64,
    pub offset: i64,
}
