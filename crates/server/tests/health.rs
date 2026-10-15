use axum::{
    body::{Body, to_bytes},
    http::{Request, StatusCode, header},
};
use openplan_server::{
    app::{AppState, build_router},
    config::Config,
};
use serde_json::Value;
use sqlx::postgres::PgPoolOptions;
use tower::ServiceExt;

fn router() -> axum::Router {
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

async fn get(path: &str) -> (StatusCode, axum::http::HeaderMap, Value) {
    let response = router()
        .oneshot(Request::get(path).body(Body::empty()).unwrap())
        .await
        .unwrap();
    let status = response.status();
    let headers = response.headers().clone();
    let bytes = to_bytes(response.into_body(), usize::MAX).await.unwrap();
    let json = serde_json::from_slice(&bytes).unwrap_or(Value::Null);
    (status, headers, json)
}

#[tokio::test]
async fn health_returns_ok() {
    let (status, headers, json) = get("/api/health").await;

    assert_eq!(status, StatusCode::OK);
    assert_eq!(json["status"], "ok");
    assert_eq!(json["version"], env!("CARGO_PKG_VERSION"));
    let request_id = headers
        .get("x-request-id")
        .expect("x-request-id header is present")
        .to_str()
        .unwrap();
    assert!(uuid::Uuid::parse_str(request_id).is_ok());
}

#[tokio::test]
async fn unknown_api_path_is_problem_json() {
    let (status, headers, json) = get("/api/v1/nope").await;

    assert_eq!(status, StatusCode::NOT_FOUND);
    let content_type = headers[header::CONTENT_TYPE].to_str().unwrap();
    assert!(content_type.starts_with("application/problem+json"));
    assert_eq!(json["code"], "not_found");
}

#[tokio::test]
async fn openapi_json_served() {
    let (status, _, json) = get("/api/openapi.json").await;

    assert_eq!(status, StatusCode::OK);
    assert!(json.get("openapi").is_some());
}

#[tokio::test]
async fn docs_page_served() {
    let response = router()
        .oneshot(Request::get("/api/docs").body(Body::empty()).unwrap())
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::OK);
    let content_type = response.headers()[header::CONTENT_TYPE].to_str().unwrap();
    assert!(content_type.starts_with("text/html"));
}
