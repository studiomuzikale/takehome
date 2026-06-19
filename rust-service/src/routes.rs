use std::sync::Arc;

use axum::{
    body::Bytes,
    extract::{Query, State},
    http::HeaderMap,
    routing::{get, post},
    Json, Router,
};
use serde_json::Value;
use sqlx::PgPool;

use crate::{
    auth::verify_authorization_header,
    config::Config,
    error::AppError,
    models::{ProcessRequest, ReportQuery},
    processor::proces_request,
    reports::{casino_rtp, user_rtp},
};

#[derive(Clone)]
pub struct AppState {
    pub pool: PgPool,
    pub config: Arc<Config>,
}

pub fn router(state: AppState) -> Router {
    Router::new()
        .route("/healthz", get(healthz))
        .route("/aggregator/takehome/process", post(proces))
        .route("/reports/rtp/users", get(report_users))
        .route("/reports/rtp/casino", get(report_casino))
        .with_state(state)
}

async fn healthz() -> Json<Value> {
    Json(serde_json::json!({ "ok": true, "service": "rust" }))
}

async fn proces(
    State(state): State<AppState>,
    headers: HeaderMap,
    body: Bytes,
) -> Result<Json<Value>, AppError> {
    verify_authorization_header(
        headers
            .get("authorization")
            .and_then(|value| value.to_str().ok()),
        &body,
        &state.config.hmac_secret,
    )?;
    let request: ProcessRequest =
        serde_json::from_slice(&body).map_err(|_| AppError::BadRequest)?;
    let response = proces_request(&state.pool, request).await?;
    Ok(Json(
        serde_json::to_value(response).map_err(|_| AppError::BadRequest)?,
    ))
}

async fn report_users(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(query): Query<ReportQuery>,
) -> Result<Json<Value>, AppError> {
    verify_authorization_header(
        headers
            .get("authorization")
            .and_then(|value| value.to_str().ok()),
        &[],
        &state.config.hmac_secret,
    )?;
    let response = user_rtp(&state.pool, query).await?;
    Ok(Json(
        serde_json::to_value(response).map_err(|_| AppError::BadRequest)?,
    ))
}

async fn report_casino(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(query): Query<ReportQuery>,
) -> Result<Json<Value>, AppError> {
    verify_authorization_header(
        headers
            .get("authorization")
            .and_then(|value| value.to_str().ok()),
        &[],
        &state.config.hmac_secret,
    )?;
    let response = casino_rtp(&state.pool, query).await?;
    Ok(Json(
        serde_json::to_value(response).map_err(|_| AppError::BadRequest)?,
    ))
}
