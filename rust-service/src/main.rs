mod auth;
mod config;
mod db;
mod error;
mod models;
mod processor;
mod reports;
mod routes;

use std::{net::SocketAddr, sync::Arc};

use anyhow::Context;
use config::Config;
use routes::{router, AppState};
use tower_http::trace::TraceLayer;
use tracing_subscriber::{layer::SubscriberExt, util::SubscriberInitExt, EnvFilter};

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::registry()
        .with(EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info")))
        .with(tracing_subscriber::fmt::layer().json())
        .init();

    let config = Config::from_env();
    let pool = db::create_pool(&config.database_url).await?;
    db::migrate(&pool).await?;

    let state = AppState {
        pool,
        config: Arc::new(config.clone()),
    };
    let app = router(state).layer(TraceLayer::new_for_http());
    let addr = SocketAddr::from(([0, 0, 0, 0], config.port));
    let listener = tokio::net::TcpListener::bind(addr)
        .await
        .with_context(|| format!("failed to bind {addr}"))?;

    tracing::info!(%addr, "Rust bet processor listening");
    axum::serve(listener, app).await?;
    Ok(())
}
