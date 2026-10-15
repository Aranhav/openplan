use std::time::Duration;

use anyhow::Context;
use sqlx::{PgPool, postgres::PgPoolOptions};

pub static MIGRATOR: sqlx::migrate::Migrator = sqlx::migrate!("./migrations");

/// How long a request waits for a free connection. The default of 30 seconds
/// is longer than a proxy such as Vercel waits for a response.
const ACQUIRE_TIMEOUT: Duration = Duration::from_secs(10);

// `test_before_acquire` stays on: behind a pooler such as Supabase's, an idle
// connection may have been closed, and a failed ping gets a new one instead of
// a 500.
fn pool_options(pool_size: u32) -> PgPoolOptions {
    PgPoolOptions::new()
        .max_connections(pool_size)
        .acquire_timeout(ACQUIRE_TIMEOUT)
}

pub async fn connect(url: &str, pool_size: u32) -> anyhow::Result<PgPool> {
    pool_options(pool_size)
        .connect(url)
        .await
        .context("failed to connect to the database")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pool_uses_the_given_size_and_a_ten_second_acquire_timeout() {
        let options = pool_options(7);

        assert_eq!(options.get_max_connections(), 7);
        assert_eq!(options.get_acquire_timeout(), Duration::from_secs(10));
    }

    #[test]
    fn pool_keeps_checking_idle_connections_before_use() {
        assert!(pool_options(10).get_test_before_acquire());
    }
}
