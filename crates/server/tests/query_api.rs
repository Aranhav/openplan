mod common;

use std::{sync::Arc, time::Duration};

use axum::http::StatusCode;
use common::{
    TestApp, TestResponse, assert_problem, create_items, create_line_item, create_list,
    create_member, create_module, create_user, id_of, list_axis, month, plan, plan_in,
    sign_in_beside, url,
};
use openplan_engine::ViewQuery;
use openplan_server::{auth::SESSION_COOKIE, work::Work};
use serde_json::{Value, json};
use sqlx::PgPool;
use uuid::Uuid;

/// Products {Widget, Gadget, Gizmo} (top level "All Products") by month, with the inputs Units
/// and Price and the calculated Revenue.
struct Sales {
    products: String,
    widget: String,
    gadget: String,
    gizmo: String,
    module: String,
    units: String,
    price: String,
    revenue: String,
}

async fn sales(app: &mut TestApp, model: &str) -> Sales {
    let products = create_list(
        app,
        model,
        json!({ "name": "Products", "top_level_name": "All Products" }),
    )
    .await;
    let items = create_items(
        app,
        model,
        &products,
        json!([{ "name": "Widget" }, { "name": "Gadget" }, { "name": "Gizmo" }]),
    )
    .await;
    let module = create_module(app, model, "Sales", vec![list_axis(&products), month()]).await;
    let line = |name: &'static str, formula: Option<&'static str>| json!({ "name": name, "formula": formula });
    let units = id_of(&create_line_item(app, model, &module, line("Units", None)).await);
    let price = id_of(&create_line_item(app, model, &module, line("Price", None)).await);
    let revenue =
        id_of(&create_line_item(app, model, &module, line("Revenue", Some("Units * Price"))).await);
    Sales {
        products,
        widget: id_of(&items[0]),
        gadget: id_of(&items[1]),
        gizmo: id_of(&items[2]),
        module,
        units,
        price,
        revenue,
    }
}

fn number(value: f64) -> Value {
    json!({ "t": "number", "v": value })
}

/// Writes `value` into a line item of Sales for a product in January, and returns the sequence
/// number of the change.
async fn put(app: &mut TestApp, model: &str, line_item: &str, product: &str, value: f64) -> i64 {
    let response = app
        .post(
            &url(model, "/cells"),
            Some(json!({ "edits": [{
                "line_item_id": line_item,
                "coords": [product, "Jan 26"],
                "value": number(value),
            }] })),
        )
        .await;
    assert_eq!(response.status, StatusCode::OK, "{}", response.text);
    response.json["seq"].as_i64().unwrap()
}

/// The products on rows and the line items on columns, in January.
fn grid(sales: &Sales) -> Value {
    json!({
        "module": sales.module,
        "rows": [{ "kind": "list", "list": sales.products }],
        "columns": [{ "kind": "line_items" }],
        "pages": [{ "dim": { "kind": "time" } }],
        "window": { "row_offset": 0, "row_limit": 50, "col_offset": 0, "col_limit": 20 },
    })
}

async fn query(app: &mut TestApp, model: &str, body: Value) -> TestResponse {
    app.post(&url(model, "/query"), Some(body)).await
}

async fn query_ok(app: &mut TestApp, model: &str, body: Value) -> Value {
    let response = query(app, model, body).await;
    assert_eq!(response.status, StatusCode::OK, "{}", response.text);
    response.json
}

fn labels(headers: &Value) -> Vec<&str> {
    headers
        .as_array()
        .unwrap()
        .iter()
        .map(|header| header["members"][0]["label"].as_str().unwrap())
        .collect()
}

fn flags(cell: &Value) -> Vec<&str> {
    cell["flags"]
        .as_array()
        .unwrap()
        .iter()
        .map(|flag| flag.as_str().unwrap())
        .collect()
}

#[sqlx::test(migrator = "openplan_server::db::MIGRATOR")]
async fn query_returns_window_and_seq(pool: PgPool) {
    let (mut admin, _, id) = plan(&pool).await;
    let s = sales(&mut admin, &id).await;
    put(&mut admin, &id, &s.units, &s.widget, 10.0).await;
    put(&mut admin, &id, &s.units, &s.gadget, 20.0).await;
    put(&mut admin, &id, &s.units, &s.gizmo, 5.0).await;
    let seq = put(&mut admin, &id, &s.price, &s.widget, 2.0).await;

    let all = query_ok(&mut admin, &id, grid(&s)).await;

    // The seq is the last change of the model that the window shows.
    assert_eq!(all["seq"], seq);
    assert_eq!(all["total_rows"], 4);
    assert_eq!(all["total_columns"], 3);
    assert_eq!(
        labels(&all["rows"]),
        ["All Products", "Widget", "Gadget", "Gizmo"]
    );
    assert_eq!(labels(&all["columns"]), ["Units", "Price", "Revenue"]);
    assert_eq!(all["pages"][0]["member"]["label"], "Jan 26");
    let cell = |row: usize, column: usize| &all["cells"][row][column];
    assert_eq!(cell(1, 0)["value"], number(10.0));
    assert_eq!(flags(cell(1, 0)), ["input"]);
    assert_eq!(cell(1, 2)["value"], number(20.0));
    assert_eq!(flags(cell(1, 2)), ["calculated", "readonly"]);
    assert_eq!(cell(0, 0)["value"], number(35.0));
    assert_eq!(flags(cell(0, 0)), ["summary", "readonly"]);
    assert_eq!(all["line_items"][0]["name"], "Units");
    assert_eq!(all["line_items"][0]["is_input"], true);
    assert_eq!(
        all["line_items"][0]["dims"],
        json!([{ "kind": "list", "list": s.products }, { "kind": "time" }])
    );
    assert_eq!(all["line_items"][0]["format"]["type"], "number");

    // A window of two rows and one column from the second row, with the totals of the whole.
    let mut windowed = grid(&s);
    windowed["window"] = json!({
        "row_offset": 1, "row_limit": 2, "col_offset": 1, "col_limit": 1,
    });
    let part = query_ok(&mut admin, &id, windowed).await;
    assert_eq!(part["seq"], seq);
    assert_eq!(part["total_rows"], 4);
    assert_eq!(part["total_columns"], 3);
    assert_eq!(labels(&part["rows"]), ["Widget", "Gadget"]);
    assert_eq!(labels(&part["columns"]), ["Price"]);
    assert_eq!(part["cells"][0][0]["value"], number(2.0));

    // A change moves the seq on.
    let next = put(&mut admin, &id, &s.units, &s.widget, 11.0).await;
    assert!(next > seq);
    assert_eq!(query_ok(&mut admin, &id, grid(&s)).await["seq"], next);
}

#[sqlx::test(migrator = "openplan_server::db::MIGRATOR")]
async fn the_answer_is_what_the_engine_writes(pool: PgPool) {
    let (mut admin, _, id) = plan(&pool).await;
    let s = sales(&mut admin, &id).await;
    put(&mut admin, &id, &s.units, &s.widget, 10.0).await;
    let seq = put(&mut admin, &id, &s.price, &s.widget, 2.0).await;
    let model_id = Uuid::parse_str(&id).unwrap();
    let mut by_time = grid(&s);
    by_time["rows"] = json!([{ "kind": "time" }]);
    by_time["pages"] = json!([{ "dim": { "kind": "list", "list": s.products }, "key": s.widget }]);
    let mut filtered = grid(&s);
    filtered["filters"] = json!([{ "line_item": s.units, "op": "gt", "value": number(1.0) }]);
    filtered["collapsed"] =
        json!([{ "dim": { "kind": "list", "list": s.products }, "key": "top" }]);
    let model = admin
        .state
        .models
        .get(model_id)
        .await
        .unwrap()
        .snapshot_seq()
        .0;

    for body in [grid(&s), by_time, filtered] {
        let query: ViewQuery = serde_json::from_value(body.clone()).unwrap();
        let mut engine =
            serde_json::to_value(openplan_engine::view::query(&model, &query).unwrap()).unwrap();
        engine["seq"] = json!(seq);

        let found = query_ok(&mut admin, &id, body).await;

        assert_eq!(found, engine);
    }
}

#[sqlx::test(migrator = "openplan_server::db::MIGRATOR")]
async fn viewer_query_cells_readonly(pool: PgPool) {
    let (mut admin, workspace, id) = plan(&pool).await;
    let s = sales(&mut admin, &id).await;
    put(&mut admin, &id, &s.units, &s.widget, 10.0).await;
    create_member(&mut admin, &workspace, "vera@acme.com", "Vera", "viewer").await;
    create_member(&mut admin, &workspace, "paul@acme.com", "Paul", "planner").await;
    let mut viewer = sign_in_beside(&admin, "vera@acme.com").await;
    let mut planner = sign_in_beside(&admin, "paul@acme.com").await;

    let seen = query_ok(&mut viewer, &id, grid(&s)).await;
    let planned = query_ok(&mut planner, &id, grid(&s)).await;

    // The viewer's cells are all read-only, in the order flags are listed in, once.
    for row in seen["cells"].as_array().unwrap() {
        for cell in row.as_array().unwrap() {
            let flags = flags(cell);
            assert_eq!(flags.iter().filter(|flag| **flag == "readonly").count(), 1);
        }
    }
    assert_eq!(flags(&seen["cells"][1][0]), ["input", "readonly"]);
    assert_eq!(flags(&seen["cells"][1][2]), ["calculated", "readonly"]);
    assert_eq!(flags(&seen["cells"][0][0]), ["summary", "readonly"]);
    // A planner's input cells can be typed into.
    assert_eq!(flags(&planned["cells"][1][0]), ["input"]);
    assert_eq!(
        seen["cells"][1][0]["value"],
        planned["cells"][1][0]["value"]
    );
}

#[sqlx::test(migrator = "openplan_server::db::MIGRATOR")]
async fn non_member_query_404(pool: PgPool) {
    let (mut admin, _, id) = plan(&pool).await;
    let s = sales(&mut admin, &id).await;
    create_user(&mut admin, "olga@acme.com", "Olga Outsider").await;
    let mut outsider = sign_in_beside(&admin, "olga@acme.com").await;
    let mut anonymous = admin.fork();
    anonymous.forget_cookie(SESSION_COOKIE);
    let unknown = Uuid::now_v7().to_string();

    let refused = query(&mut outsider, &id, grid(&s)).await;
    assert_problem(&refused, StatusCode::NOT_FOUND, "not_found");
    let gone = query(&mut admin, &unknown, grid(&s)).await;
    assert_problem(&gone, StatusCode::NOT_FOUND, "not_found");
    let unsigned = query(&mut anonymous, &id, grid(&s)).await;
    assert_problem(&unsigned, StatusCode::UNAUTHORIZED, "auth.unauthenticated");
}

#[sqlx::test(migrator = "openplan_server::db::MIGRATOR")]
async fn invalid_query_422(pool: PgPool) {
    let (mut admin, _, id) = plan(&pool).await;
    let s = sales(&mut admin, &id).await;
    let with = |change: &dyn Fn(&mut Value)| {
        let mut body = grid(&s);
        change(&mut body);
        body
    };
    let stranger = Uuid::now_v7().to_string();
    let cases = [
        (
            "a dimension left out",
            with(&|body| body["columns"] = json!([])),
            "structure.invalid",
            None,
            "The view is missing the dimension 'Line items': put it in the rows, columns or pages.",
        ),
        (
            "a window of too many rows",
            with(&|body| body["window"]["row_limit"] = json!(1001)),
            "structure.invalid",
            None,
            "Row_limit can't be more than 1000.",
        ),
        (
            "a module that does not exist",
            with(&|body| body["module"] = json!(stranger)),
            "structure.invalid",
            Some("module"),
            "The module does not exist.",
        ),
        (
            "a member that does not exist",
            with(&|body| body["pages"][0]["key"] = json!("Jan 99")),
            "structure.invalid",
            None,
            "'Jan 99' is not a member of 'Time'.",
        ),
        (
            "a line item that does not exist",
            with(&|body| body["line_items"] = json!([stranger])),
            "structure.invalid",
            None,
            "The view lists a line item that isn't in module 'Sales'.",
        ),
        (
            "a filter on a line item that does not exist",
            with(&|body| {
                body["filters"] = json!([{
                    "line_item": stranger, "op": "gt", "value": number(1.0),
                }]);
            }),
            "structure.invalid",
            Some("query"),
            "The line item does not exist.",
        ),
        (
            "a filter without its value",
            with(&|body| body["filters"] = json!([{ "line_item": s.units, "op": "gt" }])),
            "structure.invalid",
            None,
            "The filter on 'Units' needs a value.",
        ),
        (
            "a dimension of a kind that does not exist",
            with(&|body| body["rows"] = json!([{ "kind": "weeks" }])),
            "validation",
            Some("rows[0].kind"),
            "Some fields are invalid.",
        ),
        (
            "no window",
            with(&|body| {
                body.as_object_mut().unwrap().remove("window");
            }),
            "validation",
            Some("window"),
            "Some fields are invalid.",
        ),
    ];

    for (what, body, code, field, detail) in cases {
        let response = query(&mut admin, &id, body).await;
        assert_problem(&response, StatusCode::UNPROCESSABLE_ENTITY, code);
        assert_eq!(response.json["detail"], detail, "{what}");
        if let Some(field) = field {
            assert_eq!(response.json["errors"][0]["field"], field, "{what}");
        }
    }
}

#[sqlx::test(migrator = "openplan_server::db::MIGRATOR")]
async fn contains_needs_a_text_or_list_line_item(pool: PgPool) {
    let (mut admin, _, id) = plan(&pool).await;
    let s = sales(&mut admin, &id).await;
    let mut body = grid(&s);
    body["filters"] = json!([{
        "line_item": s.units, "op": "contains", "value": { "t": "text", "v": "1" },
    }]);

    let response = query(&mut admin, &id, body).await;

    assert_problem(
        &response,
        StatusCode::UNPROCESSABLE_ENTITY,
        "structure.invalid",
    );
    assert_eq!(
        response.json["detail"],
        "Contains needs a text or list line item."
    );
}

#[sqlx::test(migrator = "openplan_server::db::MIGRATOR")]
async fn a_query_has_at_most_10_filters_1000_line_items_and_5000_members_to_hide_or_collapse(
    pool: PgPool,
) {
    let (mut admin, _, id) = plan(&pool).await;
    let s = sales(&mut admin, &id).await;
    let filter = json!({ "line_item": s.units, "op": "gt", "value": number(0.0) });
    let member = json!({ "dim": { "kind": "list", "list": s.products }, "key": "top" });
    let line_items = |count: usize| vec![s.units.clone(); count];
    let with = |field: &str, value: Value| {
        let mut body = grid(&s);
        body[field] = value;
        body
    };
    let cases = [
        (
            "filters",
            json!(vec![filter.clone(); 10]),
            json!(vec![filter; 11]),
        ),
        (
            "line_items",
            json!(line_items(1000)),
            json!(line_items(1001)),
        ),
        (
            "collapsed",
            json!(vec![member.clone(); 5000]),
            json!(vec![member.clone(); 5001]),
        ),
        (
            "hidden",
            json!(vec![member.clone(); 5000]),
            json!(vec![member; 5001]),
        ),
    ];

    for (field, at_the_limit, over) in cases {
        // What is at the limit is read, and then it is the query that is wrong or right.
        let found = query(&mut admin, &id, with(field, at_the_limit)).await;
        assert_ne!(found.json["code"], "validation", "{field}: {}", found.text);

        let refused = query(&mut admin, &id, with(field, over)).await;
        assert_problem(&refused, StatusCode::UNPROCESSABLE_ENTITY, "validation");
        assert_eq!(refused.json["errors"][0]["field"], field);
    }
}

#[sqlx::test(migrator = "openplan_server::db::MIGRATOR")]
async fn a_filtered_query_keeps_its_rows_while_the_window_scrolls(pool: PgPool) {
    let (mut admin, _, id) = plan(&pool).await;
    let s = sales(&mut admin, &id).await;
    put(&mut admin, &id, &s.units, &s.widget, 10.0).await;
    put(&mut admin, &id, &s.units, &s.gadget, 20.0).await;
    let seq = put(&mut admin, &id, &s.units, &s.gizmo, 1.0).await;
    let mut body = grid(&s);
    body["filters"] = json!([{ "line_item": s.units, "op": "gt", "value": number(5.0) }]);
    body["window"] = json!({ "row_offset": 0, "row_limit": 1, "col_offset": 0, "col_limit": 20 });
    let model_id = Uuid::parse_str(&id).unwrap();
    let cache = admin
        .state
        .models
        .get(model_id)
        .await
        .unwrap()
        .passing_cache();
    let view: ViewQuery = serde_json::from_value(body.clone()).unwrap();
    assert!(cache.is_empty());

    let first = query_ok(&mut admin, &id, body.clone()).await;

    // The top row, Widget and Gadget pass: 3 rows, of which 1 is shown.
    assert_eq!(first["total_rows"], 3);
    assert_eq!(labels(&first["rows"]), ["All Products"]);
    let kept = cache.get(seq, &view).expect("the rows that pass are kept");

    body["window"]["row_offset"] = json!(1);
    let scrolled = query_ok(&mut admin, &id, body.clone()).await;

    assert_eq!(labels(&scrolled["rows"]), ["Widget"]);
    assert_eq!(scrolled["total_rows"], 3);
    assert!(
        Arc::ptr_eq(&cache.get(seq, &view).unwrap(), &kept),
        "scrolling reads the rows again"
    );
    assert_eq!(cache.len(), 1);

    // A change drops them, and the next query finds the rows again, in the model as it is.
    let next = put(&mut admin, &id, &s.units, &s.gizmo, 50.0).await;
    let changed = query_ok(&mut admin, &id, body).await;
    assert_eq!(changed["total_rows"], 4);
    assert_eq!(changed["seq"], next);
    assert!(cache.get(seq, &view).is_none());
    assert!(cache.get(next, &view).is_some());
    assert_eq!(cache.len(), 1);
}

async fn members(app: &mut TestApp, model: &str, body: Value) -> TestResponse {
    app.post(&url(model, "/members"), Some(body)).await
}

#[sqlx::test(migrator = "openplan_server::db::MIGRATOR")]
async fn members_list(pool: PgPool) {
    let (mut admin, workspace, id) = plan(&pool).await;
    let s = sales(&mut admin, &id).await;
    let products = json!({ "kind": "list", "list": s.products });

    let with_totals = members(
        &mut admin,
        &id,
        json!({ "module_id": s.module, "dim": products, "show_summaries": true }),
    )
    .await;

    assert_eq!(with_totals.status, StatusCode::OK, "{}", with_totals.text);
    let listed = with_totals.json["members"].as_array().unwrap();
    let labels: Vec<&str> = listed
        .iter()
        .map(|member| member["label"].as_str().unwrap())
        .collect();
    assert_eq!(labels, ["All Products", "Widget", "Gadget", "Gizmo"]);
    assert_eq!(
        listed[0],
        json!({
            "key": "top", "label": "All Products", "depth": 0,
            "is_summary": true, "has_children": true, "collapsed": false,
        })
    );
    assert_eq!(listed[1]["key"], s.widget.as_str());
    assert_eq!(listed[1]["depth"], 1);
    assert_eq!(listed[1]["is_summary"], false);

    // Without totals, and with the default, which is with them.
    let leaves = members(
        &mut admin,
        &id,
        json!({ "module_id": s.module, "dim": products, "show_summaries": false }),
    )
    .await;
    assert_eq!(leaves.json["members"].as_array().unwrap().len(), 3);
    let by_default = members(
        &mut admin,
        &id,
        json!({ "module_id": s.module, "dim": products }),
    )
    .await;
    assert_eq!(by_default.json, with_totals.json);

    let line_items = members(
        &mut admin,
        &id,
        json!({ "module_id": s.module, "dim": { "kind": "line_items" } }),
    )
    .await;
    let names: Vec<&str> = line_items.json["members"]
        .as_array()
        .unwrap()
        .iter()
        .map(|member| member["label"].as_str().unwrap())
        .collect();
    assert_eq!(names, ["Units", "Price", "Revenue"]);
    assert_eq!(line_items.json["members"][0]["key"], s.units.as_str());
    assert_eq!(line_items.json["members"][2]["key"], s.revenue.as_str());

    let time = members(
        &mut admin,
        &id,
        json!({ "module_id": s.module, "dim": { "kind": "time" }, "show_summaries": false }),
    )
    .await;
    assert_eq!(time.json["members"].as_array().unwrap().len(), 36);
    assert_eq!(time.json["members"][0]["key"], "Jan 26");

    // A viewer lists them too.
    create_member(&mut admin, &workspace, "vera@acme.com", "Vera", "viewer").await;
    let mut viewer = sign_in_beside(&admin, "vera@acme.com").await;
    let seen = members(
        &mut viewer,
        &id,
        json!({ "module_id": s.module, "dim": products }),
    )
    .await;
    assert_eq!(seen.json, with_totals.json);
}

#[sqlx::test(migrator = "openplan_server::db::MIGRATOR")]
async fn members_of_what_is_not_there_are_refused(pool: PgPool) {
    let (mut admin, _, id) = plan(&pool).await;
    let s = sales(&mut admin, &id).await;
    let other = create_list(&mut admin, &id, json!({ "name": "Regions" })).await;
    let stranger = Uuid::now_v7().to_string();
    create_user(&mut admin, "olga@acme.com", "Olga Outsider").await;
    let mut outsider = sign_in_beside(&admin, "olga@acme.com").await;
    let mut anonymous = admin.fork();
    anonymous.forget_cookie(SESSION_COOKIE);
    let body = |module: &str, dim: Value| json!({ "module_id": module, "dim": dim });

    let no_module = members(&mut admin, &id, body(&stranger, json!({ "kind": "time" }))).await;
    assert_problem(
        &no_module,
        StatusCode::UNPROCESSABLE_ENTITY,
        "structure.invalid",
    );
    assert_eq!(no_module.json["errors"][0]["field"], "module_id");
    let not_in_module = members(
        &mut admin,
        &id,
        body(&s.module, json!({ "kind": "list", "list": other })),
    )
    .await;
    assert_problem(
        &not_in_module,
        StatusCode::UNPROCESSABLE_ENTITY,
        "structure.invalid",
    );
    let no_versions = members(
        &mut admin,
        &id,
        body(&s.module, json!({ "kind": "versions" })),
    )
    .await;
    assert_problem(
        &no_versions,
        StatusCode::UNPROCESSABLE_ENTITY,
        "structure.invalid",
    );
    let refused = members(
        &mut outsider,
        &id,
        body(&s.module, json!({ "kind": "time" })),
    )
    .await;
    assert_problem(&refused, StatusCode::NOT_FOUND, "not_found");
    let unsigned = members(
        &mut anonymous,
        &id,
        body(&s.module, json!({ "kind": "time" })),
    )
    .await;
    assert_problem(&unsigned, StatusCode::UNAUTHORIZED, "auth.unauthenticated");
}

#[sqlx::test(migrator = "openplan_server::db::MIGRATOR")]
async fn query_and_members_are_refused_to_who_may_not_read_before_their_body_is_read(pool: PgPool) {
    let (mut admin, _, id) = plan(&pool).await;
    create_user(&mut admin, "olga@acme.com", "Olga Outsider").await;
    let mut outsider = sign_in_beside(&admin, "olga@acme.com").await;
    let mut anonymous = admin.fork();
    anonymous.forget_cookie(SESSION_COOKIE);
    // Each of these is refused by the body once it is read.
    let too_large = format!(r#"{{"module":null,"padding":"{}"}}"#, "x".repeat(3 << 20));
    let bodies = [
        (
            too_large.as_str(),
            StatusCode::PAYLOAD_TOO_LARGE,
            "payload_too_large",
        ),
        (
            r#"{"module":"a\u0000"}"#,
            StatusCode::UNPROCESSABLE_ENTITY,
            "validation",
        ),
        ("{oops", StatusCode::BAD_REQUEST, "bad_request"),
    ];

    for path in ["/query", "/members"] {
        for (body, status, code) in bodies {
            let read = admin
                .post_raw(&url(&id, path), Some("application/json"), body)
                .await;
            assert_problem(&read, status, code);

            let refused = outsider
                .post_raw(&url(&id, path), Some("application/json"), body)
                .await;
            assert_problem(&refused, StatusCode::NOT_FOUND, "not_found");
            let refused = anonymous
                .post_raw(&url(&id, path), Some("application/json"), body)
                .await;
            assert_problem(&refused, StatusCode::UNAUTHORIZED, "auth.unauthenticated");
        }
    }
}

#[sqlx::test(migrator = "openplan_server::db::MIGRATOR")]
async fn the_view_routes_are_in_the_openapi_document(pool: PgPool) {
    let mut app = TestApp::new(pool);

    let document = app.get("/api/openapi.json").await.json;

    for (path, method) in [
        ("/api/v1/models/{id}/query", "post"),
        ("/api/v1/models/{id}/members", "post"),
        ("/api/v1/models/{id}/live/ticket", "post"),
        ("/api/v1/models/{id}/live", "get"),
    ] {
        assert!(
            document["paths"][path][method].is_object(),
            "{method} {path}"
        );
    }
    let schemas = &document["components"]["schemas"];
    for schema in [
        "ViewQueryDto",
        "ViewResultDto",
        "MembersRequest",
        "MembersResponse",
        "LiveTicketResponse",
    ] {
        assert!(schemas[schema].is_object(), "{schema}");
    }
    assert_eq!(schemas["ViewDimDto"]["oneOf"].as_array().unwrap().len(), 5);
    // The ticket is for the socket, not the session cookie.
    assert!(
        document["paths"]["/api/v1/models/{id}/live"]["get"]
            .get("security")
            .is_none()
    );
    assert!(document["paths"]["/api/v1/models/{id}/live/ticket"]["post"]["security"].is_array());
}

/// A call that waits for a permit for the heavy work of a request at most `wait`.
fn busy_after(wait: Duration) -> impl FnOnce(&mut openplan_server::app::AppState) {
    move |state| state.work = Work::new(1, wait)
}

#[sqlx::test(migrator = "openplan_server::db::MIGRATOR")]
async fn heavy_work_that_waits_too_long_is_a_503_after_the_caller_is_known(pool: PgPool) {
    let (mut admin, _, id) = plan_in(TestApp::with_state(
        pool.clone(),
        busy_after(Duration::from_millis(100)),
    ))
    .await;
    let s = sales(&mut admin, &id).await;
    create_user(&mut admin, "olga@acme.com", "Olga Outsider").await;
    let mut outsider = sign_in_beside(&admin, "olga@acme.com").await;
    let read = json!({ "line_item_id": s.units, "cells": [[s.widget, "Jan 26"]] });
    let members_of = json!({ "module_id": s.module, "dim": { "kind": "line_items" } });
    let held = admin.state.work.permit().await.unwrap();

    let started = std::time::Instant::now();
    let queried = query(&mut admin, &id, grid(&s)).await;
    let listed = members(&mut admin, &id, members_of.clone()).await;
    let cells = admin
        .post(&url(&id, "/cells/read"), Some(read.clone()))
        .await;

    // Each waited for its turn, and then said when to try again.
    assert!(started.elapsed() >= Duration::from_millis(300));
    for refused in [&queried, &listed, &cells] {
        assert_problem(refused, StatusCode::SERVICE_UNAVAILABLE, "server.busy");
        assert_eq!(refused.headers["retry-after"], "2");
    }
    // The caller is known before the turn is waited for, and a write is not held up by it.
    let refused = query(&mut outsider, &id, grid(&s)).await;
    assert_problem(&refused, StatusCode::NOT_FOUND, "not_found");
    put(&mut admin, &id, &s.units, &s.widget, 1.0).await;

    drop(held);
    assert_eq!(
        query(&mut admin, &id, grid(&s)).await.status,
        StatusCode::OK
    );
    assert_eq!(
        members(&mut admin, &id, members_of).await.status,
        StatusCode::OK
    );
    let cells = admin.post(&url(&id, "/cells/read"), Some(read)).await;
    assert_eq!(cells.status, StatusCode::OK, "{}", cells.text);
}

#[sqlx::test(migrator = "openplan_server::db::MIGRATOR")]
async fn a_write_drops_the_rows_kept_at_once(pool: PgPool) {
    let (mut admin, _, id) = plan(&pool).await;
    let s = sales(&mut admin, &id).await;
    put(&mut admin, &id, &s.units, &s.widget, 10.0).await;
    let mut body = grid(&s);
    body["filters"] = json!([{ "line_item": s.units, "op": "gt", "value": number(5.0) }]);
    let cache = admin
        .state
        .models
        .get(Uuid::parse_str(&id).unwrap())
        .await
        .unwrap()
        .passing_cache();
    query_ok(&mut admin, &id, body).await;
    assert_eq!(cache.len(), 1);

    // No query comes after it, and nothing of the model before it is kept.
    put(&mut admin, &id, &s.units, &s.gadget, 20.0).await;

    assert!(cache.is_empty());
}

/// A module of two lists of 1,000 and 1,500 items, with a line item of a single cell that a
/// filter reads, which makes a view of 1,500,000 rows that takes more than a second to filter in
/// a debug build and no more room than a small model.
struct Pairs {
    module: String,
    rows: String,
    columns: String,
    flag: String,
}

async fn pairs(app: &mut TestApp, model: &str) -> Pairs {
    let rows = create_list(app, model, json!({ "name": "Rows" })).await;
    let columns = create_list(app, model, json!({ "name": "Columns" })).await;
    for (list, count) in [(&rows, 1000), (&columns, 1500)] {
        let items: Vec<Value> = (0..count)
            .map(|at| json!({ "name": format!("{at}") }))
            .collect();
        create_items(app, model, list, json!(items)).await;
    }
    let module = create_module(
        app,
        model,
        "Pairs",
        vec![list_axis(&rows), list_axis(&columns)],
    )
    .await;
    let flag = id_of(
        &create_line_item(
            app,
            model,
            &module,
            json!({ "name": "Flag", "applies_to": [] }),
        )
        .await,
    );
    let write = app
        .post(
            &url(model, "/cells"),
            Some(
                json!({ "edits": [{ "line_item_id": flag, "coords": [], "value": number(1.0) }] }),
            ),
        )
        .await;
    assert_eq!(write.status, StatusCode::OK, "{}", write.text);
    Pairs {
        module,
        rows,
        columns,
        flag,
    }
}

impl Pairs {
    /// The view of every row and column pair where the flag is over `above`, from row `offset`.
    fn view(&self, above: f64, offset: usize) -> Value {
        json!({
            "module": self.module,
            "rows": [
                { "kind": "list", "list": self.rows },
                { "kind": "list", "list": self.columns },
            ],
            "columns": [{ "kind": "line_items" }],
            "show_summaries": false,
            "filters": [{ "line_item": self.flag, "op": "gt", "value": number(above) }],
            "window": { "row_offset": offset, "row_limit": 5, "col_offset": 0, "col_limit": 5 },
        })
    }
}

#[sqlx::test(migrator = "openplan_server::db::MIGRATOR")]
async fn queries_for_one_view_that_is_not_kept_yet_read_it_once(pool: PgPool) {
    // One permit: a query that waits for the view while it holds the permit would hold it up.
    let (mut admin, _, id) = plan_in(TestApp::with_state(
        pool.clone(),
        busy_after(Duration::from_secs(15)),
    ))
    .await;
    let pairs = pairs(&mut admin, &id).await;
    let cache = admin
        .state
        .models
        .get(Uuid::parse_str(&id).unwrap())
        .await
        .unwrap()
        .passing_cache();
    let (mut second, mut third, mut fourth) = (admin.fork(), admin.fork(), admin.fork());

    let (first, a, b, c) = tokio::join!(
        query(&mut admin, &id, pairs.view(0.0, 0)),
        query(&mut second, &id, pairs.view(0.0, 100)),
        query(&mut third, &id, pairs.view(0.0, 200)),
        query(&mut fourth, &id, pairs.view(0.0, 300)),
    );

    for response in [&first, &a, &b, &c] {
        assert_eq!(response.status, StatusCode::OK, "{}", response.text);
        assert_eq!(response.json["total_rows"], 1_500_000);
    }
    assert_eq!(labels(&b.json["rows"]), ["0", "0", "0", "0", "0"]);
    // The rows were read by one of them, and the others found them kept.
    assert_eq!(cache.found(), 1);
    assert_eq!(cache.len(), 1);
}

#[sqlx::test(migrator = "openplan_server::db::MIGRATOR")]
async fn heavy_work_holds_its_permit_until_it_is_done(pool: PgPool) {
    let (mut admin, _, id) = plan_in(TestApp::with_state(
        pool.clone(),
        busy_after(Duration::from_millis(100)),
    ))
    .await;
    let pairs = pairs(&mut admin, &id).await;
    let mut other = admin.fork();

    // The second asks while the first reads a million and a half rows, for another view.
    let (first, second) = tokio::join!(query(&mut admin, &id, pairs.view(0.0, 0)), async {
        tokio::time::sleep(Duration::from_millis(300)).await;
        query(&mut other, &id, pairs.view(0.5, 0)).await
    });

    assert_eq!(first.status, StatusCode::OK, "{}", first.text);
    assert_problem(&second, StatusCode::SERVICE_UNAVAILABLE, "server.busy");
}
