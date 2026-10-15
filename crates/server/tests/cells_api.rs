mod common;

use std::collections::BTreeMap;

use axum::http::{Method, StatusCode};
use common::{
    PASSWORD, TestApp, TestResponse, assert_problem, create_member, create_model, create_user,
    setup_admin, sign_in,
};
use openplan_server::auth::{CSRF_COOKIE, SESSION_COOKIE};
use serde_json::{Value, json};
use sqlx::PgPool;
use uuid::Uuid;

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

/// A client signed in as `email` on the same server as `app`, which is the same models in memory
/// (`sign_in` starts a server of its own, and a model has one actor on each).
async fn sign_in_beside(app: &TestApp, email: &str) -> TestApp {
    let mut other = app.fork();
    other.forget_cookie(SESSION_COOKIE);
    other.forget_cookie(CSRF_COOKIE);
    let response = other
        .post(
            "/api/v1/auth/login",
            Some(json!({ "email": email, "password": PASSWORD })),
        )
        .await;
    assert_eq!(response.status, StatusCode::OK, "{}", response.text);
    other
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

fn quarter() -> Value {
    json!({ "kind": "time", "level": "quarter", "range": null })
}

fn versions() -> Value {
    json!({ "kind": "versions" })
}

fn list_axis(list: &str) -> Value {
    json!({ "kind": "list", "list": list })
}

fn percent() -> Value {
    json!({
        "type": "number",
        "decimals": 1,
        "thousands_sep": false,
        "unit": { "type": "percent" },
        "negative": "minus",
    })
}

fn number(value: f64) -> Value {
    json!({ "t": "number", "v": value })
}

/// The tokens that address a cell, one for each axis of its line item.
fn at<const N: usize>(tokens: [&str; N]) -> Vec<&str> {
    tokens.to_vec()
}

fn edit(line_item: &str, coords: Vec<&str>, value: Value) -> Value {
    json!({ "line_item_id": line_item, "coords": coords, "value": value })
}

async fn create_list(app: &mut TestApp, model: &str, body: Value) -> String {
    let response = app.post(&url(model, "/lists"), Some(body)).await;
    assert_eq!(response.status, StatusCode::CREATED, "{}", response.text);
    id_of(&response.json)
}

async fn create_items(app: &mut TestApp, model: &str, list: &str, items: Value) -> Vec<String> {
    let response = app
        .post(
            &url(model, &format!("/lists/{list}/items")),
            Some(json!({ "items": items })),
        )
        .await;
    assert_eq!(response.status, StatusCode::CREATED, "{}", response.text);
    response
        .json
        .as_array()
        .unwrap()
        .iter()
        .map(id_of)
        .collect()
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

async fn create_line_item(app: &mut TestApp, model: &str, module: &str, body: Value) -> String {
    let response = app
        .post(
            &url(model, &format!("/modules/{module}/line-items")),
            Some(body),
        )
        .await;
    assert_eq!(response.status, StatusCode::CREATED, "{}", response.text);
    id_of(&response.json)
}

async fn version_id(app: &mut TestApp, model: &str, name: &str) -> String {
    let structure = app.get(&url(model, "/structure")).await;
    assert_eq!(structure.status, StatusCode::OK, "{}", structure.text);
    structure.json["versions"]
        .as_array()
        .unwrap()
        .iter()
        .find(|version| version["name"] == name)
        .map(id_of)
        .unwrap()
}

async fn write(app: &mut TestApp, model: &str, edits: Vec<Value>) -> TestResponse {
    app.post(&url(model, "/cells"), Some(json!({ "edits": edits })))
        .await
}

async fn write_ok(app: &mut TestApp, model: &str, edits: Vec<Value>) -> Value {
    let response = write(app, model, edits).await;
    assert_eq!(response.status, StatusCode::OK, "{}", response.text);
    response.json
}

async fn read(
    app: &mut TestApp,
    model: &str,
    line_item: &str,
    cells: Vec<Vec<&str>>,
) -> TestResponse {
    app.post(
        &url(model, "/cells/read"),
        Some(json!({ "line_item_id": line_item, "cells": cells })),
    )
    .await
}

async fn read_values(
    app: &mut TestApp,
    model: &str,
    line_item: &str,
    cells: Vec<Vec<&str>>,
) -> Vec<Value> {
    let response = read(app, model, line_item, cells).await;
    assert_eq!(response.status, StatusCode::OK, "{}", response.text);
    response.json["values"].as_array().unwrap().clone()
}

async fn read_numbers(
    app: &mut TestApp,
    model: &str,
    line_item: &str,
    cells: Vec<Vec<&str>>,
) -> Vec<f64> {
    read_values(app, model, line_item, cells)
        .await
        .iter()
        .map(|value| {
            assert_eq!(value["t"], "number", "{value}");
            value["v"].as_f64().unwrap()
        })
        .collect()
}

fn assert_close(found: &[f64], expected: &[f64]) {
    assert_eq!(
        found.len(),
        expected.len(),
        "{found:?} against {expected:?}"
    );
    for (found, expected) in found.iter().zip(expected) {
        assert!(
            (found - expected).abs() < 1e-9,
            "{found:?} against {expected:?}"
        );
    }
}

/// Every change-log row of a model, whatever its kind.
async fn change_rows(pool: &PgPool, model: &str) -> i64 {
    sqlx::query_scalar("SELECT count(*) FROM change_log WHERE model_id = $1")
        .bind(Uuid::parse_str(model).unwrap())
        .fetch_one(pool)
        .await
        .unwrap()
}

async fn history(app: &mut TestApp, model: &str, line_item: &str, cell_key: &str) -> TestResponse {
    app.get(&format!(
        "{}?line_item_id={line_item}&cell_key={}",
        url(model, "/cells/history"),
        cell_key.replace(' ', "%20").replace('|', "%7C"),
    ))
    .await
}

/// Regions {North America, Europe} (top level "All Regions") over Countries {US, CA in North
/// America; DE, FR in Europe}.
struct Geography {
    regions: String,
    countries: String,
    na: String,
    eu: String,
    us: String,
    ca: String,
    de: String,
    fr: String,
}

async fn geography(app: &mut TestApp, model: &str) -> Geography {
    let regions = create_list(
        app,
        model,
        json!({ "name": "Regions", "top_level_name": "All Regions" }),
    )
    .await;
    let countries = create_list(
        app,
        model,
        json!({ "name": "Countries", "parent_list_id": regions }),
    )
    .await;
    let areas = create_items(
        app,
        model,
        &regions,
        json!([{ "name": "North America" }, { "name": "Europe" }]),
    )
    .await;
    let (na, eu) = (areas[0].clone(), areas[1].clone());
    let nations = create_items(
        app,
        model,
        &countries,
        json!([
            { "name": "US", "parent_id": na },
            { "name": "CA", "parent_id": na },
            { "name": "DE", "parent_id": eu },
            { "name": "FR", "parent_id": eu },
        ]),
    )
    .await;
    Geography {
        regions,
        countries,
        na,
        eu,
        us: nations[0].clone(),
        ca: nations[1].clone(),
        de: nations[2].clone(),
        fr: nations[3].clone(),
    }
}

/// The budget model of the scenario: revenue by country and month in every version, and a
/// summary by region and quarter.
struct Budget {
    geography: Geography,
    budget: String,
    actual: String,
    units: String,
    price: String,
    revenue: String,
    growth: String,
    cumulative: String,
    regional_revenue: String,
}

async fn budget_model(app: &mut TestApp, model: &str) -> Budget {
    let geography = geography(app, model).await;
    let plan = create_module(
        app,
        model,
        "Revenue Plan",
        vec![list_axis(&geography.countries), month(), versions()],
    )
    .await;
    let units = create_line_item(app, model, &plan, json!({ "name": "Units" })).await;
    let price = create_line_item(app, model, &plan, json!({ "name": "Price" })).await;
    let revenue = create_line_item(
        app,
        model,
        &plan,
        json!({ "name": "Revenue", "formula": "Units * Price" }),
    )
    .await;
    let growth = create_line_item(
        app,
        model,
        &plan,
        json!({
            "name": "Growth %",
            "format": percent(),
            "formula": "IF PREVIOUS(Revenue) = 0 THEN 0 ELSE Revenue / PREVIOUS(Revenue) - 1",
        }),
    )
    .await;
    let cumulative = create_line_item(
        app,
        model,
        &plan,
        json!({ "name": "Cumulative Revenue", "formula": "CUMULATE(Revenue)" }),
    )
    .await;
    let summary = create_module(
        app,
        model,
        "Regional Summary",
        vec![list_axis(&geography.regions), quarter()],
    )
    .await;
    let regional_revenue = create_line_item(
        app,
        model,
        &summary,
        json!({
            "name": "Revenue",
            "formula": "'Revenue Plan'.Revenue[SELECT: Versions.Budget]",
        }),
    )
    .await;
    Budget {
        budget: version_id(app, model, "Budget").await,
        actual: version_id(app, model, "Actual").await,
        geography,
        units,
        price,
        revenue,
        growth,
        cumulative,
        regional_revenue,
    }
}

const MONTHS: [&str; 3] = ["Jan 26", "Feb 26", "Mar 26"];

/// Units and prices for January to March in the budget version.
fn budget_inputs(model: &Budget) -> Vec<Value> {
    let g = &model.geography;
    let units = [
        (&g.us, [10.0, 20.0, 30.0]),
        (&g.ca, [5.0, 5.0, 5.0]),
        (&g.de, [8.0, 8.0, 16.0]),
        (&g.fr, [2.0, 4.0, 6.0]),
    ];
    let prices = [
        (&g.us, [10.0, 10.0, 11.0]),
        (&g.ca, [8.0, 8.0, 8.0]),
        (&g.de, [12.0, 12.0, 12.0]),
        (&g.fr, [15.0, 15.0, 15.0]),
    ];
    let mut edits = Vec::new();
    for (line_item, rows) in [(&model.units, units), (&model.price, prices)] {
        for (country, values) in rows {
            for (label, value) in MONTHS.iter().zip(values) {
                edits.push(edit(
                    line_item,
                    vec![country, label, &model.budget],
                    number(value),
                ));
            }
        }
    }
    edits
}

/// The cells of the first four months of every country that the scenario follows, by line item,
/// country and month, in the budget version.
async fn follow(
    app: &mut TestApp,
    model_id: &str,
    model: &Budget,
) -> BTreeMap<(String, String, String), f64> {
    let g = &model.geography;
    let mut cells = BTreeMap::new();
    for (name, line_item) in [
        ("Units", &model.units),
        ("Price", &model.price),
        ("Revenue", &model.revenue),
        ("Growth", &model.growth),
        ("Cumulative", &model.cumulative),
    ] {
        for (country, country_id) in [("US", &g.us), ("CA", &g.ca), ("DE", &g.de), ("FR", &g.fr)] {
            let months = ["Jan 26", "Feb 26", "Mar 26", "Apr 26"];
            let found = read_numbers(
                app,
                model_id,
                line_item,
                months
                    .iter()
                    .map(|label| vec![country_id.as_str(), label, model.budget.as_str()])
                    .collect(),
            )
            .await;
            for (label, value) in months.iter().zip(found) {
                cells.insert(
                    (name.to_string(), country.to_string(), label.to_string()),
                    value,
                );
            }
        }
    }
    cells
}

#[sqlx::test(migrator = "openplan_server::db::MIGRATOR")]
async fn scenario_budget_model(pool: PgPool) {
    let (mut admin, _, id) = plan(&pool).await;
    let model = budget_model(&mut admin, &id).await;
    let g = &model.geography;
    let budget = model.budget.as_str();

    let written = write_ok(&mut admin, &id, budget_inputs(&model)).await;

    let mut changed: Vec<&str> = written["changed_line_item_ids"]
        .as_array()
        .unwrap()
        .iter()
        .map(|id| id.as_str().unwrap())
        .collect();
    changed.sort_unstable();
    let mut expected = vec![
        model.units.as_str(),
        model.price.as_str(),
        model.revenue.as_str(),
        model.growth.as_str(),
        model.cumulative.as_str(),
        model.regional_revenue.as_str(),
    ];
    expected.sort_unstable();
    assert_eq!(changed, expected);
    assert!(written["seq"].as_i64().unwrap() > 0);

    // Revenue is units times price, country by country and month by month.
    assert_close(
        &read_numbers(
            &mut admin,
            &id,
            &model.revenue,
            vec![
                at([&g.us, "Jan 26", budget]),
                at([&g.us, "Feb 26", budget]),
                at([&g.us, "Mar 26", budget]),
                at([&g.ca, "Feb 26", budget]),
                at([&g.de, "Mar 26", budget]),
                at([&g.fr, "Mar 26", budget]),
                at([&g.fr, "Apr 26", budget]),
            ],
        )
        .await,
        &[100.0, 200.0, 330.0, 40.0, 192.0, 90.0, 0.0],
    );

    // The summary by region and quarter, and the total of all regions.
    assert_close(
        &read_numbers(
            &mut admin,
            &id,
            &model.regional_revenue,
            vec![
                at([&g.na, "Q1 FY26"]),
                at([&g.eu, "Q1 FY26"]),
                at(["top", "Q1 FY26"]),
                at(["top", "FY26"]),
                at(["top", "Total"]),
                at([&g.na, "Q2 FY26"]),
            ],
        )
        .await,
        &[750.0, 564.0, 1314.0, 1314.0, 1314.0, 0.0],
    );

    // The module that holds the revenue rolls up the same way, version by version.
    assert_close(
        &read_numbers(
            &mut admin,
            &id,
            &model.revenue,
            vec![
                at([&g.na, "Q1 FY26", budget]),
                at(["top", "Total", budget]),
                at(["top", "Total", &model.actual]),
            ],
        )
        .await,
        &[750.0, 1314.0, 0.0],
    );

    // Growth compares each month with the one before it.
    assert_close(
        &read_numbers(
            &mut admin,
            &id,
            &model.growth,
            vec![
                at([&g.us, "Jan 26", budget]),
                at([&g.us, "Feb 26", budget]),
                at([&g.us, "Mar 26", budget]),
                at([&g.us, "Apr 26", budget]),
                at([&g.ca, "Feb 26", budget]),
            ],
        )
        .await,
        &[0.0, 1.0, 0.65, -1.0, 0.0],
    );

    // Cumulative revenue adds the months up.
    assert_close(
        &read_numbers(
            &mut admin,
            &id,
            &model.cumulative,
            vec![
                at([&g.us, "Jan 26", budget]),
                at([&g.us, "Feb 26", budget]),
                at([&g.us, "Mar 26", budget]),
                at([&g.us, "Apr 26", budget]),
                at([&g.fr, "Mar 26", budget]),
            ],
        )
        .await,
        &[100.0, 300.0, 630.0, 630.0, 180.0],
    );

    // Editing one cell changes the cells that depend on it and no others.
    let before = follow(&mut admin, &id, &model).await;
    let edited = write_ok(
        &mut admin,
        &id,
        vec![edit(
            &model.units,
            at([&g.us, "Feb 26", budget]),
            number(25.0),
        )],
    )
    .await;
    let after = follow(&mut admin, &id, &model).await;

    let differing: Vec<(&str, &str, &str)> = after
        .iter()
        .filter(|(key, value)| (before[*key] - **value).abs() > 1e-9)
        .map(|((name, country, label), _)| (name.as_str(), country.as_str(), label.as_str()))
        .collect();
    assert_eq!(
        differing,
        vec![
            ("Cumulative", "US", "Apr 26"),
            ("Cumulative", "US", "Feb 26"),
            ("Cumulative", "US", "Mar 26"),
            ("Growth", "US", "Feb 26"),
            ("Growth", "US", "Mar 26"),
            ("Revenue", "US", "Feb 26"),
            ("Units", "US", "Feb 26"),
        ]
    );
    let cell =
        |name: &str, label: &str| after[&(name.to_string(), "US".to_string(), label.to_string())];
    assert_close(
        &[
            cell("Revenue", "Feb 26"),
            cell("Growth", "Feb 26"),
            cell("Growth", "Mar 26"),
            cell("Cumulative", "Mar 26"),
        ],
        &[250.0, 1.5, 0.32, 680.0],
    );
    assert_close(
        &read_numbers(
            &mut admin,
            &id,
            &model.regional_revenue,
            vec![
                at([&g.na, "Q1 FY26"]),
                at([&g.eu, "Q1 FY26"]),
                at(["top", "Q1 FY26"]),
            ],
        )
        .await,
        &[800.0, 564.0, 1364.0],
    );
    let mut changed: Vec<&str> = edited["changed_line_item_ids"]
        .as_array()
        .unwrap()
        .iter()
        .map(|id| id.as_str().unwrap())
        .collect();
    changed.sort_unstable();
    let mut expected = vec![
        model.units.as_str(),
        model.revenue.as_str(),
        model.growth.as_str(),
        model.cumulative.as_str(),
        model.regional_revenue.as_str(),
    ];
    expected.sort_unstable();
    assert_eq!(changed, expected, "the price did not change");
}

#[sqlx::test(migrator = "openplan_server::db::MIGRATOR")]
async fn batch_with_invalid_cell_rejected_atomically(pool: PgPool) {
    let (mut admin, _, id) = plan(&pool).await;
    let model = budget_model(&mut admin, &id).await;
    let g = &model.geography;
    let budget = model.budget.as_str();
    let rows = change_rows(&pool, &id).await;

    let response = write(
        &mut admin,
        &id,
        vec![
            edit(&model.units, at([&g.us, "Jan 26", budget]), number(10.0)),
            edit(
                &model.units,
                at([&g.us, "Feb 26", budget]),
                json!({ "t": "text", "v": "many" }),
            ),
            edit(&model.units, at([&g.us, "Mar 26", budget]), number(30.0)),
            edit(
                &model.units,
                at([&g.ca, "Jan 26", budget]),
                json!({ "t": "boolean", "v": true }),
            ),
        ],
    )
    .await;

    assert_problem(
        &response,
        StatusCode::UNPROCESSABLE_ENTITY,
        "cells.invalid_value",
    );
    let fields: Vec<&str> = response.json["errors"]
        .as_array()
        .unwrap()
        .iter()
        .map(|error| error["field"].as_str().unwrap())
        .collect();
    assert_eq!(fields, ["cells[1]", "cells[3]"]);
    assert_eq!(response.json["errors"][0]["message"], "Expected a number.");
    assert_eq!(change_rows(&pool, &id).await, rows);
    assert_close(
        &read_numbers(
            &mut admin,
            &id,
            &model.units,
            vec![at([&g.us, "Jan 26", budget]), at([&g.us, "Mar 26", budget])],
        )
        .await,
        &[0.0, 0.0],
    );
}

#[sqlx::test(migrator = "openplan_server::db::MIGRATOR")]
async fn a_bad_line_item_group_leaves_the_other_groups_unwritten(pool: PgPool) {
    let (mut admin, _, id) = plan(&pool).await;
    let model = budget_model(&mut admin, &id).await;
    let g = &model.geography;
    let budget = model.budget.as_str();
    let rows = change_rows(&pool, &id).await;

    let response = write(
        &mut admin,
        &id,
        vec![
            edit(&model.price, at([&g.us, "Jan 26", budget]), number(10.0)),
            edit(
                &model.units,
                at([&g.us, "Jan 26", budget]),
                json!({ "t": "text", "v": "many" }),
            ),
        ],
    )
    .await;

    assert_problem(
        &response,
        StatusCode::UNPROCESSABLE_ENTITY,
        "cells.invalid_value",
    );
    assert_eq!(change_rows(&pool, &id).await, rows);
    assert_close(
        &read_numbers(
            &mut admin,
            &id,
            &model.price,
            vec![at([&g.us, "Jan 26", budget])],
        )
        .await,
        &[0.0],
    );
}

#[sqlx::test(migrator = "openplan_server::db::MIGRATOR")]
async fn write_calculated_cell_422(pool: PgPool) {
    let (mut admin, _, id) = plan(&pool).await;
    let model = budget_model(&mut admin, &id).await;
    let g = &model.geography;
    let rows = change_rows(&pool, &id).await;

    let response = write(
        &mut admin,
        &id,
        vec![edit(
            &model.revenue,
            at([&g.us, "Jan 26", &model.budget]),
            number(1.0),
        )],
    )
    .await;

    assert_problem(
        &response,
        StatusCode::UNPROCESSABLE_ENTITY,
        "cells.not_input",
    );
    assert_eq!(change_rows(&pool, &id).await, rows);
}

#[sqlx::test(migrator = "openplan_server::db::MIGRATOR")]
async fn viewer_cannot_write_403(pool: PgPool) {
    let (mut admin, workspace, id) = plan(&pool).await;
    let model = budget_model(&mut admin, &id).await;
    let g = &model.geography;
    for (email, name, role) in [
        ("vera@acme.com", "Vera Viewer", "viewer"),
        ("pat@acme.com", "Pat Planner", "planner"),
    ] {
        create_member(&mut admin, &workspace, email, name, role).await;
    }
    let cell = || {
        edit(
            &model.units,
            at([&g.us, "Jan 26", &model.budget]),
            number(7.0),
        )
    };
    let rows = change_rows(&pool, &id).await;

    let mut viewer = sign_in_beside(&admin, "vera@acme.com").await;
    let refused = write(&mut viewer, &id, vec![cell()]).await;
    assert_problem(&refused, StatusCode::FORBIDDEN, "auth.forbidden");
    assert_eq!(change_rows(&pool, &id).await, rows);

    // A viewer reads, and a planner writes.
    let values = read_numbers(
        &mut viewer,
        &id,
        &model.units,
        vec![at([&g.us, "Jan 26", &model.budget])],
    )
    .await;
    assert_eq!(values, [0.0]);
    let mut planner = sign_in_beside(&admin, "pat@acme.com").await;
    write_ok(&mut planner, &id, vec![cell()]).await;
    let values = read_numbers(
        &mut viewer,
        &id,
        &model.units,
        vec![at([&g.us, "Jan 26", &model.budget])],
    )
    .await;
    assert_eq!(values, [7.0]);
}

#[sqlx::test(migrator = "openplan_server::db::MIGRATOR")]
async fn history_returns_changes(pool: PgPool) {
    let (mut admin, workspace, id) = plan(&pool).await;
    let model = budget_model(&mut admin, &id).await;
    let g = &model.geography;
    let planner_id = create_member(
        &mut admin,
        &workspace,
        "pat@acme.com",
        "Pat Planner",
        "planner",
    )
    .await;
    let mut planner = sign_in_beside(&admin, "pat@acme.com").await;
    let cell = |value: f64| {
        edit(
            &model.units,
            at([&g.us, "Jan 26", &model.budget]),
            number(value),
        )
    };
    let key = format!("{}|Jan 26|{}", g.us, model.budget);

    write_ok(&mut admin, &id, vec![cell(10.0)]).await;
    write_ok(&mut admin, &id, vec![cell(20.0)]).await;
    write_ok(&mut admin, &id, vec![cell(20.0)]).await;
    write_ok(&mut planner, &id, vec![cell(30.0)]).await;
    write_ok(
        &mut admin,
        &id,
        vec![edit(
            &model.units,
            at([&g.ca, "Jan 26", &model.budget]),
            number(99.0),
        )],
    )
    .await;

    let response = history(&mut planner, &id, &model.units, &key).await;

    assert_eq!(response.status, StatusCode::OK, "{}", response.text);
    let changes = response.json.as_array().unwrap();
    let summary: Vec<(&str, f64, f64)> = changes
        .iter()
        .map(|change| {
            (
                change["user"]["name"].as_str().unwrap(),
                change["old"]["v"].as_f64().unwrap(),
                change["new"]["v"].as_f64().unwrap(),
            )
        })
        .collect();
    assert_eq!(
        summary,
        [
            ("Pat Planner", 20.0, 30.0),
            ("Ada Admin", 10.0, 20.0),
            ("Ada Admin", 0.0, 10.0),
        ],
        "newest first; the edit that left the value as it was and the other cell are not there"
    );
    assert_eq!(changes[0]["user"]["id"], planner_id);
    assert_eq!(changes[0]["old"], number(20.0));
    assert_eq!(changes[0]["new"], number(30.0));
    let newest = chrono::DateTime::parse_from_rfc3339(changes[0]["at"].as_str().unwrap()).unwrap();
    let oldest = chrono::DateTime::parse_from_rfc3339(changes[2]["at"].as_str().unwrap()).unwrap();
    assert!(newest >= oldest);

    // A cell nobody wrote has no history, and neither has one of another line item.
    let other = format!("{}|Feb 26|{}", g.us, model.budget);
    let nothing = history(&mut planner, &id, &model.units, &other).await;
    assert_eq!(nothing.json, json!([]));
    let elsewhere = history(&mut planner, &id, &model.price, &key).await;
    assert_eq!(elsewhere.json, json!([]));
    let unknown = history(&mut planner, &id, &model.units, "not|a|cell|key").await;
    assert_eq!(unknown.status, StatusCode::OK, "{}", unknown.text);
    assert_eq!(unknown.json, json!([]));

    // The change of a user who is gone is still there.
    sqlx::query("UPDATE change_log SET user_id = NULL WHERE kind = 'cell' AND user_id = $1")
        .bind(Uuid::parse_str(&planner_id).unwrap())
        .execute(&pool)
        .await
        .unwrap();
    let anonymous = history(&mut admin, &id, &model.units, &key).await;
    assert_eq!(anonymous.json[0]["user"], Value::Null);
    assert_eq!(anonymous.json[0]["new"], number(30.0));
}

#[sqlx::test(migrator = "openplan_server::db::MIGRATOR")]
async fn history_keeps_the_newest_hundred_changes(pool: PgPool) {
    let (mut admin, _, id) = plan(&pool).await;
    let model = budget_model(&mut admin, &id).await;
    let g = &model.geography;
    let edits = (1..=101)
        .map(|value| {
            edit(
                &model.units,
                at([&g.us, "Jan 26", &model.budget]),
                number(f64::from(value)),
            )
        })
        .collect();
    write_ok(&mut admin, &id, edits).await;

    let response = history(
        &mut admin,
        &id,
        &model.units,
        &format!("{}|Jan 26|{}", g.us, model.budget),
    )
    .await;

    let changes = response.json.as_array().unwrap();
    assert_eq!(changes.len(), 100);
    assert_eq!(changes[0]["new"], number(101.0));
    assert_eq!(changes[99]["new"], number(2.0));
}

#[sqlx::test(migrator = "openplan_server::db::MIGRATOR")]
async fn one_cell_has_one_history_whatever_the_case_of_its_period(pool: PgPool) {
    let (mut admin, _, id) = plan(&pool).await;
    let model = budget_model(&mut admin, &id).await;
    let g = &model.geography;
    let cell = |label: &str, value: f64| {
        edit(
            &model.units,
            at([&g.us, label, &model.budget]),
            number(value),
        )
    };

    write_ok(&mut admin, &id, vec![cell("jan 26", 1.0)]).await;
    write_ok(&mut admin, &id, vec![cell("JAN  26", 2.0)]).await;
    write_ok(&mut admin, &id, vec![cell("Jan 26", 3.0)]).await;

    let keys: Vec<String> =
        sqlx::query_scalar("SELECT DISTINCT cell_key FROM change_log WHERE kind = 'cell'")
            .fetch_all(&pool)
            .await
            .unwrap();
    assert_eq!(keys, [format!("{}|Jan 26|{}", g.us, model.budget)]);
    let stored: Vec<Value> =
        sqlx::query_scalar("SELECT payload FROM change_log WHERE kind = 'cells' ORDER BY seq")
            .fetch_all(&pool)
            .await
            .unwrap();
    for batch in &stored {
        assert_eq!(batch[0]["edits"][0]["coords"][1], "Jan 26", "{batch}");
    }
    for label in ["Jan 26", "jan 26", "JAN 26"] {
        let response = history(
            &mut admin,
            &id,
            &model.units,
            &format!("{}|{label}|{}", g.us, model.budget),
        )
        .await;
        let news: Vec<f64> = response
            .json
            .as_array()
            .unwrap()
            .iter()
            .map(|change| change["new"]["v"].as_f64().unwrap())
            .collect();
        assert_eq!(news, [3.0, 2.0, 1.0], "{label}");
    }
    let values = read_numbers(
        &mut admin,
        &id,
        &model.units,
        vec![
            at([&g.us, "jan 26", &model.budget]),
            at([&g.us, "JAN 26", &model.budget]),
        ],
    )
    .await;
    assert_eq!(values, [3.0, 3.0]);
}

#[sqlx::test(migrator = "openplan_server::db::MIGRATOR")]
async fn history_of_a_line_item_that_does_not_exist_is_422(pool: PgPool) {
    let (mut admin, _, id) = plan(&pool).await;
    let stranger = Uuid::now_v7().to_string();

    let response = history(&mut admin, &id, &stranger, "").await;

    assert_problem(
        &response,
        StatusCode::UNPROCESSABLE_ENTITY,
        "structure.invalid",
    );
    assert_eq!(response.json["errors"][0]["field"], "line_item_id");
    let missing = admin
        .get(&format!(
            "{}?line_item_id={stranger}",
            url(&id, "/cells/history")
        ))
        .await;
    assert_problem(&missing, StatusCode::UNPROCESSABLE_ENTITY, "validation");
    assert_eq!(missing.json["errors"][0]["field"], "cell_key");
}

#[sqlx::test(migrator = "openplan_server::db::MIGRATOR")]
async fn a_line_item_without_dimensions_has_the_empty_key(pool: PgPool) {
    let (mut admin, _, id) = plan(&pool).await;
    let module = create_module(&mut admin, &id, "Settings", Vec::new()).await;
    let rate = create_line_item(&mut admin, &id, &module, json!({ "name": "Rate" })).await;

    write_ok(&mut admin, &id, vec![edit(&rate, at([]), number(0.25))]).await;

    let values = read_numbers(&mut admin, &id, &rate, vec![at([])]).await;
    assert_eq!(values, [0.25]);
    let response = history(&mut admin, &id, &rate, "").await;
    assert_eq!(
        response.json.as_array().unwrap().len(),
        1,
        "{}",
        response.text
    );
    assert_eq!(response.json[0]["new"], number(0.25));
}

#[sqlx::test(migrator = "openplan_server::db::MIGRATOR")]
async fn an_unknown_line_item_in_the_body_is_422_naming_the_field(pool: PgPool) {
    let (mut admin, _, id) = plan(&pool).await;
    let model = budget_model(&mut admin, &id).await;
    let g = &model.geography;
    let stranger = Uuid::now_v7().to_string();
    let rows = change_rows(&pool, &id).await;
    let good = |label: &str| edit(&model.units, at([&g.us, label, &model.budget]), number(1.0));

    let response = write(
        &mut admin,
        &id,
        vec![
            good("Jan 26"),
            good("Feb 26"),
            good("Mar 26"),
            edit(&stranger, at([&g.us, "Jan 26", &model.budget]), number(1.0)),
            edit(&stranger, at([]), number(1.0)),
        ],
    )
    .await;

    assert_problem(
        &response,
        StatusCode::UNPROCESSABLE_ENTITY,
        "structure.invalid",
    );
    let fields: Vec<&str> = response.json["errors"]
        .as_array()
        .unwrap()
        .iter()
        .map(|error| error["field"].as_str().unwrap())
        .collect();
    assert_eq!(fields, ["edits[3].line_item_id", "edits[4].line_item_id"]);
    assert_eq!(change_rows(&pool, &id).await, rows);

    let unread = read(&mut admin, &id, &stranger, vec![at([])]).await;
    assert_problem(
        &unread,
        StatusCode::UNPROCESSABLE_ENTITY,
        "structure.invalid",
    );
    assert_eq!(unread.json["errors"][0]["field"], "line_item_id");
}

#[sqlx::test(migrator = "openplan_server::db::MIGRATOR")]
async fn a_model_that_does_not_exist_is_404_and_so_is_one_of_another_workspace(pool: PgPool) {
    let (mut admin, _, id) = plan(&pool).await;
    let model = budget_model(&mut admin, &id).await;
    let g = &model.geography;
    create_user(&mut admin, "outsider@acme.com", "Outsider").await;
    let mut outsider = sign_in(&pool, "outsider@acme.com").await;
    let unknown = Uuid::now_v7().to_string();
    let cell = || {
        edit(
            &model.units,
            at([&g.us, "Jan 26", &model.budget]),
            number(1.0),
        )
    };

    for (app, model_id) in [(&mut outsider, id.as_str()), (&mut admin, unknown.as_str())] {
        let written = write(app, model_id, vec![cell()]).await;
        assert_problem(&written, StatusCode::NOT_FOUND, "not_found");
        let found = read(app, model_id, &model.units, vec![at([])]).await;
        assert_problem(&found, StatusCode::NOT_FOUND, "not_found");
        let changes = history(app, model_id, &model.units, "").await;
        assert_problem(&changes, StatusCode::NOT_FOUND, "not_found");
    }
}

#[sqlx::test(migrator = "openplan_server::db::MIGRATOR")]
async fn the_cells_routes_need_a_session_and_the_csrf_header(pool: PgPool) {
    let (mut admin, _, id) = plan(&pool).await;
    let mut anonymous = TestApp::new(pool.clone());
    let stranger = Uuid::now_v7().to_string();

    let write = anonymous
        .post(&url(&id, "/cells"), Some(json!({ "edits": [] })))
        .await;
    assert_problem(&write, StatusCode::UNAUTHORIZED, "auth.unauthenticated");
    let read = anonymous
        .post(
            &url(&id, "/cells/read"),
            Some(json!({ "line_item_id": stranger, "cells": [] })),
        )
        .await;
    assert_problem(&read, StatusCode::UNAUTHORIZED, "auth.unauthenticated");
    let history = anonymous
        .get(&format!(
            "{}?line_item_id={stranger}&cell_key=",
            url(&id, "/cells/history")
        ))
        .await;
    assert_problem(&history, StatusCode::UNAUTHORIZED, "auth.unauthenticated");

    let unprotected = admin
        .request_without_csrf(
            Method::POST,
            &url(&id, "/cells"),
            Some(json!({ "edits": [] })),
        )
        .await;
    assert_problem(&unprotected, StatusCode::FORBIDDEN, "auth.csrf");
}

#[sqlx::test(migrator = "openplan_server::db::MIGRATOR")]
async fn an_empty_write_changes_nothing(pool: PgPool) {
    let (mut admin, _, id) = plan(&pool).await;
    let model = budget_model(&mut admin, &id).await;
    let g = &model.geography;
    let first = write_ok(
        &mut admin,
        &id,
        vec![edit(
            &model.units,
            at([&g.us, "Jan 26", &model.budget]),
            number(1.0),
        )],
    )
    .await;
    let rows = change_rows(&pool, &id).await;

    let empty = write_ok(&mut admin, &id, Vec::new()).await;

    assert_eq!(
        empty,
        json!({ "seq": first["seq"], "changed_line_item_ids": [] })
    );
    assert_eq!(change_rows(&pool, &id).await, rows);
}

#[sqlx::test(migrator = "openplan_server::db::MIGRATOR")]
async fn coordinates_that_fit_no_cell_are_422(pool: PgPool) {
    let (mut admin, _, id) = plan(&pool).await;
    let model = budget_model(&mut admin, &id).await;
    let g = &model.geography;
    let budget = model.budget.as_str();
    let rows = change_rows(&pool, &id).await;

    for coords in [
        at([&g.us, "Jan 26"]),
        at([&g.us, "Jan 40", budget]),
        at([&g.us, "Q1 FY26", budget]),
        at([&g.na, "Jan 26", budget]),
        at(["top", "Jan 26", budget]),
        at(["nonsense", "Jan 26", budget]),
    ] {
        let response = write(
            &mut admin,
            &id,
            vec![edit(&model.units, coords.clone(), number(1.0))],
        )
        .await;
        assert_problem(
            &response,
            StatusCode::UNPROCESSABLE_ENTITY,
            "cells.invalid_coordinate",
        );
        assert_eq!(response.json["errors"], Value::Null);
    }
    assert_eq!(change_rows(&pool, &id).await, rows);

    for coords in [
        at([&g.us, "Jan 26"]),
        at([&g.us, "Jan 40", budget]),
        at([&g.us, "Jan 26", &g.us]),
        at(["nonsense", "Jan 26", budget]),
    ] {
        let response = read(&mut admin, &id, &model.units, vec![coords]).await;
        assert_problem(
            &response,
            StatusCode::UNPROCESSABLE_ENTITY,
            "cells.invalid_coordinate",
        );
        assert!(
            response.json["detail"]
                .as_str()
                .unwrap()
                .starts_with("Cell 0: "),
            "{}",
            response.text
        );
    }
}

#[sqlx::test(migrator = "openplan_server::db::MIGRATOR")]
async fn values_of_every_type_are_written_and_read_back(pool: PgPool) {
    let (mut admin, _, id) = plan(&pool).await;
    let g = geography(&mut admin, &id).await;
    let module = create_module(
        &mut admin,
        &id,
        "Facts",
        vec![list_axis(&g.regions), month()],
    )
    .await;
    let mut line_items = Vec::new();
    for (name, format) in [
        ("Approved", json!({ "type": "boolean" })),
        ("Note", json!({ "type": "text" })),
        ("Due", json!({ "type": "date" })),
        ("Owner", json!({ "type": "list", "list": g.regions })),
        ("Start", json!({ "type": "time_period", "level": "month" })),
    ] {
        let body = json!({ "name": name, "format": format });
        line_items.push(create_line_item(&mut admin, &id, &module, body).await);
    }
    let written = [
        json!({ "t": "boolean", "v": true }),
        json!({ "t": "text", "v": "Ship it" }),
        json!({ "t": "date", "v": "2026-03-15" }),
        json!({ "t": "item", "v": g.eu }),
        json!({ "t": "period", "v": ["month", 2] }),
    ];
    let blank = [
        json!({ "t": "boolean", "v": false }),
        json!({ "t": "text", "v": "" }),
        json!({ "t": "date", "v": null }),
        json!({ "t": "item", "v": null }),
        json!({ "t": "period", "v": null }),
    ];

    write_ok(
        &mut admin,
        &id,
        line_items
            .iter()
            .zip(&written)
            .map(|(line_item, value)| edit(line_item, at([&g.na, "Feb 26"]), value.clone()))
            .collect(),
    )
    .await;

    for ((line_item, written), blank) in line_items.iter().zip(&written).zip(&blank) {
        let found = read_values(&mut admin, &id, line_item, vec![at([&g.na, "Feb 26"])]).await;
        assert_eq!(&found[0], written);
        let elsewhere = read_values(&mut admin, &id, line_item, vec![at([&g.eu, "Feb 26"])]).await;
        assert_eq!(&elsewhere[0], blank);
    }
}

#[sqlx::test(migrator = "openplan_server::db::MIGRATOR")]
async fn text_values_are_limited_and_cannot_contain_nul(pool: PgPool) {
    let (mut admin, _, id) = plan(&pool).await;
    let module = create_module(&mut admin, &id, "Notes", Vec::new()).await;
    let note = create_line_item(
        &mut admin,
        &id,
        &module,
        json!({ "name": "Note", "format": { "type": "text" } }),
    )
    .await;
    let text = |value: &str| json!({ "t": "text", "v": value });
    let rows = change_rows(&pool, &id).await;

    let long = write(
        &mut admin,
        &id,
        vec![edit(&note, at([]), text(&"x".repeat(10_001)))],
    )
    .await;
    assert_problem(
        &long,
        StatusCode::UNPROCESSABLE_ENTITY,
        "cells.invalid_value",
    );
    assert_eq!(
        long.json["errors"][0]["message"],
        "Text is limited to 10,000 characters."
    );
    let nul = write(
        &mut admin,
        &id,
        vec![edit(&note, at([]), text("before\u{0}after"))],
    )
    .await;
    assert_problem(
        &nul,
        StatusCode::UNPROCESSABLE_ENTITY,
        "cells.invalid_value",
    );
    assert_eq!(
        nul.json["errors"][0]["message"],
        "Text can't contain the NUL character."
    );
    assert_eq!(change_rows(&pool, &id).await, rows);

    write_ok(
        &mut admin,
        &id,
        vec![edit(&note, at([]), text(&"x".repeat(10_000)))],
    )
    .await;
    let found = read_values(&mut admin, &id, &note, vec![at([])]).await;
    assert_eq!(found[0], text(&"x".repeat(10_000)));
}

#[sqlx::test(migrator = "openplan_server::db::MIGRATOR")]
async fn names_with_nul_are_422(pool: PgPool) {
    let (mut admin, _, id) = plan(&pool).await;

    let response = admin
        .post(&url(&id, "/lists"), Some(json!({ "name": "Bad\u{0}name" })))
        .await;

    assert_problem(
        &response,
        StatusCode::UNPROCESSABLE_ENTITY,
        "structure.invalid",
    );
}

#[sqlx::test(migrator = "openplan_server::db::MIGRATOR")]
async fn a_write_takes_at_most_100000_edits(pool: PgPool) {
    let (mut admin, _, id) = plan(&pool).await;
    let module = create_module(&mut admin, &id, "Settings", Vec::new()).await;
    let rate = create_line_item(&mut admin, &id, &module, json!({ "name": "Rate" })).await;
    let same = || edit(&rate, at([]), number(1.0));

    let largest = write(&mut admin, &id, (0..100_000).map(|_| same()).collect()).await;
    assert_eq!(largest.status, StatusCode::OK, "{}", largest.text);
    let rows = change_rows(&pool, &id).await;

    let too_many = write(&mut admin, &id, (0..100_001).map(|_| same()).collect()).await;

    assert_problem(&too_many, StatusCode::UNPROCESSABLE_ENTITY, "validation");
    assert_eq!(too_many.json["errors"][0]["field"], "edits");
    assert_eq!(change_rows(&pool, &id).await, rows);
}

#[sqlx::test(migrator = "openplan_server::db::MIGRATOR")]
async fn a_read_takes_at_most_10000_cells(pool: PgPool) {
    let (mut admin, _, id) = plan(&pool).await;
    let module = create_module(&mut admin, &id, "Settings", Vec::new()).await;
    let rate = create_line_item(&mut admin, &id, &module, json!({ "name": "Rate" })).await;
    write_ok(&mut admin, &id, vec![edit(&rate, at([]), number(2.0))]).await;

    let largest = read(&mut admin, &id, &rate, vec![at([]); 10_000]).await;
    assert_eq!(largest.status, StatusCode::OK, "{}", largest.text);
    assert_eq!(largest.json["values"].as_array().unwrap().len(), 10_000);

    let too_many = read(&mut admin, &id, &rate, vec![at([]); 10_001]).await;

    assert_problem(&too_many, StatusCode::UNPROCESSABLE_ENTITY, "validation");
    assert_eq!(too_many.json["errors"][0]["field"], "cells");
}

#[sqlx::test(migrator = "openplan_server::db::MIGRATOR")]
async fn production_models_still_take_cell_writes(pool: PgPool) {
    let (mut admin, _, id) = plan(&pool).await;
    let model = budget_model(&mut admin, &id).await;
    let g = &model.geography;
    let production = admin
        .patch(&url(&id, ""), Some(json!({ "mode": "prod" })))
        .await;
    assert_eq!(production.status, StatusCode::OK, "{}", production.text);

    write_ok(
        &mut admin,
        &id,
        vec![edit(
            &model.units,
            at([&g.us, "Jan 26", &model.budget]),
            number(4.0),
        )],
    )
    .await;

    let values = read_numbers(
        &mut admin,
        &id,
        &model.units,
        vec![at([&g.us, "Jan 26", &model.budget])],
    )
    .await;
    assert_eq!(values, [4.0]);
}

#[sqlx::test(migrator = "openplan_server::db::MIGRATOR")]
async fn cells_before_a_switchover_read_as_the_actual_version(pool: PgPool) {
    let (mut admin, _, id) = plan(&pool).await;
    let model = budget_model(&mut admin, &id).await;
    let g = &model.geography;
    let switched = admin
        .request(
            Method::PUT,
            &url(&id, &format!("/versions/{}", model.budget)),
            Some(json!({
                "name": "Budget",
                "is_actual": false,
                "is_current": true,
                "switchover": "Mar 26",
            })),
        )
        .await;
    assert_eq!(switched.status, StatusCode::OK, "{}", switched.text);
    write_ok(
        &mut admin,
        &id,
        vec![
            edit(
                &model.units,
                at([&g.us, "Jan 26", &model.actual]),
                number(5.0),
            ),
            edit(
                &model.units,
                at([&g.us, "Mar 26", &model.budget]),
                number(7.0),
            ),
        ],
    )
    .await;

    let values = read_numbers(
        &mut admin,
        &id,
        &model.units,
        vec![
            at([&g.us, "Jan 26", &model.budget]),
            at([&g.us, "Mar 26", &model.budget]),
            at([&g.us, "Q1 FY26", &model.budget]),
        ],
    )
    .await;

    assert_eq!(values, [5.0, 7.0, 12.0]);
    let refused = write(
        &mut admin,
        &id,
        vec![edit(
            &model.units,
            at([&g.us, "Feb 26", &model.budget]),
            number(1.0),
        )],
    )
    .await;
    assert_problem(
        &refused,
        StatusCode::UNPROCESSABLE_ENTITY,
        "cells.invalid_value",
    );
}

#[sqlx::test(migrator = "openplan_server::db::MIGRATOR")]
async fn the_cells_routes_are_in_the_openapi_document(pool: PgPool) {
    let mut app = TestApp::new(pool);

    let document = app.get("/api/openapi.json").await.json;

    for (path, method) in [
        ("/api/v1/models/{id}/cells", "post"),
        ("/api/v1/models/{id}/cells/read", "post"),
        ("/api/v1/models/{id}/cells/history", "get"),
    ] {
        let operation = &document["paths"][path][method];
        assert_eq!(operation["tags"], json!(["cells"]), "{method} {path}");
    }
    let schemas = document["components"]["schemas"].as_object().unwrap();
    for name in [
        "WriteCellsRequest",
        "WriteCellsResponse",
        "ReadCellsRequest",
        "ReadCellsResponse",
        "CellEditDto",
        "CellChangeDto",
        "ValueDto",
    ] {
        assert!(schemas.contains_key(name), "{name}");
    }
}
