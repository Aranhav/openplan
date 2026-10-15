mod common;

use axum::http::{Method, StatusCode};
use common::{
    TestApp, TestResponse, assert_problem, create_member, create_model, create_user, setup_admin,
    sign_in,
};
use serde_json::{Value, json};
use sqlx::PgPool;
use uuid::Uuid;

const PRODUCTION_LOCKED: &str =
    "This model is in production mode. Structural changes arrive through ALM sync.";
const SPEC: &str = concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../../docs/superpowers/specs/2026-10-15-openplan-design.md"
);

/// Signs the admin up to a workspace called Acme, and gives a new model a calendar of the three
/// years from January 2026, so that the period labels in these tests mean the same whatever the
/// date they run on.
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

fn month() -> Value {
    json!({ "kind": "time", "level": "month", "range": null })
}

fn list_axis(list: &str) -> Value {
    json!({ "kind": "list", "list": list })
}

fn number_format() -> Value {
    json!({
        "type": "number",
        "decimals": 0,
        "thousands_sep": true,
        "unit": { "type": "none" },
        "negative": "minus",
    })
}

async fn structure(app: &mut TestApp, model: &str) -> Value {
    let response = app.get(&url(model, "/structure")).await;
    assert_eq!(response.status, StatusCode::OK, "{}", response.text);
    response.json
}

async fn create_list(app: &mut TestApp, model: &str, name: &str) -> String {
    let response = app
        .post(&url(model, "/lists"), Some(json!({ "name": name })))
        .await;
    assert_eq!(response.status, StatusCode::CREATED, "{}", response.text);
    id_of(&response.json)
}

async fn create_module(app: &mut TestApp, model: &str, name: &str, axes: Vec<Value>) -> String {
    let response = app
        .post(
            &url(model, "/modules"),
            Some(json!({ "name": name, "axes": axes })),
        )
        .await;
    assert_eq!(response.status, StatusCode::CREATED, "{}", response.text);
    id_of(&response.json)
}

async fn create_line_item(app: &mut TestApp, model: &str, module: &str, body: Value) -> Value {
    let response = app
        .post(
            &url(model, &format!("/modules/{module}/line-items")),
            Some(body),
        )
        .await;
    assert_eq!(response.status, StatusCode::CREATED, "{}", response.text);
    response.json
}

async fn patch_line_item(
    app: &mut TestApp,
    model: &str,
    line_item: &str,
    body: Value,
) -> TestResponse {
    app.patch(&url(model, &format!("/line-items/{line_item}")), Some(body))
        .await
}

async fn check(app: &mut TestApp, model: &str, line_item: &str, formula: &str) -> TestResponse {
    app.post(
        &url(model, "/formula/check"),
        Some(json!({ "line_item_id": line_item, "formula": formula })),
    )
    .await
}

/// Every change-log row of a model, whatever its kind.
async fn change_rows(pool: &PgPool, model: &str) -> i64 {
    sqlx::query_scalar("SELECT count(*) FROM change_log WHERE model_id = $1")
        .bind(Uuid::parse_str(model).unwrap())
        .fetch_one(pool)
        .await
        .unwrap()
}

fn line_item_names(doc: &Value, module: &str) -> Vec<String> {
    let mut items: Vec<&Value> = doc["line_items"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|line_item| line_item["module"] == module)
        .collect();
    items.sort_by_key(|line_item| line_item["ordinal"].as_i64().unwrap());
    items
        .iter()
        .map(|line_item| line_item["name"].as_str().unwrap().to_string())
        .collect()
}

#[sqlx::test(migrator = "openplan_server::db::MIGRATOR")]
async fn create_module_and_line_items(pool: PgPool) {
    let (mut admin, _, model) = plan(&pool).await;
    let regions = create_list(&mut admin, &model, "Regions").await;
    let axes = json!([list_axis(&regions), month(), { "kind": "versions" }]);

    let created = admin
        .post(
            &url(&model, "/modules"),
            Some(json!({ "name": "Revenue Plan", "axes": axes, "functional_area": "Finance" })),
        )
        .await;
    assert_eq!(created.status, StatusCode::CREATED, "{}", created.text);
    let module = id_of(&created.json);
    assert_eq!(
        created.json,
        json!({
            "id": module,
            "name": "Revenue Plan",
            "axes": axes,
            "functional_area": "Finance",
        })
    );

    let units = create_line_item(&mut admin, &model, &module, json!({ "name": "Units" })).await;
    let units_id = id_of(&units);
    assert_eq!(
        units,
        json!({
            "id": units_id,
            "module": module,
            "name": "Units",
            "ordinal": 0,
            "format": number_format(),
            "formula": null,
            "summary": { "method": "sum" },
            "time_summary": null,
            "applies_to": null,
            "time_scale": "module",
            "versions": "module",
            "notes": "",
            "code": null,
            "read_access_driver": null,
            "write_access_driver": null,
        })
    );

    let euro = json!({
        "type": "number",
        "decimals": 2,
        "thousands_sep": false,
        "unit": { "type": "currency", "code": "EUR" },
        "negative": "parens",
    });
    let price = create_line_item(
        &mut admin,
        &model,
        &module,
        json!({ "name": "  Price ", "format": euro }),
    )
    .await;
    assert_eq!(price["name"], "Price");
    assert_eq!(price["ordinal"], 1);
    assert_eq!(price["format"], euro);

    let revenue = create_line_item(
        &mut admin,
        &model,
        &module,
        json!({
            "name": "Revenue",
            "formula": "Units * Price",
            "summary": { "method": "average" },
            "notes": "Units times price",
            "code": " REV ",
        }),
    )
    .await;
    let revenue_id = id_of(&revenue);
    assert_eq!(revenue["ordinal"], 2);
    assert_eq!(revenue["formula"], "Units * Price");
    assert_eq!(revenue["summary"], json!({ "method": "average" }));
    assert_eq!(revenue["code"], "REV");

    let budget = structure(&mut admin, &model).await["versions"]
        .as_array()
        .unwrap()
        .iter()
        .find(|version| version["name"] == "Budget")
        .map(id_of)
        .unwrap();
    let margin = create_line_item(
        &mut admin,
        &model,
        &module,
        json!({
            "name": "Margin",
            "ordinal": 10,
            "summary": { "method": "ratio", "numerator": revenue_id, "denominator": units_id },
            "time_summary": { "method": "last" },
            "applies_to": [list_axis(&regions)],
            "time_scale": { "level": "quarter" },
            "versions": { "only": [budget] },
            "read_access_driver": units_id,
        }),
    )
    .await;
    let margin_id = id_of(&margin);
    assert_eq!(margin["ordinal"], 10);
    assert_eq!(
        margin["summary"],
        json!({ "method": "ratio", "numerator": revenue_id, "denominator": units_id })
    );
    assert_eq!(margin["time_summary"], json!({ "method": "last" }));
    assert_eq!(margin["applies_to"], json!([list_axis(&regions)]));
    assert_eq!(margin["time_scale"], json!({ "level": "quarter" }));
    assert_eq!(margin["versions"], json!({ "only": [budget] }));
    assert_eq!(margin["read_access_driver"], units_id);
    let after_margin =
        create_line_item(&mut admin, &model, &module, json!({ "name": "After" })).await;
    assert_eq!(after_margin["ordinal"], 11);

    let doc = structure(&mut admin, &model).await;
    assert_eq!(doc["modules"].as_array().unwrap().len(), 1);
    assert_eq!(doc["modules"][0]["name"], "Revenue Plan");
    assert_eq!(
        line_item_names(&doc, &module),
        ["Units", "Price", "Revenue", "Margin", "After"]
    );

    let renamed = patch_line_item(
        &mut admin,
        &model,
        &units_id,
        json!({ "name": "Unit count", "notes": "Sold", "code": "U1" }),
    )
    .await;
    assert_eq!(renamed.status, StatusCode::OK, "{}", renamed.text);
    assert_eq!(renamed.json["name"], "Unit count");
    assert_eq!(renamed.json["notes"], "Sold");
    assert_eq!(renamed.json["code"], "U1");
    assert_eq!(renamed.json["ordinal"], 0);
    let uncoded = patch_line_item(
        &mut admin,
        &model,
        &units_id,
        json!({ "code": null, "notes": "" }),
    )
    .await;
    assert_eq!(uncoded.json["code"], Value::Null);
    assert_eq!(uncoded.json["notes"], "");
    assert_eq!(uncoded.json["name"], "Unit count");

    let cleared =
        patch_line_item(&mut admin, &model, &revenue_id, json!({ "formula": null })).await;
    assert_eq!(cleared.status, StatusCode::OK, "{}", cleared.text);
    assert_eq!(cleared.json["formula"], Value::Null);
    let set = patch_line_item(
        &mut admin,
        &model,
        &revenue_id,
        json!({ "formula": "'Unit count' * 2" }),
    )
    .await;
    assert_eq!(set.json["formula"], "'Unit count' * 2");
    let blank = patch_line_item(&mut admin, &model, &revenue_id, json!({ "formula": "  " })).await;
    assert_eq!(blank.json["formula"], Value::Null);

    let module_patch = admin
        .patch(
            &url(&model, &format!("/modules/{module}")),
            Some(json!({ "name": "Sales Plan", "functional_area": "" })),
        )
        .await;
    assert_eq!(module_patch.status, StatusCode::OK, "{}", module_patch.text);
    assert_eq!(
        module_patch.json,
        json!({ "id": module, "name": "Sales Plan", "axes": axes, "functional_area": "" })
    );

    let in_use = admin
        .delete(&url(&model, &format!("/line-items/{revenue_id}")))
        .await;
    assert_problem(&in_use, StatusCode::CONFLICT, "structure.in_use");
    for line_item in [&margin_id, &revenue_id] {
        let deleted = admin
            .delete(&url(&model, &format!("/line-items/{line_item}")))
            .await;
        assert_eq!(deleted.status, StatusCode::NO_CONTENT, "{}", deleted.text);
    }
    let doc = structure(&mut admin, &model).await;
    assert_eq!(
        line_item_names(&doc, &module),
        ["Unit count", "Price", "After"]
    );

    let deleted = admin
        .delete(&url(&model, &format!("/modules/{module}")))
        .await;
    assert_eq!(deleted.status, StatusCode::NO_CONTENT, "{}", deleted.text);
    let doc = structure(&mut admin, &model).await;
    assert!(doc["modules"].as_array().unwrap().is_empty());
    assert!(doc["line_items"].as_array().unwrap().is_empty());
}

#[sqlx::test(migrator = "openplan_server::db::MIGRATOR")]
async fn the_structure_is_served_as_the_engine_writes_it(pool: PgPool) {
    let (mut admin, _, model) = plan(&pool).await;
    let regions = create_list(&mut admin, &model, "Regions").await;
    let countries = admin
        .post(
            &url(&model, "/lists"),
            Some(json!({ "name": "Countries", "parent_list_id": regions, "numbered": true })),
        )
        .await;
    let countries = id_of(&countries.json);
    let items = admin
        .post(
            &url(&model, &format!("/lists/{regions}/items")),
            Some(json!({ "items": [{ "code": "EU", "name": "EMEA" }] })),
        )
        .await;
    let emea = id_of(&items.json[0]);
    admin
        .post(
            &url(&model, &format!("/lists/{countries}/items")),
            Some(json!({ "items": [{ "name": "France", "parent_id": emea }] })),
        )
        .await;
    let module = create_module(
        &mut admin,
        &model,
        "Plan",
        vec![
            list_axis(&countries),
            month(),
            json!({ "kind": "versions" }),
        ],
    )
    .await;
    let units = create_line_item(&mut admin, &model, &module, json!({ "name": "Units" })).await;
    for (name, format) in [
        ("Flag", json!({ "type": "boolean" })),
        ("Title", json!({ "type": "text" })),
        ("Day", json!({ "type": "date" })),
        ("Region", json!({ "type": "list", "list": regions })),
        (
            "Period",
            json!({ "type": "time_period", "level": "quarter" }),
        ),
    ] {
        create_line_item(
            &mut admin,
            &model,
            &module,
            json!({ "name": name, "format": format, "summary": { "method": "none" } }),
        )
        .await;
    }
    create_line_item(
        &mut admin,
        &model,
        &module,
        json!({
            "name": "Share",
            "format": {
                "type": "number",
                "decimals": 1,
                "thousands_sep": true,
                "unit": { "type": "percent" },
                "negative": "minus",
            },
            "summary": { "method": "ratio", "numerator": id_of(&units), "denominator": id_of(&units) },
            "time_scale": "none",
            "versions": "none",
        }),
    )
    .await;

    let served = structure(&mut admin, &model).await;

    let handle = admin
        .state
        .models
        .get(Uuid::parse_str(&model).unwrap())
        .await
        .unwrap();
    let engine = serde_json::to_value(handle.snapshot().export_structure()).unwrap();
    assert_eq!(served, engine);
    assert_eq!(served["line_items"].as_array().unwrap().len(), 7);
}

#[sqlx::test(migrator = "openplan_server::db::MIGRATOR")]
async fn formula_check_ok_and_errors(pool: PgPool) {
    let (mut admin, _, model) = plan(&pool).await;
    let module = create_module(&mut admin, &model, "Plan", vec![month()]).await;
    let revenue =
        id_of(&create_line_item(&mut admin, &model, &module, json!({ "name": "Revenue" })).await);
    create_line_item(&mut admin, &model, &module, json!({ "name": "Cost" })).await;
    let margin =
        id_of(&create_line_item(&mut admin, &model, &module, json!({ "name": "Margin" })).await);
    let title = id_of(
        &create_line_item(
            &mut admin,
            &model,
            &module,
            json!({ "name": "Title", "format": { "type": "text" } }),
        )
        .await,
    );
    let rows = change_rows(&pool, &model).await;

    let ok = check(&mut admin, &model, &margin, "Revenue - Cost").await;
    assert_eq!(ok.status, StatusCode::OK, "{}", ok.text);
    assert_eq!(ok.json, json!({ "ok": true, "type": { "type": "number" } }));
    let text = check(&mut admin, &model, &title, "\"Plan \" & \"A\"").await;
    assert_eq!(text.json, json!({ "ok": true, "type": { "type": "text" } }));
    let blank = check(&mut admin, &model, &margin, "   ").await;
    assert_eq!(
        blank.json,
        json!({ "ok": true, "type": { "type": "number" } })
    );

    let unknown = check(&mut admin, &model, &margin, "Revnue - Cost").await;
    assert_eq!(unknown.status, StatusCode::OK, "{}", unknown.text);
    assert_eq!(unknown.json["ok"], false);
    assert!(unknown.json.get("type").is_none());
    let errors = unknown.json["errors"].as_array().unwrap();
    assert_eq!(errors.len(), 1, "{}", unknown.text);
    assert_eq!(errors[0]["code"], "formula.unknown_name");
    assert_eq!(errors[0]["suggestion"], "Revenue");
    assert_eq!(
        (errors[0]["start"].as_u64(), errors[0]["end"].as_u64()),
        (Some(0), Some(6))
    );
    assert!(
        errors[0]["message"]
            .as_str()
            .unwrap()
            .contains("Did you mean 'Revenue'?"),
        "{}",
        unknown.text
    );

    let two = check(&mut admin, &model, &margin, "Revnue - Cst").await;
    assert_eq!(two.json["errors"].as_array().unwrap().len(), 2);
    let syntax = check(&mut admin, &model, &margin, "Revenue -").await;
    assert_eq!(syntax.json["ok"], false);
    assert_eq!(syntax.json["errors"][0]["code"], "formula.syntax");
    let mismatch = check(&mut admin, &model, &margin, "Revenue & \"x\"").await;
    assert_eq!(mismatch.json["errors"][0]["code"], "formula.type_mismatch");
    assert_eq!(change_rows(&pool, &model).await, rows);

    let patched = patch_line_item(
        &mut admin,
        &model,
        &revenue,
        json!({ "formula": "Margin + 1" }),
    )
    .await;
    assert_eq!(patched.status, StatusCode::OK, "{}", patched.text);
    let rows = change_rows(&pool, &model).await;
    let cycle = check(&mut admin, &model, &margin, "Revenue").await;
    assert_eq!(cycle.json["ok"], false);
    assert_eq!(cycle.json["errors"][0]["code"], "formula.cycle");

    assert_eq!(change_rows(&pool, &model).await, rows);
    let doc = structure(&mut admin, &model).await;
    let stored = doc["line_items"]
        .as_array()
        .unwrap()
        .iter()
        .find(|line_item| line_item["id"] == margin)
        .unwrap();
    assert_eq!(stored["formula"], Value::Null);

    let missing = check(&mut admin, &model, &Uuid::now_v7().to_string(), "1").await;
    assert_problem(
        &missing,
        StatusCode::UNPROCESSABLE_ENTITY,
        "structure.invalid",
    );
    assert_eq!(missing.json["errors"][0]["field"], "line_item_id");
}

#[sqlx::test(migrator = "openplan_server::db::MIGRATOR")]
async fn invalid_formula_on_update_422(pool: PgPool) {
    let (mut admin, _, model) = plan(&pool).await;
    let module = create_module(&mut admin, &model, "Plan", vec![month()]).await;
    create_line_item(&mut admin, &model, &module, json!({ "name": "Revenue" })).await;
    let margin = id_of(
        &create_line_item(
            &mut admin,
            &model,
            &module,
            json!({ "name": "Margin", "formula": "Revenue * 2" }),
        )
        .await,
    );
    let rows = change_rows(&pool, &model).await;

    let unknown = patch_line_item(
        &mut admin,
        &model,
        &margin,
        json!({ "formula": "Revnue * 2" }),
    )
    .await;

    assert_problem(
        &unknown,
        StatusCode::UNPROCESSABLE_ENTITY,
        "formula.unknown_name",
    );
    assert_eq!(unknown.json["formula_errors"][0]["suggestion"], "Revenue");
    assert_eq!(unknown.json["formula_errors"][0]["start"], 0);
    assert_eq!(unknown.json["errors"][0]["field"], "formula");
    let syntax = patch_line_item(
        &mut admin,
        &model,
        &margin,
        json!({ "formula": "Revenue *" }),
    )
    .await;
    assert_problem(&syntax, StatusCode::UNPROCESSABLE_ENTITY, "formula.syntax");

    let rejected = admin
        .post(
            &url(&model, &format!("/modules/{module}/line-items")),
            Some(json!({ "name": "Broken", "formula": "Nothing + 1" })),
        )
        .await;
    assert_problem(
        &rejected,
        StatusCode::UNPROCESSABLE_ENTITY,
        "formula.unknown_name",
    );
    assert!(rejected.json["formula_errors"].is_array());

    assert_eq!(change_rows(&pool, &model).await, rows);
    let doc = structure(&mut admin, &model).await;
    assert_eq!(line_item_names(&doc, &module), ["Revenue", "Margin"]);
    let stored = doc["line_items"]
        .as_array()
        .unwrap()
        .iter()
        .find(|line_item| line_item["id"] == margin)
        .unwrap();
    assert_eq!(stored["formula"], "Revenue * 2");
}

fn labels(response: &TestResponse) -> Vec<String> {
    assert_eq!(response.status, StatusCode::OK, "{}", response.text);
    response
        .json
        .as_array()
        .unwrap()
        .iter()
        .map(|completion| completion["label"].as_str().unwrap().to_string())
        .collect()
}

fn completions_url(model: &str, line_item: &str, prefix: &str) -> String {
    url(
        model,
        &format!("/formula/completions?line_item_id={line_item}&prefix={prefix}"),
    )
}

#[sqlx::test(migrator = "openplan_server::db::MIGRATOR")]
async fn completions_prefix_and_order(pool: PgPool) {
    let (mut admin, workspace, model) = plan(&pool).await;
    create_list(&mut admin, &model, "Units of Measure").await;
    let plan_module = create_module(&mut admin, &model, "Plan", vec![month()]).await;
    let costs_module = create_module(&mut admin, &model, "Costs", vec![month()]).await;
    create_line_item(&mut admin, &model, &plan_module, json!({ "name": "Units" })).await;
    create_line_item(&mut admin, &model, &plan_module, json!({ "name": "Price" })).await;
    let revenue = id_of(
        &create_line_item(
            &mut admin,
            &model,
            &plan_module,
            json!({ "name": "Revenue" }),
        )
        .await,
    );
    create_line_item(&mut admin, &model, &costs_module, json!({ "name": "Cost" })).await;
    create_line_item(
        &mut admin,
        &model,
        &costs_module,
        json!({ "name": "Units Bought" }),
    )
    .await;

    let matched = admin.get(&completions_url(&model, &revenue, "UNI")).await;
    assert_eq!(
        labels(&matched),
        ["Units", "Costs.Units Bought", "Units of Measure"]
    );
    assert_eq!(
        matched.json[0],
        json!({ "label": "Units", "kind": "line_item", "detail": "Number" })
    );
    assert_eq!(matched.json[1]["kind"], "line_item");
    assert_eq!(matched.json[1]["detail"], "Number in Costs");
    assert_eq!(
        matched.json[2],
        json!({ "label": "Units of Measure", "kind": "list", "detail": "List" })
    );

    let everything = admin.get(&completions_url(&model, &revenue, "")).await;
    let all = labels(&everything);
    assert_eq!(all.len(), 50);
    assert_eq!(
        all[..5],
        [
            "Units",
            "Price",
            "Revenue",
            "Costs.Cost",
            "Costs.Units Bought"
        ]
    );

    let function = admin.get(&completions_url(&model, &revenue, "rou")).await;
    assert_eq!(labels(&function), ["ROUND"]);
    assert_eq!(function.json[0]["kind"], "function");
    assert!(
        function.json[0]["detail"]
            .as_str()
            .unwrap()
            .contains("Rounds")
    );
    let keyword = admin.get(&completions_url(&model, &revenue, "th")).await;
    assert_eq!(labels(&keyword), ["THEN"]);
    assert_eq!(keyword.json[0]["kind"], "keyword");
    let spaced = admin
        .get(&completions_url(&model, &revenue, "units%20b"))
        .await;
    assert_eq!(labels(&spaced), ["Costs.Units Bought"]);
    let none = admin.get(&completions_url(&model, &revenue, "zzz")).await;
    assert_eq!(none.json, json!([]));

    create_member(
        &mut admin,
        &workspace,
        "viewer@acme.com",
        "Vera Viewer",
        "viewer",
    )
    .await;
    let mut viewer = sign_in(&pool, "viewer@acme.com").await;
    let allowed = viewer.get(&completions_url(&model, &revenue, "rev")).await;
    assert_eq!(labels(&allowed), ["Revenue"]);

    let missing = admin
        .get(&url(&model, "/formula/completions?prefix=a"))
        .await;
    assert_problem(&missing, StatusCode::UNPROCESSABLE_ENTITY, "validation");
    assert_eq!(missing.json["errors"][0]["field"], "line_item_id");
    let unknown = admin
        .get(&completions_url(&model, &Uuid::now_v7().to_string(), "a"))
        .await;
    assert_problem(
        &unknown,
        StatusCode::UNPROCESSABLE_ENTITY,
        "structure.invalid",
    );
    assert_eq!(unknown.json["errors"][0]["field"], "line_item_id");
}

#[sqlx::test(migrator = "openplan_server::db::MIGRATOR")]
async fn completions_after_a_dot_offer_the_members(pool: PgPool) {
    let (mut admin, _, model) = plan(&pool).await;
    let countries = create_list(&mut admin, &model, "Countries").await;
    admin
        .post(
            &url(&model, &format!("/lists/{countries}/items")),
            Some(json!({ "items": [{ "name": "France" }, { "name": "Germany" }] })),
        )
        .await;
    let plan_module = create_module(&mut admin, &model, "Plan", vec![month()]).await;
    let loss_module = create_module(&mut admin, &model, "Profit & Loss", vec![month()]).await;
    let units = id_of(
        &create_line_item(&mut admin, &model, &plan_module, json!({ "name": "Units" })).await,
    );
    create_line_item(
        &mut admin,
        &model,
        &loss_module,
        json!({ "name": "Gross Margin" }),
    )
    .await;

    let own = admin.get(&completions_url(&model, &units, "Plan.U")).await;
    assert_eq!(labels(&own), ["Plan.Units"]);
    assert_eq!(
        own.json[0],
        json!({ "label": "Plan.Units", "kind": "line_item", "detail": "Number" })
    );
    let quoted = admin
        .get(&completions_url(
            &model,
            &units,
            "%27Profit%20%26%20Loss%27.Gr",
        ))
        .await;
    assert_eq!(labels(&quoted), ["'Profit & Loss'.Gross Margin"]);
    assert_eq!(quoted.json[0]["detail"], "Number in Profit & Loss");
    let items = admin
        .get(&completions_url(&model, &units, "Countries."))
        .await;
    assert_eq!(labels(&items), ["Countries.France", "Countries.Germany"]);
    assert_eq!(
        items.json[0],
        json!({ "label": "Countries.France", "kind": "item", "detail": "Item of Countries" })
    );
    let versions = admin
        .get(&completions_url(&model, &units, "Versions.b"))
        .await;
    assert_eq!(
        versions.json,
        json!([{ "label": "Versions.Budget", "kind": "version", "detail": "Version" }])
    );
    let periods = admin
        .get(&completions_url(&model, &units, "Time.%27q1"))
        .await;
    assert_eq!(
        labels(&periods),
        ["Time.'Q1 FY26'", "Time.'Q1 FY27'", "Time.'Q1 FY28'"]
    );
    assert_eq!(periods.json[0]["kind"], "period");
    assert_eq!(periods.json[0]["detail"], "Period");
    let rounding = admin.get(&completions_url(&model, &units, "near")).await;
    assert_eq!(
        rounding.json,
        json!([{ "label": "NEAREST", "kind": "keyword", "detail": "ROUND mode" }])
    );
    let nothing = admin
        .get(&completions_url(&model, &units, "Nowhere."))
        .await;
    assert_eq!(nothing.json, json!([]));
}

#[sqlx::test(migrator = "openplan_server::db::MIGRATOR")]
async fn concurrent_creates_in_one_module_get_distinct_ordinals(pool: PgPool) {
    let (mut admin, _, model) = plan(&pool).await;
    let module = create_module(&mut admin, &model, "Plan", vec![month()]).await;

    let mut creates = tokio::task::JoinSet::new();
    for number in 0..8 {
        let mut client = admin.fork();
        let path = url(&model, &format!("/modules/{module}/line-items"));
        creates.spawn(async move {
            client
                .post(&path, Some(json!({ "name": format!("Item {number}") })))
                .await
        });
    }
    let mut ordinals = Vec::new();
    while let Some(response) = creates.join_next().await {
        let response = response.unwrap();
        assert_eq!(response.status, StatusCode::CREATED, "{}", response.text);
        ordinals.push(response.json["ordinal"].as_i64().unwrap());
    }

    ordinals.sort_unstable();
    assert_eq!(ordinals, (0..8).collect::<Vec<i64>>());
    let doc = structure(&mut admin, &model).await;
    assert_eq!(line_item_names(&doc, &module).len(), 8);
}

#[sqlx::test(migrator = "openplan_server::db::MIGRATOR")]
async fn text_fields_have_length_limits(pool: PgPool) {
    let (mut admin, _, model) = plan(&pool).await;
    let module = create_module(&mut admin, &model, "Plan", vec![month()]).await;
    let line_item =
        id_of(&create_line_item(&mut admin, &model, &module, json!({ "name": "Units" })).await);
    let create = url(&model, &format!("/modules/{module}/line-items"));
    let at_limit_formula = format!("1{}", " ".repeat(9_999));

    let accepted = admin
        .post(
            &create,
            Some(json!({
                "name": "Edge",
                "notes": "n".repeat(2_000),
                "code": "c".repeat(80),
                "formula": at_limit_formula,
            })),
        )
        .await;
    assert_eq!(accepted.status, StatusCode::CREATED, "{}", accepted.text);
    let modules = admin
        .post(
            &url(&model, "/modules"),
            Some(json!({ "name": "Wide", "axes": [], "functional_area": "a".repeat(80) })),
        )
        .await;
    assert_eq!(modules.status, StatusCode::CREATED, "{}", modules.text);

    let too_long = |field: &str, text: String| {
        let mut body = json!({ "name": "Over" });
        body[field] = json!(text);
        body
    };
    for (field, text, message) in [
        (
            "notes",
            "n".repeat(2_001),
            "Notes must be at most 2000 characters.",
        ),
        (
            "code",
            "c".repeat(81),
            "Code must be at most 80 characters.",
        ),
        (
            "formula",
            format!("1{}", " ".repeat(10_000)),
            "Formula must be at most 10000 characters.",
        ),
    ] {
        let created = admin
            .post(&create, Some(too_long(field, text.clone())))
            .await;
        assert_problem(&created, StatusCode::UNPROCESSABLE_ENTITY, "validation");
        assert_eq!(created.json["errors"][0]["field"], field);
        assert_eq!(created.json["errors"][0]["message"], message);
        let patched = patch_line_item(&mut admin, &model, &line_item, json!({ field: text })).await;
        assert_problem(&patched, StatusCode::UNPROCESSABLE_ENTITY, "validation");
        assert_eq!(patched.json["errors"][0]["field"], field);
    }
    let checked = check(
        &mut admin,
        &model,
        &line_item,
        &format!("1{}", " ".repeat(10_000)),
    )
    .await;
    assert_problem(&checked, StatusCode::UNPROCESSABLE_ENTITY, "validation");
    assert_eq!(checked.json["errors"][0]["field"], "formula");
    let incomplete = admin
        .post(
            &url(&model, "/formula/check"),
            Some(json!({ "line_item_id": line_item })),
        )
        .await;
    assert_problem(&incomplete, StatusCode::UNPROCESSABLE_ENTITY, "validation");
    assert_eq!(incomplete.json["errors"][0]["field"], "formula");
    let area = "a".repeat(81);
    let created = admin
        .post(
            &url(&model, "/modules"),
            Some(json!({ "name": "Over", "axes": [], "functional_area": area })),
        )
        .await;
    assert_problem(&created, StatusCode::UNPROCESSABLE_ENTITY, "validation");
    assert_eq!(created.json["errors"][0]["field"], "functional_area");
    let patched = admin
        .patch(
            &url(&model, &format!("/modules/{module}")),
            Some(json!({ "functional_area": area })),
        )
        .await;
    assert_problem(&patched, StatusCode::UNPROCESSABLE_ENTITY, "validation");
    assert_eq!(
        patched.json["errors"][0]["message"],
        "Functional area must be at most 80 characters."
    );
}

#[sqlx::test(migrator = "openplan_server::db::MIGRATOR")]
async fn a_list_id_stands_in_for_a_module_id_to_create_list_properties(pool: PgPool) {
    let (mut admin, _, model) = plan(&pool).await;
    let regions = create_list(&mut admin, &model, "Regions").await;

    let created = create_line_item(
        &mut admin,
        &model,
        &regions,
        json!({ "name": "Population" }),
    )
    .await;

    assert_eq!(created["module"], regions);
    assert_eq!(created["name"], "Population");
    let doc = structure(&mut admin, &model).await;
    let properties = doc["modules"]
        .as_array()
        .unwrap()
        .iter()
        .find(|module| module["id"] == regions.as_str())
        .unwrap();
    assert_eq!(
        *properties,
        json!({
            "id": regions,
            "name": "Regions Properties",
            "axes": [list_axis(&regions)],
            "functional_area": "System",
        })
    );
    let nowhere = admin
        .post(
            &url(&model, &format!("/modules/{}/line-items", Uuid::now_v7())),
            Some(json!({ "name": "Nope" })),
        )
        .await;
    assert_problem(&nowhere, StatusCode::NOT_FOUND, "not_found");
}

/// The function names of the table in §4.5 of the design spec: every uppercase word outside the
/// brackets and parentheses of a row.
fn spec_function_names() -> Vec<String> {
    let spec = std::fs::read_to_string(SPEC).expect("the design spec is in the repository");
    let section = spec
        .split("### 4.5 Functions")
        .nth(1)
        .and_then(|rest| rest.split("\n### ").next())
        .expect("the spec has a section 4.5");
    let mut names = Vec::new();
    for row in section.lines().filter(|line| line.starts_with("| ")) {
        let row = row.replace("\\|", "/");
        let Some(cell) = row.split('|').nth(2) else {
            continue;
        };
        let (mut depth, mut word) = (0usize, String::new());
        for c in cell.chars().chain([' ']) {
            if c.is_ascii_uppercase() && depth == 0 {
                word.push(c);
                continue;
            }
            // A capital that starts a lowercase word, such as the F of "Functions", is no function.
            if c.is_ascii_lowercase() {
                word.clear();
            }
            if !word.is_empty() {
                names.push(std::mem::take(&mut word));
            }
            match c {
                '(' | '[' => depth += 1,
                ')' | ']' => depth = depth.saturating_sub(1),
                _ => {}
            }
        }
    }
    names
}

#[sqlx::test(migrator = "openplan_server::db::MIGRATOR")]
async fn functions_reference_lists_all_spec_functions(pool: PgPool) {
    let spec = spec_function_names();
    assert!(spec.len() >= 60, "{spec:?}");
    for anchor in [
        "ABS",
        "ROUND",
        "ISFIRSTOCCURRENCE",
        "CURRENTPERIODEND",
        "FV",
    ] {
        assert!(
            spec.iter().any(|name| name == anchor),
            "{anchor} in {spec:?}"
        );
    }
    let mut anonymous = TestApp::new(pool.clone());
    let unauthenticated = anonymous.get("/api/v1/formula/functions").await;
    assert_problem(
        &unauthenticated,
        StatusCode::UNAUTHORIZED,
        "auth.unauthenticated",
    );
    let (mut admin, _, _) = plan(&pool).await;

    let response = admin.get("/api/v1/formula/functions").await;

    assert_eq!(response.status, StatusCode::OK, "{}", response.text);
    let functions = response.json.as_array().unwrap();
    let names: Vec<&str> = functions
        .iter()
        .map(|function| function["name"].as_str().unwrap())
        .collect();
    let missing: Vec<&String> = spec
        .iter()
        .filter(|name| !names.contains(&name.as_str()))
        .collect();
    assert!(
        missing.is_empty(),
        "missing from the reference: {missing:?}"
    );
    for function in functions {
        for field in ["category", "doc", "example"] {
            assert!(
                !function[field].as_str().unwrap().is_empty(),
                "{} has no {field}",
                function["name"]
            );
        }
    }
    let round = functions
        .iter()
        .find(|function| function["name"] == "ROUND")
        .unwrap();
    assert_eq!(round["category"], "Math");
    assert_eq!(
        (round["min_args"].as_u64(), round["max_args"].as_u64()),
        (Some(2), Some(3))
    );
    let min = functions
        .iter()
        .find(|function| function["name"] == "MIN")
        .unwrap();
    assert_eq!(min["min_args"], 2);
    assert_eq!(min["max_args"], Value::Null);
}

#[sqlx::test(migrator = "openplan_server::db::MIGRATOR")]
async fn reorder_line_items(pool: PgPool) {
    let (mut admin, _, model) = plan(&pool).await;
    let module = create_module(&mut admin, &model, "Plan", vec![month()]).await;
    let other = create_module(&mut admin, &model, "Other", vec![month()]).await;
    let mut ids = Vec::new();
    for name in ["A", "B", "C"] {
        ids.push(id_of(
            &create_line_item(&mut admin, &model, &module, json!({ "name": name })).await,
        ));
    }
    let foreign =
        id_of(&create_line_item(&mut admin, &model, &other, json!({ "name": "F" })).await);
    let reorder = |module: &str, ids: Vec<&str>| {
        (
            url(&model, "/line-items/reorder"),
            json!({ "module_id": module, "ids": ids }),
        )
    };

    let (path, body) = reorder(&module, vec![&ids[2], &ids[0], &ids[1]]);
    let done = admin.post(&path, Some(body)).await;
    assert_eq!(done.status, StatusCode::NO_CONTENT, "{}", done.text);
    let doc = structure(&mut admin, &model).await;
    assert_eq!(line_item_names(&doc, &module), ["C", "A", "B"]);
    let ordinals: Vec<i64> = [&ids[2], &ids[0], &ids[1]]
        .iter()
        .map(|id| {
            doc["line_items"]
                .as_array()
                .unwrap()
                .iter()
                .find(|line_item| line_item["id"] == id.as_str())
                .unwrap()["ordinal"]
                .as_i64()
                .unwrap()
        })
        .collect();
    assert_eq!(ordinals, [0, 1, 2]);
    assert_eq!(line_item_names(&doc, &other), ["F"]);

    let rows = change_rows(&pool, &model).await;
    let (path, body) = reorder(&module, vec![&ids[2], &ids[0], &ids[1]]);
    let again = admin.post(&path, Some(body)).await;
    assert_eq!(again.status, StatusCode::NO_CONTENT, "{}", again.text);
    assert_eq!(change_rows(&pool, &model).await, rows);

    let (path, body) = reorder(&module, vec![&ids[0], &ids[1]]);
    let short = admin.post(&path, Some(body)).await;
    assert_problem(&short, StatusCode::UNPROCESSABLE_ENTITY, "validation");
    assert_eq!(short.json["errors"][0]["field"], "ids");
    let (path, body) = reorder(&module, vec![&ids[0], &ids[0], &ids[1], &ids[2]]);
    let twice = admin.post(&path, Some(body)).await;
    assert_problem(&twice, StatusCode::UNPROCESSABLE_ENTITY, "validation");
    let (path, body) = reorder(&module, vec![&ids[0], &ids[1], &foreign]);
    let strange = admin.post(&path, Some(body)).await;
    assert_problem(
        &strange,
        StatusCode::UNPROCESSABLE_ENTITY,
        "structure.invalid",
    );
    assert_eq!(strange.json["errors"][0]["field"], "ids[2]");
    let nowhere = Uuid::now_v7().to_string();
    let (path, body) = reorder(&nowhere, vec![&ids[0]]);
    let no_module = admin.post(&path, Some(body)).await;
    assert_problem(
        &no_module,
        StatusCode::UNPROCESSABLE_ENTITY,
        "structure.invalid",
    );
    assert_eq!(no_module.json["errors"][0]["field"], "module_id");
    let doc = structure(&mut admin, &model).await;
    assert_eq!(line_item_names(&doc, &module), ["C", "A", "B"]);
}

/// Every route that changes modules or line items, as a request that would be valid.
fn write_requests(
    model: &str,
    module: &str,
    line_item: &str,
) -> Vec<(Method, String, Option<Value>)> {
    vec![
        (
            Method::POST,
            url(model, "/modules"),
            Some(json!({ "name": "X", "axes": [] })),
        ),
        (
            Method::PATCH,
            url(model, &format!("/modules/{module}")),
            Some(json!({ "name": "X" })),
        ),
        (
            Method::DELETE,
            url(model, &format!("/modules/{module}")),
            None,
        ),
        (
            Method::POST,
            url(model, &format!("/modules/{module}/line-items")),
            Some(json!({ "name": "X" })),
        ),
        (
            Method::PATCH,
            url(model, &format!("/line-items/{line_item}")),
            Some(json!({ "name": "X" })),
        ),
        (
            Method::DELETE,
            url(model, &format!("/line-items/{line_item}")),
            None,
        ),
        (
            Method::POST,
            url(model, "/line-items/reorder"),
            Some(json!({ "module_id": module, "ids": [line_item] })),
        ),
        (
            Method::POST,
            url(model, "/formula/check"),
            Some(json!({ "line_item_id": line_item, "formula": "1" })),
        ),
    ]
}

#[sqlx::test(migrator = "openplan_server::db::MIGRATOR")]
async fn planner_cannot_create_module(pool: PgPool) {
    let (mut admin, workspace, model) = plan(&pool).await;
    let module = create_module(&mut admin, &model, "Plan", vec![month()]).await;
    let line_item =
        id_of(&create_line_item(&mut admin, &model, &module, json!({ "name": "Units" })).await);
    create_member(
        &mut admin,
        &workspace,
        "pat@acme.com",
        "Pat Planner",
        "planner",
    )
    .await;
    create_member(
        &mut admin,
        &workspace,
        "vera@acme.com",
        "Vera Viewer",
        "viewer",
    )
    .await;
    let rows = change_rows(&pool, &model).await;

    for email in ["pat@acme.com", "vera@acme.com"] {
        let mut member = sign_in(&pool, email).await;
        let created = member
            .post(
                &url(&model, "/modules"),
                Some(json!({ "name": "Nope", "axes": [] })),
            )
            .await;
        assert_problem(&created, StatusCode::FORBIDDEN, "auth.forbidden");
        for (method, path, body) in write_requests(&model, &module, &line_item) {
            let response = member.request(method.clone(), &path, body).await;
            assert_problem(&response, StatusCode::FORBIDDEN, "auth.forbidden");
        }
        let doc = member.get(&url(&model, "/structure")).await;
        assert_eq!(doc.status, StatusCode::OK, "{}", doc.text);
    }

    assert_eq!(change_rows(&pool, &model).await, rows);
    assert_eq!(
        structure(&mut admin, &model).await["modules"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
}

#[sqlx::test(migrator = "openplan_server::db::MIGRATOR")]
async fn production_mode_blocks_modules(pool: PgPool) {
    let (mut admin, _, model) = plan(&pool).await;
    let module = create_module(&mut admin, &model, "Plan", vec![month()]).await;
    let line_item =
        id_of(&create_line_item(&mut admin, &model, &module, json!({ "name": "Units" })).await);
    let production = admin
        .patch(&url(&model, ""), Some(json!({ "mode": "prod" })))
        .await;
    assert_eq!(production.status, StatusCode::OK, "{}", production.text);

    for (method, path, body) in write_requests(&model, &module, &line_item) {
        if path.ends_with("/formula/check") {
            continue;
        }
        let response = admin.request(method, &path, body).await;
        assert_problem(&response, StatusCode::CONFLICT, "model.production_locked");
        assert_eq!(response.json["detail"], PRODUCTION_LOCKED);
    }
    let checked = check(&mut admin, &model, &line_item, "1 + 1").await;
    assert_eq!(checked.json["ok"], true, "{}", checked.text);
    let completions = admin.get(&completions_url(&model, &line_item, "un")).await;
    assert_eq!(labels(&completions), ["Units"]);
    assert_eq!(
        structure(&mut admin, &model).await["modules"]
            .as_array()
            .unwrap()
            .len(),
        1
    );

    let development = admin
        .patch(&url(&model, ""), Some(json!({ "mode": "dev" })))
        .await;
    assert_eq!(development.status, StatusCode::OK, "{}", development.text);
    let created = admin
        .post(
            &url(&model, "/modules"),
            Some(json!({ "name": "Costs", "axes": [] })),
        )
        .await;
    assert_eq!(created.status, StatusCode::CREATED, "{}", created.text);
}

#[sqlx::test(migrator = "openplan_server::db::MIGRATOR")]
async fn non_members_get_not_found(pool: PgPool) {
    let (mut admin, _, model) = plan(&pool).await;
    let module = create_module(&mut admin, &model, "Plan", vec![month()]).await;
    let line_item =
        id_of(&create_line_item(&mut admin, &model, &module, json!({ "name": "Units" })).await);
    create_user(&mut admin, "outsider@acme.com", "Outsider").await;
    let mut outsider = sign_in(&pool, "outsider@acme.com").await;

    for (method, path, body) in write_requests(&model, &module, &line_item) {
        let response = outsider.request(method, &path, body).await;
        assert_problem(&response, StatusCode::NOT_FOUND, "not_found");
    }
    let completions = outsider
        .get(&completions_url(&model, &line_item, "u"))
        .await;
    assert_problem(&completions, StatusCode::NOT_FOUND, "not_found");

    let unknown = Uuid::now_v7().to_string();
    for (method, path, body) in write_requests(&unknown, &module, &line_item) {
        let response = admin.request(method, &path, body).await;
        assert_problem(&response, StatusCode::NOT_FOUND, "not_found");
    }
}

#[sqlx::test(migrator = "openplan_server::db::MIGRATOR")]
async fn number_formats_are_validated(pool: PgPool) {
    let (mut admin, _, model) = plan(&pool).await;
    let module = create_module(&mut admin, &model, "Plan", vec![month()]).await;
    let line_item =
        id_of(&create_line_item(&mut admin, &model, &module, json!({ "name": "Units" })).await);
    let number = |decimals: u32, unit: Value| {
        json!({
            "type": "number",
            "decimals": decimals,
            "thousands_sep": true,
            "unit": unit,
            "negative": "minus",
        })
    };
    let fields = |response: &TestResponse| -> Vec<String> {
        response.json["errors"]
            .as_array()
            .map(|errors| {
                errors
                    .iter()
                    .map(|error| error["field"].as_str().unwrap().to_string())
                    .collect()
            })
            .unwrap_or_default()
    };

    for code in ["usd", "US", "USDX", "U5D", "€UR", ""] {
        let unit = json!({ "type": "currency", "code": code });
        let created = admin
            .post(
                &url(&model, &format!("/modules/{module}/line-items")),
                Some(json!({ "name": "Bad", "format": number(2, unit.clone()) })),
            )
            .await;
        assert_problem(&created, StatusCode::UNPROCESSABLE_ENTITY, "validation");
        assert_eq!(fields(&created), ["format.unit.code"], "{code}");
        let patched = patch_line_item(
            &mut admin,
            &model,
            &line_item,
            json!({ "format": number(2, unit) }),
        )
        .await;
        assert_problem(&patched, StatusCode::UNPROCESSABLE_ENTITY, "validation");
        assert_eq!(fields(&patched), ["format.unit.code"], "{code}");
    }
    let decimals = patch_line_item(
        &mut admin,
        &model,
        &line_item,
        json!({ "format": number(11, json!({ "type": "none" })) }),
    )
    .await;
    assert_problem(&decimals, StatusCode::UNPROCESSABLE_ENTITY, "validation");
    assert_eq!(fields(&decimals), ["format.decimals"]);
    assert_eq!(
        decimals.json["errors"][0]["message"],
        "Decimals must be between 0 and 10."
    );
    let enormous = patch_line_item(
        &mut admin,
        &model,
        &line_item,
        json!({ "format": number(300, json!({ "type": "none" })) }),
    )
    .await;
    assert_eq!(fields(&enormous), ["format.decimals"]);
    assert_eq!(
        enormous.json["errors"][0]["message"],
        "Decimals must be between 0 and 10."
    );
    let both = patch_line_item(
        &mut admin,
        &model,
        &line_item,
        json!({ "format": number(12, json!({ "type": "currency", "code": "eur" })) }),
    )
    .await;
    assert_eq!(fields(&both), ["format.decimals", "format.unit.code"]);

    for (decimals, unit) in [
        (0, json!({ "type": "currency", "code": "USD" })),
        (10, json!({ "type": "percent" })),
        (3, json!({ "type": "none" })),
    ] {
        let accepted = patch_line_item(
            &mut admin,
            &model,
            &line_item,
            json!({ "format": number(decimals, unit) }),
        )
        .await;
        assert_eq!(accepted.status, StatusCode::OK, "{}", accepted.text);
    }
    let doc = structure(&mut admin, &model).await;
    assert_eq!(doc["line_items"][0]["format"]["decimals"], 3);
}

#[sqlx::test(migrator = "openplan_server::db::MIGRATOR")]
async fn references_in_bodies_that_do_not_exist_are_422(pool: PgPool) {
    let (mut admin, _, model) = plan(&pool).await;
    let module = create_module(&mut admin, &model, "Plan", vec![month()]).await;
    let line_item =
        id_of(&create_line_item(&mut admin, &model, &module, json!({ "name": "Units" })).await);
    let nothing = Uuid::now_v7().to_string();
    let rows = change_rows(&pool, &model).await;
    let create = |body: Value| {
        (
            Method::POST,
            url(&model, &format!("/modules/{module}/line-items")),
            body,
        )
    };
    let patch = |body: Value| {
        (
            Method::PATCH,
            url(&model, &format!("/line-items/{line_item}")),
            body,
        )
    };

    let cases: Vec<((Method, String, Value), &str)> = vec![
        (
            (
                Method::POST,
                url(&model, "/modules"),
                json!({ "name": "X", "axes": [month(), list_axis(&nothing)] }),
            ),
            "axes[1].list",
        ),
        (
            (
                Method::POST,
                url(&model, "/modules"),
                json!({ "name": "X", "axes": [{ "kind": "subset", "subset": nothing }] }),
            ),
            "axes[0].subset",
        ),
        (
            (
                Method::POST,
                url(&model, "/modules"),
                json!({ "name": "X", "axes": [{ "kind": "time", "level": "month", "range": nothing }] }),
            ),
            "axes[0].range",
        ),
        (
            (
                Method::PATCH,
                url(&model, &format!("/modules/{module}")),
                json!({ "axes": [list_axis(&nothing)] }),
            ),
            "axes[0].list",
        ),
        (
            create(json!({ "name": "X", "format": { "type": "list", "list": nothing } })),
            "format.list",
        ),
        (
            patch(
                json!({ "format": { "type": "time_period", "level": "month" }, "summary": { "method": "ratio", "numerator": nothing, "denominator": line_item } }),
            ),
            "summary.numerator",
        ),
        (
            create(
                json!({ "name": "X", "time_summary": { "method": "ratio", "numerator": line_item, "denominator": nothing } }),
            ),
            "time_summary.denominator",
        ),
        (
            create(json!({ "name": "X", "applies_to": [list_axis(&nothing)] })),
            "applies_to[0].list",
        ),
        (
            create(json!({ "name": "X", "versions": { "only": [nothing] } })),
            "versions.only[0]",
        ),
        (
            patch(json!({ "read_access_driver": nothing })),
            "read_access_driver",
        ),
        (
            create(json!({ "name": "X", "write_access_driver": nothing })),
            "write_access_driver",
        ),
    ];
    for ((method, path, body), field) in cases {
        let response = admin.request(method, &path, Some(body)).await;
        assert_problem(
            &response,
            StatusCode::UNPROCESSABLE_ENTITY,
            "structure.invalid",
        );
        assert_eq!(
            response.json["errors"][0]["field"], field,
            "{}",
            response.text
        );
        assert!(
            response.json["errors"][0]["message"]
                .as_str()
                .unwrap()
                .ends_with("does not exist."),
            "{}",
            response.text
        );
    }
    assert_eq!(change_rows(&pool, &model).await, rows);

    let several = admin
        .post(
            &url(&model, "/modules"),
            Some(json!({ "name": "X", "axes": [list_axis(&nothing), { "kind": "subset", "subset": nothing }] })),
        )
        .await;
    assert_problem(
        &several,
        StatusCode::UNPROCESSABLE_ENTITY,
        "structure.invalid",
    );
    assert_eq!(several.json["errors"].as_array().unwrap().len(), 2);

    let unknown_module = admin
        .patch(
            &url(&model, &format!("/modules/{nothing}")),
            Some(json!({ "name": "Y" })),
        )
        .await;
    assert_problem(&unknown_module, StatusCode::NOT_FOUND, "not_found");
    let no_module_for_item = admin
        .post(
            &url(&model, &format!("/modules/{nothing}/line-items")),
            Some(json!({ "name": "Y" })),
        )
        .await;
    assert_problem(&no_module_for_item, StatusCode::NOT_FOUND, "not_found");
    let unknown_line_item =
        patch_line_item(&mut admin, &model, &nothing, json!({ "name": "Y" })).await;
    assert_problem(&unknown_line_item, StatusCode::NOT_FOUND, "not_found");
    let deleted = admin
        .delete(&url(&model, &format!("/line-items/{nothing}")))
        .await;
    assert_problem(&deleted, StatusCode::NOT_FOUND, "not_found");
    let deleted = admin
        .delete(&url(&model, &format!("/modules/{nothing}")))
        .await;
    assert_problem(&deleted, StatusCode::NOT_FOUND, "not_found");
}

#[sqlx::test(migrator = "openplan_server::db::MIGRATOR")]
async fn names_must_be_valid_and_unique(pool: PgPool) {
    let (mut admin, _, model) = plan(&pool).await;
    let module = create_module(&mut admin, &model, "Plan", vec![month()]).await;
    create_line_item(&mut admin, &model, &module, json!({ "name": "Units" })).await;

    let duplicate = admin
        .post(
            &url(&model, "/modules"),
            Some(json!({ "name": "plan", "axes": [] })),
        )
        .await;
    assert_problem(&duplicate, StatusCode::CONFLICT, "structure.name_taken");
    let blank = admin
        .post(
            &url(&model, "/modules"),
            Some(json!({ "name": "  ", "axes": [] })),
        )
        .await;
    assert_problem(&blank, StatusCode::UNPROCESSABLE_ENTITY, "validation");
    assert_eq!(blank.json["errors"][0]["field"], "name");
    let too_long = admin
        .post(
            &url(&model, "/modules"),
            Some(json!({ "name": "x".repeat(81), "axes": [] })),
        )
        .await;
    assert_problem(&too_long, StatusCode::UNPROCESSABLE_ENTITY, "validation");
    let twice = admin
        .post(
            &url(&model, &format!("/modules/{module}/line-items")),
            Some(json!({ "name": " UNITS " })),
        )
        .await;
    assert_problem(&twice, StatusCode::CONFLICT, "structure.name_taken");
    let blank_item = admin
        .post(
            &url(&model, &format!("/modules/{module}/line-items")),
            Some(json!({ "name": "" })),
        )
        .await;
    assert_problem(&blank_item, StatusCode::UNPROCESSABLE_ENTITY, "validation");
    let no_name = admin
        .post(
            &url(&model, &format!("/modules/{module}/line-items")),
            Some(json!({})),
        )
        .await;
    assert_problem(&no_name, StatusCode::UNPROCESSABLE_ENTITY, "validation");
    assert_eq!(no_name.json["errors"][0]["field"], "name");
    let twice_axis = admin
        .post(
            &url(&model, "/modules"),
            Some(json!({ "name": "Two times", "axes": [month(), month()] })),
        )
        .await;
    assert_problem(
        &twice_axis,
        StatusCode::UNPROCESSABLE_ENTITY,
        "structure.invalid",
    );
}

#[sqlx::test(migrator = "openplan_server::db::MIGRATOR")]
async fn modules_and_formulas_survive_unloading_the_model(pool: PgPool) {
    let (mut admin, _, model) = plan(&pool).await;
    let module = create_module(&mut admin, &model, "Plan", vec![month()]).await;
    create_line_item(&mut admin, &model, &module, json!({ "name": "Units" })).await;
    create_line_item(
        &mut admin,
        &model,
        &module,
        json!({ "name": "Double", "formula": "Units * 2" }),
    )
    .await;
    let before = structure(&mut admin, &model).await;

    admin.state.models.shutdown().await;

    assert_eq!(structure(&mut admin, &model).await, before);
}
