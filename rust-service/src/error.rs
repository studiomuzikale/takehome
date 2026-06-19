use axum::{
    http::StatusCode,
    response::{IntoResponse, Response},
    Json,
};
use serde_json::json;
use thiserror::Error;

#[derive(Debug, Error)]
pub enum AppError {
    #[error("forbidden")]
    Forbidden,
    #[error("bad request")]
    BadRequest,
    #[error("insufficient funds")]
    InsufficientFunds,
    #[error(transparent)]
    Sqlx(#[from] sqlx::Error),
    #[error(transparent)]
    Anyhow(#[from] anyhow::Error),
}

impl IntoResponse for AppError {
    fn into_response(self) -> Response {
        match self {
            AppError::Forbidden => {
                (StatusCode::FORBIDDEN, Json(json!({ "error": "Forbidden" }))).into_response()
            }
            AppError::BadRequest => (
                StatusCode::BAD_REQUEST,
                Json(json!({ "error": "Bad Request" })),
            )
                .into_response(),
            AppError::InsufficientFunds => (
                StatusCode::UNPROCESSABLE_ENTITY,
                Json(json!({
                    "code": 100,
                    "message": "Player has not enough funds to process an action"
                })),
            )
                .into_response(),
            error => {
                tracing::error!(?error, "unhandled application error");
                (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    Json(json!({ "error": "Internal Server Error" })),
                )
                    .into_response()
            }
        }
    }
}
