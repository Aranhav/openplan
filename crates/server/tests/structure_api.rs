mod common;

use axum::http::{Method, StatusCode, header};
use common::{TestApp, TestResponse};
use serde_json::{Value, json};
use sqlx::PgPool;
use uuid::Uuid;

const ADMIN_EMAIL: &str = "admin@acme.com";
const PASSWORD: &str = "correct horse battery";
const PRODUCTION_LOCKED: &str =
    "This model is in production mode. Structural changes arrive through ALM sync.";

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

/// Creates a user and adds them to `workspace_id` with `role`, as the signed-in `admin`.
async fn create_member(admin: &mut TestApp, workspace_id: &str, email: &str, role: &str) {
    create_user(admin, email, "Member").await;
    let added = admin
        .post(
            &format!("/api/v1/workspaces/{workspace_id}/members"),
            Some(json!({ "email": email, "role": role })),
        )
        .await;
    assert_eq!(added.status, StatusCode::CREATED, "{}", added.text);
}

async fn create_model(admin: &mut TestApp, workspace_id: &str, name: &str) -> String {
    let response = admin
        .post(
            &format!("/api/v1/workspaces/{workspace_id}/models"),
            Some(json!({ "name": name })),
        )
        .await;
    assert_eq!(response.status, StatusCode::CREATED, "{}", response.text);
    response.json["id"].as_str().unwrap().to_string()
}

/// Signs the admin up to a workspace called Acme, and gives a new model a calendar of the
/// three years from January 2026, so that the period labels in these tests mean the same
/// whatever the date they run on.
async fn plan(pool: &PgPool) -> (TestApp, String, String) {
    let mut admin = TestApp::new(pool.clone());
    let workspace = setup_admin(&mut admin).await;
    let model = create_model(&mut admin, &workspace, "Plan").await;
    let calendar = admin
        .request(
            Method::PUT,
            &url(&model, "/calendar"),
            Some(json!({ "fiscal_year_start_month": 1, "first_year": 2026, "years": 3 })),
        )
        .await;
    assert_eq!(calendar.status, StatusCode::OK, "{}", calendar.text);
    (admin, workspace, model)
}

fn url(model: &str, rest: &str) -> String {
    format!("/api/v1/models/{model}{rest}")
}

fn id_of(json: &Value) -> String {
    json["id"].as_str().unwrap().to_string()
}

async fn structure(app: &mut TestApp, model: &str) -> Value {
    let response = app.get(&url(model, "/structure")).await;
    assert_eq!(response.status, StatusCode::OK, "{}", response.text);
    response.json
}

async fn create_list(app: &mut TestApp, model: &str, body: Value) -> String {
    let response = app.post(&url(model, "/lists"), Some(body)).await;
    assert_eq!(response.status, StatusCode::CREATED, "{}", response.text);
    id_of(&response.json)
}

async fn create_items(app: &mut TestApp, model: &str, list: &str, items: Value) -> Vec<Value> {
    let response = app
        .post(
            &url(model, &format!("/lists/{list}/items")),
            Some(json!({ "items": items })),
        )
        .await;
    assert_eq!(response.status, StatusCode::CREATED, "{}", response.text);
    response.json.as_array().unwrap().clone()
}

async fn put(app: &mut TestApp, path: &str, body: Value) -> TestResponse {
    app.request(Method::PUT, path, Some(body)).await
}

/// The structure rows of a model in the change log: one for every structural change applied.
async fn structure_rows(pool: &PgPool, model: &str) -> i64 {
    sqlx::query_scalar("SELECT count(*) FROM change_log WHERE model_id = $1 AND kind = 'structure'")
        .bind(Uuid::parse_str(model).unwrap())
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
    assert_eq!(response.json["code"], code, "{}", response.text);
}

#[sqlx::test(migrator = "openplan_server::db::MIGRATOR")]
async fn structure_reads_show_the_default_versions_and_the_calendar(pool: PgPool) {
    let (mut admin, _, model) = plan(&pool).await;

    let doc = structure(&mut admin, &model).await;

    assert_eq!(doc["format_version"], 1);
    assert_eq!(doc["calendar"]["first_year"], 2026);
    assert_eq!(doc["calendar"]["years"], 3);
    let names: Vec<&str> = doc["versions"]
        .as_array()
        .unwrap()
        .iter()
        .map(|version| version["name"].as_str().unwrap())
        .collect();
    assert_eq!(names, ["Actual", "Budget", "Forecast"]);
    assert!(doc["lists"].as_array().unwrap().is_empty());
}

#[sqlx::test(migrator = "openplan_server::db::MIGRATOR")]
async fn lists_are_created_renamed_and_deleted(pool: PgPool) {
    let (mut admin, _, model) = plan(&pool).await;
    let calendar_rows = structure_rows(&pool, &model).await;

    let created = admin
        .post(
            &url(&model, "/lists"),
            Some(json!({ "name": "Regions", "top_level_name": "All Regions" })),
        )
        .await;
    assert_eq!(created.status, StatusCode::CREATED, "{}", created.text);
    let regions = id_of(&created.json);
    assert_eq!(
        created.json,
        json!({
            "id": regions,
            "name": "Regions",
            "parent_list_id": null,
            "top_level_name": "All Regions",
            "numbered": false,
            "production_data": false,
            "selective_access": false,
        })
    );

    let renamed = admin
        .patch(
            &url(&model, &format!("/lists/{regions}")),
            Some(json!({ "name": "Territories", "top_level_name": null })),
        )
        .await;
    assert_eq!(renamed.status, StatusCode::OK, "{}", renamed.text);
    assert_eq!(renamed.json["name"], "Territories");
    assert_eq!(renamed.json["top_level_name"], Value::Null);
    let lists = structure(&mut admin, &model).await["lists"].clone();
    assert_eq!(lists[0]["name"], "Territories");
    assert_eq!(lists[0]["top_level_name"], Value::Null);

    let deleted = admin
        .delete(&url(&model, &format!("/lists/{regions}")))
        .await;
    assert_eq!(deleted.status, StatusCode::NO_CONTENT, "{}", deleted.text);
    assert!(
        structure(&mut admin, &model).await["lists"]
            .as_array()
            .unwrap()
            .is_empty()
    );
    assert_eq!(structure_rows(&pool, &model).await, calendar_rows + 3);
}

#[sqlx::test(migrator = "openplan_server::db::MIGRATOR")]
async fn duplicate_and_reserved_list_names_are_rejected(pool: PgPool) {
    let (mut admin, _, model) = plan(&pool).await;
    create_list(&mut admin, &model, json!({ "name": "Regions" })).await;

    let duplicate = admin
        .post(&url(&model, "/lists"), Some(json!({ "name": "regions" })))
        .await;
    assert_problem(&duplicate, StatusCode::CONFLICT, "structure.name_taken");

    let reserved = admin
        .post(&url(&model, "/lists"), Some(json!({ "name": "Versions" })))
        .await;
    assert_problem(
        &reserved,
        StatusCode::UNPROCESSABLE_ENTITY,
        "structure.invalid",
    );

    let blank = admin
        .post(&url(&model, "/lists"), Some(json!({ "name": "   " })))
        .await;
    assert_problem(&blank, StatusCode::UNPROCESSABLE_ENTITY, "validation");
    assert_eq!(blank.json["errors"][0]["field"], "name");
}

#[sqlx::test(migrator = "openplan_server::db::MIGRATOR")]
async fn delete_list_in_use_409(pool: PgPool) {
    let (mut admin, _, model) = plan(&pool).await;
    let regions = create_list(&mut admin, &model, json!({ "name": "Regions" })).await;
    create_list(
        &mut admin,
        &model,
        json!({ "name": "Countries", "parent_list_id": regions }),
    )
    .await;

    let response = admin
        .delete(&url(&model, &format!("/lists/{regions}")))
        .await;

    assert_problem(&response, StatusCode::CONFLICT, "structure.in_use");
    assert!(
        response.json["detail"]
            .as_str()
            .unwrap()
            .contains("'Countries'"),
        "{}",
        response.text
    );
}

#[sqlx::test(migrator = "openplan_server::db::MIGRATOR")]
async fn items_are_added_in_bulk_renamed_and_deleted(pool: PgPool) {
    let (mut admin, _, model) = plan(&pool).await;
    let regions = create_list(&mut admin, &model, json!({ "name": "Regions" })).await;
    let other = create_list(&mut admin, &model, json!({ "name": "Products" })).await;

    let created = create_items(
        &mut admin,
        &model,
        &regions,
        json!([{ "name": "Europe" }, { "code": "NA", "name": "North America" }]),
    )
    .await;
    assert_eq!(created.len(), 2);
    let (europe, north_america) = (id_of(&created[0]), id_of(&created[1]));
    assert_eq!(
        created[1],
        json!({
            "id": north_america,
            "code": "NA",
            "name": "North America",
            "parent_id": null,
        })
    );

    let listed = admin
        .get(&url(&model, &format!("/lists/{regions}/items")))
        .await;
    assert_eq!(listed.status, StatusCode::OK, "{}", listed.text);
    assert_eq!(listed.json.as_array().unwrap().len(), 2);
    assert_eq!(listed.json[0]["name"], "Europe");

    let renamed = admin
        .patch(
            &url(&model, &format!("/lists/{regions}/items/{europe}")),
            Some(json!({ "name": "EMEA", "code": "EU" })),
        )
        .await;
    assert_eq!(renamed.status, StatusCode::OK, "{}", renamed.text);
    assert_eq!(
        renamed.json,
        json!({ "id": europe, "code": "EU", "name": "EMEA", "parent_id": null })
    );

    let uncoded = admin
        .patch(
            &url(&model, &format!("/lists/{regions}/items/{europe}")),
            Some(json!({ "code": null })),
        )
        .await;
    assert_eq!(uncoded.status, StatusCode::OK, "{}", uncoded.text);
    assert_eq!(uncoded.json["code"], Value::Null);
    assert_eq!(uncoded.json["name"], "EMEA");

    let foreign = admin
        .patch(
            &url(&model, &format!("/lists/{other}/items/{europe}")),
            Some(json!({ "name": "Nope" })),
        )
        .await;
    assert_problem(&foreign, StatusCode::NOT_FOUND, "not_found");

    let deleted = admin
        .post(
            &url(&model, &format!("/lists/{regions}/items/delete")),
            Some(json!({ "ids": [north_america] })),
        )
        .await;
    assert_eq!(deleted.status, StatusCode::NO_CONTENT, "{}", deleted.text);
    let left = admin
        .get(&url(&model, &format!("/lists/{regions}/items")))
        .await;
    assert_eq!(
        left.json,
        json!([{ "id": europe, "code": null, "name": "EMEA", "parent_id": null }])
    );

    let gone = admin
        .patch(
            &url(&model, &format!("/lists/{regions}/items/{north_america}")),
            Some(json!({ "name": "Gone" })),
        )
        .await;
    assert_problem(&gone, StatusCode::NOT_FOUND, "not_found");
}

#[sqlx::test(migrator = "openplan_server::db::MIGRATOR")]
async fn bulk_items_with_parents(pool: PgPool) {
    let (mut admin, _, model) = plan(&pool).await;
    let regions = create_list(&mut admin, &model, json!({ "name": "Regions" })).await;
    let region_items = create_items(
        &mut admin,
        &model,
        &regions,
        json!([{ "name": "Europe" }, { "name": "North America" }]),
    )
    .await;
    let (europe, north_america) = (id_of(&region_items[0]), id_of(&region_items[1]));
    let countries = create_list(
        &mut admin,
        &model,
        json!({ "name": "Countries", "parent_list_id": regions }),
    )
    .await;

    let children = create_items(
        &mut admin,
        &model,
        &countries,
        json!([
            { "name": "France", "parent_id": europe },
            { "name": "Canada", "parent_id": north_america },
        ]),
    )
    .await;
    assert_eq!(children[0]["parent_id"], europe);
    assert_eq!(children[1]["parent_id"], north_america);
    let france = id_of(&children[0]);

    let orphan = admin
        .post(
            &url(&model, &format!("/lists/{countries}/items")),
            Some(json!({ "items": [{ "name": "Peru" }] })),
        )
        .await;
    assert_problem(
        &orphan,
        StatusCode::UNPROCESSABLE_ENTITY,
        "structure.invalid",
    );

    let stranger = admin
        .post(
            &url(&model, &format!("/lists/{countries}/items")),
            Some(json!({ "items": [{ "name": "Peru", "parent_id": Uuid::now_v7() }] })),
        )
        .await;
    assert_problem(
        &stranger,
        StatusCode::UNPROCESSABLE_ENTITY,
        "structure.invalid",
    );

    let moved = admin
        .patch(
            &url(&model, &format!("/lists/{countries}/items/{france}")),
            Some(json!({ "parent_id": north_america })),
        )
        .await;
    assert_eq!(moved.status, StatusCode::OK, "{}", moved.text);
    assert_eq!(moved.json["parent_id"], north_america);
    assert_eq!(moved.json["name"], "France");
}

#[sqlx::test(migrator = "openplan_server::db::MIGRATOR")]
async fn subsets_are_created_updated_and_deleted(pool: PgPool) {
    let (mut admin, _, model) = plan(&pool).await;
    let regions = create_list(&mut admin, &model, json!({ "name": "Regions" })).await;
    let items = create_items(
        &mut admin,
        &model,
        &regions,
        json!([{ "name": "Europe" }, { "name": "Asia" }]),
    )
    .await;
    let (europe, asia) = (id_of(&items[0]), id_of(&items[1]));

    let created = admin
        .post(
            &url(&model, "/subsets"),
            Some(json!({ "list_id": regions, "name": "Core", "item_ids": [europe] })),
        )
        .await;
    assert_eq!(created.status, StatusCode::CREATED, "{}", created.text);
    let core = id_of(&created.json);
    assert_eq!(
        created.json,
        json!({ "id": core, "list_id": regions, "name": "Core", "item_ids": [europe] })
    );

    let duplicate = admin
        .post(
            &url(&model, "/subsets"),
            Some(json!({ "list_id": regions, "name": "core", "item_ids": [] })),
        )
        .await;
    assert_problem(&duplicate, StatusCode::CONFLICT, "structure.name_taken");

    let updated = admin
        .patch(
            &url(&model, &format!("/subsets/{core}")),
            Some(json!({ "name": "Everyone", "item_ids": [europe, asia] })),
        )
        .await;
    assert_eq!(updated.status, StatusCode::OK, "{}", updated.text);
    assert_eq!(updated.json["name"], "Everyone");
    assert_eq!(updated.json["item_ids"], json!([europe, asia]));

    let deleted = admin
        .delete(&url(&model, &format!("/subsets/{core}")))
        .await;
    assert_eq!(deleted.status, StatusCode::NO_CONTENT, "{}", deleted.text);
    assert!(
        structure(&mut admin, &model).await["subsets"]
            .as_array()
            .unwrap()
            .is_empty()
    );
}

#[sqlx::test(migrator = "openplan_server::db::MIGRATOR")]
async fn versions_are_created_upserted_and_deleted_with_switchover_months(pool: PgPool) {
    let (mut admin, _, model) = plan(&pool).await;

    let created = admin
        .post(
            &url(&model, "/versions"),
            Some(json!({
                "name": "Plan A",
                "is_actual": false,
                "is_current": false,
                "switchover": "Mar 27",
            })),
        )
        .await;
    assert_eq!(created.status, StatusCode::CREATED, "{}", created.text);
    let plan_a = id_of(&created.json);
    assert_eq!(created.json["switchover"], "Mar 27");
    let doc = structure(&mut admin, &model).await;
    let stored = doc["versions"]
        .as_array()
        .unwrap()
        .iter()
        .find(|version| version["name"] == "Plan A")
        .unwrap();
    assert_eq!(
        stored["switchover"], 14,
        "Mar 27 is the fifteenth month of the calendar"
    );

    let cleared = put(
        &mut admin,
        &url(&model, &format!("/versions/{plan_a}")),
        json!({ "name": "Plan A", "is_actual": false, "is_current": false, "switchover": null }),
    )
    .await;
    assert_eq!(cleared.status, StatusCode::OK, "{}", cleared.text);
    assert_eq!(cleared.json["switchover"], Value::Null);

    let upserted = Uuid::now_v7().to_string();
    let inserted = put(
        &mut admin,
        &url(&model, &format!("/versions/{upserted}")),
        json!({ "name": "Plan B", "is_actual": false, "is_current": false }),
    )
    .await;
    assert_eq!(inserted.status, StatusCode::OK, "{}", inserted.text);
    assert_eq!(inserted.json["id"], upserted);

    let bad_label = admin
        .post(
            &url(&model, "/versions"),
            Some(json!({ "name": "Plan C", "is_actual": false, "is_current": false, "switchover": "Q1 FY26" })),
        )
        .await;
    assert_problem(&bad_label, StatusCode::UNPROCESSABLE_ENTITY, "validation");
    assert_eq!(bad_label.json["errors"][0]["field"], "switchover");

    let outside = admin
        .post(
            &url(&model, "/versions"),
            Some(json!({ "name": "Plan C", "is_actual": false, "is_current": false, "switchover": "Jan 29" })),
        )
        .await;
    assert_problem(&outside, StatusCode::UNPROCESSABLE_ENTITY, "validation");
    assert_eq!(outside.json["errors"][0]["field"], "switchover");

    let taken = admin
        .post(
            &url(&model, "/versions"),
            Some(json!({ "name": "budget", "is_actual": false, "is_current": false })),
        )
        .await;
    assert_problem(&taken, StatusCode::CONFLICT, "structure.name_taken");

    let deleted = admin
        .delete(&url(&model, &format!("/versions/{plan_a}")))
        .await;
    assert_eq!(deleted.status, StatusCode::NO_CONTENT, "{}", deleted.text);
}

#[sqlx::test(migrator = "openplan_server::db::MIGRATOR")]
async fn the_actual_version_cannot_be_deleted(pool: PgPool) {
    let (mut admin, _, model) = plan(&pool).await;
    let doc = structure(&mut admin, &model).await;
    let actual = doc["versions"][0]["id"].as_str().unwrap().to_string();

    let response = admin
        .delete(&url(&model, &format!("/versions/{actual}")))
        .await;

    assert_problem(
        &response,
        StatusCode::UNPROCESSABLE_ENTITY,
        "structure.invalid",
    );
}

#[sqlx::test(migrator = "openplan_server::db::MIGRATOR")]
async fn calendar_is_updated_and_stored(pool: PgPool) {
    let (mut admin, _, model) = plan(&pool).await;

    let updated = put(
        &mut admin,
        &url(&model, "/calendar"),
        json!({
            "fiscal_year_start_month": 4,
            "first_year": 2027,
            "years": 2,
            "current_period": "Jun 26",
        }),
    )
    .await;

    assert_eq!(updated.status, StatusCode::OK, "{}", updated.text);
    assert_eq!(
        updated.json,
        json!({ "fiscal_year_start_month": 4, "first_year": 2027, "years": 2 })
    );
    let doc = structure(&mut admin, &model).await;
    assert_eq!(doc["calendar"]["first_year"], 2027);
    assert_eq!(
        doc["calendar"]["current_month"], 2,
        "FY27 starts in April 2026, so June 2026 is its third month"
    );
    let stored: Value = sqlx::query_scalar("SELECT calendar FROM models WHERE id = $1")
        .bind(Uuid::parse_str(&model).unwrap())
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(
        stored,
        json!({ "fiscal_year_start_month": 4, "first_year": 2027, "years": 2 })
    );
}

#[sqlx::test(migrator = "openplan_server::db::MIGRATOR")]
async fn calendar_rejects_a_current_period_that_is_not_a_month_and_an_invalid_calendar(
    pool: PgPool,
) {
    let (mut admin, _, model) = plan(&pool).await;

    let not_a_month = put(
        &mut admin,
        &url(&model, "/calendar"),
        json!({ "fiscal_year_start_month": 1, "first_year": 2026, "years": 3, "current_period": "FY27" }),
    )
    .await;
    assert_problem(&not_a_month, StatusCode::UNPROCESSABLE_ENTITY, "validation");
    assert_eq!(not_a_month.json["errors"][0]["field"], "current_period");

    let invalid = put(
        &mut admin,
        &url(&model, "/calendar"),
        json!({ "fiscal_year_start_month": 13, "first_year": 2026, "years": 3 }),
    )
    .await;
    assert_problem(
        &invalid,
        StatusCode::UNPROCESSABLE_ENTITY,
        "structure.invalid",
    );
}

#[sqlx::test(migrator = "openplan_server::db::MIGRATOR")]
async fn time_ranges_are_created_and_deleted(pool: PgPool) {
    let (mut admin, _, model) = plan(&pool).await;

    let created = admin
        .post(
            &url(&model, "/time-ranges"),
            Some(json!({ "name": "Next two years", "first_year": 2027, "years": 2 })),
        )
        .await;
    assert_eq!(created.status, StatusCode::CREATED, "{}", created.text);
    let range = id_of(&created.json);
    assert_eq!(
        created.json,
        json!({ "id": range, "name": "Next two years", "first_year": 2027, "years": 2 })
    );
    assert_eq!(
        structure(&mut admin, &model).await["time_ranges"]
            .as_array()
            .unwrap()
            .len(),
        1
    );

    let invalid = admin
        .post(
            &url(&model, "/time-ranges"),
            Some(json!({ "name": "Nothing", "first_year": 2027, "years": 0 })),
        )
        .await;
    assert_problem(
        &invalid,
        StatusCode::UNPROCESSABLE_ENTITY,
        "structure.invalid",
    );

    let deleted = admin
        .delete(&url(&model, &format!("/time-ranges/{range}")))
        .await;
    assert_eq!(deleted.status, StatusCode::NO_CONTENT, "{}", deleted.text);
    assert!(
        structure(&mut admin, &model).await["time_ranges"]
            .as_array()
            .unwrap()
            .is_empty()
    );
}

#[sqlx::test(migrator = "openplan_server::db::MIGRATOR")]
async fn viewer_cannot_write_structure(pool: PgPool) {
    let (mut admin, workspace, model) = plan(&pool).await;
    create_member(&mut admin, &workspace, "viewer@acme.com", "viewer").await;
    let mut viewer = sign_in(&pool, "viewer@acme.com").await;
    let (list, item, subset, version, range) = (
        Uuid::now_v7(),
        Uuid::now_v7(),
        Uuid::now_v7(),
        Uuid::now_v7(),
        Uuid::now_v7(),
    );
    let writes: Vec<(Method, String, Option<Value>)> = vec![
        (
            Method::POST,
            url(&model, "/lists"),
            Some(json!({ "name": "X" })),
        ),
        (
            Method::PATCH,
            url(&model, &format!("/lists/{list}")),
            Some(json!({ "name": "X" })),
        ),
        (Method::DELETE, url(&model, &format!("/lists/{list}")), None),
        (
            Method::POST,
            url(&model, &format!("/lists/{list}/items")),
            Some(json!({ "items": [{ "name": "X" }] })),
        ),
        (
            Method::PATCH,
            url(&model, &format!("/lists/{list}/items/{item}")),
            Some(json!({ "name": "X" })),
        ),
        (
            Method::POST,
            url(&model, &format!("/lists/{list}/items/delete")),
            Some(json!({ "ids": [item] })),
        ),
        (
            Method::POST,
            url(&model, "/subsets"),
            Some(json!({ "list_id": list, "name": "X", "item_ids": [] })),
        ),
        (
            Method::PATCH,
            url(&model, &format!("/subsets/{subset}")),
            Some(json!({ "name": "X" })),
        ),
        (
            Method::DELETE,
            url(&model, &format!("/subsets/{subset}")),
            None,
        ),
        (
            Method::POST,
            url(&model, "/versions"),
            Some(json!({ "name": "X", "is_actual": false, "is_current": false })),
        ),
        (
            Method::PUT,
            url(&model, &format!("/versions/{version}")),
            Some(json!({ "name": "X", "is_actual": false, "is_current": false })),
        ),
        (
            Method::DELETE,
            url(&model, &format!("/versions/{version}")),
            None,
        ),
        (
            Method::PUT,
            url(&model, "/calendar"),
            Some(json!({ "fiscal_year_start_month": 1, "first_year": 2026, "years": 3 })),
        ),
        (
            Method::POST,
            url(&model, "/time-ranges"),
            Some(json!({ "name": "X", "first_year": 2027, "years": 1 })),
        ),
        (
            Method::DELETE,
            url(&model, &format!("/time-ranges/{range}")),
            None,
        ),
    ];

    for (method, path, body) in writes {
        let response = viewer.request(method.clone(), &path, body).await;

        assert_problem(&response, StatusCode::FORBIDDEN, "auth.forbidden");
        assert_eq!(
            response.json["detail"], "You do not have permission to do that.",
            "{method} {path}"
        );
    }
    let reads = viewer.get(&url(&model, "/structure")).await;
    assert_eq!(reads.status, StatusCode::OK, "{}", reads.text);
}

#[sqlx::test(migrator = "openplan_server::db::MIGRATOR")]
async fn production_mode_blocks_structure(pool: PgPool) {
    let (mut admin, _, model) = plan(&pool).await;
    let regions = create_list(&mut admin, &model, json!({ "name": "Regions" })).await;
    let production = admin
        .patch(&url(&model, ""), Some(json!({ "mode": "prod" })))
        .await;
    assert_eq!(production.status, StatusCode::OK, "{}", production.text);

    let locked = [
        admin
            .post(&url(&model, "/lists"), Some(json!({ "name": "Countries" })))
            .await,
        admin
            .delete(&url(&model, &format!("/lists/{regions}")))
            .await,
        put(
            &mut admin,
            &url(&model, "/calendar"),
            json!({ "fiscal_year_start_month": 1, "first_year": 2026, "years": 3 }),
        )
        .await,
        admin
            .post(
                &url(&model, "/time-ranges"),
                Some(json!({ "name": "X", "first_year": 2027, "years": 1 })),
            )
            .await,
    ];
    for response in &locked {
        assert_problem(response, StatusCode::CONFLICT, "model.production_locked");
        assert_eq!(response.json["detail"], PRODUCTION_LOCKED);
    }
    assert_eq!(
        structure(&mut admin, &model).await["lists"][0]["name"],
        "Regions"
    );

    let development = admin
        .patch(&url(&model, ""), Some(json!({ "mode": "dev" })))
        .await;
    assert_eq!(development.status, StatusCode::OK, "{}", development.text);
    let unlocked = admin
        .post(&url(&model, "/lists"), Some(json!({ "name": "Countries" })))
        .await;
    assert_eq!(unlocked.status, StatusCode::CREATED, "{}", unlocked.text);
}

#[sqlx::test(migrator = "openplan_server::db::MIGRATOR")]
async fn non_members_get_not_found(pool: PgPool) {
    let (mut admin, _, model) = plan(&pool).await;
    create_user(&mut admin, "outsider@acme.com", "Outsider").await;
    let mut outsider = sign_in(&pool, "outsider@acme.com").await;

    let read = outsider.get(&url(&model, "/structure")).await;
    assert_problem(&read, StatusCode::NOT_FOUND, "not_found");
    let write = outsider
        .post(&url(&model, "/lists"), Some(json!({ "name": "X" })))
        .await;
    assert_problem(&write, StatusCode::NOT_FOUND, "not_found");

    let unknown = admin
        .get(&url(&Uuid::now_v7().to_string(), "/structure"))
        .await;
    assert_problem(&unknown, StatusCode::NOT_FOUND, "not_found");
}

#[sqlx::test(migrator = "openplan_server::db::MIGRATOR")]
async fn structure_survives_unloading_the_model(pool: PgPool) {
    let (mut admin, _, model) = plan(&pool).await;
    let regions = create_list(&mut admin, &model, json!({ "name": "Regions" })).await;
    create_items(&mut admin, &model, &regions, json!([{ "name": "Europe" }])).await;

    admin.state.models.shutdown().await;

    let listed = admin
        .get(&url(&model, &format!("/lists/{regions}/items")))
        .await;
    assert_eq!(listed.status, StatusCode::OK, "{}", listed.text);
    assert_eq!(listed.json[0]["name"], "Europe");
    assert_eq!(
        structure(&mut admin, &model).await["lists"][0]["name"],
        "Regions"
    );
}
