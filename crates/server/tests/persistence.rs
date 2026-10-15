mod common;

use std::{
    io,
    sync::{Arc, Mutex, PoisonError},
    time::Duration,
};

use axum::http::StatusCode;
use common::{Stored, TestApp, insert_model, line_item, setup_admin};
use openplan_engine::{
    AxisSpec, Calendar, CellEdit, Command, CoordToken, Format, ItemId, ItemSpec, LineItemId,
    LineItemPatch, ListId, Model, ModuleId, TimeLevel, Value,
};
use openplan_server::{
    actor::previous_values,
    engine_store::{self, cell_key},
    error::AppError,
};
use serde_json::json;
use sqlx::PgPool;
use tracing_subscriber::fmt::MakeWriter;
use uuid::Uuid;

const MONTHS: [&str; 12] = [
    "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

fn calendar() -> Calendar {
    Calendar {
        fiscal_year_start_month: 1,
        first_year: 2026,
        years: 1,
        current_month: None,
    }
}

/// A model row with the state a new model gets, loaded as the engine would hold it.
async fn stored_model(pool: &PgPool) -> (Stored, Model) {
    let stored = insert_model(pool).await;
    engine_store::create_model_state(pool, stored.id, calendar())
        .await
        .unwrap();
    let (model, seq) = engine_store::load(pool, stored.id).await.unwrap();
    assert_eq!(seq, 0);
    (stored, model)
}

/// The line items of the Sales module the tests build.
struct Plan {
    products: Vec<ItemId>,
    sales: ModuleId,
    units: LineItemId,
    price: LineItemId,
    revenue: LineItemId,
    note: LineItemId,
}

/// A structure batch: two products and a Sales module over products, months and versions with
/// typed numbers, a calculated revenue and typed notes.
fn plan_structure() -> (Plan, Vec<Command>) {
    let products = ListId::new();
    let items: Vec<ItemId> = (0..2).map(|_| ItemId::new()).collect();
    let sales = ModuleId::new();
    let units = line_item(sales, "Units", Format::number(), None);
    let price = line_item(sales, "Price", Format::number(), None);
    let revenue = line_item(sales, "Revenue", Format::number(), Some("Units * Price"));
    let note = line_item(sales, "Note", Format::Text, None);
    let plan = Plan {
        products: items.clone(),
        sales,
        units: units.id,
        price: price.id,
        revenue: revenue.id,
        note: note.id,
    };
    let commands = vec![
        Command::CreateList {
            id: products,
            name: "Products".to_string(),
            parent: None,
            top_level_name: None,
            numbered: false,
            production_data: false,
        },
        Command::UpsertListItems {
            list: products,
            items: items
                .iter()
                .zip(["Widget", "Gadget"])
                .map(|(&id, name)| ItemSpec {
                    id,
                    code: None,
                    name: name.to_string(),
                    parent: None,
                })
                .collect(),
        },
        Command::CreateModule {
            id: sales,
            name: "Sales".to_string(),
            axes: vec![
                AxisSpec::List { list: products },
                AxisSpec::Time {
                    level: TimeLevel::Month,
                    range: None,
                },
                AxisSpec::Versions,
            ],
            functional_area: String::new(),
        },
        Command::CreateLineItem(units),
        Command::CreateLineItem(price),
        Command::CreateLineItem(revenue),
        Command::CreateLineItem(note),
    ];
    (plan, commands)
}

/// The coordinates of a cell of the Sales module.
fn cell(
    model: &Model,
    plan: &Plan,
    product: usize,
    month: usize,
    version: usize,
) -> Vec<CoordToken> {
    vec![
        CoordToken::Item(plan.products[product]),
        CoordToken::Period(format!("{} 26", MONTHS[month])),
        CoordToken::Item(ItemId(model.structure().versions()[version].id.0)),
    ]
}

fn number_cells(
    model: &Model,
    plan: &Plan,
    line_item: LineItemId,
    cells: &[(usize, usize, usize, f64)],
) -> Command {
    Command::SetCells {
        line_item,
        edits: cells
            .iter()
            .map(|&(product, month, version, value)| CellEdit {
                coords: cell(model, plan, product, month, version),
                value: Value::Number(value),
            })
            .collect(),
    }
}

/// Every cell of every line item of the Sales module.
fn snapshot(model: &Model, plan: &Plan) -> Vec<Vec<Value>> {
    let grid: Vec<Vec<CoordToken>> = (0..plan.products.len())
        .flat_map(|product| {
            (0..12).flat_map(move |month| (0..3).map(move |version| (product, month, version)))
        })
        .map(|(product, month, version)| cell(model, plan, product, month, version))
        .collect();
    [plan.units, plan.price, plan.revenue, plan.note]
        .into_iter()
        .map(|line_item| model.read_cells(line_item, &grid).unwrap())
        .collect()
}

fn revenue_at(model: &Model, plan: &Plan, coords: Vec<CoordToken>) -> Value {
    model.read_cells(plan.revenue, &[coords]).unwrap().remove(0)
}

fn assert_same(loaded: &Model, expected: &Model, plan: &Plan) {
    assert_eq!(loaded.export_structure(), expected.export_structure());
    assert_eq!(snapshot(loaded, plan), snapshot(expected, plan));
}

/// Applies the batch to the model and records it in the change log, as a model's editor does.
/// Returns the sequence number of the batch.
async fn commit(pool: &PgPool, stored: &Stored, model: &mut Model, cmds: Vec<Command>) -> i64 {
    let previous = previous_values(model, &cmds);
    model.apply_batch(cmds.clone()).unwrap();
    let mut tx = pool.begin().await.unwrap();
    let appended = engine_store::append(&mut tx, stored.id, Some(stored.user), &cmds, &previous)
        .await
        .unwrap();
    tx.commit().await.unwrap();
    appended.seq
}

async fn count(pool: &PgPool, table: &str, model_id: Uuid) -> i64 {
    sqlx::query_scalar(&format!("SELECT count(*) FROM {table} WHERE model_id = $1"))
        .bind(model_id)
        .fetch_one(pool)
        .await
        .unwrap()
}

/// How many change-log rows of the model satisfy `condition`, which refers to `$2`.
async fn count_where(pool: &PgPool, model_id: Uuid, condition: &str, bound: i64) -> i64 {
    sqlx::query_scalar(&format!(
        "SELECT count(*) FROM change_log WHERE model_id = $1 AND {condition}"
    ))
    .bind(model_id)
    .bind(bound)
    .fetch_one(pool)
    .await
    .unwrap()
}

#[sqlx::test(migrator = "openplan_server::db::MIGRATOR")]
async fn new_model_has_state(pool: PgPool) {
    let mut app = TestApp::new(pool.clone());
    let workspace_id = setup_admin(&mut app).await;

    let created = app
        .post(
            &format!("/api/v1/workspaces/{workspace_id}/models"),
            Some(json!({ "name": "Plan" })),
        )
        .await;

    assert_eq!(created.status, StatusCode::CREATED, "{}", created.text);
    let id: Uuid = created.json["id"].as_str().unwrap().parse().unwrap();
    assert_eq!(count(&pool, "model_structure", id).await, 1);
    let (model, seq) = engine_store::load(&pool, id).await.unwrap();
    assert_eq!(seq, 0);
    let structure = model.structure();
    let versions: Vec<(&str, bool, bool)> = structure
        .versions()
        .iter()
        .map(|version| (&*version.name, version.is_actual, version.is_current))
        .collect();
    assert_eq!(
        versions,
        [
            ("Actual", true, false),
            ("Budget", false, true),
            ("Forecast", false, false)
        ]
    );
    assert_eq!(
        json!({
            "fiscal_year_start_month": structure.calendar.fiscal_year_start_month,
            "first_year": structure.calendar.first_year,
            "years": structure.calendar.years,
        }),
        created.json["calendar"]
    );
    assert_eq!(structure.calendar.current_month, None);
}

#[sqlx::test(migrator = "openplan_server::db::MIGRATOR")]
async fn model_without_state_gets_the_default_state_on_first_load(pool: PgPool) {
    let stored = insert_model(&pool).await;
    assert_eq!(count(&pool, "model_structure", stored.id).await, 0);

    let (model, seq) = engine_store::load(&pool, stored.id).await.unwrap();

    assert_eq!(seq, 0);
    assert_eq!(count(&pool, "model_structure", stored.id).await, 1);
    assert_eq!(model.structure().calendar, calendar());
    let names: Vec<&str> = model
        .structure()
        .versions()
        .iter()
        .map(|version| &*version.name)
        .collect();
    assert_eq!(names, ["Actual", "Budget", "Forecast"]);
    let (again, _) = engine_store::load(&pool, stored.id).await.unwrap();
    assert_eq!(
        again.export_structure(),
        model.export_structure(),
        "the default state is written once, not made up again on every load"
    );
}

/// The calendar a model stores in its row, as the database holds it.
async fn stored_calendar(pool: &PgPool, model_id: Uuid) -> serde_json::Value {
    sqlx::query_scalar("SELECT calendar FROM models WHERE id = $1")
        .bind(model_id)
        .fetch_one(pool)
        .await
        .unwrap()
}

#[sqlx::test(migrator = "openplan_server::db::MIGRATOR")]
async fn a_calendar_change_updates_the_calendar_of_the_model_in_its_transaction(pool: PgPool) {
    let (stored, mut model) = stored_model(&pool).await;
    let original = json!({ "fiscal_year_start_month": 1, "first_year": 2026, "years": 1 });
    let moved = |first_year| Calendar {
        fiscal_year_start_month: 4,
        first_year,
        years: 2,
        current_month: Some(3),
    };
    assert_eq!(stored_calendar(&pool, stored.id).await, original);

    // A batch that is not committed leaves the calendar as it was.
    let mut tx = pool.begin().await.unwrap();
    let set = Command::SetCalendar {
        calendar: moved(2027),
    };
    engine_store::append(&mut tx, stored.id, Some(stored.user), &[set], &[])
        .await
        .unwrap();
    tx.rollback().await.unwrap();
    assert_eq!(stored_calendar(&pool, stored.id).await, original);

    // One that is committed sets it to the last calendar the batch sets.
    let batch = vec![
        Command::SetCalendar {
            calendar: moved(2027),
        },
        Command::SetCalendar {
            calendar: moved(2028),
        },
    ];
    commit(&pool, &stored, &mut model, batch).await;
    assert_eq!(
        stored_calendar(&pool, stored.id).await,
        json!({ "fiscal_year_start_month": 4, "first_year": 2028, "years": 2 })
    );

    // A batch without a calendar leaves it be.
    let list = Command::CreateList {
        id: ListId::new(),
        name: "Regions".to_string(),
        parent: None,
        top_level_name: None,
        numbered: false,
        production_data: false,
    };
    commit(&pool, &stored, &mut model, vec![list]).await;
    assert_eq!(stored_calendar(&pool, stored.id).await["first_year"], 2028);
}

#[sqlx::test(migrator = "openplan_server::db::MIGRATOR")]
async fn append_then_load_replays(pool: PgPool) {
    let (stored, mut model) = stored_model(&pool).await;
    let (plan, structure) = plan_structure();
    commit(&pool, &stored, &mut model, structure).await;
    let cells = vec![
        number_cells(
            &model,
            &plan,
            plan.units,
            &[(0, 0, 1, 10.0), (1, 2, 1, 4.0)],
        ),
        number_cells(&model, &plan, plan.price, &[(0, 0, 1, 3.0), (1, 2, 1, 5.0)]),
    ];
    let last = commit(&pool, &stored, &mut model, cells).await;

    let (loaded, seq) = engine_store::load(&pool, stored.id).await.unwrap();

    assert_eq!(seq, last);
    assert_same(&loaded, &model, &plan);
    assert_eq!(
        revenue_at(&loaded, &plan, cell(&loaded, &plan, 0, 0, 1)),
        Value::Number(30.0)
    );
}

/// `count` numbers that use all 53 bits of an f64, from a fixed seed.
fn full_precision_numbers(count: usize) -> Vec<f64> {
    let mut state = 0x9E37_79B9_7F4A_7C15_u64;
    (0..count)
        .map(|_| {
            state ^= state << 13;
            state ^= state >> 7;
            state ^= state << 17;
            (state >> 11) as f64 / (1_u64 << 53) as f64 * 1_000_000.0
        })
        .collect()
}

fn number_bits(values: &[Value]) -> Vec<u64> {
    values
        .iter()
        .map(|value| match value {
            Value::Number(number) => number.to_bits(),
            other => panic!("expected a number, found {other:?}"),
        })
        .collect()
}

#[sqlx::test(migrator = "openplan_server::db::MIGRATOR")]
async fn replay_keeps_numbers_to_the_last_bit(pool: PgPool) {
    let (stored, mut model) = stored_model(&pool).await;
    let (plan, structure) = plan_structure();
    commit(&pool, &stored, &mut model, structure).await;
    let named = [0.1 + 0.2, 1.0 / 3.0, 123_456_789.123_456_79];
    let numbers: Vec<f64> = named
        .into_iter()
        .chain(full_precision_numbers(69))
        .collect();
    let cells: Vec<(usize, usize, usize, f64)> = (0..2)
        .flat_map(|product| {
            (0..12).flat_map(move |month| (0..3).map(move |version| (product, month, version)))
        })
        .zip(numbers.iter())
        .map(|((product, month, version), &number)| (product, month, version, number))
        .collect();
    assert_eq!(cells.len(), 72);
    let edit = number_cells(&model, &plan, plan.units, &cells);
    commit(&pool, &stored, &mut model, vec![edit]).await;

    let (loaded, _) = engine_store::load(&pool, stored.id).await.unwrap();

    let expected: Vec<u64> = numbers.iter().map(|number| number.to_bits()).collect();
    assert_eq!(number_bits(&snapshot(&model, &plan)[0]), expected);
    assert_eq!(number_bits(&snapshot(&loaded, &plan)[0]), expected);
    assert_same(&loaded, &model, &plan);
}

#[sqlx::test(migrator = "openplan_server::db::MIGRATOR")]
async fn checkpoint_then_load_equals(pool: PgPool) {
    let (stored, mut model) = stored_model(&pool).await;
    let (plan, structure) = plan_structure();
    commit(&pool, &stored, &mut model, structure).await;
    let cells = vec![
        number_cells(
            &model,
            &plan,
            plan.units,
            &[(0, 0, 1, 10.0), (1, 5, 0, 7.0)],
        ),
        number_cells(&model, &plan, plan.price, &[(0, 0, 1, 3.0), (1, 5, 0, 2.0)]),
        Command::SetCells {
            line_item: plan.note,
            edits: vec![CellEdit {
                coords: cell(&model, &plan, 1, 1, 2),
                value: Value::Text("rush é".into()),
            }],
        },
    ];
    let last = commit(&pool, &stored, &mut model, cells).await;

    engine_store::checkpoint(&pool, stored.id, &model, last)
        .await
        .unwrap();
    sqlx::query("DELETE FROM change_log WHERE model_id = $1")
        .bind(stored.id)
        .execute(&pool)
        .await
        .unwrap();
    let (loaded, seq) = engine_store::load(&pool, stored.id).await.unwrap();

    assert_eq!(seq, last);
    assert_same(&loaded, &model, &plan);
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT checkpoint_seq FROM models WHERE id = $1")
            .bind(stored.id)
            .fetch_one(&pool)
            .await
            .unwrap(),
        last
    );
}

#[sqlx::test(migrator = "openplan_server::db::MIGRATOR")]
async fn edits_after_checkpoint_survive_restart(pool: PgPool) {
    let (stored, mut model) = stored_model(&pool).await;
    let (plan, structure) = plan_structure();
    commit(&pool, &stored, &mut model, structure).await;
    let before = vec![
        number_cells(&model, &plan, plan.units, &[(0, 0, 1, 10.0)]),
        number_cells(&model, &plan, plan.price, &[(0, 0, 1, 3.0)]),
    ];
    let checkpointed = commit(&pool, &stored, &mut model, before).await;
    engine_store::checkpoint(&pool, stored.id, &model, checkpointed)
        .await
        .unwrap();

    let doubled = line_item(plan.sales, "Doubled", Format::number(), Some("Revenue * 2"));
    commit(
        &pool,
        &stored,
        &mut model,
        vec![Command::CreateLineItem(doubled)],
    )
    .await;
    let after = vec![
        number_cells(
            &model,
            &plan,
            plan.units,
            &[(0, 0, 1, 20.0), (1, 3, 1, 6.0)],
        ),
        number_cells(&model, &plan, plan.price, &[(1, 3, 1, 2.0)]),
    ];
    let last = commit(&pool, &stored, &mut model, after).await;

    let (loaded, seq) = engine_store::load(&pool, stored.id).await.unwrap();

    assert_eq!(seq, last);
    assert_same(&loaded, &model, &plan);
    assert_eq!(
        revenue_at(&loaded, &plan, cell(&loaded, &plan, 0, 0, 1)),
        Value::Number(60.0),
        "revenue is calculated from the edit made after the checkpoint"
    );
    assert_eq!(
        revenue_at(&loaded, &plan, cell(&loaded, &plan, 1, 3, 1)),
        Value::Number(12.0)
    );
}

#[derive(sqlx::FromRow)]
struct LogRow {
    kind: String,
    user_id: Option<Uuid>,
    line_item_id: Option<Uuid>,
    cell_key: Option<String>,
    payload: serde_json::Value,
}

async fn log_rows(pool: &PgPool, model_id: Uuid, cells: bool) -> Vec<LogRow> {
    sqlx::query_as::<_, LogRow>(
        "SELECT kind, user_id, line_item_id, cell_key, payload FROM change_log
         WHERE model_id = $1 AND (kind = 'cell') = $2 ORDER BY seq",
    )
    .bind(model_id)
    .bind(cells)
    .fetch_all(pool)
    .await
    .unwrap()
}

fn value_of(payload: &serde_json::Value, side: &str) -> Value {
    serde_json::from_value(payload[side].clone()).unwrap()
}

#[sqlx::test(migrator = "openplan_server::db::MIGRATOR")]
async fn audit_rows_have_old_and_new(pool: PgPool) {
    let (stored, mut model) = stored_model(&pool).await;
    let (plan, structure) = plan_structure();
    commit(&pool, &stored, &mut model, structure).await;
    let first = cell(&model, &plan, 0, 0, 1);
    let second = cell(&model, &plan, 1, 2, 1);
    let edits = number_cells(
        &model,
        &plan,
        plan.units,
        &[(0, 0, 1, 10.0), (1, 2, 1, 20.0)],
    );
    commit(&pool, &stored, &mut model, vec![edits]).await;
    let edit = number_cells(&model, &plan, plan.units, &[(0, 0, 1, 12.0)]);
    commit(&pool, &stored, &mut model, vec![edit]).await;

    let audit = log_rows(&pool, stored.id, true).await;

    assert_eq!(audit.len(), 3);
    for row in &audit {
        assert_eq!(row.kind, "cell");
        assert_eq!(row.user_id, Some(stored.user));
        assert_eq!(row.line_item_id, Some(plan.units.0));
    }
    assert_eq!(
        audit[0].cell_key.as_deref(),
        Some(cell_key(&first).as_str())
    );
    assert_eq!(value_of(&audit[0].payload, "old"), Value::Number(0.0));
    assert_eq!(value_of(&audit[0].payload, "new"), Value::Number(10.0));
    assert_eq!(
        audit[1].cell_key.as_deref(),
        Some(cell_key(&second).as_str())
    );
    assert_eq!(value_of(&audit[1].payload, "old"), Value::Number(0.0));
    assert_eq!(value_of(&audit[1].payload, "new"), Value::Number(20.0));
    assert_eq!(
        audit[2].cell_key.as_deref(),
        Some(cell_key(&first).as_str())
    );
    assert_eq!(value_of(&audit[2].payload, "old"), Value::Number(10.0));
    assert_eq!(value_of(&audit[2].payload, "new"), Value::Number(12.0));

    let batches = log_rows(&pool, stored.id, false).await;
    let kinds: Vec<&str> = batches.iter().map(|row| row.kind.as_str()).collect();
    assert_eq!(kinds, ["structure", "cells", "cells"]);
    for row in &batches {
        assert_eq!(row.user_id, Some(stored.user));
        assert_eq!(row.line_item_id, None);
        assert_eq!(row.cell_key, None);
    }
}

#[sqlx::test(migrator = "openplan_server::db::MIGRATOR")]
async fn audit_old_values_follow_the_edits_of_a_batch(pool: PgPool) {
    let (stored, mut model) = stored_model(&pool).await;
    let (plan, structure) = plan_structure();
    commit(&pool, &stored, &mut model, structure).await;
    let (x, z) = (cell(&model, &plan, 0, 0, 1), cell(&model, &plan, 1, 2, 1));
    // X is set to 5 and then 7, Y to the value it already has, Z to 3 and then to 3 again.
    let edits = number_cells(
        &model,
        &plan,
        plan.units,
        &[
            (0, 0, 1, 5.0),
            (0, 0, 1, 7.0),
            (0, 1, 1, 0.0),
            (1, 2, 1, 3.0),
            (1, 2, 1, 3.0),
        ],
    );
    commit(&pool, &stored, &mut model, vec![edits]).await;

    let audit = log_rows(&pool, stored.id, true).await;

    let number = |value: Value| match value {
        Value::Number(number) => number,
        other => panic!("expected a number, found {other:?}"),
    };
    let changes: Vec<(&str, f64, f64)> = audit
        .iter()
        .map(|row| {
            (
                row.cell_key.as_deref().unwrap(),
                number(value_of(&row.payload, "old")),
                number(value_of(&row.payload, "new")),
            )
        })
        .collect();
    assert_eq!(
        changes,
        [
            (cell_key(&x).as_str(), 0.0, 5.0),
            (cell_key(&x).as_str(), 5.0, 7.0),
            (cell_key(&z).as_str(), 0.0, 3.0),
        ]
    );
    assert_eq!(
        log_rows(&pool, stored.id, false).await.len(),
        2,
        "the batch itself is logged whatever it changes"
    );
}

async fn chunk_rows(pool: &PgPool, model_id: Uuid) -> Vec<(Uuid, i32)> {
    sqlx::query_as(
        "SELECT line_item_id, chunk FROM line_item_data WHERE model_id = $1
         ORDER BY line_item_id, chunk",
    )
    .bind(model_id)
    .fetch_all(pool)
    .await
    .unwrap()
}

#[sqlx::test(migrator = "openplan_server::db::MIGRATOR")]
async fn checkpoint_replaces_every_stored_chunk(pool: PgPool) {
    let (stored, mut model) = stored_model(&pool).await;
    let (plan, structure) = plan_structure();
    commit(&pool, &stored, &mut model, structure).await;
    let cells = vec![
        number_cells(&model, &plan, plan.units, &[(0, 0, 1, 10.0)]),
        number_cells(&model, &plan, plan.price, &[(0, 0, 1, 3.0)]),
    ];
    let last = commit(&pool, &stored, &mut model, cells).await;
    engine_store::checkpoint(&pool, stored.id, &model, last)
        .await
        .unwrap();
    let first: Vec<Uuid> = chunk_rows(&pool, stored.id)
        .await
        .into_iter()
        .map(|(line_item, _)| line_item)
        .collect();
    assert!(first.contains(&plan.units.0) && first.contains(&plan.price.0));

    // Price becomes calculated, so it has no typed cells left; the other rows are chunks of a
    // line item that no longer exists and a chunk number past the end.
    let last = commit(
        &pool,
        &stored,
        &mut model,
        vec![Command::UpdateLineItem {
            id: plan.price,
            patch: LineItemPatch {
                formula: Some(Some("Units * 2".to_string())),
                ..LineItemPatch::default()
            },
        }],
    )
    .await;
    for (line_item, chunk) in [(Uuid::now_v7(), 0), (plan.units.0, 7)] {
        sqlx::query(
            "INSERT INTO line_item_data (model_id, line_item_id, chunk, data)
             VALUES ($1, $2, $3, '\\x00')",
        )
        .bind(stored.id)
        .bind(line_item)
        .bind(chunk)
        .execute(&pool)
        .await
        .unwrap();
    }
    engine_store::checkpoint(&pool, stored.id, &model, last)
        .await
        .unwrap();

    let expected: Vec<(Uuid, i32)> = model
        .export_inputs()
        .iter()
        .map(|chunk| (chunk.line_item.0, chunk.chunk as i32))
        .collect();
    assert_eq!(chunk_rows(&pool, stored.id).await, expected);
    assert!(
        !expected
            .iter()
            .any(|&(line_item, _)| line_item == plan.price.0)
    );
    assert!(
        expected
            .iter()
            .any(|&(line_item, _)| line_item == plan.units.0)
    );
    let (loaded, _) = engine_store::load(&pool, stored.id).await.unwrap();
    assert_same(&loaded, &model, &plan);
}

#[sqlx::test(migrator = "openplan_server::db::MIGRATOR")]
async fn a_checkpoint_older_than_the_stored_one_changes_nothing(pool: PgPool) {
    let (stored, mut model) = stored_model(&pool).await;
    let (plan, structure) = plan_structure();
    let behind_seq = commit(&pool, &stored, &mut model, structure).await;
    let behind = model.clone();
    let cells = vec![number_cells(&model, &plan, plan.units, &[(0, 0, 1, 10.0)])];
    let last = commit(&pool, &stored, &mut model, cells).await;
    engine_store::checkpoint(&pool, stored.id, &model, last)
        .await
        .unwrap();

    engine_store::checkpoint(&pool, stored.id, &behind, behind_seq)
        .await
        .unwrap();

    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT checkpoint_seq FROM models WHERE id = $1")
            .bind(stored.id)
            .fetch_one(&pool)
            .await
            .unwrap(),
        last
    );
    sqlx::query("DELETE FROM change_log WHERE model_id = $1")
        .bind(stored.id)
        .execute(&pool)
        .await
        .unwrap();
    let (loaded, seq) = engine_store::load(&pool, stored.id).await.unwrap();
    assert_eq!(seq, last);
    assert_same(&loaded, &model, &plan);
}

/// Waits until a statement that starts with `prefix` waits for a lock another transaction holds.
async fn wait_for_lock_wait(pool: &PgPool, prefix: &str) {
    for _ in 0..200 {
        let waiting: i64 = sqlx::query_scalar(
            "SELECT count(*) FROM pg_stat_activity
             WHERE datname = current_database() AND wait_event_type = 'Lock' AND query LIKE $1",
        )
        .bind(format!("{prefix}%"))
        .fetch_one(pool)
        .await
        .unwrap();
        if waiting > 0 {
            return;
        }
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
    panic!("no statement starting with {prefix:?} is waiting for a lock");
}

#[sqlx::test(migrator = "openplan_server::db::MIGRATOR")]
async fn a_checkpoint_and_a_model_delete_do_not_deadlock(pool: PgPool) {
    let (stored, mut model) = stored_model(&pool).await;
    let (plan, structure) = plan_structure();
    commit(&pool, &stored, &mut model, structure).await;
    let cells = vec![number_cells(&model, &plan, plan.units, &[(0, 0, 1, 10.0)])];
    let last = commit(&pool, &stored, &mut model, cells).await;
    // The checkpoint stops at the delete of the stored chunks, past its first writes, for as
    // long as this transaction holds the row it deletes.
    sqlx::query(
        "INSERT INTO line_item_data (model_id, line_item_id, chunk, data)
         VALUES ($1, $2, 0, '\\x00')",
    )
    .bind(stored.id)
    .bind(Uuid::now_v7())
    .execute(&pool)
    .await
    .unwrap();
    let mut holder = pool.begin().await.unwrap();
    sqlx::query("SELECT 1 FROM line_item_data WHERE model_id = $1 FOR UPDATE")
        .bind(stored.id)
        .fetch_all(&mut *holder)
        .await
        .unwrap();
    let checkpointing = tokio::spawn({
        let pool = pool.clone();
        let model = model.clone();
        let model_id = stored.id;
        async move { engine_store::checkpoint(&pool, model_id, &model, last).await }
    });
    wait_for_lock_wait(&pool, "DELETE FROM line_item_data").await;
    let deleting = tokio::spawn({
        let pool = pool.clone();
        let model_id = stored.id;
        async move {
            sqlx::query("DELETE FROM models WHERE id = $1")
                .bind(model_id)
                .execute(&pool)
                .await
        }
    });
    wait_for_lock_wait(&pool, "DELETE FROM models").await;

    holder.commit().await.unwrap();

    checkpointing.await.unwrap().unwrap();
    assert_eq!(deleting.await.unwrap().unwrap().rows_affected(), 1);
    assert_eq!(count(&pool, "model_structure", stored.id).await, 0);
}

#[sqlx::test(migrator = "openplan_server::db::MIGRATOR")]
async fn append_needs_an_old_value_for_every_edited_cell(pool: PgPool) {
    let (stored, mut model) = stored_model(&pool).await;
    let (plan, structure) = plan_structure();
    commit(&pool, &stored, &mut model, structure).await;
    let edit = number_cells(
        &model,
        &plan,
        plan.units,
        &[(0, 0, 1, 10.0), (1, 2, 1, 20.0)],
    );
    let before = count(&pool, "change_log", stored.id).await;

    let mut tx = pool.begin().await.unwrap();
    let result =
        engine_store::append(&mut tx, stored.id, None, &[edit], &[Value::Number(0.0)]).await;
    tx.commit().await.unwrap();

    assert!(matches!(result, Err(AppError::Internal(_))));
    assert_eq!(count(&pool, "change_log", stored.id).await, before);
}

#[sqlx::test(migrator = "openplan_server::db::MIGRATOR")]
async fn appends_to_one_model_wait_for_each_other(pool: PgPool) {
    let (stored, mut model) = stored_model(&pool).await;
    let (plan, structure) = plan_structure();
    commit(&pool, &stored, &mut model, structure).await;
    let first = vec![number_cells(&model, &plan, plan.units, &[(0, 0, 1, 1.0)])];
    let second = vec![number_cells(&model, &plan, plan.units, &[(0, 0, 1, 2.0)])];

    let mut tx = pool.begin().await.unwrap();
    let first_seq = engine_store::append(&mut tx, stored.id, None, &first, &[Value::Number(0.0)])
        .await
        .unwrap()
        .seq;
    let mut other = tokio::spawn({
        let pool = pool.clone();
        let model_id = stored.id;
        async move {
            let mut tx = pool.begin().await.unwrap();
            let appended =
                engine_store::append(&mut tx, model_id, None, &second, &[Value::Number(1.0)])
                    .await
                    .unwrap();
            tx.commit().await.unwrap();
            appended.seq
        }
    });

    let waiting = tokio::time::timeout(Duration::from_millis(300), &mut other).await;
    assert!(
        waiting.is_err(),
        "the second append waits for the first to commit"
    );
    tx.commit().await.unwrap();
    let second_seq = other.await.unwrap();
    assert!(second_seq > first_seq);
}

#[sqlx::test(migrator = "openplan_server::db::MIGRATOR")]
async fn append_reports_the_rows_it_logged(pool: PgPool) {
    let (stored, mut model) = stored_model(&pool).await;
    let (plan, structure) = plan_structure();
    model.apply_batch(structure.clone()).unwrap();
    let mut tx = pool.begin().await.unwrap();
    let appended = engine_store::append(&mut tx, stored.id, None, &structure, &[])
        .await
        .unwrap();
    tx.commit().await.unwrap();
    assert_eq!(appended.rows, 1, "a batch that sets no cell is one row");

    // Of three edits, one leaves a blank cell blank and one sets a cell again: 2 cell rows.
    let cmds = vec![number_cells(
        &model,
        &plan,
        plan.units,
        &[(0, 0, 1, 10.0), (1, 2, 1, 0.0), (0, 0, 1, 12.0)],
    )];
    let previous = previous_values(&model, &cmds);
    let mut tx = pool.begin().await.unwrap();
    let appended = engine_store::append(&mut tx, stored.id, None, &cmds, &previous)
        .await
        .unwrap();
    tx.commit().await.unwrap();

    assert_eq!(appended.rows, 3);
    assert_eq!(
        count_where(&pool, stored.id, "seq > $2", appended.seq - 1).await,
        3
    );
}

#[sqlx::test(migrator = "openplan_server::db::MIGRATOR")]
async fn batches_since_the_checkpoint_leave_out_the_cells(pool: PgPool) {
    let (stored, mut model) = stored_model(&pool).await;
    let (plan, structure) = plan_structure();
    commit(&pool, &stored, &mut model, structure).await;
    let cells = vec![number_cells(
        &model,
        &plan,
        plan.units,
        &[(0, 0, 1, 10.0), (1, 2, 1, 20.0)],
    )];
    let last = commit(&pool, &stored, &mut model, cells).await;

    let counted = engine_store::batches_since_checkpoint(&pool, stored.id)
        .await
        .unwrap();
    assert_eq!(
        counted,
        (0, 2),
        "the structure and the cells, not their 2 cell rows"
    );

    engine_store::checkpoint(&pool, stored.id, &model, last)
        .await
        .unwrap();
    let counted = engine_store::batches_since_checkpoint(&pool, stored.id)
        .await
        .unwrap();
    assert_eq!(counted, (last, 0));

    let more = vec![number_cells(&model, &plan, plan.units, &[(0, 0, 1, 11.0)])];
    commit(&pool, &stored, &mut model, more).await;
    let counted = engine_store::batches_since_checkpoint(&pool, stored.id)
        .await
        .unwrap();
    assert_eq!(counted, (last, 1));
}

#[sqlx::test(migrator = "openplan_server::db::MIGRATOR")]
async fn unknown_model_is_not_found(pool: PgPool) {
    let id = Uuid::now_v7();

    let created = engine_store::create_model_state(&pool, id, calendar()).await;
    let loaded = engine_store::load(&pool, id).await;
    let checkpointed = engine_store::checkpoint(&pool, id, &Model::new(calendar()), 0).await;
    let mut tx = pool.begin().await.unwrap();
    let appended = engine_store::append(&mut tx, id, None, &[], &[]).await;
    let counted = engine_store::batches_since_checkpoint(&pool, id).await;

    assert!(matches!(created, Err(AppError::NotFound)));
    assert!(matches!(counted, Err(AppError::NotFound)));
    assert!(matches!(loaded, Err(AppError::NotFound)));
    assert!(matches!(checkpointed, Err(AppError::NotFound)));
    assert!(matches!(appended, Err(AppError::NotFound)));
}

#[sqlx::test(migrator = "openplan_server::db::MIGRATOR")]
async fn deleting_a_model_deletes_its_stored_state(pool: PgPool) {
    let (stored, mut model) = stored_model(&pool).await;
    let (plan, structure) = plan_structure();
    commit(&pool, &stored, &mut model, structure).await;
    let cells = vec![number_cells(&model, &plan, plan.units, &[(0, 0, 1, 10.0)])];
    let last = commit(&pool, &stored, &mut model, cells).await;
    engine_store::checkpoint(&pool, stored.id, &model, last)
        .await
        .unwrap();
    for table in ["model_structure", "line_item_data", "change_log"] {
        assert!(count(&pool, table, stored.id).await > 0, "{table}");
    }

    sqlx::query("DELETE FROM models WHERE id = $1")
        .bind(stored.id)
        .execute(&pool)
        .await
        .unwrap();

    for table in ["model_structure", "line_item_data", "change_log"] {
        assert_eq!(count(&pool, table, stored.id).await, 0, "{table}");
    }
}

#[sqlx::test(migrator = "openplan_server::db::MIGRATOR")]
async fn a_model_is_not_created_when_its_state_cannot_be_stored(pool: PgPool) {
    let mut app = TestApp::new(pool.clone());
    let workspace_id = setup_admin(&mut app).await;
    let path = format!("/api/v1/workspaces/{workspace_id}/models");
    sqlx::query("ALTER TABLE model_structure ADD CONSTRAINT refuse_every_state CHECK (false)")
        .execute(&pool)
        .await
        .unwrap();

    let refused = app.post(&path, Some(json!({ "name": "Plan" }))).await;

    assert_eq!(refused.status, StatusCode::INTERNAL_SERVER_ERROR);
    assert_eq!(refused.json["code"], "internal");
    let models: i64 = sqlx::query_scalar("SELECT count(*) FROM models")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(models, 0);
    sqlx::query("ALTER TABLE model_structure DROP CONSTRAINT refuse_every_state")
        .execute(&pool)
        .await
        .unwrap();
    let created = app.post(&path, Some(json!({ "name": "Plan" }))).await;
    assert_eq!(created.status, StatusCode::CREATED, "{}", created.text);
}

/// A log writer that keeps what it is given.
#[derive(Clone, Default)]
struct LogBuffer(Arc<Mutex<Vec<u8>>>);

impl LogBuffer {
    fn contents(&self) -> String {
        let bytes = self.0.lock().unwrap_or_else(PoisonError::into_inner);
        String::from_utf8_lossy(&bytes).into_owned()
    }
}

impl io::Write for LogBuffer {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        self.0
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .extend_from_slice(buf);
        Ok(buf.len())
    }

    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

impl MakeWriter<'_> for LogBuffer {
    type Writer = LogBuffer;

    fn make_writer(&self) -> LogBuffer {
        self.clone()
    }
}

#[sqlx::test(migrator = "openplan_server::db::MIGRATOR")]
async fn stored_cells_the_structure_cannot_hold_are_logged_and_left_out(pool: PgPool) {
    let (stored, mut model) = stored_model(&pool).await;
    let (plan, structure) = plan_structure();
    commit(&pool, &stored, &mut model, structure).await;
    let cells = vec![number_cells(&model, &plan, plan.units, &[(0, 0, 1, 10.0)])];
    commit(&pool, &stored, &mut model, cells).await;
    let orphans = model.export_inputs();
    let last = commit(
        &pool,
        &stored,
        &mut model,
        vec![Command::DeleteLineItem { id: plan.units }],
    )
    .await;
    engine_store::checkpoint(&pool, stored.id, &model, last)
        .await
        .unwrap();
    for chunk in orphans.iter().filter(|chunk| chunk.line_item == plan.units) {
        sqlx::query(
            "INSERT INTO line_item_data (model_id, line_item_id, chunk, data)
             VALUES ($1, $2, $3, $4)",
        )
        .bind(stored.id)
        .bind(chunk.line_item.0)
        .bind(chunk.chunk as i32)
        .bind(&chunk.data)
        .execute(&pool)
        .await
        .unwrap();
    }
    let logs = LogBuffer::default();
    let subscriber = tracing_subscriber::fmt()
        .with_writer(logs.clone())
        .with_ansi(false)
        .finish();
    let _logging = tracing::subscriber::set_default(subscriber);

    let (loaded, seq) = engine_store::load(&pool, stored.id).await.unwrap();

    assert_eq!(seq, last);
    assert_eq!(loaded.load_warnings(), 1);
    assert_eq!(loaded.export_structure(), model.export_structure());
    let id = stored.id.to_string();
    assert!(
        logs.contents()
            .lines()
            .any(|line| line.contains("ERROR") && line.contains(&id)),
        "the left out cells are logged at error level for the model"
    );
}

#[test]
fn cell_key_joins_the_coordinates_with_pipes() {
    let item = ItemId::new();
    let version = ItemId::new();

    let key = cell_key(&[
        CoordToken::Item(item),
        CoordToken::Period("Jan 26".to_string()),
        CoordToken::Item(version),
    ]);

    assert_eq!(key, format!("{}|Jan 26|{}", item.0, version.0));
    assert_eq!(cell_key(&[]), "");
}
