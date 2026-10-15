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
    trace::TraceLayer,
};
use utoipa::{OpenApi, ToSchema};
use utoipa_scalar::{Scalar, Servable};
use uuid::Uuid;

use crate::{
    auth::{self, csrf, rate_limit::LoginLimiter, renewal},
    config::Config,
    error::AppError,
    models,
    openapi::ApiDoc,
    static_files, users, workspaces,
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
}

impl AppState {
    pub fn new(db: PgPool, config: Config) -> AppState {
        AppState {
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

pub fn build_router(state: AppState) -> Router {
    let api_v1: Router<AppState> = auth::routes::router()
        .merge(users::router())
        .merge(workspaces::router())
        .merge(models::router())
        .layer(middleware::from_fn(csrf::require_csrf))
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
                    TraceLayer::new_for_http().make_span_with(|request: &Request<_>| {
                        let request_id = request
                            .headers()
                            .get(REQUEST_ID_HEADER)
                            .and_then(|value| value.to_str().ok())
                            .unwrap_or_default();
                        tracing::info_span!(
                            "request",
                            method = %request.method(),
                            uri = %request.uri(),
                            request_id,
                        )
                    }),
                )
                .layer(PropagateRequestIdLayer::new(REQUEST_ID_HEADER))
                .layer(middleware::from_fn(no_store_for_api)),
        )
        .with_state(state)
}
