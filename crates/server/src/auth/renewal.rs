use std::sync::{Arc, OnceLock};

use axum::{
    extract::Request,
    middleware::Next,
    response::{IntoResponse, Response},
};
use axum_extra::extract::cookie::{Cookie, CookieJar};

type SessionCookies = (Cookie<'static>, Cookie<'static>);

/// Carries renewed session cookies from the `CurrentUser` extractor, which
/// cannot touch the response, to [`reissue_cookies`].
#[derive(Clone, Default)]
pub struct SessionRenewal(Arc<OnceLock<SessionCookies>>);

impl SessionRenewal {
    pub(super) fn offer(&self, cookies: SessionCookies) {
        self.0.get_or_init(|| cookies);
    }
}

/// Keeps the browser's cookies as long-lived as the sliding server session:
/// when the request renewed its session, the response sets both cookies again
/// with a fresh `Max-Age`.
pub async fn reissue_cookies(mut req: Request, next: Next) -> Response {
    let renewal = SessionRenewal::default();
    req.extensions_mut().insert(renewal.clone());
    let response = next.run(req).await;
    match renewal.0.get() {
        Some((session, csrf)) => (
            CookieJar::new().add(session.clone()).add(csrf.clone()),
            response,
        )
            .into_response(),
        None => response,
    }
}
