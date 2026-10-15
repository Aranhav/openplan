mod common;

use axum::http::{StatusCode, header};
use common::{TestApp, TestResponse};
use serde_json::Value;
use sqlx::PgPool;

async fn get(path: &str) -> TestResponse {
    TestApp::without_database().get(path).await
}

#[tokio::test]
async fn health_returns_ok() {
    let response = get("/api/health").await;

    assert_eq!(response.status, StatusCode::OK);
    assert_eq!(response.json["status"], "ok");
    assert_eq!(response.json["version"], env!("CARGO_PKG_VERSION"));
    let request_id = response
        .headers
        .get("x-request-id")
        .expect("x-request-id header is present")
        .to_str()
        .unwrap();
    assert!(uuid::Uuid::parse_str(request_id).is_ok());
}

#[tokio::test]
async fn unknown_api_path_is_problem_json() {
    let response = get("/api/v1/nope").await;

    assert_eq!(response.status, StatusCode::NOT_FOUND);
    let content_type = response.headers[header::CONTENT_TYPE].to_str().unwrap();
    assert!(content_type.starts_with("application/problem+json"));
    assert_eq!(response.json["code"], "not_found");
    assert_eq!(response.headers[header::CACHE_CONTROL], "no-store");
}

#[tokio::test]
async fn openapi_json_served() {
    let response = get("/api/openapi.json").await;

    assert_eq!(response.status, StatusCode::OK);
    assert!(response.json.get("openapi").is_some());
}

#[tokio::test]
async fn docs_page_served() {
    let response = get("/api/docs").await;

    assert_eq!(response.status, StatusCode::OK);
    let content_type = response.headers[header::CONTENT_TYPE].to_str().unwrap();
    assert!(content_type.starts_with("text/html"));
}

#[tokio::test]
async fn every_response_carries_the_security_headers() {
    let mut app = TestApp::without_database();
    let responses = [
        app.get("/api/health").await,
        app.get("/api/openapi.json").await,
        app.get("/api/docs").await,
        app.get("/api/v1/nope").await,
        app.get("/api/v1/auth/me").await,
        app.post("/api/health", None).await,
        app.get("/").await,
        app.get("/models/123").await,
        app.get("/assets/missing.js").await,
    ];

    for response in responses {
        let status = response.status;
        let headers = &response.headers;
        assert_eq!(
            headers[header::X_CONTENT_TYPE_OPTIONS],
            "nosniff",
            "{status}"
        );
        assert_eq!(
            headers[header::REFERRER_POLICY],
            "strict-origin-when-cross-origin",
            "{status}"
        );
        assert_eq!(headers[header::X_FRAME_OPTIONS], "DENY", "{status}");
    }
}

#[tokio::test]
async fn vercel_config_sends_the_same_security_headers() {
    let path = concat!(env!("CARGO_MANIFEST_DIR"), "/../../web/vercel.json");
    let config: Value = serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap();
    let rule = config["headers"]
        .as_array()
        .and_then(|rules| rules.iter().find(|rule| rule["source"] == "/(.*)"))
        .expect("vercel.json sets headers for every path");
    let configured = |name: &str| {
        rule["headers"]
            .as_array()
            .unwrap()
            .iter()
            .find(|header| header["key"].as_str().unwrap().eq_ignore_ascii_case(name))
            .unwrap_or_else(|| panic!("vercel.json does not set {name}"))["value"]
            .as_str()
            .unwrap()
            .to_string()
    };

    let response = get("/api/health").await;

    for name in [
        header::X_CONTENT_TYPE_OPTIONS,
        header::REFERRER_POLICY,
        header::X_FRAME_OPTIONS,
    ] {
        assert_eq!(
            configured(name.as_str()),
            response.headers[name].to_str().unwrap()
        );
    }
    assert_eq!(
        configured("Content-Security-Policy"),
        "frame-ancestors 'none'"
    );
}

#[sqlx::test(migrator = "openplan_server::db::MIGRATOR")]
async fn migrations_create_tables(pool: PgPool) {
    let count = sqlx::query_scalar::<_, i64>(
        "SELECT count(*) FROM information_schema.tables WHERE table_name IN ('users','sessions','workspaces','workspace_members','models')",
    )
    .fetch_one(&pool)
    .await
    .unwrap();

    assert_eq!(count, 5);
}

#[sqlx::test(migrator = "openplan_server::db::MIGRATOR")]
async fn migrations_enable_row_level_security_on_every_public_table(pool: PgPool) {
    let unprotected = sqlx::query_scalar::<_, String>(
        "SELECT c.relname::text FROM pg_class c
         JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = 'public' AND c.relkind = 'r' AND NOT c.relrowsecurity
         ORDER BY c.relname",
    )
    .fetch_all(&pool)
    .await
    .unwrap();

    assert_eq!(unprotected, Vec::<String>::new());
}

#[sqlx::test(migrator = "openplan_server::db::MIGRATOR")]
async fn wrong_method_on_api_route_is_problem_json(pool: PgPool) {
    let mut app = TestApp::new(pool);

    let response = app.post("/api/health", None).await;

    assert_eq!(response.status, StatusCode::METHOD_NOT_ALLOWED);
    let content_type = response.headers[header::CONTENT_TYPE].to_str().unwrap();
    assert!(content_type.starts_with("application/problem+json"));
    assert_eq!(response.json["code"], "method_not_allowed");
    let allow = response.headers[header::ALLOW].to_str().unwrap();
    assert!(allow.contains("GET"), "Allow header was {allow:?}");
}

#[sqlx::test(migrator = "openplan_server::db::MIGRATOR")]
async fn wrong_method_on_v1_route_is_problem_json(pool: PgPool) {
    let mut app = TestApp::new(pool);

    let response = app.get("/api/v1/auth/logout").await;

    assert_eq!(response.status, StatusCode::METHOD_NOT_ALLOWED);
    let content_type = response.headers[header::CONTENT_TYPE].to_str().unwrap();
    assert!(content_type.starts_with("application/problem+json"));
    assert_eq!(response.json["code"], "method_not_allowed");
    let allow = response.headers[header::ALLOW].to_str().unwrap();
    assert!(allow.contains("POST"), "Allow header was {allow:?}");
    assert_eq!(response.headers[header::CACHE_CONTROL], "no-store");
}

#[sqlx::test(migrator = "openplan_server::db::MIGRATOR")]
async fn non_json_body_is_exposed_as_text(pool: PgPool) {
    let mut app = TestApp::new(pool);

    let response = app.get("/assets/missing.js").await;

    assert_eq!(response.status, StatusCode::NOT_FOUND);
    assert_eq!(response.text, "Not found");
    assert_eq!(response.json, Value::Null);
}
