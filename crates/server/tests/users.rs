mod common;

use axum::http::{Method, StatusCode, header};
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

async fn change_password_request(app: &mut TestApp, current: &str, new: &str) -> TestResponse {
    app.post(
        "/api/v1/auth/me/password",
        Some(json!({ "current_password": current, "new_password": new })),
    )
    .await
}

/// Makes every statement that deletes sessions fail, so that a password change
/// or a user update fails after its other writes.
async fn fail_session_deletes(pool: &PgPool) {
    sqlx::query(
        "CREATE FUNCTION fail_session_delete() RETURNS trigger LANGUAGE plpgsql AS
         $$ BEGIN RAISE EXCEPTION 'injected failure'; END $$",
    )
    .execute(pool)
    .await
    .unwrap();
    sqlx::query(
        "CREATE TRIGGER fail_session_delete BEFORE DELETE ON sessions
         FOR EACH STATEMENT EXECUTE FUNCTION fail_session_delete()",
    )
    .execute(pool)
    .await
    .unwrap();
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
    assert_problem(&malformed, StatusCode::NOT_FOUND, "not_found");
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

#[sqlx::test(migrator = "openplan_server::db::MIGRATOR")]
async fn admin_renames_another_user_and_keeps_their_session(pool: PgPool) {
    let mut admin = TestApp::new(pool.clone());
    setup_admin(&mut admin).await;
    let planner_id = create_planner(&mut admin).await;
    let mut planner = TestApp::new(pool);
    assert_eq!(
        login(&mut planner, PLANNER_EMAIL, PASSWORD).await.status,
        StatusCode::OK
    );

    let renamed = admin
        .patch(
            &format!("/api/v1/users/{planner_id}"),
            Some(json!({ "name": "Patricia Planner" })),
        )
        .await;

    assert_eq!(renamed.status, StatusCode::OK, "{}", renamed.text);
    assert_eq!(renamed.json["name"], "Patricia Planner");
    assert_eq!(renamed.json["email"], PLANNER_EMAIL);
    assert_eq!(renamed.json["disabled"], false);
    let me = planner.get("/api/v1/auth/me").await;
    assert_eq!(me.status, StatusCode::OK, "{}", me.text);
    assert_eq!(me.json["user"]["name"], "Patricia Planner");
}

#[sqlx::test(migrator = "openplan_server::db::MIGRATOR")]
async fn admin_promotes_user_to_instance_admin(pool: PgPool) {
    let mut admin = TestApp::new(pool.clone());
    setup_admin(&mut admin).await;
    let planner_id = create_planner(&mut admin).await;
    let mut planner = TestApp::new(pool);
    assert_eq!(
        login(&mut planner, PLANNER_EMAIL, PASSWORD).await.status,
        StatusCode::OK
    );
    assert_problem(
        &planner.get("/api/v1/users").await,
        StatusCode::FORBIDDEN,
        "auth.forbidden",
    );

    let promoted = admin
        .patch(
            &format!("/api/v1/users/{planner_id}"),
            Some(json!({ "is_instance_admin": true })),
        )
        .await;

    assert_eq!(promoted.status, StatusCode::OK, "{}", promoted.text);
    assert_eq!(promoted.json["is_instance_admin"], true);
    let listed = planner.get("/api/v1/users").await;
    assert_eq!(listed.status, StatusCode::OK, "{}", listed.text);
}

#[sqlx::test(migrator = "openplan_server::db::MIGRATOR")]
async fn admin_reenables_disabled_user(pool: PgPool) {
    let mut admin = TestApp::new(pool.clone());
    setup_admin(&mut admin).await;
    let planner_id = create_planner(&mut admin).await;
    let mut planner = TestApp::new(pool);
    let target = format!("/api/v1/users/{planner_id}");
    admin
        .patch(&target, Some(json!({ "disabled": true })))
        .await;
    assert_problem(
        &login(&mut planner, PLANNER_EMAIL, PASSWORD).await,
        StatusCode::UNAUTHORIZED,
        "auth.invalid_credentials",
    );

    let reenabled = admin
        .patch(&target, Some(json!({ "disabled": false })))
        .await;

    assert_eq!(reenabled.status, StatusCode::OK, "{}", reenabled.text);
    assert_eq!(reenabled.json["disabled"], false);
    assert_eq!(
        login(&mut planner, PLANNER_EMAIL, PASSWORD).await.status,
        StatusCode::OK
    );
}

#[sqlx::test(migrator = "openplan_server::db::MIGRATOR")]
async fn admin_cannot_set_own_password_here(pool: PgPool) {
    let mut admin = TestApp::new(pool);
    setup_admin(&mut admin).await;
    let own_id = admin_id(&mut admin).await;

    let response = admin
        .patch(
            &format!("/api/v1/users/{own_id}"),
            Some(json!({ "password": NEW_PASSWORD })),
        )
        .await;

    assert_problem(&response, StatusCode::UNPROCESSABLE_ENTITY, "validation");
    assert_eq!(field_names(&response), ["password"]);
    assert_eq!(
        response.json["errors"][0]["message"],
        "Use your profile to change your own password."
    );
    assert_eq!(admin.get("/api/v1/auth/me").await.status, StatusCode::OK);
    assert_eq!(
        login(&mut admin, ADMIN_EMAIL, PASSWORD).await.status,
        StatusCode::OK
    );
}

#[sqlx::test(migrator = "openplan_server::db::MIGRATOR")]
async fn user_update_is_atomic_with_session_revocation(pool: PgPool) {
    let mut admin = TestApp::new(pool.clone());
    setup_admin(&mut admin).await;
    let planner_id = create_planner(&mut admin).await;
    let mut planner = TestApp::new(pool.clone());
    assert_eq!(
        login(&mut planner, PLANNER_EMAIL, PASSWORD).await.status,
        StatusCode::OK
    );
    let target = format!("/api/v1/users/{planner_id}");
    fail_session_deletes(&pool).await;

    let disabled = admin
        .patch(&target, Some(json!({ "disabled": true })))
        .await;
    assert_problem(&disabled, StatusCode::INTERNAL_SERVER_ERROR, "internal");
    let reset = admin
        .patch(&target, Some(json!({ "password": NEW_PASSWORD })))
        .await;
    assert_problem(&reset, StatusCode::INTERNAL_SERVER_ERROR, "internal");

    assert_eq!(
        login(&mut planner, PLANNER_EMAIL, PASSWORD).await.status,
        StatusCode::OK
    );
}

#[sqlx::test(migrator = "openplan_server::db::MIGRATOR")]
async fn password_change_is_atomic_with_session_revocation(pool: PgPool) {
    let mut app = TestApp::new(pool.clone());
    setup_admin(&mut app).await;
    fail_session_deletes(&pool).await;

    let response = change_password_request(&mut app, PASSWORD, NEW_PASSWORD).await;

    assert_problem(&response, StatusCode::INTERNAL_SERVER_ERROR, "internal");
    assert_eq!(
        login(&mut app, ADMIN_EMAIL, PASSWORD).await.status,
        StatusCode::OK
    );
}

#[sqlx::test(migrator = "openplan_server::db::MIGRATOR")]
async fn password_change_is_rate_limited_after_10_wrong_attempts(pool: PgPool) {
    let mut app = TestApp::new(pool);
    setup_admin(&mut app).await;

    for attempt in 1..=10 {
        let response = change_password_request(&mut app, "not the password", NEW_PASSWORD).await;
        assert_eq!(
            response.status,
            StatusCode::UNPROCESSABLE_ENTITY,
            "attempt {attempt}"
        );
    }
    let blocked = change_password_request(&mut app, "not the password", NEW_PASSWORD).await;

    assert_problem(&blocked, StatusCode::TOO_MANY_REQUESTS, "auth.rate_limited");
    let retry_after: u64 = blocked.headers[header::RETRY_AFTER]
        .to_str()
        .unwrap()
        .parse()
        .unwrap();
    assert!((1..=900).contains(&retry_after), "{retry_after}");
    let correct = change_password_request(&mut app, PASSWORD, NEW_PASSWORD).await;
    assert_eq!(correct.status, StatusCode::TOO_MANY_REQUESTS);
}

#[sqlx::test(migrator = "openplan_server::db::MIGRATOR")]
async fn successful_password_change_resets_the_rate_limit(pool: PgPool) {
    let mut app = TestApp::new(pool);
    setup_admin(&mut app).await;

    for _ in 0..9 {
        change_password_request(&mut app, "not the password", NEW_PASSWORD).await;
    }
    let changed = change_password_request(&mut app, PASSWORD, NEW_PASSWORD).await;
    assert_eq!(changed.status, StatusCode::NO_CONTENT, "{}", changed.text);

    for attempt in 1..=10 {
        let response =
            change_password_request(&mut app, "not the password", "another passphrase").await;
        assert_eq!(
            response.status,
            StatusCode::UNPROCESSABLE_ENTITY,
            "attempt {attempt}"
        );
    }
}

#[sqlx::test(migrator = "openplan_server::db::MIGRATOR")]
async fn users_api_responses_are_not_cacheable(pool: PgPool) {
    let mut admin = TestApp::new(pool);
    setup_admin(&mut admin).await;

    assert_no_store(&admin.get("/api/v1/users").await);
    let rejected = admin
        .request_without_csrf(
            Method::POST,
            "/api/v1/users",
            Some(json!({
                "email": "x@acme.com",
                "name": "Xan",
                "password": PASSWORD,
                "is_instance_admin": false,
            })),
        )
        .await;
    assert_problem(&rejected, StatusCode::FORBIDDEN, "auth.csrf");
    assert_no_store(&rejected);
}
