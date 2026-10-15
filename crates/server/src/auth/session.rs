use sha2::{Digest, Sha256};
use sqlx::PgPool;
use uuid::Uuid;

use crate::error::AppResult;

use super::random_token;

pub const SESSION_TTL_DAYS: i32 = 14;
pub const SESSION_RENEW_BELOW_DAYS: i32 = 7;

#[derive(sqlx::FromRow)]
struct SessionRow {
    user_id: Uuid,
    near_expiry: bool,
}

/// An unexpired session found by [`lookup`].
pub struct ActiveSession {
    pub user_id: Uuid,
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

/// Finds an unexpired session. One with fewer than `SESSION_RENEW_BELOW_DAYS`
/// days left is extended to a full `SESSION_TTL_DAYS`.
pub async fn lookup(db: &PgPool, raw: &str) -> AppResult<Option<ActiveSession>> {
    let id_hash = hash_token(raw);
    let row = sqlx::query_as::<_, SessionRow>(
        "SELECT user_id, expires_at < now() + make_interval(days => $2) AS near_expiry
         FROM sessions
         WHERE id_hash = $1 AND expires_at > now()",
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
        user_id: row.user_id,
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

pub async fn delete_all_for_user(db: &PgPool, user_id: Uuid) -> AppResult<()> {
    sqlx::query("DELETE FROM sessions WHERE user_id = $1")
        .bind(user_id)
        .execute(db)
        .await?;
    Ok(())
}
