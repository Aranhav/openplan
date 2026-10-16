mod common;

use axum::http::StatusCode;
use common::{
    TestApp, assert_problem, create_items, create_line_item, create_list, create_member,
    create_model, create_module, id_of, list_axis, month, plan, sign_in_beside, structure, url,
};
use serde_json::{Value, json};
use sqlx::{PgPool, types::Json};
use std::time::Duration;
use uuid::Uuid;

fn views_path(model: &str, module: &str) -> String {
    url(model, &format!("/modules/{module}/views"))
}

fn view_path(model: &str, view: &str) -> String {
    url(model, &format!("/views/{view}"))
}

/// The smallest definition: the line items on the rows and the time on the columns.
fn definition() -> Value {
    json!({
        "rows": [{ "kind": "line_items" }],
        "columns": [{ "kind": "time" }],
        "pages": [],
    })
}

/// Saves a view called `name` on the module, as `app`, and returns it as created.
async fn save(app: &mut TestApp, model: &str, module: &str, name: &str) -> Value {
    let response = app
        .post(
            &views_path(model, module),
            Some(json!({ "name": name, "definition": definition() })),
        )
        .await;
    assert_eq!(response.status, StatusCode::CREATED, "{}", response.text);
    response.json
}

/// The views of the module, as `app` lists them.
async fn list(app: &mut TestApp, model: &str, module: &str) -> Vec<Value> {
    let response = app.get(&views_path(model, module)).await;
    assert_eq!(response.status, StatusCode::OK, "{}", response.text);
    response.json.as_array().unwrap().clone()
}

/// Asks the grid for a view as it is after the prune, to see that the engine takes it.
async fn grid_accepts(app: &mut TestApp, model: &str, module: &str, definition: &Value) {
    let mut query = definition.clone();
    query["module"] = json!(module);
    query["window"] =
        json!({ "row_offset": 0, "row_limit": 100, "col_offset": 0, "col_limit": 50 });
    let response = app.post(&url(model, "/query"), Some(query)).await;
    assert_eq!(response.status, StatusCode::OK, "{}", response.text);
}

#[sqlx::test(migrator = "openplan_server::db::MIGRATOR")]
async fn crud_happy_path(pool: PgPool) {
    let (mut admin, _, model) = plan(&pool).await;
    let module = create_module(&mut admin, &model, "Revenue", vec![month()]).await;

    let created = admin
        .post(
            &views_path(&model, &module),
            Some(json!({ "name": "  By month  ", "definition": definition() })),
        )
        .await;
    assert_eq!(created.status, StatusCode::CREATED, "{}", created.text);
    let id = id_of(&created.json);
    assert_eq!(created.json["name"], "By month");
    assert_eq!(created.json["module_id"], module);
    assert_eq!(created.json["is_default"], false);
    assert_eq!(
        created.json["definition"]["rows"],
        json!([{ "kind": "line_items" }])
    );
    assert_eq!(created.json["definition"]["show_summaries"], true);
    assert!(created.json["created_by"].is_string());
    assert!(created.json["updated_at"].is_string());

    let listed = list(&mut admin, &model, &module).await;
    assert_eq!(listed.len(), 1);
    assert_eq!(listed[0]["id"], id);
    assert_eq!(listed[0]["pruned"], false);

    let changed = admin
        .patch(
            &view_path(&model, &id),
            Some(json!({
                "name": "Monthly",
                "definition": {
                    "rows": [{ "kind": "time" }],
                    "columns": [{ "kind": "line_items" }],
                },
            })),
        )
        .await;
    assert_eq!(changed.status, StatusCode::OK, "{}", changed.text);
    assert_eq!(changed.json["name"], "Monthly");
    let stamp =
        |value: &Value| chrono::DateTime::parse_from_rfc3339(value.as_str().unwrap()).unwrap();
    assert!(stamp(&changed.json["updated_at"]) > stamp(&created.json["updated_at"]));
    assert_eq!(
        changed.json["definition"]["rows"],
        json!([{ "kind": "time" }])
    );

    let deleted = admin.delete(&view_path(&model, &id)).await;
    assert_eq!(deleted.status, StatusCode::NO_CONTENT, "{}", deleted.text);
    assert!(list(&mut admin, &model, &module).await.is_empty());
}

#[sqlx::test(migrator = "openplan_server::db::MIGRATOR")]
async fn default_view_moves(pool: PgPool) {
    let (mut admin, _, model) = plan(&pool).await;
    let module = create_module(&mut admin, &model, "Revenue", vec![month()]).await;
    let zeta = admin
        .post(
            &views_path(&model, &module),
            Some(json!({ "name": "Zeta", "definition": definition(), "is_default": true })),
        )
        .await;
    assert_eq!(zeta.status, StatusCode::CREATED, "{}", zeta.text);
    let alpha = save(&mut admin, &model, &module, "alpha").await;

    let listed = list(&mut admin, &model, &module).await;
    assert_eq!(listed[0]["name"], "Zeta");
    assert_eq!(listed[0]["is_default"], true);
    assert_eq!(listed[1]["name"], "alpha");
    assert_eq!(listed[1]["is_default"], false);

    let moved = admin
        .patch(
            &view_path(&model, &id_of(&alpha)),
            Some(json!({ "is_default": true })),
        )
        .await;
    assert_eq!(moved.status, StatusCode::OK, "{}", moved.text);

    let listed = list(&mut admin, &model, &module).await;
    assert_eq!(listed[0]["name"], "alpha");
    assert_eq!(listed[0]["is_default"], true);
    assert_eq!(listed[1]["name"], "Zeta");
    assert_eq!(listed[1]["is_default"], false);
}

#[sqlx::test(migrator = "openplan_server::db::MIGRATOR")]
async fn duplicate_name_409(pool: PgPool) {
    let (mut admin, _, model) = plan(&pool).await;
    let module = create_module(&mut admin, &model, "Revenue", vec![month()]).await;
    save(&mut admin, &model, &module, "Base").await;

    let duplicate = admin
        .post(
            &views_path(&model, &module),
            Some(json!({ "name": "base", "definition": definition() })),
        )
        .await;
    assert_problem(&duplicate, StatusCode::CONFLICT, "structure.name_taken");

    let other = save(&mut admin, &model, &module, "Other").await;
    let renamed = admin
        .patch(
            &view_path(&model, &id_of(&other)),
            Some(json!({ "name": "BASE" })),
        )
        .await;
    assert_problem(&renamed, StatusCode::CONFLICT, "structure.name_taken");
}

#[sqlx::test(migrator = "openplan_server::db::MIGRATOR")]
async fn viewer_can_list_not_write_403(pool: PgPool) {
    let (mut admin, workspace, model) = plan(&pool).await;
    let module = create_module(&mut admin, &model, "Revenue", vec![month()]).await;
    let saved = save(&mut admin, &model, &module, "Shared").await;
    let view = id_of(&saved);
    create_member(&mut admin, &workspace, "viewer@acme.com", "Vic", "viewer").await;
    let mut viewer = sign_in_beside(&admin, "viewer@acme.com").await;

    let listed = list(&mut viewer, &model, &module).await;
    assert_eq!(listed.len(), 1);

    let created = viewer
        .post(
            &views_path(&model, &module),
            Some(json!({ "name": "Mine", "definition": definition() })),
        )
        .await;
    assert_problem(&created, StatusCode::FORBIDDEN, "auth.forbidden");

    let changed = viewer
        .patch(
            &view_path(&model, &view),
            Some(json!({ "name": "Renamed" })),
        )
        .await;
    assert_problem(&changed, StatusCode::FORBIDDEN, "auth.forbidden");

    let deleted = viewer.delete(&view_path(&model, &view)).await;
    assert_problem(&deleted, StatusCode::FORBIDDEN, "auth.forbidden");

    let still = list(&mut admin, &model, &module).await;
    assert_eq!(still.len(), 1);
    assert_eq!(still[0]["name"], "Shared");
}

#[sqlx::test(migrator = "openplan_server::db::MIGRATOR")]
async fn unknown_module_404(pool: PgPool) {
    let (mut admin, _, model) = plan(&pool).await;
    let missing = Uuid::now_v7().to_string();

    let listed = admin.get(&views_path(&model, &missing)).await;
    assert_problem(&listed, StatusCode::NOT_FOUND, "not_found");

    let created = admin
        .post(
            &views_path(&model, &missing),
            Some(json!({ "name": "Lost", "definition": definition() })),
        )
        .await;
    assert_problem(&created, StatusCode::NOT_FOUND, "not_found");
}

#[sqlx::test(migrator = "openplan_server::db::MIGRATOR")]
async fn invalid_definition_422(pool: PgPool) {
    let (mut admin, _, model) = plan(&pool).await;
    let module = create_module(&mut admin, &model, "Revenue", vec![month()]).await;
    let cases = [
        json!({ "rows": [{ "kind": "line_items" }], "columns": [], "bogus": true }),
        json!({
            "rows": [{ "kind": "line_items" }],
            "columns": [],
            "filters": [{ "line_item": Uuid::nil(), "op": "bogus" }],
        }),
        json!({ "rows": [{ "kind": "nothing" }], "columns": [] }),
        json!({
            "rows": [{ "kind": "line_items" }],
            "columns": [],
            "conditional_formats": [{
                "name": "Odd",
                "line_item_ids": [],
                "op": "lt",
                "value": 0,
                "style": { "color": "purple", "bold": false },
            }],
        }),
    ];

    for definition in cases {
        let response = admin
            .post(
                &views_path(&model, &module),
                Some(json!({ "name": "Broken", "definition": definition })),
            )
            .await;
        assert_problem(&response, StatusCode::UNPROCESSABLE_ENTITY, "validation");
    }
    assert!(list(&mut admin, &model, &module).await.is_empty());
}

#[sqlx::test(migrator = "openplan_server::db::MIGRATOR")]
async fn model_delete_cascades(pool: PgPool) {
    let (mut admin, _, model) = plan(&pool).await;
    let module = create_module(&mut admin, &model, "Revenue", vec![month()]).await;
    save(&mut admin, &model, &module, "Gone with the model").await;

    let deleted = admin.delete(&format!("/api/v1/models/{model}")).await;
    assert!(deleted.status.is_success(), "{}", deleted.text);

    let remaining: i64 = sqlx::query_scalar("SELECT count(*) FROM views WHERE model_id = $1")
        .bind(Uuid::parse_str(&model).unwrap())
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(remaining, 0);
}

#[sqlx::test(migrator = "openplan_server::db::MIGRATOR")]
async fn module_delete_removes_its_views(pool: PgPool) {
    let (mut admin, _, model) = plan(&pool).await;
    let gone = create_module(&mut admin, &model, "Gone", vec![month()]).await;
    let kept = create_module(&mut admin, &model, "Kept", vec![month()]).await;
    save(&mut admin, &model, &gone, "Doomed").await;
    let survivor = save(&mut admin, &model, &kept, "Survivor").await;

    let deleted = admin
        .delete(&url(&model, &format!("/modules/{gone}")))
        .await;
    assert_eq!(deleted.status, StatusCode::NO_CONTENT, "{}", deleted.text);

    let remaining: i64 = sqlx::query_scalar("SELECT count(*) FROM views WHERE module_id = $1")
        .bind(Uuid::parse_str(&gone).unwrap())
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(remaining, 0);
    let kept_views = list(&mut admin, &model, &kept).await;
    assert_eq!(kept_views.len(), 1);
    assert_eq!(kept_views[0]["id"], id_of(&survivor));
}

#[sqlx::test(migrator = "openplan_server::db::MIGRATOR")]
async fn name_is_trimmed_to_1_to_80_characters(pool: PgPool) {
    let (mut admin, _, model) = plan(&pool).await;
    let module = create_module(&mut admin, &model, "Revenue", vec![month()]).await;

    for name in ["   ".to_string(), "x".repeat(81)] {
        let response = admin
            .post(
                &views_path(&model, &module),
                Some(json!({ "name": name, "definition": definition() })),
            )
            .await;
        assert_problem(&response, StatusCode::UNPROCESSABLE_ENTITY, "validation");
        assert_eq!(response.json["errors"][0]["field"], "name");
    }

    let longest = admin
        .post(
            &views_path(&model, &module),
            Some(json!({ "name": "x".repeat(80), "definition": definition() })),
        )
        .await;
    assert_eq!(longest.status, StatusCode::CREATED, "{}", longest.text);
    assert_eq!(longest.json["name"].as_str().unwrap().chars().count(), 80);
}

#[sqlx::test(migrator = "openplan_server::db::MIGRATOR")]
async fn prune_drops_deleted_member_and_line_item(pool: PgPool) {
    let (mut admin, _, model) = plan(&pool).await;
    let countries = create_list(
        &mut admin,
        &model,
        json!({ "name": "Countries", "top_level_name": "All countries" }),
    )
    .await;
    let items = create_items(
        &mut admin,
        &model,
        &countries,
        json!([{ "name": "US" }, { "name": "France" }]),
    )
    .await;
    let (us, france) = (id_of(&items[0]), id_of(&items[1]));
    let module = create_module(
        &mut admin,
        &model,
        "Revenue",
        vec![list_axis(&countries), month()],
    )
    .await;
    let units =
        id_of(&create_line_item(&mut admin, &model, &module, json!({ "name": "Units" })).await);
    let price =
        id_of(&create_line_item(&mut admin, &model, &module, json!({ "name": "Price" })).await);
    let country = json!({ "kind": "list", "list": countries });

    let mut definition = json!({
        "rows": [{ "kind": "line_items" }],
        "columns": [{ "kind": "time" }],
        "pages": [{ "dim": country, "key": us }],
        "collapsed": [{ "dim": country, "key": "top" }],
        "hidden": [{ "dim": country, "key": france }],
        "filters": [
            { "line_item": units, "op": "not_blank" },
            { "line_item": price, "op": "not_blank" },
        ],
        "line_items": [units, price],
        "conditional_formats": [
            {
                "name": "Only price",
                "line_item_ids": [price],
                "op": "negative",
                "style": { "color": "red", "bold": true },
            },
            {
                "name": "Both",
                "line_item_ids": [units, price],
                "op": "negative",
                "style": { "color": "red", "bold": false },
            },
        ],
        "column_widths": { "Jan 26": 150 },
    });
    definition["column_widths"][france.as_str()] = json!(90);
    let saved = admin
        .post(
            &views_path(&model, &module),
            Some(json!({ "name": "Detail", "definition": definition })),
        )
        .await;
    assert_eq!(saved.status, StatusCode::CREATED, "{}", saved.text);

    let removed = admin
        .post(
            &url(&model, &format!("/lists/{countries}/items/delete")),
            Some(json!({ "ids": [france] })),
        )
        .await;
    assert!(removed.status.is_success(), "{}", removed.text);
    let deleted = admin
        .delete(&url(&model, &format!("/line-items/{price}")))
        .await;
    assert!(deleted.status.is_success(), "{}", deleted.text);

    let listed = list(&mut admin, &model, &module).await;
    assert_eq!(listed[0]["pruned"], true);
    let pruned = &listed[0]["definition"];
    assert_eq!(pruned["hidden"], json!([]));
    assert_eq!(
        pruned["collapsed"],
        json!([{ "dim": country, "key": "top" }])
    );
    assert_eq!(pruned["pages"], json!([{ "dim": country, "key": us, }]));
    assert_eq!(pruned["filters"].as_array().unwrap().len(), 1);
    assert_eq!(pruned["filters"][0]["line_item"], units);
    assert_eq!(pruned["line_items"], json!([units]));
    assert_eq!(pruned["conditional_formats"].as_array().unwrap().len(), 1);
    assert_eq!(pruned["conditional_formats"][0]["name"], "Both");
    assert_eq!(
        pruned["conditional_formats"][0]["line_item_ids"],
        json!([units])
    );
    assert_eq!(pruned["column_widths"], json!({ "Jan 26": 150 }));
    grid_accepts(&mut admin, &model, &module, pruned).await;
}

#[sqlx::test(migrator = "openplan_server::db::MIGRATOR")]
async fn prune_resets_axes_when_module_dims_change(pool: PgPool) {
    let (mut admin, _, model) = plan(&pool).await;
    let countries = create_list(
        &mut admin,
        &model,
        json!({ "name": "Countries", "top_level_name": "All countries" }),
    )
    .await;
    let items = create_items(
        &mut admin,
        &model,
        &countries,
        json!([{ "name": "US" }, { "name": "France" }]),
    )
    .await;
    let (us, france) = (id_of(&items[0]), id_of(&items[1]));
    let module = create_module(
        &mut admin,
        &model,
        "Revenue",
        vec![list_axis(&countries), month()],
    )
    .await;
    create_line_item(&mut admin, &model, &module, json!({ "name": "Units" })).await;
    let country = json!({ "kind": "list", "list": countries });
    let saved = admin
        .post(
            &views_path(&model, &module),
            Some(json!({
                "name": "Detail",
                "definition": {
                    "rows": [{ "kind": "line_items" }],
                    "columns": [{ "kind": "time" }],
                    "pages": [{ "dim": country, "key": us }],
                    "collapsed": [{ "dim": country, "key": "top" }],
                    "hidden": [{ "dim": country, "key": france }],
                },
            })),
        )
        .await;
    assert_eq!(saved.status, StatusCode::CREATED, "{}", saved.text);

    // A versions axis that the view does not name: the time goes on the columns, and each of the
    // other dimensions on the pages at its first member.
    let widened = admin
        .patch(
            &url(&model, &format!("/modules/{module}")),
            Some(json!({
                "axes": [list_axis(&countries), month(), { "kind": "versions" }],
            })),
        )
        .await;
    assert_eq!(widened.status, StatusCode::OK, "{}", widened.text);
    let first_version = structure(&mut admin, &model).await["versions"][0]["id"].clone();

    let listed = list(&mut admin, &model, &module).await;
    assert_eq!(listed[0]["pruned"], true);
    let pruned = &listed[0]["definition"];
    assert_eq!(pruned["rows"], json!([{ "kind": "line_items" }]));
    assert_eq!(pruned["columns"], json!([{ "kind": "time" }]));
    assert_eq!(
        pruned["pages"],
        json!([
            { "dim": country, "key": "top" },
            { "dim": { "kind": "versions" }, "key": first_version },
        ])
    );
    assert_eq!(pruned["collapsed"], json!([]));
    assert_eq!(pruned["hidden"], json!([]));
    grid_accepts(&mut admin, &model, &module, pruned).await;

    // Without the time, the first list goes on the columns and nothing is left for the pages.
    let narrowed = admin
        .patch(
            &url(&model, &format!("/modules/{module}")),
            Some(json!({ "axes": [list_axis(&countries)] })),
        )
        .await;
    assert_eq!(narrowed.status, StatusCode::OK, "{}", narrowed.text);

    let listed = list(&mut admin, &model, &module).await;
    assert_eq!(listed[0]["pruned"], true);
    let pruned = &listed[0]["definition"];
    assert_eq!(pruned["rows"], json!([{ "kind": "line_items" }]));
    assert_eq!(pruned["columns"], json!([country]));
    assert_eq!(pruned["pages"], json!([]));
    assert_eq!(pruned["collapsed"], json!([]));
    assert_eq!(pruned["hidden"], json!([]));
    grid_accepts(&mut admin, &model, &module, pruned).await;
}

/// A definition of the smallest kind whose `field` holds `value`.
fn with_field(field: &str, value: Value) -> Value {
    let mut definition = definition();
    definition[field] = value;
    definition
}

#[sqlx::test(migrator = "openplan_server::db::MIGRATOR")]
async fn caps_422(pool: PgPool) {
    let (mut admin, _, model) = plan(&pool).await;
    let module = create_module(&mut admin, &model, "Revenue", vec![month()]).await;
    let nil = Uuid::nil().to_string();
    let many = |count: usize, item: Value| Value::Array(vec![item; count]);
    let member = json!({ "dim": { "kind": "time" }, "key": "Jan 26" });
    let rule = json!({
        "name": "Any",
        "line_item_ids": [],
        "op": "blank",
        "style": { "color": "muted", "bold": false },
    });
    let widths = |width: u32| {
        let mut map = serde_json::Map::new();
        map.insert("Jan 26".to_string(), json!(width));
        Value::Object(map)
    };
    let too_many_widths: serde_json::Map<String, Value> = (0..1_001)
        .map(|index| (format!("Column {index}"), json!(100)))
        .collect();

    let cases = [
        (
            "definition.filters",
            with_field(
                "filters",
                many(11, json!({ "line_item": nil, "op": "not_blank" })),
            ),
        ),
        (
            "definition.line_items",
            with_field("line_items", many(1_001, json!(nil))),
        ),
        (
            "definition.collapsed",
            with_field("collapsed", many(5_001, member.clone())),
        ),
        (
            "definition.hidden",
            with_field("hidden", many(5_001, member)),
        ),
        (
            "definition.conditional_formats",
            with_field("conditional_formats", many(51, rule)),
        ),
        (
            "definition.column_widths",
            with_field("column_widths", Value::Object(too_many_widths)),
        ),
        (
            "definition.column_widths",
            with_field("column_widths", widths(23)),
        ),
        (
            "definition.column_widths",
            with_field("column_widths", widths(2_001)),
        ),
    ];

    for (field, definition) in cases {
        let response = admin
            .post(
                &views_path(&model, &module),
                Some(json!({ "name": "Too big", "definition": definition })),
            )
            .await;
        assert_problem(&response, StatusCode::UNPROCESSABLE_ENTITY, "validation");
        assert_eq!(
            response.json["errors"][0]["field"], field,
            "{}",
            response.text
        );
    }
    assert!(list(&mut admin, &model, &module).await.is_empty());
}

#[sqlx::test(migrator = "openplan_server::db::MIGRATOR")]
async fn views_per_module_cap(pool: PgPool) {
    let (mut admin, _, model) = plan(&pool).await;
    let module = create_module(&mut admin, &model, "Revenue", vec![month()]).await;
    let model_id = Uuid::parse_str(&model).unwrap();
    let module_id = Uuid::parse_str(&module).unwrap();
    for index in 0..199 {
        sqlx::query(
            "INSERT INTO views (id, model_id, module_id, name, definition) VALUES ($1, $2, $3, $4, $5)",
        )
        .bind(Uuid::now_v7())
        .bind(model_id)
        .bind(module_id)
        .bind(format!("View {index}"))
        .bind(Json(json!({ "rows": [], "columns": [] })))
        .execute(&pool)
        .await
        .unwrap();
    }
    save(&mut admin, &model, &module, "Two hundredth").await;

    let refused = admin
        .post(
            &views_path(&model, &module),
            Some(json!({ "name": "One too many", "definition": definition() })),
        )
        .await;
    assert_problem(&refused, StatusCode::UNPROCESSABLE_ENTITY, "validation");
    assert_eq!(refused.json["errors"][0]["field"], "name");
    assert!(
        refused.json["errors"][0]["message"]
            .as_str()
            .unwrap()
            .contains("200")
    );

    let count: i64 = sqlx::query_scalar("SELECT count(*) FROM views WHERE module_id = $1")
        .bind(module_id)
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(count, 200);
}

/// Waits until a write of the test is blocked on a lock that another transaction holds.
async fn wait_for_a_blocked_write(pool: &PgPool) {
    for _ in 0..500 {
        let blocked: i64 = sqlx::query_scalar(
            "SELECT count(*) FROM pg_stat_activity
             WHERE datname = current_database() AND wait_event_type = 'Lock'",
        )
        .fetch_one(pool)
        .await
        .unwrap();
        if blocked > 0 {
            return;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    panic!("no write waited on the other transaction");
}

/// A conditional format on the first line item, with the values given.
fn rule(name: &str, op: &str, value: Option<f64>, value2: Option<f64>) -> Value {
    let mut rule = json!({
        "name": name,
        "line_item_ids": [],
        "op": op,
        "style": { "color": "red", "bold": false },
    });
    if let Some(value) = value {
        rule["value"] = json!(value);
    }
    if let Some(value2) = value2 {
        rule["value2"] = json!(value2);
    }
    rule
}

/// A definition of the smallest kind with the conditional formats given.
fn with_formats(formats: Vec<Value>) -> Value {
    let mut definition = definition();
    definition["conditional_formats"] = Value::Array(formats);
    definition
}

#[sqlx::test(migrator = "openplan_server::db::MIGRATOR")]
async fn creating_a_default_moves_the_default(pool: PgPool) {
    let (mut admin, _, model) = plan(&pool).await;
    let module = create_module(&mut admin, &model, "Revenue", vec![month()]).await;
    let zeta = admin
        .post(
            &views_path(&model, &module),
            Some(json!({ "name": "Zeta", "definition": definition(), "is_default": true })),
        )
        .await;
    assert_eq!(zeta.status, StatusCode::CREATED, "{}", zeta.text);
    save(&mut admin, &model, &module, "alpha").await;

    let gamma = admin
        .post(
            &views_path(&model, &module),
            Some(json!({ "name": "Gamma", "definition": definition(), "is_default": true })),
        )
        .await;
    assert_eq!(gamma.status, StatusCode::CREATED, "{}", gamma.text);

    let listed: Vec<(String, bool)> = list(&mut admin, &model, &module)
        .await
        .iter()
        .map(|view| {
            (
                view["name"].as_str().unwrap().to_string(),
                view["is_default"].as_bool().unwrap(),
            )
        })
        .collect();
    assert_eq!(
        listed,
        [
            ("Gamma".to_string(), true),
            ("alpha".to_string(), false),
            ("Zeta".to_string(), false),
        ]
    );
}

#[sqlx::test(migrator = "openplan_server::db::MIGRATOR")]
async fn concurrent_defaults_leave_one_default(pool: PgPool) {
    let (mut admin, _, model) = plan(&pool).await;
    let module = create_module(&mut admin, &model, "Revenue", vec![month()]).await;
    let first = id_of(&save(&mut admin, &model, &module, "First").await);
    let second = id_of(&save(&mut admin, &model, &module, "Second").await);
    let mut other = admin.fork();

    let (first_path, second_path) = (view_path(&model, &first), view_path(&model, &second));
    let (a, b) = tokio::join!(
        admin.patch(&first_path, Some(json!({ "is_default": true }))),
        other.patch(&second_path, Some(json!({ "is_default": true }))),
    );
    assert_eq!(a.status, StatusCode::OK, "{}", a.text);
    assert_eq!(b.status, StatusCode::OK, "{}", b.text);

    let defaults = list(&mut admin, &model, &module)
        .await
        .iter()
        .filter(|view| view["is_default"] == true)
        .count();
    assert_eq!(defaults, 1);
}

#[sqlx::test(migrator = "openplan_server::db::MIGRATOR")]
async fn default_race_409(pool: PgPool) {
    let (mut admin, _, model) = plan(&pool).await;
    let module = create_module(&mut admin, &model, "Revenue", vec![month()]).await;

    // Another write makes a default view and does not commit it yet. It takes no lock on the
    // model's row beyond the share a foreign key takes, so the save below is not held back by it:
    // it finds no default to clear, and then waits on the default index until the other commits.
    let mut racing = pool.begin().await.unwrap();
    sqlx::query(
        "INSERT INTO views (id, model_id, module_id, name, definition, is_default)
         VALUES ($1, $2, $3, 'Racing', $4, true)",
    )
    .bind(Uuid::now_v7())
    .bind(Uuid::parse_str(&model).unwrap())
    .bind(Uuid::parse_str(&module).unwrap())
    .bind(Json(json!({ "rows": [], "columns": [] })))
    .execute(&mut *racing)
    .await
    .unwrap();

    let path = views_path(&model, &module);
    let (response, ()) = tokio::join!(
        admin.post(
            &path,
            Some(json!({ "name": "Late", "definition": definition(), "is_default": true })),
        ),
        async {
            wait_for_a_blocked_write(&pool).await;
            racing.commit().await.unwrap();
        },
    );
    assert_problem(&response, StatusCode::CONFLICT, "view.default_conflict");

    let defaults = list(&mut admin, &model, &module)
        .await
        .iter()
        .filter(|view| view["is_default"] == true)
        .count();
    assert_eq!(defaults, 1);
}

#[sqlx::test(migrator = "openplan_server::db::MIGRATOR")]
async fn views_of_another_model_are_not_found(pool: PgPool) {
    let (mut admin, workspace, model) = plan(&pool).await;
    let module = create_module(&mut admin, &model, "Revenue", vec![month()]).await;
    let view = id_of(&save(&mut admin, &model, &module, "Mine").await);
    let other_model = create_model(&mut admin, &workspace, "Other").await;

    let renamed = admin
        .patch(
            &view_path(&other_model, &view),
            Some(json!({ "name": "Hijacked" })),
        )
        .await;
    assert_problem(&renamed, StatusCode::NOT_FOUND, "not_found");
    let deleted = admin.delete(&view_path(&other_model, &view)).await;
    assert_problem(&deleted, StatusCode::NOT_FOUND, "not_found");

    let unknown = Uuid::now_v7().to_string();
    let missing = admin
        .patch(
            &view_path(&model, &unknown),
            Some(json!({ "name": "Nobody" })),
        )
        .await;
    assert_problem(&missing, StatusCode::NOT_FOUND, "not_found");
    let missing = admin.delete(&view_path(&model, &unknown)).await;
    assert_problem(&missing, StatusCode::NOT_FOUND, "not_found");

    let listed = list(&mut admin, &model, &module).await;
    assert_eq!(listed.len(), 1);
    assert_eq!(listed[0]["name"], "Mine");
}

#[sqlx::test(migrator = "openplan_server::db::MIGRATOR")]
async fn planner_can_list_not_write(pool: PgPool) {
    let (mut admin, workspace, model) = plan(&pool).await;
    let module = create_module(&mut admin, &model, "Revenue", vec![month()]).await;
    let view = id_of(&save(&mut admin, &model, &module, "Shared").await);
    create_member(&mut admin, &workspace, "planner@acme.com", "Pat", "planner").await;
    let mut planner = sign_in_beside(&admin, "planner@acme.com").await;

    assert_eq!(list(&mut planner, &model, &module).await.len(), 1);
    let created = planner
        .post(
            &views_path(&model, &module),
            Some(json!({ "name": "Mine", "definition": definition() })),
        )
        .await;
    assert_problem(&created, StatusCode::FORBIDDEN, "auth.forbidden");
    let changed = planner
        .patch(
            &view_path(&model, &view),
            Some(json!({ "name": "Renamed" })),
        )
        .await;
    assert_problem(&changed, StatusCode::FORBIDDEN, "auth.forbidden");
    let deleted = planner.delete(&view_path(&model, &view)).await;
    assert_problem(&deleted, StatusCode::FORBIDDEN, "auth.forbidden");
}

#[sqlx::test(migrator = "openplan_server::db::MIGRATOR")]
async fn patch_checks_the_definition(pool: PgPool) {
    let (mut admin, _, model) = plan(&pool).await;
    let module = create_module(&mut admin, &model, "Revenue", vec![month()]).await;
    let view = id_of(&save(&mut admin, &model, &module, "Steady").await);
    let filters = Value::Array(vec![
        json!({ "line_item": Uuid::nil(), "op": "not_blank" });
        11
    ]);

    let too_many = admin
        .patch(
            &view_path(&model, &view),
            Some(json!({
                "name": "Renamed",
                "definition": {
                    "rows": [{ "kind": "line_items" }],
                    "columns": [],
                    "filters": filters,
                },
            })),
        )
        .await;
    assert_problem(&too_many, StatusCode::UNPROCESSABLE_ENTITY, "validation");
    assert_eq!(too_many.json["errors"][0]["field"], "definition.filters");

    let bad_op = admin
        .patch(
            &view_path(&model, &view),
            Some(json!({
                "definition": {
                    "rows": [{ "kind": "line_items" }],
                    "columns": [],
                    "filters": [{ "line_item": Uuid::nil(), "op": "bogus" }],
                },
            })),
        )
        .await;
    assert_problem(&bad_op, StatusCode::UNPROCESSABLE_ENTITY, "validation");

    let listed = list(&mut admin, &model, &module).await;
    assert_eq!(listed[0]["name"], "Steady");
    assert_eq!(listed[0]["definition"]["filters"], json!([]));
}

#[sqlx::test(migrator = "openplan_server::db::MIGRATOR")]
async fn caps_at_the_limit_are_accepted(pool: PgPool) {
    let (mut admin, _, model) = plan(&pool).await;
    let module = create_module(&mut admin, &model, "Revenue", vec![month()]).await;
    let nil = Uuid::nil().to_string();
    let member = json!({ "dim": { "kind": "time" }, "key": "Jan 26" });
    let rule = json!({
        "name": "Any",
        "line_item_ids": [],
        "op": "blank",
        "style": { "color": "muted", "bold": false },
    });
    let dims = Value::Array(vec![json!({ "kind": "time" }); 16]);
    let filters = Value::Array(vec![json!({ "line_item": nil, "op": "not_blank" }); 10]);
    let line_items = Value::Array(vec![json!(nil); 1_000]);
    let formats = Value::Array(vec![rule; 50]);
    let widths: serde_json::Map<String, Value> = (0..1_000)
        .map(|index| {
            let width = if index % 2 == 0 { 24 } else { 2_000 };
            (format!("Column {index}"), json!(width))
        })
        .collect();

    let saved = admin
        .post(
            &views_path(&model, &module),
            Some(json!({
                "name": "Largest",
                "definition": {
                    "rows": dims,
                    "columns": [],
                    "filters": filters,
                    "line_items": line_items,
                    "collapsed": vec![member.clone(); 5_000],
                    "hidden": vec![member; 5_000],
                    "conditional_formats": formats,
                    "column_widths": widths,
                },
            })),
        )
        .await;
    assert_eq!(saved.status, StatusCode::CREATED, "{}", saved.text);
    assert_eq!(
        saved.json["definition"]["filters"]
            .as_array()
            .unwrap()
            .len(),
        10
    );
    assert_eq!(
        saved.json["definition"]["column_widths"]
            .as_object()
            .unwrap()
            .len(),
        1_000
    );
}

#[sqlx::test(migrator = "openplan_server::db::MIGRATOR")]
async fn prune_drops_a_deleted_collapsed_member_and_resets_a_stale_page(pool: PgPool) {
    let (mut admin, _, model) = plan(&pool).await;
    let countries = create_list(
        &mut admin,
        &model,
        json!({ "name": "Countries", "top_level_name": "All countries" }),
    )
    .await;
    let items = create_items(
        &mut admin,
        &model,
        &countries,
        json!([{ "name": "US" }, { "name": "France" }]),
    )
    .await;
    let france = id_of(&items[1]);
    let module = create_module(
        &mut admin,
        &model,
        "Revenue",
        vec![list_axis(&countries), month()],
    )
    .await;
    create_line_item(&mut admin, &model, &module, json!({ "name": "Units" })).await;
    let country = json!({ "kind": "list", "list": countries });
    let saved = admin
        .post(
            &views_path(&model, &module),
            Some(json!({
                "name": "Detail",
                "definition": {
                    "rows": [{ "kind": "line_items" }],
                    "columns": [{ "kind": "time" }],
                    "pages": [{ "dim": country, "key": france }],
                    "collapsed": [{ "dim": country, "key": france }],
                },
            })),
        )
        .await;
    assert_eq!(saved.status, StatusCode::CREATED, "{}", saved.text);

    let removed = admin
        .post(
            &url(&model, &format!("/lists/{countries}/items/delete")),
            Some(json!({ "ids": [france] })),
        )
        .await;
    assert!(removed.status.is_success(), "{}", removed.text);

    let listed = list(&mut admin, &model, &module).await;
    assert_eq!(listed[0]["pruned"], true);
    let pruned = &listed[0]["definition"];
    assert_eq!(pruned["collapsed"], json!([]));
    assert_eq!(pruned["pages"], json!([{ "dim": country, "key": "top" }]));
    grid_accepts(&mut admin, &model, &module, pruned).await;
}

#[sqlx::test(migrator = "openplan_server::db::MIGRATOR")]
async fn conditional_formats_are_checked(pool: PgPool) {
    let (mut admin, _, model) = plan(&pool).await;
    let module = create_module(&mut admin, &model, "Revenue", vec![month()]).await;
    let nil = Uuid::nil().to_string();
    let mut many_items = rule("Many", "blank", None, None);
    many_items["line_item_ids"] = Value::Array(vec![json!(nil); 1_001]);
    let mut seventeen = definition();
    seventeen["rows"] = Value::Array(vec![json!({ "kind": "time" }); 17]);

    let cases = [
        (
            "definition.conditional_formats[0].name",
            with_formats(vec![rule("   ", "blank", None, None)]),
        ),
        (
            "definition.conditional_formats[0].name",
            with_formats(vec![rule(&"x".repeat(81), "blank", None, None)]),
        ),
        (
            "definition.conditional_formats[0].value",
            with_formats(vec![rule("Low", "lt", None, None)]),
        ),
        (
            "definition.conditional_formats[0].value2",
            with_formats(vec![rule("Band", "between", Some(5.0), None)]),
        ),
        (
            "definition.conditional_formats[0].value2",
            with_formats(vec![rule("Band", "between", Some(5.0), Some(4.0))]),
        ),
        (
            "definition.conditional_formats[1].value",
            with_formats(vec![
                rule("Any", "blank", None, None),
                rule("High", "ge", None, None),
            ]),
        ),
        (
            "definition.conditional_formats[0].line_item_ids",
            with_formats(vec![many_items]),
        ),
        ("definition.rows", seventeen),
    ];
    for (field, definition) in cases {
        let response = admin
            .post(
                &views_path(&model, &module),
                Some(json!({ "name": "Rules", "definition": definition })),
            )
            .await;
        assert_problem(&response, StatusCode::UNPROCESSABLE_ENTITY, "validation");
        assert_eq!(
            response.json["errors"][0]["field"], field,
            "{}",
            response.text
        );
    }

    let accepted = admin
        .post(
            &views_path(&model, &module),
            Some(json!({
                "name": "Rules",
                "definition": with_formats(vec![rule("  Alert  ", "between", Some(5.0), Some(5.0))]),
            })),
        )
        .await;
    assert_eq!(accepted.status, StatusCode::CREATED, "{}", accepted.text);
    let stored = &accepted.json["definition"]["conditional_formats"][0];
    assert_eq!(stored["name"], "Alert");
    assert_eq!(stored["value2"], 5.0);
}

#[sqlx::test(migrator = "openplan_server::db::MIGRATOR")]
async fn list_delete_removes_its_properties_views(pool: PgPool) {
    let (mut admin, _, model) = plan(&pool).await;
    let countries = create_list(&mut admin, &model, json!({ "name": "Countries" })).await;
    create_line_item(
        &mut admin,
        &model,
        &countries,
        json!({ "name": "Population" }),
    )
    .await;
    let on_properties = save(&mut admin, &model, &countries, "On properties").await;
    assert_eq!(on_properties["module_id"], countries);

    let deleted = admin
        .delete(&url(&model, &format!("/lists/{countries}")))
        .await;
    assert_eq!(deleted.status, StatusCode::NO_CONTENT, "{}", deleted.text);

    let remaining: i64 = sqlx::query_scalar("SELECT count(*) FROM views WHERE module_id = $1")
        .bind(Uuid::parse_str(&countries).unwrap())
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(remaining, 0);
}
