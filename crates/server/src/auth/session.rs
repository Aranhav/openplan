use std::time::Duration;

use sha2::{Digest, Sha256};
use sqlx::{PgExecutor, PgPool};
use tokio::time::MissedTickBehavior;
use uuid::Uuid;

use crate::error::AppResult;

use super::{CurrentUser, random_token};

pub const SESSION_TTL_DAYS: i32 = 14;
pub const SESSION_RENEW_BELOW_DAYS: i32 = 7;
const PURGE_INTERVAL: Duration = Duration::from_secs(60 * 60);

#[derive(sqlx::FromRow)]
struct SessionRow {
    #[sqlx(flatten)]
    user: CurrentUser,
    near_expiry: bool,
}

/// An unexpired session of an enabled user, found by [`lookup`].
pub struct ActiveSession {
    pub user: CurrentUser,
    /// Whether this lookup extended the session to a full `SESSION_TTL_DAYS`.
    pub renewed: bool,
}

fn hash_token(raw: &str) -> Vec<u8> {
    Sha256::digest(raw.as_bytes()).to_vec()
}

/// Starts a session for `user_id` and returns the raw token. Only its SHA-256
/// hash is stored.
pub async fn create(db: &PgPool, user_id: Uuid, user_agent: Option<&str>) -> AppResult<String> {
    let token = random_token();
    sqlx::query(
        "INSERT INTO sessions (id_hash, user_id, expires_at, user_agent)
         VALUES ($1, $2, now() + make_interval(days => $3), $4)",
    )
    .bind(hash_token(&token))
    .bind(user_id)
    .bind(SESSION_TTL_DAYS)
    .bind(user_agent)
    .execute(db)
    .await?;
    Ok(token)
}

/// Finds an unexpired session of an enabled user and returns that user in the
/// same query. One with fewer than `SESSION_RENEW_BELOW_DAYS` days left is
/// extended to a full `SESSION_TTL_DAYS`; a disabled user's session is never
/// renewed.
pub async fn lookup(db: &PgPool, raw: &str) -> AppResult<Option<ActiveSession>> {
    let id_hash = hash_token(raw);
    let row = sqlx::query_as::<_, SessionRow>(
        "SELECT u.id, u.email, u.name, u.is_instance_admin,
                s.expires_at < now() + make_interval(days => $2) AS near_expiry
         FROM sessions s JOIN users u ON u.id = s.user_id
         WHERE s.id_hash = $1 AND s.expires_at > now() AND NOT u.disabled",
    )
    .bind(&id_hash)
    .bind(SESSION_RENEW_BELOW_DAYS)
    .fetch_optional(db)
    .await?;
    let Some(row) = row else {
        return Ok(None);
    };
    if row.near_expiry {
        sqlx::query(
            "UPDATE sessions SET expires_at = now() + make_interval(days => $2)
             WHERE id_hash = $1",
        )
        .bind(&id_hash)
        .bind(SESSION_TTL_DAYS)
        .execute(db)
        .await?;
    }
    Ok(Some(ActiveSession {
        user: row.user,
        renewed: row.near_expiry,
    }))
}

pub async fn delete(db: &PgPool, raw: &str) -> AppResult<()> {
    sqlx::query("DELETE FROM sessions WHERE id_hash = $1")
        .bind(hash_token(raw))
        .execute(db)
        .await?;
    Ok(())
}

pub async fn delete_all_for_user(db: impl PgExecutor<'_>, user_id: Uuid) -> AppResult<()> {
    sqlx::query("DELETE FROM sessions WHERE user_id = $1")
        .bind(user_id)
        .execute(db)
        .await?;
    Ok(())
}

/// Deletes every session of `user_id` except the one whose raw token is
/// `keep_raw_token`.
pub async fn delete_others(
    db: impl PgExecutor<'_>,
    user_id: Uuid,
    keep_raw_token: &str,
) -> AppResult<()> {
    sqlx::query("DELETE FROM sessions WHERE user_id = $1 AND id_hash <> $2")
        .bind(user_id)
        .bind(hash_token(keep_raw_token))
        .execute(db)
        .await?;
    Ok(())
}

/// Deletes every expired session and returns how many there were.
pub async fn purge_expired(db: &PgPool) -> AppResult<u64> {
    let result = sqlx::query("DELETE FROM sessions WHERE expires_at < now()")
        .execute(db)
        .await?;
    Ok(result.rows_affected())
}

/// Purges expired sessions right away and then once an hour, for as long as
/// the process runs. A failed purge is logged and tried again next time.
pub async fn purge_expired_periodically(db: PgPool) {
    let mut ticker = tokio::time::interval(PURGE_INTERVAL);
    ticker.set_missed_tick_behavior(MissedTickBehavior::Delay);
    loop {
        ticker.tick().await;
        match purge_expired(&db).await {
            Ok(0) => {}
            Ok(purged) => tracing::info!(purged, "purged expired sessions"),
            Err(error) => tracing::warn!(%error, "failed to purge expired sessions"),
        }
    }
}
