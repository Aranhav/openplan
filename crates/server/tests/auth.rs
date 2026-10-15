mod common;

use std::net::SocketAddr;

use axum::{
    Extension,
    extract::ConnectInfo,
    http::{StatusCode, header},
};
use common::{TestApp, TestResponse};
use openplan_server::{
    app::{AppState, build_router},
    auth::session,
    config::Config,
};
use serde_json::{Value, json};
use sqlx::PgPool;
use uuid::Uuid;

const EMAIL: &str = "admin@acme.com";
const PASSWORD: &str = "correct horse battery";

fn setup_body() -> Value {
    json!({
        "email": EMAIL,
        "name": "Ada Admin",
        "password": PASSWORD,
        "workspace_name": "Acme",
    })
}

async fn setup_admin(app: &mut TestApp) -> TestResponse {
    let response = app.post("/api/v1/setup", Some(setup_body())).await;
    assert_eq!(response.status, StatusCode::CREATED, "{}", response.text);
    response
}

async fn login(app: &mut TestApp, email: &str, password: &str) -> TestResponse {
    app.post(
        "/api/v1/auth/login",
        Some(json!({ "email": email, "password": password })),
    )
    .await
}

fn set_cookie<'a>(response: &'a TestResponse, name: &str) -> &'a str {
    response
        .headers
        .get_all(header::SET_COOKIE)
        .iter()
        .map(|value| value.to_str().unwrap())
        .find(|value| value.starts_with(&format!("{name}=")))
        .unwrap_or_else(|| panic!("no Set-Cookie for {name}"))
}

fn field_names(response: &TestResponse) -> Vec<String> {
    let mut fields: Vec<String> = response.json["errors"]
        .as_array()
        .expect("response has an errors array")
        .iter()
        .map(|error| error["field"].as_str().unwrap().to_string())
        .collect();
    fields.sort();
    fields
}

/// Inserts a regular user who can sign in with the same password as the admin.
async fn insert_member(pool: &PgPool, email: &str) -> Uuid {
    let id = Uuid::now_v7();
    sqlx::query(
        "INSERT INTO users (id, email, name, password_hash)
         SELECT $1, $2, 'Mia Member', password_hash FROM users WHERE is_instance_admin",
    )
    .bind(id)
    .bind(email)
    .execute(pool)
    .await
    .unwrap();
    id
}

async fn session_count(pool: &PgPool) -> i64 {
    sqlx::query_scalar("SELECT count(*) FROM sessions")
        .fetch_one(pool)
        .await
        .unwrap()
}

async fn user_count(pool: &PgPool) -> i64 {
    sqlx::query_scalar("SELECT count(*) FROM users")
        .fetch_one(pool)
        .await
        .unwrap()
}

#[sqlx::test(migrator = "openplan_server::db::MIGRATOR")]
async fn setup_status_true_on_empty_db(pool: PgPool) {
    let mut app = TestApp::new(pool);

    let response = app.get("/api/v1/setup/status").await;

    assert_eq!(response.status, StatusCode::OK);
    assert_eq!(response.json, json!({ "needs_setup": true }));
}

#[sqlx::test(migrator = "openplan_server::db::MIGRATOR")]
async fn setup_creates_admin_workspace_and_session(pool: PgPool) {
    let mut app = TestApp::new(pool.clone());

    let created = setup_admin(&mut app).await;

    let user = &created.json["user"];
    assert_eq!(user["email"], EMAIL);
    assert_eq!(user["name"], "Ada Admin");
    assert_eq!(user["is_instance_admin"], true);
    assert!(Uuid::parse_str(user["id"].as_str().unwrap()).is_ok());
    assert!(user.get("password_hash").is_none());
    assert_eq!(created.json["workspace"]["name"], "Acme");

    let session = set_cookie(&created, "op_session");
    assert!(session.contains("HttpOnly"), "{session}");
    assert!(session.contains("SameSite=Lax"), "{session}");
    assert!(session.contains("Path=/"), "{session}");
    assert!(session.contains("Max-Age=1209600"), "{session}");
    assert!(!session.contains("Secure"), "{session}");
    let csrf = set_cookie(&created, "op_csrf");
    assert!(!csrf.contains("HttpOnly"), "{csrf}");
    assert!(csrf.contains("SameSite=Lax"), "{csrf}");
    assert!(csrf.contains("Max-Age=1209600"), "{csrf}");

    let me = app.get("/api/v1/auth/me").await;
    assert_eq!(me.status, StatusCode::OK);
    assert_eq!(me.json["user"]["email"], EMAIL);
    let workspaces = me.json["workspaces"].as_array().unwrap();
    assert_eq!(workspaces.len(), 1);
    assert_eq!(workspaces[0]["id"], created.json["workspace"]["id"]);
    assert_eq!(workspaces[0]["name"], "Acme");
    assert_eq!(workspaces[0]["role"], "admin");

    let role: String = sqlx::query_scalar("SELECT role FROM workspace_members")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(role, "admin");
    let hash: String = sqlx::query_scalar("SELECT password_hash FROM users")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert!(hash.starts_with("$argon2id$"), "{hash}");

    let status = app.get("/api/v1/setup/status").await;
    assert_eq!(status.json, json!({ "needs_setup": false }));
}

#[sqlx::test(migrator = "openplan_server::db::MIGRATOR")]
async fn setup_twice_conflicts(pool: PgPool) {
    let mut app = TestApp::new(pool.clone());
    setup_admin(&mut app).await;

    let mut second = setup_body();
    second["email"] = json!("other@acme.com");
    let response = app.post("/api/v1/setup", Some(second)).await;

    assert_eq!(response.status, StatusCode::CONFLICT);
    assert_eq!(response.json["code"], "setup.already_done");
    assert_eq!(user_count(&pool).await, 1);
}

#[sqlx::test(migrator = "openplan_server::db::MIGRATOR")]
async fn concurrent_setup_creates_one_admin(pool: PgPool) {
    let mut first = TestApp::new(pool.clone());
    let mut second = TestApp::new(pool.clone());

    let (a, b) = tokio::join!(
        first.post("/api/v1/setup", Some(setup_body())),
        second.post("/api/v1/setup", Some(setup_body())),
    );

    let mut statuses = [a.status, b.status];
    statuses.sort();
    assert_eq!(statuses, [StatusCode::CREATED, StatusCode::CONFLICT]);
    let loser = if a.status == StatusCode::CONFLICT {
        &a
    } else {
        &b
    };
    assert_eq!(loser.json["code"], "setup.already_done");
    assert_eq!(user_count(&pool).await, 1);
}

#[sqlx::test(migrator = "openplan_server::db::MIGRATOR")]
async fn setup_waits_for_the_setup_lock_then_rechecks(pool: PgPool) {
    let mut other_setup = pool.begin().await.unwrap();
    sqlx::query("SELECT pg_advisory_xact_lock(4242)")
        .execute(&mut *other_setup)
        .await
        .unwrap();
    let mut app = TestApp::new(pool.clone());
    let request = app.post("/api/v1/setup", Some(setup_body()));
    tokio::pin!(request);

    let waiting_on_lock = async {
        let poll = async {
            loop {
                let waiters: i64 = sqlx::query_scalar(
                    "SELECT count(*) FROM pg_locks
                     WHERE locktype = 'advisory' AND NOT granted
                       AND database = (SELECT oid FROM pg_database WHERE datname = current_database())",
                )
                .fetch_one(&pool)
                .await
                .unwrap();
                if waiters == 1 {
                    return;
                }
                tokio::time::sleep(std::time::Duration::from_millis(10)).await;
            }
        };
        tokio::time::timeout(std::time::Duration::from_secs(10), poll)
            .await
            .expect("setup never waited on the advisory lock");
    };
    tokio::select! {
        response = &mut request => panic!("setup finished while the lock was held: {}", response.status),
        () = waiting_on_lock => {}
    }

    sqlx::query(
        "INSERT INTO users (id, email, name, is_instance_admin) VALUES ($1, 'first@acme.com', 'First', true)",
    )
    .bind(Uuid::now_v7())
    .execute(&mut *other_setup)
    .await
    .unwrap();
    other_setup.commit().await.unwrap();

    let response = request.await;
    assert_eq!(response.status, StatusCode::CONFLICT, "{}", response.text);
    assert_eq!(response.json["code"], "setup.already_done");
    assert_eq!(user_count(&pool).await, 1);
}

#[sqlx::test(migrator = "openplan_server::db::MIGRATOR")]
async fn setup_validation_errors(pool: PgPool) {
    let mut app = TestApp::new(pool.clone());

    let mut body = setup_body();
    body["email"] = json!("not-an-email");
    body["password"] = json!("short");
    let response = app.post("/api/v1/setup", Some(body)).await;

    assert_eq!(response.status, StatusCode::UNPROCESSABLE_ENTITY);
    assert_eq!(response.json["code"], "validation");
    assert_eq!(field_names(&response), ["email", "password"]);

    let blank = json!({ "email": " ", "name": " ", "password": "", "workspace_name": " " });
    let response = app.post("/api/v1/setup", Some(blank)).await;

    assert_eq!(response.status, StatusCode::UNPROCESSABLE_ENTITY);
    assert_eq!(
        field_names(&response),
        ["email", "name", "password", "workspace_name"]
    );
    assert_eq!(user_count(&pool).await, 0);
}

#[sqlx::test(migrator = "openplan_server::db::MIGRATOR")]
async fn cookies_are_secure_when_public_url_is_https(pool: PgPool) {
    let config = Config::from_lookup(|name| match name {
        "DATABASE_URL" => Some("postgres://invalid".to_string()),
        "OPENPLAN_PUBLIC_URL" => Some("https://plan.acme.com".to_string()),
        _ => None,
    })
    .unwrap();
    let mut app = TestApp::new(pool.clone());
    app.router = build_router(AppState::new(pool, config));

    let created = setup_admin(&mut app).await;
    assert!(set_cookie(&created, "op_session").contains("Secure"));
    assert!(set_cookie(&created, "op_csrf").contains("Secure"));

    let logout = app.post("/api/v1/auth/logout", None).await;
    assert!(set_cookie(&logout, "op_session").contains("Secure"));
    assert!(set_cookie(&logout, "op_csrf").contains("Secure"));
}

#[sqlx::test(migrator = "openplan_server::db::MIGRATOR")]
async fn login_with_mixed_case_email(pool: PgPool) {
    let mut app = TestApp::new(pool);
    setup_admin(&mut app).await;

    let response = login(&mut app, " Admin@Acme.COM ", PASSWORD).await;

    assert_eq!(response.status, StatusCode::OK, "{}", response.text);
    assert_eq!(response.json["user"]["email"], EMAIL);
    set_cookie(&response, "op_session");
    set_cookie(&response, "op_csrf");
    assert_eq!(app.get("/api/v1/auth/me").await.status, StatusCode::OK);
}

#[sqlx::test(migrator = "openplan_server::db::MIGRATOR")]
async fn login_wrong_password_401(pool: PgPool) {
    let mut app = TestApp::new(pool);
    setup_admin(&mut app).await;

    let response = login(&mut app, EMAIL, "not the password").await;

    assert_eq!(response.status, StatusCode::UNAUTHORIZED);
    assert_eq!(response.json["code"], "auth.invalid_credentials");
    assert!(response.headers.get(header::SET_COOKIE).is_none());
}

#[sqlx::test(migrator = "openplan_server::db::MIGRATOR")]
async fn login_unknown_email_same_error(pool: PgPool) {
    let mut app = TestApp::new(pool);
    setup_admin(&mut app).await;

    let wrong_password = login(&mut app, EMAIL, "not the password").await;
    let unknown_email = login(&mut app, "nobody@acme.com", PASSWORD).await;
    let malformed_email = login(&mut app, "nobody", PASSWORD).await;
    let overlong_email = login(&mut app, &format!("{}@acme.com", "a".repeat(300)), PASSWORD).await;

    assert_eq!(unknown_email.status, StatusCode::UNAUTHORIZED);
    assert_eq!(unknown_email.json, wrong_password.json);
    assert_eq!(malformed_email.status, StatusCode::UNAUTHORIZED);
    assert_eq!(malformed_email.json, wrong_password.json);
    assert_eq!(overlong_email.status, StatusCode::UNAUTHORIZED);
    assert_eq!(overlong_email.json, wrong_password.json);
}

#[sqlx::test(migrator = "openplan_server::db::MIGRATOR")]
async fn login_disabled_user_same_error(pool: PgPool) {
    let mut app = TestApp::new(pool.clone());
    setup_admin(&mut app).await;
    let wrong_password = login(&mut app, EMAIL, "not the password").await;
    sqlx::query("UPDATE users SET disabled = true")
        .execute(&pool)
        .await
        .unwrap();

    let response = login(&mut app, EMAIL, PASSWORD).await;

    assert_eq!(response.status, StatusCode::UNAUTHORIZED);
    assert_eq!(response.json, wrong_password.json);
}

#[sqlx::test(migrator = "openplan_server::db::MIGRATOR")]
async fn login_user_without_password_same_error(pool: PgPool) {
    let mut app = TestApp::new(pool.clone());
    setup_admin(&mut app).await;
    let wrong_password = login(&mut app, EMAIL, "not the password").await;
    sqlx::query("UPDATE users SET password_hash = NULL")
        .execute(&pool)
        .await
        .unwrap();

    let response = login(&mut app, EMAIL, PASSWORD).await;

    assert_eq!(response.status, StatusCode::UNAUTHORIZED);
    assert_eq!(response.json, wrong_password.json);
}

#[sqlx::test(migrator = "openplan_server::db::MIGRATOR")]
async fn login_rate_limited_after_10_failures(pool: PgPool) {
    let mut app = TestApp::new(pool);
    setup_admin(&mut app).await;

    for attempt in 1..=10 {
        let response = login(&mut app, EMAIL, "not the password").await;
        assert_eq!(
            response.status,
            StatusCode::UNAUTHORIZED,
            "attempt {attempt}"
        );
    }
    let blocked = login(&mut app, EMAIL, PASSWORD).await;

    assert_eq!(blocked.status, StatusCode::TOO_MANY_REQUESTS);
    assert_eq!(blocked.json["code"], "auth.rate_limited");
    let retry_after: u64 = blocked.headers[header::RETRY_AFTER]
        .to_str()
        .unwrap()
        .parse()
        .unwrap();
    assert!((1..=900).contains(&retry_after), "{retry_after}");

    let other = login(&mut app, "other@acme.com", PASSWORD).await;
    assert_eq!(other.status, StatusCode::UNAUTHORIZED);
}

#[sqlx::test(migrator = "openplan_server::db::MIGRATOR")]
async fn login_rate_limit_is_per_client_ip(pool: PgPool) {
    let mut app = TestApp::new(pool);
    setup_admin(&mut app).await;
    let router = app.router.clone();
    let from = |addr: &str| {
        let addr: SocketAddr = addr.parse().unwrap();
        router.clone().layer(Extension(ConnectInfo(addr)))
    };

    app.router = from("10.0.0.1:50000");
    for _ in 0..10 {
        login(&mut app, EMAIL, "not the password").await;
    }
    let blocked = login(&mut app, EMAIL, PASSWORD).await;
    assert_eq!(blocked.status, StatusCode::TOO_MANY_REQUESTS);

    app.router = from("10.0.0.1:50001");
    let same_ip_new_port = login(&mut app, EMAIL, PASSWORD).await;
    assert_eq!(same_ip_new_port.status, StatusCode::TOO_MANY_REQUESTS);

    app.router = from("10.0.0.2:50000");
    let other_ip = login(&mut app, EMAIL, PASSWORD).await;
    assert_eq!(other_ip.status, StatusCode::OK, "{}", other_ip.text);
}

#[sqlx::test(migrator = "openplan_server::db::MIGRATOR")]
async fn successful_login_resets_failure_count(pool: PgPool) {
    let mut app = TestApp::new(pool);
    setup_admin(&mut app).await;

    for _ in 0..9 {
        login(&mut app, EMAIL, "not the password").await;
    }
    assert_eq!(
        login(&mut app, EMAIL, PASSWORD).await.status,
        StatusCode::OK
    );
    for _ in 0..9 {
        login(&mut app, EMAIL, "not the password").await;
    }

    let response = login(&mut app, EMAIL, "not the password").await;
    assert_eq!(response.status, StatusCode::UNAUTHORIZED);
}

#[sqlx::test(migrator = "openplan_server::db::MIGRATOR")]
async fn logout_invalidates_session(pool: PgPool) {
    let mut app = TestApp::new(pool.clone());
    setup_admin(&mut app).await;
    assert_eq!(app.get("/api/v1/auth/me").await.status, StatusCode::OK);

    let response = app.post("/api/v1/auth/logout", None).await;

    assert_eq!(response.status, StatusCode::NO_CONTENT);
    assert!(set_cookie(&response, "op_session").contains("Max-Age=0"));
    assert!(set_cookie(&response, "op_csrf").contains("Max-Age=0"));
    let me = app.get("/api/v1/auth/me").await;
    assert_eq!(me.status, StatusCode::UNAUTHORIZED);
    assert_eq!(me.json["code"], "auth.unauthenticated");
    assert_eq!(session_count(&pool).await, 0);
}

#[sqlx::test(migrator = "openplan_server::db::MIGRATOR")]
async fn logout_without_session_is_no_content(pool: PgPool) {
    let mut app = TestApp::new(pool);

    let response = app.post("/api/v1/auth/logout", None).await;

    assert_eq!(response.status, StatusCode::NO_CONTENT);
    assert!(set_cookie(&response, "op_session").contains("Max-Age=0"));
}

#[sqlx::test(migrator = "openplan_server::db::MIGRATOR")]
async fn logout_with_stale_session_is_no_content(pool: PgPool) {
    let mut app = TestApp::new(pool.clone());
    setup_admin(&mut app).await;
    sqlx::query("DELETE FROM sessions")
        .execute(&pool)
        .await
        .unwrap();

    let response = app.post("/api/v1/auth/logout", None).await;

    assert_eq!(response.status, StatusCode::NO_CONTENT);
}

#[sqlx::test(migrator = "openplan_server::db::MIGRATOR")]
async fn me_requires_session(pool: PgPool) {
    let mut app = TestApp::new(pool);

    let response = app.get("/api/v1/auth/me").await;

    assert_eq!(response.status, StatusCode::UNAUTHORIZED);
    assert_eq!(response.json["code"], "auth.unauthenticated");
}

#[sqlx::test(migrator = "openplan_server::db::MIGRATOR")]
async fn csrf_required_for_cookie_mutations(pool: PgPool) {
    let mut app = TestApp::new(pool);
    setup_admin(&mut app).await;
    login(&mut app, EMAIL, PASSWORD).await;

    let rejected = app
        .request_without_csrf(axum::http::Method::POST, "/api/v1/auth/logout", None)
        .await;

    assert_eq!(rejected.status, StatusCode::FORBIDDEN);
    assert_eq!(rejected.json["code"], "auth.csrf");
    assert_eq!(app.get("/api/v1/auth/me").await.status, StatusCode::OK);

    let accepted = app.post("/api/v1/auth/logout", None).await;
    assert_eq!(accepted.status, StatusCode::NO_CONTENT);
}

#[sqlx::test(migrator = "openplan_server::db::MIGRATOR")]
async fn expired_session_rejected(pool: PgPool) {
    let mut app = TestApp::new(pool.clone());
    setup_admin(&mut app).await;
    sqlx::query("UPDATE sessions SET expires_at = now() - interval '1 minute'")
        .execute(&pool)
        .await
        .unwrap();

    let response = app.get("/api/v1/auth/me").await;

    assert_eq!(response.status, StatusCode::UNAUTHORIZED);
    assert_eq!(response.json["code"], "auth.unauthenticated");
}

#[sqlx::test(migrator = "openplan_server::db::MIGRATOR")]
async fn session_renewed_when_near_expiry(pool: PgPool) {
    let mut app = TestApp::new(pool.clone());
    setup_admin(&mut app).await;
    sqlx::query("UPDATE sessions SET expires_at = now() + interval '1 day'")
        .execute(&pool)
        .await
        .unwrap();

    let response = app.get("/api/v1/auth/me").await;

    assert_eq!(response.status, StatusCode::OK);
    let renewed: bool =
        sqlx::query_scalar("SELECT expires_at > now() + interval '13 days' FROM sessions")
            .fetch_one(&pool)
            .await
            .unwrap();
    assert!(renewed);
}

#[sqlx::test(migrator = "openplan_server::db::MIGRATOR")]
async fn session_not_renewed_with_plenty_of_time_left(pool: PgPool) {
    let mut app = TestApp::new(pool.clone());
    setup_admin(&mut app).await;
    sqlx::query("UPDATE sessions SET expires_at = now() + interval '10 days'")
        .execute(&pool)
        .await
        .unwrap();

    let response = app.get("/api/v1/auth/me").await;

    assert_eq!(response.status, StatusCode::OK);
    let untouched: bool =
        sqlx::query_scalar("SELECT expires_at < now() + interval '11 days' FROM sessions")
            .fetch_one(&pool)
            .await
            .unwrap();
    assert!(untouched);
}

#[sqlx::test(migrator = "openplan_server::db::MIGRATOR")]
async fn session_of_disabled_user_rejected(pool: PgPool) {
    let mut app = TestApp::new(pool.clone());
    setup_admin(&mut app).await;
    sqlx::query("UPDATE users SET disabled = true")
        .execute(&pool)
        .await
        .unwrap();

    let response = app.get("/api/v1/auth/me").await;

    assert_eq!(response.status, StatusCode::UNAUTHORIZED);
    assert_eq!(response.json["code"], "auth.unauthenticated");
}

#[sqlx::test(migrator = "openplan_server::db::MIGRATOR")]
async fn me_lists_workspaces_by_name_with_roles(pool: PgPool) {
    let mut app = TestApp::new(pool.clone());
    setup_admin(&mut app).await;
    let member_id = insert_member(&pool, "member@acme.com").await;
    for (name, role) in [
        ("Zeta", Some("viewer")),
        ("Beta", Some("planner")),
        ("Hidden", None),
    ] {
        let workspace_id = Uuid::now_v7();
        sqlx::query("INSERT INTO workspaces (id, name) VALUES ($1, $2)")
            .bind(workspace_id)
            .bind(name)
            .execute(&pool)
            .await
            .unwrap();
        if let Some(role) = role {
            sqlx::query(
                "INSERT INTO workspace_members (workspace_id, user_id, role) VALUES ($1, $2, $3)",
            )
            .bind(workspace_id)
            .bind(member_id)
            .bind(role)
            .execute(&pool)
            .await
            .unwrap();
        }
    }

    let admin = app.get("/api/v1/auth/me").await;
    let admin_view: Vec<(&str, &str)> = admin.json["workspaces"]
        .as_array()
        .unwrap()
        .iter()
        .map(|w| (w["name"].as_str().unwrap(), w["role"].as_str().unwrap()))
        .collect();
    assert_eq!(
        admin_view,
        [
            ("Acme", "admin"),
            ("Beta", "admin"),
            ("Hidden", "admin"),
            ("Zeta", "admin")
        ]
    );

    let member_login = login(&mut app, "member@acme.com", PASSWORD).await;
    assert_eq!(member_login.status, StatusCode::OK, "{}", member_login.text);
    let member = app.get("/api/v1/auth/me").await;
    assert_eq!(member.json["user"]["is_instance_admin"], false);
    let member_view: Vec<(&str, &str)> = member.json["workspaces"]
        .as_array()
        .unwrap()
        .iter()
        .map(|w| (w["name"].as_str().unwrap(), w["role"].as_str().unwrap()))
        .collect();
    assert_eq!(member_view, [("Beta", "planner"), ("Zeta", "viewer")]);
}

#[sqlx::test(migrator = "openplan_server::db::MIGRATOR")]
async fn session_token_is_stored_only_as_a_hash(pool: PgPool) {
    let mut app = TestApp::new(pool.clone());
    setup_admin(&mut app).await;
    let user_id: Uuid = sqlx::query_scalar("SELECT id FROM users")
        .fetch_one(&pool)
        .await
        .unwrap();

    let token = session::create(&pool, user_id, Some("test-agent"))
        .await
        .unwrap();

    assert_eq!(token.len(), 43);
    let stored_as_hash: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM sessions
         WHERE id_hash = sha256(convert_to($1, 'UTF8')) AND user_agent = 'test-agent'",
    )
    .bind(&token)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(stored_as_hash, 1);
    let stored_raw: i64 =
        sqlx::query_scalar("SELECT count(*) FROM sessions WHERE id_hash = convert_to($1, 'UTF8')")
            .bind(&token)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(stored_raw, 0);
    let ttl_days: bool = sqlx::query_scalar(
        "SELECT expires_at > now() + interval '13 days' AND expires_at <= now() + interval '14 days'
         FROM sessions WHERE user_agent = 'test-agent'",
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    assert!(ttl_days);
}

#[sqlx::test(migrator = "openplan_server::db::MIGRATOR")]
async fn session_lookup_and_delete(pool: PgPool) {
    let mut app = TestApp::new(pool.clone());
    setup_admin(&mut app).await;
    let user_id: Uuid = sqlx::query_scalar("SELECT id FROM users")
        .fetch_one(&pool)
        .await
        .unwrap();
    let token = session::create(&pool, user_id, None).await.unwrap();

    assert_eq!(session::lookup(&pool, &token).await.unwrap(), Some(user_id));
    assert_eq!(session::lookup(&pool, "not-a-token").await.unwrap(), None);

    session::delete(&pool, &token).await.unwrap();

    assert_eq!(session::lookup(&pool, &token).await.unwrap(), None);
    session::delete(&pool, &token).await.unwrap();
}

#[sqlx::test(migrator = "openplan_server::db::MIGRATOR")]
async fn delete_all_for_user_keeps_other_users_sessions(pool: PgPool) {
    let mut app = TestApp::new(pool.clone());
    setup_admin(&mut app).await;
    let admin_id: Uuid = sqlx::query_scalar("SELECT id FROM users")
        .fetch_one(&pool)
        .await
        .unwrap();
    let member_id = insert_member(&pool, "member@acme.com").await;
    let admin_tokens = [
        session::create(&pool, admin_id, None).await.unwrap(),
        session::create(&pool, admin_id, None).await.unwrap(),
    ];
    let member_token = session::create(&pool, member_id, None).await.unwrap();

    session::delete_all_for_user(&pool, admin_id).await.unwrap();

    for token in &admin_tokens {
        assert_eq!(session::lookup(&pool, token).await.unwrap(), None);
    }
    assert_eq!(
        session::lookup(&pool, &member_token).await.unwrap(),
        Some(member_id)
    );
    assert_eq!(session_count(&pool).await, 1);
}

#[sqlx::test(migrator = "openplan_server::db::MIGRATOR")]
async fn openapi_documents_the_auth_routes(pool: PgPool) {
    let mut app = TestApp::new(pool);

    let response = app.get("/api/openapi.json").await;

    assert_eq!(response.status, StatusCode::OK);
    let paths = &response.json["paths"];
    assert!(paths["/api/v1/setup/status"]["get"].is_object());
    assert!(paths["/api/v1/setup"]["post"].is_object());
    assert!(paths["/api/v1/auth/login"]["post"].is_object());
    assert!(paths["/api/v1/auth/logout"]["post"].is_object());
    assert!(paths["/api/v1/auth/me"]["get"].is_object());
    assert_eq!(paths["/api/v1/auth/me"]["get"]["tags"][0], "auth");
    assert!(response.json["components"]["schemas"]["CurrentUser"].is_object());
}
