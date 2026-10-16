use std::{sync::Arc, time::Duration};

use axum::{
    Json, Router,
    extract::Request,
    http::{HeaderName, HeaderValue, header},
    middleware::{self, Next},
    response::Response,
    routing::get,
};
use serde::Serialize;
use sqlx::PgPool;
use tower::ServiceBuilder;
use tower_http::{
    request_id::{MakeRequestId, PropagateRequestIdLayer, RequestId, SetRequestIdLayer},
    trace::{DefaultOnResponse, TraceLayer},
};
use tracing::Level;
use utoipa::{OpenApi, ToSchema};
use utoipa_scalar::{Scalar, Servable};
use uuid::Uuid;

use crate::{
    actor::ModelRegistry,
    auth::{self, csrf, rate_limit::LoginLimiter, renewal},
    cells_api,
    config::Config,
    error::AppError,
    live::{self, Live, LiveSettings},
    models, modules_api,
    openapi::ApiDoc,
    query_api, static_files, structure_api, users, workspaces,
};

const REQUEST_ID_HEADER: HeaderName = HeaderName::from_static("x-request-id");
const LOGIN_MAX_FAILURES: u32 = 10;
/// Ceiling for one email across every client address; see `docs/deploy.md`.
const LOGIN_EMAIL_MAX_FAILURES: u32 = 50;
const LOGIN_FAILURE_WINDOW: Duration = Duration::from_secs(15 * 60);

#[derive(Clone)]
pub struct AppState {
    pub db: PgPool,
    pub config: Arc<Config>,
    /// Per email and client address.
    pub login_limiter: Arc<LoginLimiter>,
    /// Per email, whatever the client address.
    pub login_email_limiter: Arc<LoginLimiter>,
    /// The models held in memory, one actor each.
    pub models: ModelRegistry,
    /// The tickets that open the live sockets of the models.
    pub live: Live,
}

impl AppState {
    pub fn new(db: PgPool, config: Config) -> AppState {
        let model_idle = Duration::from_secs(u64::from(config.model_idle_minutes) * 60);
        AppState {
            models: ModelRegistry::new(db.clone(), model_idle),
            live: Live::new(LiveSettings::default()),
            db,
            config: Arc::new(config),
            login_limiter: Arc::new(LoginLimiter::new(LOGIN_MAX_FAILURES, LOGIN_FAILURE_WINDOW)),
            login_email_limiter: Arc::new(LoginLimiter::new(
                LOGIN_EMAIL_MAX_FAILURES,
                LOGIN_FAILURE_WINDOW,
            )),
        }
    }
}

#[derive(Clone, Copy)]
struct MakeRequestUuidV7;

impl MakeRequestId for MakeRequestUuidV7 {
    fn make_request_id<B>(&mut self, _request: &Request<B>) -> Option<RequestId> {
        HeaderValue::from_str(&Uuid::now_v7().to_string())
            .ok()
            .map(RequestId::new)
    }
}

#[derive(Serialize, ToSchema)]
pub struct HealthResponse {
    status: &'static str,
    version: &'static str,
}

#[utoipa::path(
    get,
    path = "/api/health",
    tag = "health",
    responses((status = 200, description = "The server is up", body = HealthResponse))
)]
pub(crate) async fn health() -> Json<HealthResponse> {
    Json(HealthResponse {
        status: "ok",
        version: env!("CARGO_PKG_VERSION"),
    })
}

/// Keeps every `/api/v1` response out of shared caches, including CSRF
/// rejections and the 404s and 405s that the outer router's fallbacks produce.
async fn no_store_for_api(request: Request, next: Next) -> Response {
    let is_api = request.uri().path().starts_with("/api/v1");
    let mut response = next.run(request).await;
    if is_api {
        response
            .headers_mut()
            .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    }
    response
}

/// Stops browsers from sniffing content types, from sending the full URL as the
/// referrer to other origins and from showing any response in a frame.
async fn security_headers(request: Request, next: Next) -> Response {
    let mut response = next.run(request).await;
    let headers = response.headers_mut();
    headers.insert(
        header::X_CONTENT_TYPE_OPTIONS,
        HeaderValue::from_static("nosniff"),
    );
    headers.insert(
        header::REFERRER_POLICY,
        HeaderValue::from_static("strict-origin-when-cross-origin"),
    );
    headers.insert(header::X_FRAME_OPTIONS, HeaderValue::from_static("DENY"));
    response
}

pub fn build_router(state: AppState) -> Router {
    let csrf_protected: Router<AppState> = auth::routes::router()
        .merge(users::router())
        .merge(workspaces::router())
        .merge(models::router())
        .merge(structure_api::router())
        .merge(modules_api::router())
        .merge(cells_api::router())
        .merge(query_api::router())
        .merge(live::router())
        .layer(middleware::from_fn(csrf::require_csrf));
    let api_v1: Router<AppState> = csrf_protected
        .merge(auth::routes::session_router())
        .layer(middleware::from_fn(renewal::reissue_cookies));

    Router::new()
        .route("/api/health", get(health))
        .route(
            "/api/openapi.json",
            get(|| async { Json(ApiDoc::openapi()) }),
        )
        .merge(Scalar::with_url("/api/docs", ApiDoc::openapi()))
        .nest("/api/v1", api_v1)
        .fallback(static_files::serve)
        .method_not_allowed_fallback(|| async { AppError::MethodNotAllowed })
        .layer(
            ServiceBuilder::new()
                .layer(SetRequestIdLayer::new(REQUEST_ID_HEADER, MakeRequestUuidV7))
                .layer(
                    TraceLayer::new_for_http()
                        .make_span_with(|request: &Request<_>| {
                            let request_id = request
                                .headers()
                                .get(REQUEST_ID_HEADER)
                                .and_then(|value| value.to_str().ok())
                                .unwrap_or_default();
                            // The path only: query strings can carry secrets.
                            tracing::info_span!(
                                "request",
                                method = %request.method(),
                                path = %request.uri().path(),
                                request_id = %request_id,
                            )
                        })
                        .on_response(DefaultOnResponse::new().level(Level::INFO)),
                )
                .layer(PropagateRequestIdLayer::new(REQUEST_ID_HEADER))
                .layer(middleware::from_fn(no_store_for_api))
                .layer(middleware::from_fn(security_headers)),
        )
        .with_state(state)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::LogBuffer;
    use axum::{body::Body, http::StatusCode};
    use sqlx::postgres::PgPoolOptions;
    use tower::ServiceExt;
    use tracing_subscriber::EnvFilter;

    fn router() -> Router {
        let config = Config::from_lookup(|name| match name {
            "DATABASE_URL" => Some("postgres://invalid".to_string()),
            "OPENPLAN_PUBLIC_URL" => Some("http://localhost:8080".to_string()),
            _ => None,
        })
        .expect("test config is valid");
        let db = PgPoolOptions::new()
            .connect_lazy("postgres://invalid")
            .expect("lazy pool does not connect");
        build_router(AppState::new(db, config))
    }

    /// Sends `uri` through the router and returns the status and the log lines
    /// written at the default `info` level.
    async fn request_logs(uri: &str) -> (StatusCode, Vec<String>) {
        let buffer = LogBuffer::default();
        let subscriber = crate::logging::subscriber(EnvFilter::new("info"), false, buffer.clone());
        let _guard = tracing::subscriber::set_default(subscriber);
        let response = router()
            .oneshot(Request::get(uri).body(Body::empty()).unwrap())
            .await
            .unwrap();
        let lines = buffer.contents().lines().map(str::to_string).collect();
        (response.status(), lines)
    }

    #[tokio::test]
    async fn each_request_logs_one_info_line_with_method_path_status_and_latency() {
        let (status, lines) = request_logs("/api/health?token=hunter2&page=2").await;

        assert_eq!(status, StatusCode::OK);
        assert_eq!(lines.len(), 1, "{lines:?}");
        let line = &lines[0];
        assert!(line.contains(" INFO "), "{line}");
        assert!(line.contains("method=GET"), "{line}");
        assert!(line.contains("path=/api/health"), "{line}");
        assert!(line.contains("status=200"), "{line}");
        assert!(line.contains(" ms"), "{line}");
        assert!(line.contains("latency="), "{line}");
    }

    #[tokio::test]
    async fn the_query_string_never_reaches_the_logs() {
        let (_, lines) = request_logs("/api/health?token=hunter2").await;

        let logs = lines.join("\n");
        assert!(!logs.contains("hunter2"), "{logs}");
        assert!(!logs.contains('?'), "{logs}");
    }

    #[tokio::test]
    async fn client_errors_are_logged_with_their_status() {
        let (status, lines) = request_logs("/api/v1/nope").await;

        assert_eq!(status, StatusCode::NOT_FOUND);
        assert_eq!(lines.len(), 1, "{lines:?}");
        assert!(lines[0].contains("status=404"), "{}", lines[0]);
    }
}
