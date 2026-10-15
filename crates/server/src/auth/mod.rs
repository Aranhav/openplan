use axum::{extract::FromRequestParts, http::request::Parts};
use axum_extra::extract::cookie::{Cookie, CookieJar, SameSite};
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use cookie::time::Duration;
use rand::RngCore;
use serde::Serialize;
use sqlx::FromRow;
use utoipa::ToSchema;
use uuid::Uuid;

use crate::{app::AppState, error::AppError};

use renewal::SessionRenewal;

pub mod csrf;
pub mod password;
pub mod rate_limit;
pub mod renewal;
pub mod routes;
pub mod session;

pub const SESSION_COOKIE: &str = "op_session";
pub const CSRF_COOKIE: &str = "op_csrf";
pub const CSRF_HEADER: &str = "x-openplan-csrf";

#[derive(Clone, Serialize, ToSchema, FromRow)]
pub struct CurrentUser {
    pub id: Uuid,
    pub email: String,
    pub name: String,
    pub is_instance_admin: bool,
}

impl FromRequestParts<AppState> for CurrentUser {
    type Rejection = AppError;

    async fn from_request_parts(
        parts: &mut Parts,
        state: &AppState,
    ) -> Result<CurrentUser, AppError> {
        let jar = CookieJar::from_headers(&parts.headers);
        let token = jar
            .get(SESSION_COOKIE)
            .ok_or(AppError::Unauthenticated)?
            .value();
        let session = session::lookup(&state.db, token)
            .await?
            .ok_or(AppError::Unauthenticated)?;
        let csrf = jar
            .get(CSRF_COOKIE)
            .map(Cookie::value)
            .filter(|value| !value.is_empty());
        // A browser that lost its CSRF cookie gets a new one on its next request.
        if (session.renewed || csrf.is_none())
            && let Some(renewal) = parts.extensions.get::<SessionRenewal>()
        {
            renewal.offer(session_cookies_with_csrf(
                token,
                csrf.map_or_else(random_token, str::to_string),
                state.config.secure_cookies(),
            ));
        }
        Ok(session.user)
    }
}

/// 32 random bytes as unpadded base64url.
fn random_token() -> String {
    let mut bytes = [0u8; 32];
    rand::rng().fill_bytes(&mut bytes);
    URL_SAFE_NO_PAD.encode(bytes)
}

fn cookie(name: &'static str, value: String, http_only: bool, secure: bool) -> Cookie<'static> {
    Cookie::build((name, value))
        .path("/")
        .http_only(http_only)
        .secure(secure)
        .same_site(SameSite::Lax)
        .max_age(Duration::days(i64::from(session::SESSION_TTL_DAYS)))
        .build()
}

/// The `HttpOnly` session cookie and a new script-readable CSRF cookie.
pub fn session_cookies(token: &str, secure: bool) -> (Cookie<'static>, Cookie<'static>) {
    session_cookies_with_csrf(token, random_token(), secure)
}

fn session_cookies_with_csrf(
    token: &str,
    csrf: String,
    secure: bool,
) -> (Cookie<'static>, Cookie<'static>) {
    (
        cookie(SESSION_COOKIE, token.to_string(), true, secure),
        cookie(CSRF_COOKIE, csrf, false, secure),
    )
}

/// Expired, empty versions of both cookies that make the browser drop them.
pub fn clear_cookies(secure: bool) -> (Cookie<'static>, Cookie<'static>) {
    let mut session = cookie(SESSION_COOKIE, String::new(), true, secure);
    let mut csrf = cookie(CSRF_COOKIE, String::new(), false, secure);
    session.make_removal();
    csrf.make_removal();
    (session, csrf)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn random_tokens_are_unique_unpadded_base64url_of_32_bytes() {
        let first = random_token();
        let second = random_token();

        assert_ne!(first, second);
        assert_eq!(first.len(), 43);
        assert!(
            first
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
        );
        assert_eq!(URL_SAFE_NO_PAD.decode(&first).unwrap().len(), 32);
    }

    #[test]
    fn session_cookie_is_http_only_lax_and_lasts_14_days() {
        let (session, _) = session_cookies("token", false);

        assert_eq!(session.name(), SESSION_COOKIE);
        assert_eq!(session.value(), "token");
        assert_eq!(session.http_only(), Some(true));
        assert_eq!(session.same_site(), Some(SameSite::Lax));
        assert_eq!(session.path(), Some("/"));
        assert_eq!(session.max_age(), Some(Duration::days(14)));
        assert_eq!(session.secure(), Some(false));
    }

    #[test]
    fn csrf_cookie_is_readable_by_scripts_with_a_fresh_token() {
        let (_, first) = session_cookies("token", false);
        let (_, second) = session_cookies("token", false);

        assert_eq!(first.name(), CSRF_COOKIE);
        assert_ne!(first.value(), second.value());
        assert_eq!(first.value().len(), 43);
        assert_ne!(first.http_only(), Some(true));
        assert_eq!(first.same_site(), Some(SameSite::Lax));
        assert_eq!(first.path(), Some("/"));
        assert_eq!(first.max_age(), Some(Duration::days(14)));
    }

    #[test]
    fn existing_csrf_value_can_be_kept() {
        let (session, csrf) = session_cookies_with_csrf("token", "keep-me".into(), false);

        assert_eq!(session.value(), "token");
        assert_eq!(csrf.value(), "keep-me");
        assert_eq!(csrf.max_age(), Some(Duration::days(14)));
    }

    #[test]
    fn secure_flag_follows_the_argument() {
        let (session, csrf) = session_cookies("token", true);
        assert_eq!(session.secure(), Some(true));
        assert_eq!(csrf.secure(), Some(true));

        let (session, csrf) = clear_cookies(true);
        assert_eq!(session.secure(), Some(true));
        assert_eq!(csrf.secure(), Some(true));
    }

    #[test]
    fn cleared_cookies_are_empty_and_expired() {
        let (session, csrf) = clear_cookies(false);

        for (cookie, name) in [(session, SESSION_COOKIE), (csrf, CSRF_COOKIE)] {
            assert_eq!(cookie.name(), name);
            assert_eq!(cookie.value(), "");
            assert_eq!(cookie.path(), Some("/"));
            assert_eq!(cookie.max_age(), Some(Duration::ZERO));
        }
    }
}
