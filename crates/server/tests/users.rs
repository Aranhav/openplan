mod common;

use axum::http::{StatusCode, header};
use common::{TestApp, TestResponse};
use serde_json::{Value, json};
use sqlx::PgPool;
use uuid::Uuid;

const ADMIN_EMAIL: &str = "admin@acme.com";
const PASSWORD: &str = "correct horse battery";
const NEW_PASSWORD: &str = "battery staple horse";
const PLANNER_EMAIL: &str = "planner@acme.com";
const OWN_ACCOUNT_MESSAGE: &str = "You can't change this for your own account.";

fn setup_body() -> Value {
    json!({
        "email": ADMIN_EMAIL,
        "name": "Ada Admin",
        "password": PASSWORD,
        "workspace_name": "Acme",
    })
}

async fn setup_admin(app: &mut TestApp) {
    let response = app.post("/api/v1/setup", Some(setup_body())).await;
    assert_eq!(response.status, StatusCode::CREATED, "{}", response.text);
}

async fn login(app: &mut TestApp, email: &str, password: &str) -> TestResponse {
    app.post(
        "/api/v1/auth/login",
        Some(json!({ "email": email, "password": password })),
    )
    .await
}

async fn create_user(app: &mut TestApp, email: &str, name: &str) -> TestResponse {
    app.post(
        "/api/v1/users",
        Some(json!({
            "email": email,
            "name": name,
            "password": PASSWORD,
            "is_instance_admin": false,
        })),
    )
    .await
}

/// Creates the regular user that the tests sign in as, and returns their id.
async fn create_planner(admin: &mut TestApp) -> String {
    let created = create_user(admin, PLANNER_EMAIL, "Pat Planner").await;
    assert_eq!(created.status, StatusCode::CREATED, "{}", created.text);
    created.json["id"].as_str().unwrap().to_string()
}

async fn admin_id(app: &mut TestApp) -> String {
    app.get("/api/v1/auth/me").await.json["user"]["id"]
        .as_str()
        .unwrap()
        .to_string()
}

fn assert_problem(response: &TestResponse, status: StatusCode, code: &str) {
    assert_eq!(response.status, status, "{}", response.text);
    let content_type = response.headers[header::CONTENT_TYPE].to_str().unwrap();
    assert!(
        content_type.starts_with("application/problem+json"),
        "{content_type}"
    );
    assert_eq!(response.json["code"], code);
}

fn assert_no_store(response: &TestResponse) {
    assert_eq!(response.headers[header::CACHE_CONTROL], "no-store");
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

#[sqlx::test(migrator = "openplan_server::db::MIGRATOR")]
async fn admin_creates_and_lists_users(pool: PgPool) {
    let mut app = TestApp::new(pool);
    setup_admin(&mut app).await;

    let created = create_user(&mut app, "Pat@Acme.com", "Pat Planner").await;

    assert_eq!(created.status, StatusCode::CREATED, "{}", created.text);
    assert_eq!(created.json["email"], "pat@acme.com");
    assert_eq!(created.json["name"], "Pat Planner");
    assert_eq!(created.json["is_instance_admin"], false);
    assert_eq!(created.json["disabled"], false);
    assert!(Uuid::parse_str(created.json["id"].as_str().unwrap()).is_ok());
    assert!(created.json["created_at"].as_str().unwrap().ends_with('Z'));
    assert!(created.json.get("password_hash").is_none());
    let bea = create_user(&mut app, "bea@acme.com", "Bea Builder").await;
    assert_eq!(bea.status, StatusCode::CREATED, "{}", bea.text);

    let listed = app.get("/api/v1/users").await;

    assert_eq!(listed.status, StatusCode::OK, "{}", listed.text);
    let names: Vec<&str> = listed
        .json
        .as_array()
        .unwrap()
        .iter()
        .map(|user| user["name"].as_str().unwrap())
        .collect();
    assert_eq!(names, ["Ada Admin", "Bea Builder", "Pat Planner"]);
}

#[sqlx::test(migrator = "openplan_server::db::MIGRATOR")]
async fn non_admin_forbidden(pool: PgPool) {
    let mut admin = TestApp::new(pool.clone());
    setup_admin(&mut admin).await;
    create_planner(&mut admin).await;
    let mut planner = TestApp::new(pool);
    assert_eq!(
        login(&mut planner, PLANNER_EMAIL, PASSWORD).await.status,
        StatusCode::OK
    );
    let target = format!("/api/v1/users/{}", Uuid::now_v7());

    let list = planner.get("/api/v1/users").await;
    assert_problem(&list, StatusCode::FORBIDDEN, "auth.forbidden");
    let create = create_user(&mut planner, "new@acme.com", "New Person").await;
    assert_problem(&create, StatusCode::FORBIDDEN, "auth.forbidden");
    let update = planner
        .patch(&target, Some(json!({ "name": "Renamed" })))
        .await;
    assert_problem(&update, StatusCode::FORBIDDEN, "auth.forbidden");
}

#[sqlx::test(migrator = "openplan_server::db::MIGRATOR")]
async fn duplicate_email_case_insensitive(pool: PgPool) {
    let mut app = TestApp::new(pool.clone());
    setup_admin(&mut app).await;
    let first = create_user(&mut app, "pat@acme.com", "Pat Planner").await;
    assert_eq!(first.status, StatusCode::CREATED, "{}", first.text);

    let duplicate = create_user(&mut app, "Pat@Acme.com", "Other Pat").await;
    assert_problem(&duplicate, StatusCode::CONFLICT, "user.email_taken");
    let admin_clash = create_user(&mut app, "ADMIN@acme.com", "Impostor").await;
    assert_problem(&admin_clash, StatusCode::CONFLICT, "user.email_taken");

    let users: i64 = sqlx::query_scalar("SELECT count(*) FROM users")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(users, 2);
}

#[sqlx::test(migrator = "openplan_server::db::MIGRATOR")]
async fn disable_user_kills_session_and_login(pool: PgPool) {
    let mut admin = TestApp::new(pool.clone());
    setup_admin(&mut admin).await;
    let planner_id = create_planner(&mut admin).await;
    let mut planner = TestApp::new(pool);
    assert_eq!(
        login(&mut planner, PLANNER_EMAIL, PASSWORD).await.status,
        StatusCode::OK
    );
    assert_eq!(planner.get("/api/v1/auth/me").await.status, StatusCode::OK);

    let disabled = admin
        .patch(
            &format!("/api/v1/users/{planner_id}"),
            Some(json!({ "disabled": true })),
        )
        .await;

    assert_eq!(disabled.status, StatusCode::OK, "{}", disabled.text);
    assert_eq!(disabled.json["disabled"], true);
    assert_problem(
        &planner.get("/api/v1/auth/me").await,
        StatusCode::UNAUTHORIZED,
        "auth.unauthenticated",
    );
    assert_problem(
        &login(&mut planner, PLANNER_EMAIL, PASSWORD).await,
        StatusCode::UNAUTHORIZED,
        "auth.invalid_credentials",
    );
}

#[sqlx::test(migrator = "openplan_server::db::MIGRATOR")]
async fn admin_cannot_disable_self(pool: PgPool) {
    let mut admin = TestApp::new(pool);
    setup_admin(&mut admin).await;
    let own_id = admin_id(&mut admin).await;

    let response = admin
        .patch(
            &format!("/api/v1/users/{own_id}"),
            Some(json!({ "disabled": true })),
        )
        .await;

    assert_problem(&response, StatusCode::UNPROCESSABLE_ENTITY, "validation");
    assert_eq!(field_names(&response), ["disabled"]);
    assert_eq!(response.json["errors"][0]["message"], OWN_ACCOUNT_MESSAGE);
    assert_eq!(admin.get("/api/v1/auth/me").await.status, StatusCode::OK);
}

#[sqlx::test(migrator = "openplan_server::db::MIGRATOR")]
async fn admin_cannot_remove_own_admin_flag(pool: PgPool) {
    let mut admin = TestApp::new(pool);
    setup_admin(&mut admin).await;
    let own_id = admin_id(&mut admin).await;
    let target = format!("/api/v1/users/{own_id}");

    let demote = admin
        .patch(&target, Some(json!({ "is_instance_admin": false })))
        .await;
    assert_problem(&demote, StatusCode::UNPROCESSABLE_ENTITY, "validation");
    assert_eq!(field_names(&demote), ["is_instance_admin"]);
    assert_eq!(demote.json["errors"][0]["message"], OWN_ACCOUNT_MESSAGE);

    let both = admin
        .patch(
            &target,
            Some(json!({ "disabled": true, "is_instance_admin": false })),
        )
        .await;
    assert_eq!(field_names(&both), ["disabled", "is_instance_admin"]);
    assert_eq!(
        admin.get("/api/v1/auth/me").await.json["user"]["is_instance_admin"],
        true
    );
}

#[sqlx::test(migrator = "openplan_server::db::MIGRATOR")]
async fn update_own_name(pool: PgPool) {
    let mut app = TestApp::new(pool);
    setup_admin(&mut app).await;
    let own_id = admin_id(&mut app).await;

    let renamed = app
        .patch(
            "/api/v1/auth/me",
            Some(json!({ "name": "  Ada Lovelace " })),
        )
        .await;

    assert_eq!(renamed.status, StatusCode::OK, "{}", renamed.text);
    assert_eq!(
        renamed.json,
        json!({
            "id": own_id,
            "email": ADMIN_EMAIL,
            "name": "Ada Lovelace",
            "is_instance_admin": true,
        })
    );
    assert_eq!(
        app.get("/api/v1/auth/me").await.json["user"]["name"],
        "Ada Lovelace"
    );
    let blank = app
        .patch("/api/v1/auth/me", Some(json!({ "name": " " })))
        .await;
    assert_problem(&blank, StatusCode::UNPROCESSABLE_ENTITY, "validation");
    assert_eq!(field_names(&blank), ["name"]);
}

#[sqlx::test(migrator = "openplan_server::db::MIGRATOR")]
async fn change_password_requires_current(pool: PgPool) {
    let mut app = TestApp::new(pool);
    setup_admin(&mut app).await;

    let wrong = app
        .post(
            "/api/v1/auth/me/password",
            Some(json!({ "current_password": "not the password", "new_password": NEW_PASSWORD })),
        )
        .await;
    assert_problem(&wrong, StatusCode::UNPROCESSABLE_ENTITY, "validation");
    assert_eq!(field_names(&wrong), ["current_password"]);
    assert_eq!(
        wrong.json["errors"][0]["message"],
        "Current password is incorrect."
    );

    let short = app
        .post(
            "/api/v1/auth/me/password",
            Some(json!({ "current_password": PASSWORD, "new_password": "short" })),
        )
        .await;
    assert_problem(&short, StatusCode::UNPROCESSABLE_ENTITY, "validation");
    assert_eq!(field_names(&short), ["new_password"]);

    let changed = app
        .post(
            "/api/v1/auth/me/password",
            Some(json!({ "current_password": PASSWORD, "new_password": NEW_PASSWORD })),
        )
        .await;
    assert_eq!(changed.status, StatusCode::NO_CONTENT, "{}", changed.text);
    assert!(changed.text.is_empty());
    assert_problem(
        &login(&mut app, ADMIN_EMAIL, PASSWORD).await,
        StatusCode::UNAUTHORIZED,
        "auth.invalid_credentials",
    );
    assert_eq!(
        login(&mut app, ADMIN_EMAIL, NEW_PASSWORD).await.status,
        StatusCode::OK
    );
}

#[sqlx::test(migrator = "openplan_server::db::MIGRATOR")]
async fn change_password_signs_out_other_sessions(pool: PgPool) {
    let mut current = TestApp::new(pool.clone());
    setup_admin(&mut current).await;
    let mut other = TestApp::new(pool);
    assert_eq!(
        login(&mut other, ADMIN_EMAIL, PASSWORD).await.status,
        StatusCode::OK
    );

    let changed = current
        .post(
            "/api/v1/auth/me/password",
            Some(json!({ "current_password": PASSWORD, "new_password": NEW_PASSWORD })),
        )
        .await;

    assert_eq!(changed.status, StatusCode::NO_CONTENT, "{}", changed.text);
    assert_eq!(current.get("/api/v1/auth/me").await.status, StatusCode::OK);
    assert_problem(
        &other.get("/api/v1/auth/me").await,
        StatusCode::UNAUTHORIZED,
        "auth.unauthenticated",
    );
}

#[sqlx::test(migrator = "openplan_server::db::MIGRATOR")]
async fn admin_resets_password_signs_user_out(pool: PgPool) {
    let mut admin = TestApp::new(pool.clone());
    setup_admin(&mut admin).await;
    let planner_id = create_planner(&mut admin).await;
    let mut planner = TestApp::new(pool);
    assert_eq!(
        login(&mut planner, PLANNER_EMAIL, PASSWORD).await.status,
        StatusCode::OK
    );
    let target = format!("/api/v1/users/{planner_id}");

    let short = admin
        .patch(&target, Some(json!({ "password": "short" })))
        .await;
    assert_problem(&short, StatusCode::UNPROCESSABLE_ENTITY, "validation");
    assert_eq!(field_names(&short), ["password"]);

    let reset = admin
        .patch(&target, Some(json!({ "password": NEW_PASSWORD })))
        .await;

    assert_eq!(reset.status, StatusCode::OK, "{}", reset.text);
    assert_problem(
        &planner.get("/api/v1/auth/me").await,
        StatusCode::UNAUTHORIZED,
        "auth.unauthenticated",
    );
    assert_problem(
        &login(&mut planner, PLANNER_EMAIL, PASSWORD).await,
        StatusCode::UNAUTHORIZED,
        "auth.invalid_credentials",
    );
    assert_eq!(
        login(&mut planner, PLANNER_EMAIL, NEW_PASSWORD)
            .await
            .status,
        StatusCode::OK
    );
    assert_eq!(admin.get("/api/v1/auth/me").await.status, StatusCode::OK);
}

#[sqlx::test(migrator = "openplan_server::db::MIGRATOR")]
async fn unknown_user_is_not_found(pool: PgPool) {
    let mut admin = TestApp::new(pool);
    setup_admin(&mut admin).await;

    let missing = admin
        .patch(
            &format!("/api/v1/users/{}", Uuid::now_v7()),
            Some(json!({ "name": "Nobody" })),
        )
        .await;
    assert_problem(&missing, StatusCode::NOT_FOUND, "user.not_found");
    let malformed = admin
        .patch(
            "/api/v1/users/not-a-uuid",
            Some(json!({ "name": "Nobody" })),
        )
        .await;
    assert_problem(&malformed, StatusCode::NOT_FOUND, "user.not_found");
}

#[sqlx::test(migrator = "openplan_server::db::MIGRATOR")]
async fn profile_responses_are_not_cacheable(pool: PgPool) {
    let mut app = TestApp::new(pool);
    setup_admin(&mut app).await;

    assert_no_store(
        &app.patch("/api/v1/auth/me", Some(json!({ "name": "Ada Admin" })))
            .await,
    );
    assert_no_store(
        &app.post(
            "/api/v1/auth/me/password",
            Some(json!({ "current_password": "not the password", "new_password": NEW_PASSWORD })),
        )
        .await,
    );
}

#[sqlx::test(migrator = "openplan_server::db::MIGRATOR")]
async fn create_user_validates_input(pool: PgPool) {
    let mut app = TestApp::new(pool);
    setup_admin(&mut app).await;

    let invalid = app
        .post(
            "/api/v1/users",
            Some(json!({
                "email": "nope",
                "name": " ",
                "password": "short",
                "is_instance_admin": false,
            })),
        )
        .await;
    assert_problem(&invalid, StatusCode::UNPROCESSABLE_ENTITY, "validation");
    assert_eq!(field_names(&invalid), ["email", "name", "password"]);

    let missing_flag = app
        .post(
            "/api/v1/users",
            Some(json!({ "email": "x@acme.com", "name": "Xan", "password": PASSWORD })),
        )
        .await;
    assert_problem(
        &missing_flag,
        StatusCode::UNPROCESSABLE_ENTITY,
        "validation",
    );
    assert_eq!(field_names(&missing_flag), ["is_instance_admin"]);
}

#[sqlx::test(migrator = "openplan_server::db::MIGRATOR")]
async fn openapi_documents_the_user_routes(pool: PgPool) {
    let mut app = TestApp::new(pool);

    let response = app.get("/api/openapi.json").await;

    assert_eq!(response.status, StatusCode::OK);
    let paths = &response.json["paths"];
    assert!(paths["/api/v1/users"]["get"].is_object());
    assert!(paths["/api/v1/users"]["post"].is_object());
    assert_eq!(paths["/api/v1/users"]["get"]["tags"][0], "users");
    assert!(paths["/api/v1/users/{id}"]["patch"].is_object());
    assert!(paths["/api/v1/auth/me"]["patch"].is_object());
    assert!(paths["/api/v1/auth/me/password"]["post"].is_object());
    assert!(response.json["components"]["schemas"]["UserDto"].is_object());
}
