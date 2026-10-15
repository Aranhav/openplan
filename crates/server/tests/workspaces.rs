mod common;

use axum::http::{StatusCode, header};
use common::{TestApp, TestResponse};
use serde_json::{Value, json};
use sqlx::PgPool;
use uuid::Uuid;

const ADMIN_EMAIL: &str = "admin@acme.com";
const PASSWORD: &str = "correct horse battery";
const LAST_ADMIN_DETAIL: &str = "A workspace needs at least one admin.";

/// Completes first-run setup and returns the id of the "Acme" workspace it creates.
async fn setup_admin(app: &mut TestApp) -> String {
    let response = app
        .post(
            "/api/v1/setup",
            Some(json!({
                "email": ADMIN_EMAIL,
                "name": "Ada Admin",
                "password": PASSWORD,
                "workspace_name": "Acme",
            })),
        )
        .await;
    assert_eq!(response.status, StatusCode::CREATED, "{}", response.text);
    response.json["workspace"]["id"]
        .as_str()
        .unwrap()
        .to_string()
}

async fn create_user(admin: &mut TestApp, email: &str, name: &str) -> String {
    let response = admin
        .post(
            "/api/v1/users",
            Some(json!({
                "email": email,
                "name": name,
                "password": PASSWORD,
                "is_instance_admin": false,
            })),
        )
        .await;
    assert_eq!(response.status, StatusCode::CREATED, "{}", response.text);
    response.json["id"].as_str().unwrap().to_string()
}

async fn sign_in(pool: &PgPool, email: &str) -> TestApp {
    let mut app = TestApp::new(pool.clone());
    let response = app
        .post(
            "/api/v1/auth/login",
            Some(json!({ "email": email, "password": PASSWORD })),
        )
        .await;
    assert_eq!(response.status, StatusCode::OK, "{}", response.text);
    app
}

/// Creates a user and adds them to `workspace_id` with `role`, as the signed-in
/// `admin`. Returns the new user's id.
async fn create_member(
    admin: &mut TestApp,
    workspace_id: &str,
    email: &str,
    name: &str,
    role: &str,
) -> String {
    let user_id = create_user(admin, email, name).await;
    let added = add_member(admin, workspace_id, email, role).await;
    assert_eq!(added.status, StatusCode::CREATED, "{}", added.text);
    user_id
}

async fn add_member(
    app: &mut TestApp,
    workspace_id: &str,
    email: &str,
    role: &str,
) -> TestResponse {
    app.post(
        &format!("/api/v1/workspaces/{workspace_id}/members"),
        Some(json!({ "email": email, "role": role })),
    )
    .await
}

async fn change_role(
    app: &mut TestApp,
    workspace_id: &str,
    user_id: &str,
    role: &str,
) -> TestResponse {
    app.patch(
        &format!("/api/v1/workspaces/{workspace_id}/members/{user_id}"),
        Some(json!({ "role": role })),
    )
    .await
}

async fn remove_member(app: &mut TestApp, workspace_id: &str, user_id: &str) -> TestResponse {
    app.delete(&format!(
        "/api/v1/workspaces/{workspace_id}/members/{user_id}"
    ))
    .await
}

async fn admin_count(pool: &PgPool, workspace_id: &str) -> i64 {
    sqlx::query_scalar(
        "SELECT count(*) FROM workspace_members WHERE workspace_id = $1 AND role = 'admin'",
    )
    .bind(Uuid::parse_str(workspace_id).unwrap())
    .fetch_one(pool)
    .await
    .unwrap()
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

fn pairs(response: &TestResponse, first: &str, second: &str) -> Vec<(String, String)> {
    response
        .json
        .as_array()
        .expect("response is an array")
        .iter()
        .map(|item| {
            (
                item[first].as_str().unwrap().to_string(),
                item[second].as_str().unwrap().to_string(),
            )
        })
        .collect()
}

fn pair(first: &str, second: &str) -> (String, String) {
    (first.to_string(), second.to_string())
}

#[sqlx::test(migrator = "openplan_server::db::MIGRATOR")]
async fn admin_creates_workspace_and_is_admin_member(pool: PgPool) {
    let mut app = TestApp::new(pool.clone());
    setup_admin(&mut app).await;

    let created = app
        .post(
            "/api/v1/workspaces",
            Some(json!({ "name": "  Planning  " })),
        )
        .await;

    assert_eq!(created.status, StatusCode::CREATED, "{}", created.text);
    assert_no_store(&created);
    assert_eq!(created.json["name"], "Planning");
    assert_eq!(created.json["role"], "admin");
    let id = created.json["id"].as_str().unwrap();
    assert!(Uuid::parse_str(id).is_ok());
    let role: String = sqlx::query_scalar(
        "SELECT m.role FROM workspace_members m JOIN users u ON u.id = m.user_id
         WHERE m.workspace_id = $1 AND u.email = $2",
    )
    .bind(Uuid::parse_str(id).unwrap())
    .bind(ADMIN_EMAIL)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(role, "admin");
}

#[sqlx::test(migrator = "openplan_server::db::MIGRATOR")]
async fn workspace_name_is_validated(pool: PgPool) {
    let mut app = TestApp::new(pool);
    let workspace_id = setup_admin(&mut app).await;

    for name in ["   ".to_string(), "a".repeat(81)] {
        let created = app
            .post("/api/v1/workspaces", Some(json!({ "name": name })))
            .await;
        assert_problem(&created, StatusCode::UNPROCESSABLE_ENTITY, "validation");
        assert_eq!(created.json["errors"][0]["field"], "name");

        let renamed = app
            .patch(
                &format!("/api/v1/workspaces/{workspace_id}"),
                Some(json!({ "name": name })),
            )
            .await;
        assert_problem(&renamed, StatusCode::UNPROCESSABLE_ENTITY, "validation");
        assert_eq!(renamed.json["errors"][0]["field"], "name");
    }
}

#[sqlx::test(migrator = "openplan_server::db::MIGRATOR")]
async fn non_instance_admin_cannot_create_workspace(pool: PgPool) {
    let mut admin = TestApp::new(pool.clone());
    let workspace_id = setup_admin(&mut admin).await;
    create_member(&mut admin, &workspace_id, "bea@acme.com", "Bea", "admin").await;
    let mut bea = sign_in(&pool, "bea@acme.com").await;

    let created = bea
        .post("/api/v1/workspaces", Some(json!({ "name": "Mine" })))
        .await;

    assert_problem(&created, StatusCode::FORBIDDEN, "auth.forbidden");
    let workspaces: i64 = sqlx::query_scalar("SELECT count(*) FROM workspaces")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(workspaces, 1);
}

#[sqlx::test(migrator = "openplan_server::db::MIGRATOR")]
async fn workspace_routes_require_a_session(pool: PgPool) {
    let mut admin = TestApp::new(pool.clone());
    let workspace_id = setup_admin(&mut admin).await;
    let mut anonymous = TestApp::new(pool);
    let member = format!(
        "/api/v1/workspaces/{workspace_id}/members/{}",
        Uuid::now_v7()
    );

    for response in [
        anonymous.get("/api/v1/workspaces").await,
        anonymous
            .post("/api/v1/workspaces", Some(json!({ "name": "X" })))
            .await,
        anonymous
            .get(&format!("/api/v1/workspaces/{workspace_id}/members"))
            .await,
        anonymous.delete(&member).await,
    ] {
        assert_problem(&response, StatusCode::UNAUTHORIZED, "auth.unauthenticated");
    }
}

#[sqlx::test(migrator = "openplan_server::db::MIGRATOR")]
async fn workspace_list_matches_auth_me(pool: PgPool) {
    let mut admin = TestApp::new(pool.clone());
    let acme = setup_admin(&mut admin).await;
    let zeta = admin
        .post("/api/v1/workspaces", Some(json!({ "name": "Zeta" })))
        .await
        .json["id"]
        .as_str()
        .unwrap()
        .to_string();
    create_member(&mut admin, &acme, "pat@acme.com", "Pat", "viewer").await;
    add_member(&mut admin, &zeta, "pat@acme.com", "builder").await;
    let mut pat = sign_in(&pool, "pat@acme.com").await;

    let admin_list = admin.get("/api/v1/workspaces").await;
    let pat_list = pat.get("/api/v1/workspaces").await;

    assert_eq!(admin_list.status, StatusCode::OK, "{}", admin_list.text);
    assert_no_store(&admin_list);
    assert_eq!(
        pairs(&admin_list, "name", "role"),
        [pair("Acme", "admin"), pair("Zeta", "admin")]
    );
    assert_eq!(
        pairs(&pat_list, "name", "role"),
        [pair("Acme", "viewer"), pair("Zeta", "builder")]
    );
    assert!(pat_list.json[0]["id"].as_str().is_some());
    assert_eq!(
        admin_list.json,
        admin.get("/api/v1/auth/me").await.json["workspaces"]
    );
    assert_eq!(
        pat_list.json,
        pat.get("/api/v1/auth/me").await.json["workspaces"]
    );
}

#[sqlx::test(migrator = "openplan_server::db::MIGRATOR")]
async fn member_lists_members(pool: PgPool) {
    let mut admin = TestApp::new(pool.clone());
    let workspace_id = setup_admin(&mut admin).await;
    let pat_id = create_member(
        &mut admin,
        &workspace_id,
        "pat@acme.com",
        "Pat Planner",
        "planner",
    )
    .await;
    create_member(
        &mut admin,
        &workspace_id,
        "bea@acme.com",
        "Bea Viewer",
        "viewer",
    )
    .await;
    create_user(&mut admin, "outsider@acme.com", "Olly Outsider").await;
    let mut pat = sign_in(&pool, "pat@acme.com").await;

    let listed = pat
        .get(&format!("/api/v1/workspaces/{workspace_id}/members"))
        .await;

    assert_eq!(listed.status, StatusCode::OK, "{}", listed.text);
    assert_no_store(&listed);
    assert_eq!(
        pairs(&listed, "name", "role"),
        [
            pair("Ada Admin", "admin"),
            pair("Bea Viewer", "viewer"),
            pair("Pat Planner", "planner"),
        ]
    );
    let member = &listed.json[2];
    assert_eq!(member["user_id"], pat_id);
    assert_eq!(member["email"], "pat@acme.com");
    assert!(member.get("password_hash").is_none());
}

#[sqlx::test(migrator = "openplan_server::db::MIGRATOR")]
async fn non_member_gets_404_for_workspace_and_members(pool: PgPool) {
    let mut admin = TestApp::new(pool.clone());
    let workspace_id = setup_admin(&mut admin).await;
    let admin_user_id = admin.get("/api/v1/auth/me").await.json["user"]["id"]
        .as_str()
        .unwrap()
        .to_string();
    create_user(&mut admin, "pat@acme.com", "Pat").await;
    let mut pat = sign_in(&pool, "pat@acme.com").await;
    let base = format!("/api/v1/workspaces/{workspace_id}");

    let responses = [
        pat.get(&format!("{base}/members")).await,
        add_member(&mut pat, &workspace_id, "pat@acme.com", "admin").await,
        pat.patch(&base, Some(json!({ "name": "Mine" }))).await,
        change_role(&mut pat, &workspace_id, &admin_user_id, "viewer").await,
        remove_member(&mut pat, &workspace_id, &admin_user_id).await,
    ];

    for response in &responses {
        assert_problem(response, StatusCode::NOT_FOUND, "not_found");
        assert_no_store(response);
    }
    assert_eq!(admin_count(&pool, &workspace_id).await, 1);
    let unknown = admin
        .get(&format!("/api/v1/workspaces/{}/members", Uuid::now_v7()))
        .await;
    assert_problem(&unknown, StatusCode::NOT_FOUND, "not_found");
    assert_eq!(unknown.json, responses[0].json);
    let malformed = admin.get("/api/v1/workspaces/not-a-uuid/members").await;
    assert_problem(&malformed, StatusCode::NOT_FOUND, "not_found");
}

#[sqlx::test(migrator = "openplan_server::db::MIGRATOR")]
async fn add_member_by_email(pool: PgPool) {
    let mut admin = TestApp::new(pool.clone());
    let workspace_id = setup_admin(&mut admin).await;
    let pat_id = create_user(&mut admin, "pat@acme.com", "Pat Planner").await;

    let added = add_member(&mut admin, &workspace_id, "  Pat@ACME.com ", "planner").await;

    assert_eq!(added.status, StatusCode::CREATED, "{}", added.text);
    assert_no_store(&added);
    assert_eq!(added.json["user_id"], pat_id);
    assert_eq!(added.json["email"], "pat@acme.com");
    assert_eq!(added.json["name"], "Pat Planner");
    assert_eq!(added.json["role"], "planner");
    let mut pat = sign_in(&pool, "pat@acme.com").await;
    let workspaces = pat.get("/api/v1/workspaces").await;
    assert_eq!(
        pairs(&workspaces, "name", "role"),
        [pair("Acme", "planner")]
    );
}

#[sqlx::test(migrator = "openplan_server::db::MIGRATOR")]
async fn add_member_rejects_invalid_input(pool: PgPool) {
    let mut admin = TestApp::new(pool);
    let workspace_id = setup_admin(&mut admin).await;
    create_user(&mut admin, "pat@acme.com", "Pat").await;

    let bad_role = add_member(&mut admin, &workspace_id, "pat@acme.com", "owner").await;
    assert_problem(&bad_role, StatusCode::UNPROCESSABLE_ENTITY, "validation");
    assert_eq!(bad_role.json["errors"][0]["field"], "role");
    let bad_email = add_member(&mut admin, &workspace_id, "not-an-email", "viewer").await;
    assert_problem(&bad_email, StatusCode::UNPROCESSABLE_ENTITY, "validation");
    assert_eq!(bad_email.json["errors"][0]["field"], "email");
    let bad_change = change_role(
        &mut admin,
        &workspace_id,
        &Uuid::now_v7().to_string(),
        "owner",
    )
    .await;
    assert_problem(&bad_change, StatusCode::UNPROCESSABLE_ENTITY, "validation");
    assert_eq!(bad_change.json["errors"][0]["field"], "role");
}

#[sqlx::test(migrator = "openplan_server::db::MIGRATOR")]
async fn add_unknown_email_404_user_not_found(pool: PgPool) {
    let mut admin = TestApp::new(pool);
    let workspace_id = setup_admin(&mut admin).await;

    let added = add_member(&mut admin, &workspace_id, "ghost@acme.com", "viewer").await;

    assert_problem(&added, StatusCode::NOT_FOUND, "user.not_found");
    assert_eq!(
        added.json["detail"],
        "No user with that email. Ask an instance admin to create the account."
    );
}

#[sqlx::test(migrator = "openplan_server::db::MIGRATOR")]
async fn add_existing_member_409(pool: PgPool) {
    let mut admin = TestApp::new(pool);
    let workspace_id = setup_admin(&mut admin).await;
    create_member(&mut admin, &workspace_id, "pat@acme.com", "Pat", "viewer").await;

    let duplicate = add_member(&mut admin, &workspace_id, "PAT@acme.com", "admin").await;

    assert_problem(&duplicate, StatusCode::CONFLICT, "workspace.member_exists");
    let members = admin
        .get(&format!("/api/v1/workspaces/{workspace_id}/members"))
        .await;
    assert!(pairs(&members, "name", "role").contains(&pair("Pat", "viewer")));
}

#[sqlx::test(migrator = "openplan_server::db::MIGRATOR")]
async fn planner_cannot_add_members(pool: PgPool) {
    let mut admin = TestApp::new(pool.clone());
    let workspace_id = setup_admin(&mut admin).await;
    create_member(&mut admin, &workspace_id, "pat@acme.com", "Pat", "planner").await;
    create_user(&mut admin, "new@acme.com", "New Person").await;
    let mut pat = sign_in(&pool, "pat@acme.com").await;

    let added = add_member(&mut pat, &workspace_id, "new@acme.com", "viewer").await;

    assert_problem(&added, StatusCode::FORBIDDEN, "auth.forbidden");
    let members: i64 = sqlx::query_scalar("SELECT count(*) FROM workspace_members")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(members, 2);
}

#[sqlx::test(migrator = "openplan_server::db::MIGRATOR")]
async fn only_workspace_admins_change_or_remove_members(pool: PgPool) {
    let mut admin = TestApp::new(pool.clone());
    let workspace_id = setup_admin(&mut admin).await;
    let viewer_id =
        create_member(&mut admin, &workspace_id, "viewer@acme.com", "Vi", "viewer").await;
    create_member(
        &mut admin,
        &workspace_id,
        "builder@acme.com",
        "Bu",
        "builder",
    )
    .await;
    let mut builder = sign_in(&pool, "builder@acme.com").await;

    let changed = change_role(&mut builder, &workspace_id, &viewer_id, "admin").await;
    let removed = remove_member(&mut builder, &workspace_id, &viewer_id).await;

    assert_problem(&changed, StatusCode::FORBIDDEN, "auth.forbidden");
    assert_problem(&removed, StatusCode::FORBIDDEN, "auth.forbidden");
    let role: String = sqlx::query_scalar("SELECT role FROM workspace_members WHERE user_id = $1")
        .bind(Uuid::parse_str(&viewer_id).unwrap())
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(role, "viewer");
}

#[sqlx::test(migrator = "openplan_server::db::MIGRATOR")]
async fn admin_changes_and_removes_members(pool: PgPool) {
    let mut admin = TestApp::new(pool);
    let workspace_id = setup_admin(&mut admin).await;
    let pat_id = create_member(&mut admin, &workspace_id, "pat@acme.com", "Pat", "viewer").await;

    let changed = change_role(&mut admin, &workspace_id, &pat_id, "builder").await;

    assert_eq!(changed.status, StatusCode::OK, "{}", changed.text);
    assert_no_store(&changed);
    assert_eq!(changed.json["user_id"], pat_id);
    assert_eq!(changed.json["email"], "pat@acme.com");
    assert_eq!(changed.json["name"], "Pat");
    assert_eq!(changed.json["role"], "builder");
    let removed = remove_member(&mut admin, &workspace_id, &pat_id).await;
    assert_eq!(removed.status, StatusCode::NO_CONTENT, "{}", removed.text);
    assert_no_store(&removed);
    let again = remove_member(&mut admin, &workspace_id, &pat_id).await;
    assert_problem(&again, StatusCode::NOT_FOUND, "not_found");
    let missing = change_role(&mut admin, &workspace_id, &pat_id, "viewer").await;
    assert_problem(&missing, StatusCode::NOT_FOUND, "not_found");
}

#[sqlx::test(migrator = "openplan_server::db::MIGRATOR")]
async fn cannot_remove_last_admin(pool: PgPool) {
    let mut admin = TestApp::new(pool.clone());
    let workspace_id = setup_admin(&mut admin).await;
    let admin_id = admin.get("/api/v1/auth/me").await.json["user"]["id"]
        .as_str()
        .unwrap()
        .to_string();
    create_member(&mut admin, &workspace_id, "pat@acme.com", "Pat", "viewer").await;

    let removed = remove_member(&mut admin, &workspace_id, &admin_id).await;

    assert_problem(&removed, StatusCode::CONFLICT, "workspace.last_admin");
    assert_eq!(removed.json["detail"], LAST_ADMIN_DETAIL);
    assert_eq!(admin_count(&pool, &workspace_id).await, 1);
}

#[sqlx::test(migrator = "openplan_server::db::MIGRATOR")]
async fn cannot_demote_last_admin(pool: PgPool) {
    let mut admin = TestApp::new(pool.clone());
    let workspace_id = setup_admin(&mut admin).await;
    let admin_id = admin.get("/api/v1/auth/me").await.json["user"]["id"]
        .as_str()
        .unwrap()
        .to_string();

    let demoted = change_role(&mut admin, &workspace_id, &admin_id, "builder").await;

    assert_problem(&demoted, StatusCode::CONFLICT, "workspace.last_admin");
    assert_eq!(demoted.json["detail"], LAST_ADMIN_DETAIL);
    assert_eq!(admin_count(&pool, &workspace_id).await, 1);
    let kept = change_role(&mut admin, &workspace_id, &admin_id, "admin").await;
    assert_eq!(kept.status, StatusCode::OK, "{}", kept.text);
}

#[sqlx::test(migrator = "openplan_server::db::MIGRATOR")]
async fn can_demote_admin_when_another_exists(pool: PgPool) {
    let mut admin = TestApp::new(pool.clone());
    let workspace_id = setup_admin(&mut admin).await;
    let admin_id = admin.get("/api/v1/auth/me").await.json["user"]["id"]
        .as_str()
        .unwrap()
        .to_string();
    create_member(&mut admin, &workspace_id, "bea@acme.com", "Bea", "admin").await;

    let demoted = change_role(&mut admin, &workspace_id, &admin_id, "planner").await;

    assert_eq!(demoted.status, StatusCode::OK, "{}", demoted.text);
    assert_eq!(demoted.json["role"], "planner");
    assert_eq!(admin_count(&pool, &workspace_id).await, 1);
}

#[sqlx::test(migrator = "openplan_server::db::MIGRATOR")]
async fn instance_admin_is_not_a_workspace_admin_for_the_last_admin_rule(pool: PgPool) {
    let mut admin = TestApp::new(pool.clone());
    setup_admin(&mut admin).await;
    let other = admin
        .post("/api/v1/workspaces", Some(json!({ "name": "Other" })))
        .await
        .json["id"]
        .as_str()
        .unwrap()
        .to_string();
    let admin_id = admin.get("/api/v1/auth/me").await.json["user"]["id"]
        .as_str()
        .unwrap()
        .to_string();
    let bea_id = create_member(&mut admin, &other, "bea@acme.com", "Bea", "admin").await;
    let removed_self = remove_member(&mut admin, &other, &admin_id).await;
    assert_eq!(
        removed_self.status,
        StatusCode::NO_CONTENT,
        "{}",
        removed_self.text
    );

    let removed = remove_member(&mut admin, &other, &bea_id).await;
    let demoted = change_role(&mut admin, &other, &bea_id, "viewer").await;

    assert_problem(&removed, StatusCode::CONFLICT, "workspace.last_admin");
    assert_problem(&demoted, StatusCode::CONFLICT, "workspace.last_admin");
    assert_eq!(admin_count(&pool, &other).await, 1);
    let listed = admin
        .get(&format!("/api/v1/workspaces/{other}/members"))
        .await;
    assert_eq!(pairs(&listed, "name", "role"), [pair("Bea", "admin")]);
}

#[sqlx::test(migrator = "openplan_server::db::MIGRATOR")]
async fn concurrent_changes_cannot_leave_a_workspace_without_an_admin(pool: PgPool) {
    let mut ada = TestApp::new(pool.clone());
    let workspace_id = setup_admin(&mut ada).await;
    let ada_id = ada.get("/api/v1/auth/me").await.json["user"]["id"]
        .as_str()
        .unwrap()
        .to_string();
    let bea_id = create_member(&mut ada, &workspace_id, "bea@acme.com", "Bea", "admin").await;
    let mut bea = sign_in(&pool, "bea@acme.com").await;
    // A slow change widens the window in which the two requests overlap.
    sqlx::query(
        "CREATE FUNCTION slow_member_change() RETURNS trigger LANGUAGE plpgsql AS
         $$ BEGIN PERFORM pg_sleep(0.5); RETURN COALESCE(NEW, OLD); END $$",
    )
    .execute(&pool)
    .await
    .unwrap();
    sqlx::query(
        "CREATE TRIGGER slow_member_change BEFORE UPDATE OR DELETE ON workspace_members
         FOR EACH ROW EXECUTE FUNCTION slow_member_change()",
    )
    .execute(&pool)
    .await
    .unwrap();

    let (demoted, removed) = tokio::join!(
        change_role(&mut ada, &workspace_id, &bea_id, "viewer"),
        remove_member(&mut bea, &workspace_id, &ada_id),
    );

    let mut statuses = [demoted.status, removed.status];
    statuses.sort();
    assert!(
        statuses[0].is_success() && statuses[1] == StatusCode::CONFLICT,
        "{statuses:?}: {} / {}",
        demoted.text,
        removed.text
    );
    assert_eq!(admin_count(&pool, &workspace_id).await, 1);
}

#[sqlx::test(migrator = "openplan_server::db::MIGRATOR")]
async fn rename_requires_workspace_admin(pool: PgPool) {
    let mut admin = TestApp::new(pool.clone());
    let workspace_id = setup_admin(&mut admin).await;
    create_member(
        &mut admin,
        &workspace_id,
        "builder@acme.com",
        "Bu",
        "builder",
    )
    .await;
    create_member(&mut admin, &workspace_id, "bea@acme.com", "Bea", "admin").await;
    let mut builder = sign_in(&pool, "builder@acme.com").await;
    let mut bea = sign_in(&pool, "bea@acme.com").await;
    let path = format!("/api/v1/workspaces/{workspace_id}");

    let denied = builder.patch(&path, Some(json!({ "name": "Nope" }))).await;
    let by_member_admin = bea
        .patch(&path, Some(json!({ "name": " Beas Plan " })))
        .await;
    let by_instance_admin = admin.patch(&path, Some(json!({ "name": "Final" }))).await;

    assert_problem(&denied, StatusCode::FORBIDDEN, "auth.forbidden");
    assert_eq!(
        by_member_admin.status,
        StatusCode::OK,
        "{}",
        by_member_admin.text
    );
    assert_eq!(by_member_admin.json["name"], "Beas Plan");
    assert_eq!(by_member_admin.json["role"], "admin");
    assert_eq!(by_member_admin.json["id"], workspace_id.as_str());
    assert_eq!(
        by_instance_admin.status,
        StatusCode::OK,
        "{}",
        by_instance_admin.text
    );
    assert_no_store(&by_instance_admin);
    let name: String = sqlx::query_scalar("SELECT name FROM workspaces")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(name, "Final");
}

#[sqlx::test(migrator = "openplan_server::db::MIGRATOR")]
async fn delete_workspace_cascades_members(pool: PgPool) {
    let mut admin = TestApp::new(pool.clone());
    let workspace_id = setup_admin(&mut admin).await;
    create_member(&mut admin, &workspace_id, "bea@acme.com", "Bea", "admin").await;
    let mut bea = sign_in(&pool, "bea@acme.com").await;
    let path = format!("/api/v1/workspaces/{workspace_id}");

    let by_workspace_admin = bea.delete(&path).await;
    assert_problem(&by_workspace_admin, StatusCode::FORBIDDEN, "auth.forbidden");
    let deleted = admin.delete(&path).await;

    assert_eq!(deleted.status, StatusCode::NO_CONTENT, "{}", deleted.text);
    assert_no_store(&deleted);
    let workspaces: i64 = sqlx::query_scalar("SELECT count(*) FROM workspaces")
        .fetch_one(&pool)
        .await
        .unwrap();
    let members: i64 = sqlx::query_scalar("SELECT count(*) FROM workspace_members")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!((workspaces, members), (0, 0));
    let users: i64 = sqlx::query_scalar("SELECT count(*) FROM users")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(users, 2);
    assert_problem(
        &admin.delete(&path).await,
        StatusCode::NOT_FOUND,
        "not_found",
    );
}

#[sqlx::test(migrator = "openplan_server::db::MIGRATOR")]
async fn workspaces_appear_in_the_openapi_document(pool: PgPool) {
    let mut app = TestApp::new(pool);

    let document = app.get("/api/openapi.json").await;

    let paths = document.json["paths"].as_object().unwrap();
    for path in [
        "/api/v1/workspaces",
        "/api/v1/workspaces/{id}",
        "/api/v1/workspaces/{id}/members",
        "/api/v1/workspaces/{id}/members/{user_id}",
    ] {
        assert!(paths.contains_key(path), "missing {path}");
    }
    let schemas: &Value = &document.json["components"]["schemas"];
    assert_eq!(
        schemas["WorkspaceRole"]["enum"],
        json!(["viewer", "planner", "builder", "admin"])
    );
}
