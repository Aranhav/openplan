mod common;

use axum::http::{StatusCode, header};
use chrono::{DateTime, Datelike, FixedOffset, Utc};
use common::{
    TestApp, TestResponse, assert_problem, create_member, create_model, create_user, setup_admin,
    sign_in,
};
use serde_json::json;
use sqlx::PgPool;
use uuid::Uuid;

const NAME_TAKEN_DETAIL: &str = "A model with this name already exists in this workspace.";

fn models_path(workspace_id: &str) -> String {
    format!("/api/v1/workspaces/{workspace_id}/models")
}

fn model_path(model_id: &str) -> String {
    format!("/api/v1/models/{model_id}")
}

async fn try_create_model(app: &mut TestApp, workspace_id: &str, name: &str) -> TestResponse {
    app.post(&models_path(workspace_id), Some(json!({ "name": name })))
        .await
}

async fn stored_name(pool: &PgPool, model_id: &str) -> String {
    sqlx::query_scalar("SELECT name FROM models WHERE id = $1")
        .bind(Uuid::parse_str(model_id).unwrap())
        .fetch_one(pool)
        .await
        .unwrap()
}

async fn model_count(pool: &PgPool) -> i64 {
    sqlx::query_scalar("SELECT count(*) FROM models")
        .fetch_one(pool)
        .await
        .unwrap()
}

fn assert_no_store(response: &TestResponse) {
    assert_eq!(response.headers[header::CACHE_CONTROL], "no-store");
}

fn names(response: &TestResponse) -> Vec<String> {
    response
        .json
        .as_array()
        .expect("response is an array")
        .iter()
        .map(|model| model["name"].as_str().unwrap().to_string())
        .collect()
}

fn updated_at(response: &TestResponse) -> DateTime<FixedOffset> {
    DateTime::parse_from_rfc3339(response.json["updated_at"].as_str().unwrap()).unwrap()
}

#[sqlx::test(migrator = "openplan_server::db::MIGRATOR")]
async fn builder_creates_model_with_default_calendar(pool: PgPool) {
    let mut admin = TestApp::new(pool.clone());
    let workspace_id = setup_admin(&mut admin).await;
    let builder_id = create_member(&mut admin, &workspace_id, "bu@acme.com", "Bu", "builder").await;
    let mut builder = sign_in(&pool, "bu@acme.com").await;

    let created = builder
        .post(
            &models_path(&workspace_id),
            Some(json!({ "name": "  FY27 Plan  ", "description": "Revenue and cost" })),
        )
        .await;

    assert_eq!(created.status, StatusCode::CREATED, "{}", created.text);
    assert_no_store(&created);
    assert!(Uuid::parse_str(created.json["id"].as_str().unwrap()).is_ok());
    assert_eq!(created.json["workspace_id"], workspace_id.as_str());
    assert_eq!(created.json["name"], "FY27 Plan");
    assert_eq!(created.json["description"], "Revenue and cost");
    assert_eq!(created.json["mode"], "dev");
    assert_eq!(created.json["created_by"], builder_id.as_str());
    assert_eq!(
        created.json["calendar"],
        json!({ "fiscal_year_start_month": 1, "first_year": Utc::now().year(), "years": 3 })
    );
}

#[sqlx::test(migrator = "openplan_server::db::MIGRATOR")]
async fn planner_cannot_create_model(pool: PgPool) {
    let mut admin = TestApp::new(pool.clone());
    let workspace_id = setup_admin(&mut admin).await;
    create_member(&mut admin, &workspace_id, "pat@acme.com", "Pat", "planner").await;
    let mut pat = sign_in(&pool, "pat@acme.com").await;

    let created = try_create_model(&mut pat, &workspace_id, "Plan").await;

    assert_problem(&created, StatusCode::FORBIDDEN, "auth.forbidden");
    assert_eq!(model_count(&pool).await, 0);
}

#[sqlx::test(migrator = "openplan_server::db::MIGRATOR")]
async fn viewer_can_list_and_get(pool: PgPool) {
    let mut admin = TestApp::new(pool.clone());
    let workspace_id = setup_admin(&mut admin).await;
    let alpha = create_model(&mut admin, &workspace_id, "Alpha").await;
    let beta = create_model(&mut admin, &workspace_id, "Beta").await;
    create_member(&mut admin, &workspace_id, "vi@acme.com", "Vi", "viewer").await;
    let mut viewer = sign_in(&pool, "vi@acme.com").await;

    let listed = viewer.get(&models_path(&workspace_id)).await;
    assert_eq!(listed.status, StatusCode::OK, "{}", listed.text);
    assert_no_store(&listed);
    assert_eq!(names(&listed), ["Beta", "Alpha"]);

    let touched = admin
        .patch(
            &model_path(&alpha),
            Some(json!({ "description": "Revised" })),
        )
        .await;
    assert_eq!(touched.status, StatusCode::OK, "{}", touched.text);
    let relisted = viewer.get(&models_path(&workspace_id)).await;
    assert_eq!(names(&relisted), ["Alpha", "Beta"]);

    let fetched = viewer.get(&model_path(&beta)).await;
    assert_eq!(fetched.status, StatusCode::OK, "{}", fetched.text);
    assert_no_store(&fetched);
    assert_eq!(fetched.json["id"], beta.as_str());
    assert_eq!(fetched.json["name"], "Beta");
}

#[sqlx::test(migrator = "openplan_server::db::MIGRATOR")]
async fn non_member_404_on_get_model(pool: PgPool) {
    let mut admin = TestApp::new(pool.clone());
    let workspace_id = setup_admin(&mut admin).await;
    let model_id = create_model(&mut admin, &workspace_id, "Plan").await;
    create_user(&mut admin, "olly@acme.com", "Olly Outsider").await;
    let mut outsider = sign_in(&pool, "olly@acme.com").await;
    let path = model_path(&model_id);

    let fetched = outsider.get(&path).await;
    let unknown = outsider.get(&model_path(&Uuid::now_v7().to_string())).await;
    let patched = outsider
        .patch(&path, Some(json!({ "name": "Hijacked" })))
        .await;
    let deleted = outsider.delete(&path).await;

    assert_problem(&fetched, StatusCode::NOT_FOUND, "not_found");
    assert_no_store(&fetched);
    assert_eq!(fetched.json, unknown.json);
    assert_problem(&patched, StatusCode::NOT_FOUND, "not_found");
    assert_problem(&deleted, StatusCode::NOT_FOUND, "not_found");
    assert_eq!(stored_name(&pool, &model_id).await, "Plan");
}

#[sqlx::test(migrator = "openplan_server::db::MIGRATOR")]
async fn duplicate_name_case_insensitive_409(pool: PgPool) {
    let mut admin = TestApp::new(pool.clone());
    let workspace_id = setup_admin(&mut admin).await;
    create_model(&mut admin, &workspace_id, "Plan").await;

    let duplicate = try_create_model(&mut admin, &workspace_id, "  pLAN ").await;

    assert_problem(&duplicate, StatusCode::CONFLICT, "model.name_taken");
    assert_eq!(duplicate.json["detail"], NAME_TAKEN_DETAIL);
    assert_eq!(model_count(&pool).await, 1);
}

#[sqlx::test(migrator = "openplan_server::db::MIGRATOR")]
async fn same_name_allowed_in_other_workspace(pool: PgPool) {
    let mut admin = TestApp::new(pool.clone());
    let acme = setup_admin(&mut admin).await;
    let zeta = admin
        .post("/api/v1/workspaces", Some(json!({ "name": "Zeta" })))
        .await
        .json["id"]
        .as_str()
        .unwrap()
        .to_string();

    let in_acme = try_create_model(&mut admin, &acme, "Plan").await;
    let in_zeta = try_create_model(&mut admin, &zeta, "Plan").await;

    assert_eq!(in_acme.status, StatusCode::CREATED, "{}", in_acme.text);
    assert_eq!(in_zeta.status, StatusCode::CREATED, "{}", in_zeta.text);
    assert_eq!(model_count(&pool).await, 2);
}

#[sqlx::test(migrator = "openplan_server::db::MIGRATOR")]
async fn patch_updates_fields_and_timestamp(pool: PgPool) {
    let mut admin = TestApp::new(pool.clone());
    let workspace_id = setup_admin(&mut admin).await;
    let created = try_create_model(&mut admin, &workspace_id, "Plan").await;
    let path = model_path(created.json["id"].as_str().unwrap());

    let patched = admin
        .patch(
            &path,
            Some(json!({
                "name": " Plan FY27 ",
                "description": "Revenue and cost",
                "mode": "prod",
            })),
        )
        .await;

    assert_eq!(patched.status, StatusCode::OK, "{}", patched.text);
    assert_no_store(&patched);
    assert_eq!(patched.json["name"], "Plan FY27");
    assert_eq!(patched.json["description"], "Revenue and cost");
    assert_eq!(patched.json["mode"], "prod");
    assert_eq!(patched.json["created_at"], created.json["created_at"]);
    assert!(updated_at(&patched) > updated_at(&created));

    let partial = admin.patch(&path, Some(json!({ "mode": "dev" }))).await;
    assert_eq!(partial.status, StatusCode::OK, "{}", partial.text);
    assert_eq!(partial.json["name"], "Plan FY27");
    assert_eq!(partial.json["mode"], "dev");
}

#[sqlx::test(migrator = "openplan_server::db::MIGRATOR")]
async fn invalid_name_422(pool: PgPool) {
    let mut admin = TestApp::new(pool.clone());
    let workspace_id = setup_admin(&mut admin).await;
    let model_id = create_model(&mut admin, &workspace_id, "Plan").await;

    for name in ["   ".to_string(), "a".repeat(81)] {
        let created = try_create_model(&mut admin, &workspace_id, &name).await;
        assert_problem(&created, StatusCode::UNPROCESSABLE_ENTITY, "validation");
        assert_eq!(created.json["errors"][0]["field"], "name");

        let renamed = admin
            .patch(&model_path(&model_id), Some(json!({ "name": name })))
            .await;
        assert_problem(&renamed, StatusCode::UNPROCESSABLE_ENTITY, "validation");
        assert_eq!(renamed.json["errors"][0]["field"], "name");
    }
    assert_eq!(stored_name(&pool, &model_id).await, "Plan");
    assert_eq!(model_count(&pool).await, 1);
}

#[sqlx::test(migrator = "openplan_server::db::MIGRATOR")]
async fn description_too_long_422(pool: PgPool) {
    let mut admin = TestApp::new(pool.clone());
    let workspace_id = setup_admin(&mut admin).await;
    let model_id = create_model(&mut admin, &workspace_id, "Plan").await;
    let too_long = "a".repeat(501);

    let created = admin
        .post(
            &models_path(&workspace_id),
            Some(json!({ "name": "Other", "description": too_long })),
        )
        .await;
    let patched = admin
        .patch(
            &model_path(&model_id),
            Some(json!({ "description": too_long })),
        )
        .await;
    let at_limit = admin
        .post(
            &models_path(&workspace_id),
            Some(json!({ "name": "Edge", "description": "a".repeat(500) })),
        )
        .await;

    assert_problem(&created, StatusCode::UNPROCESSABLE_ENTITY, "validation");
    assert_eq!(created.json["errors"][0]["field"], "description");
    assert_problem(&patched, StatusCode::UNPROCESSABLE_ENTITY, "validation");
    assert_eq!(patched.json["errors"][0]["field"], "description");
    assert_eq!(at_limit.status, StatusCode::CREATED, "{}", at_limit.text);
    assert_eq!(model_count(&pool).await, 2);
}

#[sqlx::test(migrator = "openplan_server::db::MIGRATOR")]
async fn delete_model(pool: PgPool) {
    let mut admin = TestApp::new(pool.clone());
    let workspace_id = setup_admin(&mut admin).await;
    let model_id = create_model(&mut admin, &workspace_id, "Plan").await;
    let path = model_path(&model_id);

    let deleted = admin.delete(&path).await;

    assert_eq!(deleted.status, StatusCode::NO_CONTENT, "{}", deleted.text);
    assert_no_store(&deleted);
    assert_problem(&admin.get(&path).await, StatusCode::NOT_FOUND, "not_found");
    assert_problem(
        &admin.delete(&path).await,
        StatusCode::NOT_FOUND,
        "not_found",
    );
    assert_eq!(model_count(&pool).await, 0);
}

#[sqlx::test(migrator = "openplan_server::db::MIGRATOR")]
async fn only_builders_change_or_delete_models(pool: PgPool) {
    let mut admin = TestApp::new(pool.clone());
    let workspace_id = setup_admin(&mut admin).await;
    let model_id = create_model(&mut admin, &workspace_id, "Plan").await;
    let path = model_path(&model_id);
    create_member(&mut admin, &workspace_id, "pat@acme.com", "Pat", "planner").await;
    create_member(&mut admin, &workspace_id, "vi@acme.com", "Vi", "viewer").await;
    let mut pat = sign_in(&pool, "pat@acme.com").await;
    let mut vi = sign_in(&pool, "vi@acme.com").await;

    for app in [&mut pat, &mut vi] {
        let patched = app.patch(&path, Some(json!({ "name": "Nope" }))).await;
        let deleted = app.delete(&path).await;

        assert_problem(&patched, StatusCode::FORBIDDEN, "auth.forbidden");
        assert_problem(&deleted, StatusCode::FORBIDDEN, "auth.forbidden");
    }
    assert_eq!(stored_name(&pool, &model_id).await, "Plan");
    assert_eq!(model_count(&pool).await, 1);
}

#[sqlx::test(migrator = "openplan_server::db::MIGRATOR")]
async fn unknown_or_malformed_model_id_is_404(pool: PgPool) {
    let mut admin = TestApp::new(pool);
    setup_admin(&mut admin).await;
    let unknown = model_path(&Uuid::now_v7().to_string());

    let responses = [
        admin.get(&unknown).await,
        admin.get("/api/v1/models/not-a-uuid").await,
        admin.patch(&unknown, Some(json!({ "name": "X" }))).await,
        admin.delete(&unknown).await,
        admin
            .post(
                &models_path(&Uuid::now_v7().to_string()),
                Some(json!({ "name": "X" })),
            )
            .await,
    ];

    for response in &responses {
        assert_problem(response, StatusCode::NOT_FOUND, "not_found");
    }
}

#[sqlx::test(migrator = "openplan_server::db::MIGRATOR")]
async fn rename_to_an_existing_name_409(pool: PgPool) {
    let mut admin = TestApp::new(pool.clone());
    let workspace_id = setup_admin(&mut admin).await;
    let plan = create_model(&mut admin, &workspace_id, "Plan").await;
    let other = create_model(&mut admin, &workspace_id, "Other").await;

    let renamed = admin
        .patch(&model_path(&other), Some(json!({ "name": " pLAN " })))
        .await;
    let recased = admin
        .patch(&model_path(&plan), Some(json!({ "name": "plan" })))
        .await;

    assert_problem(&renamed, StatusCode::CONFLICT, "model.name_taken");
    assert_eq!(renamed.json["detail"], NAME_TAKEN_DETAIL);
    assert_eq!(stored_name(&pool, &other).await, "Other");
    assert_eq!(recased.status, StatusCode::OK, "{}", recased.text);
    assert_eq!(recased.json["name"], "plan");
}

#[sqlx::test(migrator = "openplan_server::db::MIGRATOR")]
async fn patch_rejects_unknown_mode(pool: PgPool) {
    let mut admin = TestApp::new(pool.clone());
    let workspace_id = setup_admin(&mut admin).await;
    let model_id = create_model(&mut admin, &workspace_id, "Plan").await;

    let patched = admin
        .patch(&model_path(&model_id), Some(json!({ "mode": "staging" })))
        .await;

    assert_problem(&patched, StatusCode::UNPROCESSABLE_ENTITY, "validation");
    assert_eq!(patched.json["errors"][0]["field"], "mode");
    let mode: String = sqlx::query_scalar("SELECT mode FROM models WHERE id = $1")
        .bind(Uuid::parse_str(&model_id).unwrap())
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(mode, "dev");
}

#[sqlx::test(migrator = "openplan_server::db::MIGRATOR")]
async fn models_appear_in_the_openapi_document(pool: PgPool) {
    let mut app = TestApp::new(pool);

    let document = app.get("/api/openapi.json").await;

    let paths = document.json["paths"].as_object().unwrap();
    for path in ["/api/v1/workspaces/{id}/models", "/api/v1/models/{id}"] {
        assert!(paths.contains_key(path), "missing {path}");
    }
    let schemas = &document.json["components"]["schemas"];
    assert_eq!(schemas["ModelMode"]["enum"], json!(["dev", "prod"]));
    assert!(schemas["Calendar"]["properties"]["first_year"].is_object());
}
