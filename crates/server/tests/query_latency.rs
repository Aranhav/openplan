//! How long a view query takes on the model of a million cells that the engine's benchmarks use:
//! 10,000 products over 36 months and 3 versions, with two inputs and four calculated line items.
//! A window of it comes back in under 50 ms, and so does a window of a filtered view of 580,000
//! rows once the rows that pass the filters are known; finding them takes longer, once.
//!
//! These are timings, so they are ignored and run in a release build:
//! `cargo test --release -p openplan-server --test query_latency -- --ignored --nocapture`.

mod common;

use std::time::{Duration, Instant};

use axum::http::StatusCode;
use common::{TestApp, create_model, setup_admin, url};
use openplan_engine::{
    AxisSpec, Calendar, CellEdit, Command, CoordToken, Format, ItemId, ItemSpec, LineItem,
    LineItemId, ListId, Model, ModuleId, SummaryMethod, TimeLevel, TimeScale, Value, VersionsScope,
};
use openplan_server::engine_store;
use serde_json::{Value as Json, json};
use sqlx::PgPool;
use uuid::Uuid;

const PRODUCTS: usize = 10_000;
const MONTHS: [&str; 12] = [
    "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

fn line_item(module: ModuleId, name: &str, formula: Option<&str>) -> LineItem {
    LineItem {
        id: LineItemId::new(),
        module,
        name: name.to_string(),
        ordinal: 0,
        format: Format::number(),
        formula: formula.map(str::to_string),
        summary: SummaryMethod::Sum,
        time_summary: None,
        applies_to: None,
        time_scale: TimeScale::Module,
        versions: VersionsScope::Module,
        notes: String::new(),
        code: None,
        read_access_driver: None,
        write_access_driver: None,
    }
}

struct Million {
    model: Model,
    list: ListId,
    module: ModuleId,
    units: LineItemId,
    price: LineItemId,
    revenue: LineItemId,
}

/// Fills an input line item with a number in every cell, 500 products to a command.
fn fill(
    model: &mut Model,
    line_item: LineItemId,
    products: &[ItemId],
    versions: &[ItemId],
    value: impl Fn(usize, usize) -> f64,
) {
    for (first, group) in products
        .chunks(500)
        .enumerate()
        .map(|(at, g)| (at * 500, g))
    {
        let mut edits = Vec::new();
        for (at, product) in group.iter().enumerate() {
            for month in 0..36 {
                for version in versions {
                    edits.push(CellEdit {
                        coords: vec![
                            CoordToken::Item(*product),
                            CoordToken::Period(format!(
                                "{} {}",
                                MONTHS[month % 12],
                                26 + month / 12
                            )),
                            CoordToken::Item(*version),
                        ],
                        value: Value::Number(value(first + at, month)),
                    });
                }
            }
        }
        model.apply(Command::SetCells { line_item, edits }).unwrap();
    }
}

fn million_cells() -> Million {
    let mut model = Model::new(Calendar {
        fiscal_year_start_month: 1,
        first_year: 2026,
        years: 3,
        current_month: None,
    });
    let list = ListId::new();
    let items: Vec<ItemSpec> = (0..PRODUCTS)
        .map(|at| ItemSpec {
            id: ItemId::new(),
            code: None,
            name: format!("Product {at}"),
            parent: None,
        })
        .collect();
    let products: Vec<ItemId> = items.iter().map(|item| item.id).collect();
    let module = ModuleId::new();
    model
        .apply_batch(vec![
            Command::CreateList {
                id: list,
                name: "Products".to_string(),
                parent: None,
                top_level_name: None,
                numbered: false,
                production_data: false,
            },
            Command::UpsertListItems { list, items },
            Command::CreateModule {
                id: module,
                name: "Sales".to_string(),
                axes: vec![
                    AxisSpec::List { list },
                    AxisSpec::Time {
                        level: TimeLevel::Month,
                        range: None,
                    },
                    AxisSpec::Versions,
                ],
                functional_area: String::new(),
            },
        ])
        .unwrap();
    let versions: Vec<ItemId> = model
        .structure()
        .versions()
        .iter()
        .map(|version| ItemId(version.id.0))
        .collect();
    let create = |model: &mut Model, name: &str, formula: Option<&str>| {
        let item = line_item(module, name, formula);
        let id = item.id;
        model.apply(Command::CreateLineItem(item)).unwrap();
        id
    };
    let units = create(&mut model, "Units", None);
    let price = create(&mut model, "Price", None);
    fill(&mut model, units, &products, &versions, |product, month| {
        10.0 + ((product + month) % 5) as f64
    });
    fill(&mut model, price, &products, &versions, |_, month| {
        2.0 + (month % 5) as f64
    });
    let revenue = create(&mut model, "Revenue", Some("Units * Price"));
    create(&mut model, "Cost", Some("Revenue * 0.6"));
    create(&mut model, "Margin", Some("Revenue - Cost"));
    create(&mut model, "Cumulative Margin", Some("CUMULATE(Margin)"));
    Million {
        model,
        list,
        module,
        units,
        price,
        revenue,
    }
}

struct Timed {
    status: StatusCode,
    took: Duration,
    json: Json,
    bytes: usize,
}

async fn timed_post(app: &mut TestApp, model: &str, path: &str, body: Json) -> Timed {
    let started = Instant::now();
    let response = app.post(&url(model, path), Some(body)).await;
    Timed {
        status: response.status,
        took: started.elapsed(),
        bytes: response.text.len(),
        json: response.json,
    }
}

fn median(mut times: Vec<Duration>) -> Duration {
    times.sort();
    times[times.len() / 2]
}

#[sqlx::test(migrator = "openplan_server::db::MIGRATOR")]
#[ignore = "timings; run in a release build"]
async fn queries_of_a_million_cells(pool: PgPool) {
    let started = Instant::now();
    let million = million_cells();
    eprintln!("built the model in {:.1?}", started.elapsed());
    let mut admin = TestApp::new(pool.clone());
    let workspace = setup_admin(&mut admin).await;
    let id = create_model(&mut admin, &workspace, "Million").await;
    let model_id = Uuid::parse_str(&id).unwrap();
    let (_, seq) = engine_store::load(&pool, model_id).await.unwrap();
    engine_store::checkpoint(&pool, model_id, &million.model, seq)
        .await
        .unwrap();
    let started = Instant::now();
    admin.state.models.get(model_id).await.unwrap();
    eprintln!("loaded the model in {:.1?}", started.elapsed());

    // The benchmark's query: products on rows, the periods of time with their totals on columns,
    // a window of 100 rows by 40 columns.
    let window = |row_offset: usize| json!({ "row_offset": row_offset, "row_limit": 100, "col_offset": 0, "col_limit": 40 });
    let plain = json!({
        "module": million.module.0,
        "rows": [{ "kind": "list", "list": million.list.0 }],
        "columns": [{ "kind": "time" }],
        "pages": [{ "dim": { "kind": "versions" } }, { "dim": { "kind": "line_items" } }],
        "window": window(5_000),
    });
    let first = timed_post(&mut admin, &id, "/query", plain.clone()).await;
    assert_eq!(first.status, StatusCode::OK);
    assert_eq!(first.json["total_rows"], PRODUCTS);
    let mut times = Vec::new();
    for _ in 0..20 {
        times.push(
            timed_post(&mut admin, &id, "/query", plain.clone())
                .await
                .took,
        );
    }
    let plain_median = median(times);
    eprintln!(
        "window of 100 x 40, no filter: first {:.1?}, median of 20 {plain_median:.1?}, {} bytes",
        first.took, first.bytes
    );

    // Every product in every period on rows, which are 580,000 rows once the totals are counted,
    // and three filters over them.
    let filter = |line_item: LineItemId, value: f64| json!({ "line_item": line_item.0, "op": "gt", "value": { "t": "number", "v": value } });
    let filtered = |row_offset: usize| {
        json!({
            "module": million.module.0,
            "rows": [{ "kind": "list", "list": million.list.0 }, { "kind": "time" }],
            "columns": [{ "kind": "line_items" }],
            "pages": [{ "dim": { "kind": "versions" } }],
            "filters": [
                filter(million.units, 12.0),
                filter(million.price, 3.0),
                filter(million.revenue, 40.0),
            ],
            "window": window(row_offset),
        })
    };
    let cold = timed_post(&mut admin, &id, "/query", filtered(0)).await;
    assert_eq!(cold.status, StatusCode::OK, "{}", cold.json);
    let passing = cold.json["total_rows"].as_u64().unwrap();
    let mut times = Vec::new();
    for scroll in 1..=20 {
        let scrolled = timed_post(&mut admin, &id, "/query", filtered(scroll * 1_000)).await;
        assert_eq!(scrolled.json["total_rows"], passing);
        times.push(scrolled.took);
    }
    let cached = median(times);
    eprintln!(
        "three filters over 580,000 rows ({passing} pass): cold {:.1?}, scrolling (cached) median of 20 {cached:.1?}",
        cold.took
    );

    // A change of the model drops them.
    let write = admin
        .post(
            &url(&id, "/cells"),
            Some(json!({ "edits": [{
                "line_item_id": million.units.0,
                "coords": [
                    million.model.structure().list(million.list).unwrap().item(0).id.0,
                    "Jan 26",
                    million.model.structure().versions()[0].id.0,
                ],
                "value": { "t": "number", "v": 99.0 },
            }] })),
        )
        .await;
    assert_eq!(write.status, StatusCode::OK, "{}", write.text);
    let after_a_change = timed_post(&mut admin, &id, "/query", filtered(0)).await;
    eprintln!("after a change of the model: {:.1?}", after_a_change.took);

    let members = timed_post(
        &mut admin,
        &id,
        "/members",
        json!({ "module_id": million.module.0, "dim": { "kind": "list", "list": million.list.0 } }),
    )
    .await;
    assert_eq!(members.status, StatusCode::OK);
    eprintln!(
        "members of 10,000 products: {:.1?}, {} bytes",
        members.took, members.bytes
    );

    assert!(
        plain_median < Duration::from_millis(250),
        "{plain_median:?}"
    );
    assert!(cached < Duration::from_millis(250), "{cached:?}");
    assert!(cached < cold.took);
}
