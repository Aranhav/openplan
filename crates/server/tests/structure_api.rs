mod common;

use axum::http::{Method, StatusCode};
use common::{
    TestApp, TestResponse, assert_problem, create_items, create_list, create_member, create_user,
    id_of, plan, sign_in, url,
};
use serde_json::{Value, json};
use sqlx::PgPool;
use uuid::Uuid;

const PRODUCTION_LOCKED: &str =
    "This model is in production mode. Structural changes arrive through ALM sync.";

async fn structure(app: &mut TestApp, model: &str) -> Value {
    let response = app.get(&url(model, "/structure")).await;
    assert_eq!(response.status, StatusCode::OK, "{}", response.text);
    response.json
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
    assert_eq!(stranger.json["errors"][0]["field"], "items[0].parent_id");

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
        json!({
            "fiscal_year_start_month": 4,
            "first_year": 2027,
            "years": 2,
            "current_period": "Jun 26",
        })
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
    assert_problem(&invalid, StatusCode::UNPROCESSABLE_ENTITY, "validation");
    assert_eq!(
        invalid.json["errors"][0]["field"],
        "fiscal_year_start_month"
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
    assert_problem(&invalid, StatusCode::UNPROCESSABLE_ENTITY, "validation");
    assert_eq!(invalid.json["errors"][0]["field"], "years");

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
    create_member(
        &mut admin,
        &workspace,
        "viewer@acme.com",
        "Vera Viewer",
        "viewer",
    )
    .await;
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
async fn production_mode_blocks_every_structure_write(pool: PgPool) {
    let (mut admin, _, model) = plan(&pool).await;
    let regions = create_list(&mut admin, &model, json!({ "name": "Regions" })).await;
    let items = create_items(&mut admin, &model, &regions, json!([{ "name": "Europe" }])).await;
    let subset = admin
        .post(
            &url(&model, "/subsets"),
            Some(json!({ "list_id": regions, "name": "Core" })),
        )
        .await;
    let subset = id_of(&subset.json);
    let range = admin
        .post(
            &url(&model, "/time-ranges"),
            Some(json!({ "name": "Next", "first_year": 2027, "years": 1 })),
        )
        .await;
    let range = id_of(&range.json);
    let version = admin
        .post(
            &url(&model, "/versions"),
            Some(json!({ "name": "Plan A", "is_actual": false, "is_current": false })),
        )
        .await;
    let version = id_of(&version.json);
    let (list, item) = (regions.clone(), id_of(&items[0]));
    let writes: Vec<(Method, String, Option<Value>)> = vec![
        (
            Method::PUT,
            url(&model, "/calendar"),
            Some(json!({ "fiscal_year_start_month": 1, "first_year": 2026, "years": 3 })),
        ),
        (
            Method::POST,
            url(&model, "/lists"),
            Some(json!({ "name": "Countries" })),
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
            Some(json!({ "items": [{ "name": "Asia" }] })),
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
            Some(json!({ "list_id": list, "name": "Other" })),
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
            Some(json!({ "name": "Plan B", "is_actual": false, "is_current": false })),
        ),
        (
            Method::PUT,
            url(&model, &format!("/versions/{version}")),
            Some(json!({ "name": "Plan A", "is_actual": false, "is_current": false })),
        ),
        (
            Method::DELETE,
            url(&model, &format!("/versions/{version}")),
            None,
        ),
        (
            Method::POST,
            url(&model, "/time-ranges"),
            Some(json!({ "name": "Later", "first_year": 2030, "years": 1 })),
        ),
        (
            Method::DELETE,
            url(&model, &format!("/time-ranges/{range}")),
            None,
        ),
    ];
    assert_eq!(writes.len(), 15, "every write route is in the table");

    let production = admin
        .patch(&url(&model, ""), Some(json!({ "mode": "prod" })))
        .await;
    assert_eq!(production.status, StatusCode::OK, "{}", production.text);
    for (method, path, body) in writes {
        let response = admin.request(method.clone(), &path, body).await;
        assert_problem(&response, StatusCode::CONFLICT, "model.production_locked");
        assert_eq!(
            response.json["detail"], PRODUCTION_LOCKED,
            "{method} {path}"
        );
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

/// The calendar a model stores in its row, as the database holds it.
async fn stored_calendar(pool: &PgPool, model: &str) -> Value {
    sqlx::query_scalar("SELECT calendar FROM models WHERE id = $1")
        .bind(Uuid::parse_str(model).unwrap())
        .fetch_one(pool)
        .await
        .unwrap()
}

#[sqlx::test(migrator = "openplan_server::db::MIGRATOR")]
async fn concurrent_patches_to_one_item_keep_both_changes(pool: PgPool) {
    let (mut admin, _, model) = plan(&pool).await;
    let regions = create_list(&mut admin, &model, json!({ "name": "Regions" })).await;
    let items_path = url(&model, &format!("/lists/{regions}/items"));

    for round in 0..20 {
        let created = create_items(
            &mut admin,
            &model,
            &regions,
            json!([{ "name": format!("Region {round}") }]),
        )
        .await;
        let item = id_of(&created[0]);
        let path = format!("{items_path}/{item}");
        let mut renamer = admin.fork();
        let mut coder = admin.fork();

        let (renamed, coded) = tokio::join!(
            renamer.patch(&path, Some(json!({ "name": format!("Renamed {round}") }))),
            coder.patch(&path, Some(json!({ "code": format!("C{round}") }))),
        );

        assert_eq!(renamed.status, StatusCode::OK, "{}", renamed.text);
        assert_eq!(coded.status, StatusCode::OK, "{}", coded.text);
        let listed = admin.get(&items_path).await;
        let stored = listed
            .json
            .as_array()
            .unwrap()
            .iter()
            .find(|entry| entry["id"].as_str() == Some(item.as_str()))
            .unwrap();
        assert_eq!(
            stored["name"],
            json!(format!("Renamed {round}")),
            "round {round}"
        );
        assert_eq!(stored["code"], json!(format!("C{round}")), "round {round}");
    }
}

#[sqlx::test(migrator = "openplan_server::db::MIGRATOR")]
async fn empty_bulk_requests_are_refused_and_change_nothing(pool: PgPool) {
    let (mut admin, _, model) = plan(&pool).await;
    let regions = create_list(&mut admin, &model, json!({ "name": "Regions" })).await;
    let rows = structure_rows(&pool, &model).await;

    let created = admin
        .post(
            &url(&model, &format!("/lists/{regions}/items")),
            Some(json!({ "items": [] })),
        )
        .await;
    assert_problem(&created, StatusCode::UNPROCESSABLE_ENTITY, "validation");
    assert_eq!(created.json["errors"][0]["field"], "items");
    assert_eq!(
        created.json["errors"][0]["message"],
        "Add at least one item."
    );

    let deleted = admin
        .post(
            &url(&model, &format!("/lists/{regions}/items/delete")),
            Some(json!({ "ids": [] })),
        )
        .await;
    assert_problem(&deleted, StatusCode::UNPROCESSABLE_ENTITY, "validation");
    assert_eq!(deleted.json["errors"][0]["field"], "ids");
    assert_eq!(
        deleted.json["errors"][0]["message"],
        "Select at least one item."
    );

    assert_eq!(structure_rows(&pool, &model).await, rows);
}

#[sqlx::test(migrator = "openplan_server::db::MIGRATOR")]
async fn a_bulk_create_with_one_bad_name_creates_nothing(pool: PgPool) {
    let (mut admin, _, model) = plan(&pool).await;
    let regions = create_list(&mut admin, &model, json!({ "name": "Regions" })).await;
    let rows = structure_rows(&pool, &model).await;

    let created = admin
        .post(
            &url(&model, &format!("/lists/{regions}/items")),
            Some(json!({ "items": [{ "name": "Europe" }, { "name": "   " }] })),
        )
        .await;

    assert_problem(&created, StatusCode::UNPROCESSABLE_ENTITY, "validation");
    assert_eq!(created.json["errors"][0]["field"], "items[1].name");
    assert_eq!(created.json["errors"][0]["message"], "Name is required.");
    let listed = admin
        .get(&url(&model, &format!("/lists/{regions}/items")))
        .await;
    assert_eq!(listed.json, json!([]));
    assert_eq!(structure_rows(&pool, &model).await, rows);
}

#[sqlx::test(migrator = "openplan_server::db::MIGRATOR")]
async fn missing_references_in_a_body_are_refused_by_name(pool: PgPool) {
    let (mut admin, _, model) = plan(&pool).await;
    let regions = create_list(&mut admin, &model, json!({ "name": "Regions" })).await;
    let products = create_list(&mut admin, &model, json!({ "name": "Products" })).await;
    let europe =
        id_of(&create_items(&mut admin, &model, &regions, json!([{ "name": "Europe" }])).await[0]);
    let lamp =
        id_of(&create_items(&mut admin, &model, &products, json!([{ "name": "Lamp" }])).await[0]);
    let missing = Uuid::now_v7().to_string();
    let rows = structure_rows(&pool, &model).await;

    let parent_list = admin
        .post(
            &url(&model, "/lists"),
            Some(json!({ "name": "Countries", "parent_list_id": missing })),
        )
        .await;
    assert_problem(
        &parent_list,
        StatusCode::UNPROCESSABLE_ENTITY,
        "structure.invalid",
    );
    assert_eq!(parent_list.json["errors"][0]["field"], "parent_list_id");

    let subset_list = admin
        .post(
            &url(&model, "/subsets"),
            Some(json!({ "list_id": missing, "name": "Core" })),
        )
        .await;
    assert_problem(
        &subset_list,
        StatusCode::UNPROCESSABLE_ENTITY,
        "structure.invalid",
    );
    assert_eq!(subset_list.json["errors"][0]["field"], "list_id");

    let subset_item = admin
        .post(
            &url(&model, "/subsets"),
            Some(json!({ "list_id": regions, "name": "Core", "item_ids": [europe, lamp] })),
        )
        .await;
    assert_problem(
        &subset_item,
        StatusCode::UNPROCESSABLE_ENTITY,
        "structure.invalid",
    );
    assert_eq!(subset_item.json["errors"][0]["field"], "item_ids[1]");

    let deleted = admin
        .post(
            &url(&model, &format!("/lists/{regions}/items/delete")),
            Some(json!({ "ids": [europe, missing] })),
        )
        .await;
    assert_problem(
        &deleted,
        StatusCode::UNPROCESSABLE_ENTITY,
        "structure.invalid",
    );
    assert_eq!(deleted.json["errors"][0]["field"], "ids[1]");
    let listed = admin
        .get(&url(&model, &format!("/lists/{regions}/items")))
        .await;
    assert_eq!(
        listed.json.as_array().unwrap().len(),
        1,
        "nothing was deleted"
    );

    assert_eq!(structure_rows(&pool, &model).await, rows);
}

#[sqlx::test(migrator = "openplan_server::db::MIGRATOR")]
async fn missing_parents_of_items_are_refused_by_name_and_missing_lists_are_not_found(
    pool: PgPool,
) {
    let (mut admin, _, model) = plan(&pool).await;
    let regions = create_list(&mut admin, &model, json!({ "name": "Regions" })).await;
    let europe =
        id_of(&create_items(&mut admin, &model, &regions, json!([{ "name": "Europe" }])).await[0]);
    let countries = create_list(
        &mut admin,
        &model,
        json!({ "name": "Countries", "parent_list_id": regions }),
    )
    .await;
    let france = id_of(
        &create_items(
            &mut admin,
            &model,
            &countries,
            json!([{ "name": "France", "parent_id": europe }]),
        )
        .await[0],
    );
    let missing = Uuid::now_v7().to_string();

    let moved = admin
        .patch(
            &url(&model, &format!("/lists/{countries}/items/{france}")),
            Some(json!({ "parent_id": missing })),
        )
        .await;
    assert_problem(
        &moved,
        StatusCode::UNPROCESSABLE_ENTITY,
        "structure.invalid",
    );
    assert_eq!(moved.json["errors"][0]["field"], "parent_id");

    let bulk = admin
        .post(
            &url(&model, &format!("/lists/{countries}/items")),
            Some(json!({ "items": [{ "name": "Peru", "parent_id": missing }] })),
        )
        .await;
    assert_problem(&bulk, StatusCode::UNPROCESSABLE_ENTITY, "structure.invalid");
    assert_eq!(bulk.json["errors"][0]["field"], "items[0].parent_id");

    let nowhere = admin
        .post(
            &url(&model, &format!("/lists/{missing}/items")),
            Some(json!({ "items": [{ "name": "Peru" }] })),
        )
        .await;
    assert_problem(&nowhere, StatusCode::NOT_FOUND, "not_found");
}

#[sqlx::test(migrator = "openplan_server::db::MIGRATOR")]
async fn calendar_and_time_range_limits_are_refused_by_field(pool: PgPool) {
    let (mut admin, _, model) = plan(&pool).await;
    let calendars = [
        (
            "fiscal_year_start_month",
            json!({ "fiscal_year_start_month": 0, "first_year": 2026, "years": 3 }),
        ),
        (
            "fiscal_year_start_month",
            json!({ "fiscal_year_start_month": 13, "first_year": 2026, "years": 3 }),
        ),
        (
            "years",
            json!({ "fiscal_year_start_month": 1, "first_year": 2026, "years": 0 }),
        ),
        (
            "years",
            json!({ "fiscal_year_start_month": 1, "first_year": 2026, "years": 21 }),
        ),
        (
            "first_year",
            json!({ "fiscal_year_start_month": 1, "first_year": 0, "years": 3 }),
        ),
        (
            "first_year",
            json!({ "fiscal_year_start_month": 1, "first_year": 10000, "years": 3 }),
        ),
    ];
    for (field, body) in calendars {
        let response = put(&mut admin, &url(&model, "/calendar"), body).await;
        assert_problem(&response, StatusCode::UNPROCESSABLE_ENTITY, "validation");
        assert_eq!(
            response.json["errors"][0]["field"], field,
            "{}",
            response.text
        );
    }
    let ranges = [
        (
            "years",
            json!({ "name": "A", "first_year": 2027, "years": 0 }),
        ),
        (
            "years",
            json!({ "name": "A", "first_year": 2027, "years": 21 }),
        ),
        (
            "first_year",
            json!({ "name": "B", "first_year": 0, "years": 1 }),
        ),
        (
            "first_year",
            json!({ "name": "B", "first_year": 10000, "years": 1 }),
        ),
    ];
    for (field, body) in ranges {
        let response = admin.post(&url(&model, "/time-ranges"), Some(body)).await;
        assert_problem(&response, StatusCode::UNPROCESSABLE_ENTITY, "validation");
        assert_eq!(
            response.json["errors"][0]["field"], field,
            "{}",
            response.text
        );
    }
    assert_eq!(
        structure(&mut admin, &model).await["calendar"]["first_year"],
        2026
    );
}

#[sqlx::test(migrator = "openplan_server::db::MIGRATOR")]
async fn calendar_change_keeps_each_switchover_in_its_month(pool: PgPool) {
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

    let moved = put(
        &mut admin,
        &url(&model, "/calendar"),
        json!({ "fiscal_year_start_month": 1, "first_year": 2027, "years": 3 }),
    )
    .await;

    assert_eq!(moved.status, StatusCode::OK, "{}", moved.text);
    let doc = structure(&mut admin, &model).await;
    let plan_a = doc["versions"]
        .as_array()
        .unwrap()
        .iter()
        .find(|version| version["name"] == "Plan A")
        .unwrap();
    assert_eq!(
        plan_a["switchover"], 2,
        "March 2027 is the third month of a calendar from January 2027"
    );
}

#[sqlx::test(migrator = "openplan_server::db::MIGRATOR")]
async fn calendar_change_clears_switchovers_off_the_timeline(pool: PgPool) {
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

    let shorter = put(
        &mut admin,
        &url(&model, "/calendar"),
        json!({ "fiscal_year_start_month": 1, "first_year": 2026, "years": 1 }),
    )
    .await;

    assert_eq!(shorter.status, StatusCode::OK, "{}", shorter.text);
    let doc = structure(&mut admin, &model).await;
    let plan_a = doc["versions"]
        .as_array()
        .unwrap()
        .iter()
        .find(|version| version["name"] == "Plan A")
        .unwrap();
    assert_eq!(plan_a["switchover"], Value::Null);
    assert_eq!(
        stored_calendar(&pool, &model).await,
        json!({ "fiscal_year_start_month": 1, "first_year": 2026, "years": 1 })
    );
}

#[sqlx::test(migrator = "openplan_server::db::MIGRATOR")]
async fn an_invalid_current_period_leaves_the_stored_calendar_unchanged(pool: PgPool) {
    let (mut admin, _, model) = plan(&pool).await;
    let before = stored_calendar(&pool, &model).await;

    let refused = put(
        &mut admin,
        &url(&model, "/calendar"),
        json!({ "fiscal_year_start_month": 1, "first_year": 2026, "years": 1, "current_period": "Jun 27" }),
    )
    .await;

    assert_problem(&refused, StatusCode::UNPROCESSABLE_ENTITY, "validation");
    assert_eq!(refused.json["errors"][0]["field"], "current_period");
    assert_eq!(stored_calendar(&pool, &model).await, before);
    assert_eq!(
        structure(&mut admin, &model).await["calendar"]["current_month"],
        Value::Null
    );
}

#[sqlx::test(migrator = "openplan_server::db::MIGRATOR")]
async fn planners_are_refused_and_builders_may_write(pool: PgPool) {
    let (mut admin, workspace, model) = plan(&pool).await;
    create_member(
        &mut admin,
        &workspace,
        "planner@acme.com",
        "Pia Planner",
        "planner",
    )
    .await;
    let mut planner = sign_in(&pool, "planner@acme.com").await;

    let refused = planner
        .post(&url(&model, "/lists"), Some(json!({ "name": "Regions" })))
        .await;

    assert_problem(&refused, StatusCode::FORBIDDEN, "auth.forbidden");
    create_member(
        &mut admin,
        &workspace,
        "builder@acme.com",
        "Bea Builder",
        "builder",
    )
    .await;
    let mut builder = sign_in(&pool, "builder@acme.com").await;

    let created = builder
        .post(&url(&model, "/lists"), Some(json!({ "name": "Regions" })))
        .await;
    assert_eq!(created.status, StatusCode::CREATED, "{}", created.text);
    let calendar = put(
        &mut builder,
        &url(&model, "/calendar"),
        json!({ "fiscal_year_start_month": 1, "first_year": 2026, "years": 3 }),
    )
    .await;
    assert_eq!(calendar.status, StatusCode::OK, "{}", calendar.text);
}
