#[derive(Clone, Debug)]
pub struct Config {
    pub database_url: String,
    pub hmac_secret: String,
    pub port: u16,
}

impl Config {
    pub fn from_env() -> Self {
        dotenvy::dotenv().ok();
        Self {
            database_url: std::env::var("DATABASE_URL")
                .unwrap_or_else(|_| "postgres://yeet:yeet@localhost:5432/yeet".to_string()),
            hmac_secret: std::env::var("HMAC_SECRET").unwrap_or_else(|_| "test".to_string()),
            port: std::env::var("RUST_PORT")
                .or_else(|_| std::env::var("PORT"))
                .ok()
                .and_then(|value| value.parse().ok())
                .unwrap_or(3001),
        }
    }
}
