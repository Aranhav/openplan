use axum::{
    extract::Request,
    http::Method,
    middleware::Next,
    response::{IntoResponse, Response},
};
use axum_extra::extract::CookieJar;

use crate::error::AppError;

use super::{CSRF_COOKIE, CSRF_HEADER, SESSION_COOKIE};

/// Double-submit CSRF check for cookie-authenticated requests: unsafe methods
/// that carry a session cookie must echo the `op_csrf` cookie in a header.
pub async fn require_csrf(req: Request, next: Next) -> Response {
    let is_safe = matches!(*req.method(), Method::GET | Method::HEAD | Method::OPTIONS);
    if !is_safe && !csrf_token_matches(&req) {
        return AppError::Csrf.into_response();
    }
    next.run(req).await
}

fn csrf_token_matches(req: &Request) -> bool {
    let jar = CookieJar::from_headers(req.headers());
    if jar.get(SESSION_COOKIE).is_none() {
        return true;
    }
    let header = req
        .headers()
        .get(CSRF_HEADER)
        .and_then(|value| value.to_str().ok());
    match (header, jar.get(CSRF_COOKIE)) {
        (Some(header), Some(cookie)) => !header.is_empty() && header == cookie.value(),
        _ => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::{Router, body::Body, http::StatusCode, middleware::from_fn, routing::any};
    use tower::ServiceExt;

    async fn status_of(method: Method, cookie: Option<&str>, csrf: Option<&str>) -> StatusCode {
        let router = Router::new()
            .route("/", any(|| async { "ok" }))
            .layer(from_fn(require_csrf));
        let mut request = Request::builder().method(method).uri("/");
        if let Some(cookie) = cookie {
            request = request.header("cookie", cookie);
        }
        if let Some(csrf) = csrf {
            request = request.header(CSRF_HEADER, csrf);
        }
        router
            .oneshot(request.body(Body::empty()).unwrap())
            .await
            .unwrap()
            .status()
    }

    const SESSION: &str = "op_session=abc; op_csrf=token123";

    #[tokio::test]
    async fn safe_methods_skip_the_check() {
        for method in [Method::GET, Method::HEAD, Method::OPTIONS] {
            assert_eq!(status_of(method, Some(SESSION), None).await, StatusCode::OK);
        }
    }

    #[tokio::test]
    async fn requests_without_a_session_cookie_pass() {
        assert_eq!(status_of(Method::POST, None, None).await, StatusCode::OK);
        assert_eq!(
            status_of(Method::POST, Some("op_csrf=token123"), None).await,
            StatusCode::OK
        );
    }

    #[tokio::test]
    async fn matching_header_passes() {
        for method in [Method::POST, Method::PUT, Method::PATCH, Method::DELETE] {
            let status = status_of(method, Some(SESSION), Some("token123")).await;
            assert_eq!(status, StatusCode::OK);
        }
    }

    #[tokio::test]
    async fn missing_or_wrong_header_is_rejected() {
        assert_eq!(
            status_of(Method::POST, Some(SESSION), None).await,
            StatusCode::FORBIDDEN
        );
        assert_eq!(
            status_of(Method::POST, Some(SESSION), Some("other")).await,
            StatusCode::FORBIDDEN
        );
    }

    #[tokio::test]
    async fn missing_or_empty_csrf_cookie_is_rejected() {
        assert_eq!(
            status_of(Method::POST, Some("op_session=abc"), Some("token123")).await,
            StatusCode::FORBIDDEN
        );
        assert_eq!(
            status_of(Method::POST, Some("op_session=abc; op_csrf="), Some("")).await,
            StatusCode::FORBIDDEN
        );
    }
}
