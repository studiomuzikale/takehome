use anyhow::Context;
use sqlx::{postgres::PgPoolOptions, Executor, PgPool};

pub async fn create_pool(database_url: &str) -> anyhow::Result<PgPool> {
    PgPoolOptions::new()
        .max_connections(
            std::env::var("PG_POOL_SIZE")
                .ok()
                .and_then(|value| value.parse().ok())
                .unwrap_or(20),
        )
        .connect(database_url)
        .await
        .context("failed to connect to Postgres")
}

pub async fn migrate(pool: &PgPool) -> anyhow::Result<()> {
    let schema = match tokio::fs::read_to_string("../sql/schema.sql").await {
        Ok(schema) => schema,
        Err(_) => {
            std::fs::read_to_string("sql/schema.sql").context("failed to read shared SQL schema")?
        }
    };
    pool.execute(schema.as_str()).await?;
    Ok(())
}
