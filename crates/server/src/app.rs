use std::sync::Arc;

use axum::{
    Json, Router,
    http::{HeaderName, HeaderValue, Request},
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

use crate::{config::Config, openapi::ApiDoc, static_files};

const REQUEST_ID_HEADER: HeaderName = HeaderName::from_static("x-request-id");

#[derive(Clone)]
pub struct AppState {
    pub db: PgPool,
    pub config: Arc<Config>,
}

impl AppState {
    pub fn new(db: PgPool, config: Config) -> AppState {
        AppState {
            db,
            config: Arc::new(config),
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

pub fn build_router(state: AppState) -> Router {
    let api_v1: Router<AppState> = Router::new();

    Router::new()
        .route("/api/health", get(health))
        .route(
            "/api/openapi.json",
            get(|| async { Json(ApiDoc::openapi()) }),
        )
        .merge(Scalar::with_url("/api/docs", ApiDoc::openapi()))
        .nest("/api/v1", api_v1)
        .fallback(static_files::serve)
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
                .layer(PropagateRequestIdLayer::new(REQUEST_ID_HEADER)),
        )
        .with_state(state)
}
