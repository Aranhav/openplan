mod common;

use std::{
    collections::HashMap,
    io,
    sync::{
        Arc, Mutex, PoisonError,
        atomic::{AtomicBool, Ordering},
    },
    time::Duration,
};

use axum::http::StatusCode;
use common::TestApp;
use openplan_engine::{
    AxisSpec, CellEdit, Command, CoordToken, EngineError, Format, ItemId, ItemSpec, LineItem,
    LineItemId, LineItemPatch, ListId, Model, ModuleId, SummaryMethod, TimeLevel, TimeScale, Value,
    VersionsScope,
};
use openplan_server::{
    actor::{ApplyOutcome, ModelEvent, ModelHandle, ModelRegistry},
    engine_store::{self, cell_key},
    error::{AppError, AppResult},
};
use serde_json::json;
use sqlx::{PgPool, postgres::PgPoolOptions, types::Json};
use tokio::{
    sync::broadcast::{
        self,
        error::{RecvError, TryRecvError},
    },
    time::{sleep, timeout},
};
use tracing_subscriber::fmt::MakeWriter;
use uuid::Uuid;

const MONTHS: [&str; 12] = [
    "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];
/// An idle time no test waits out.
const LONG: Duration = Duration::from_secs(30 * 60);
/// How long a test waits for something that should happen at once before it calls it a hang.
const WAIT: Duration = Duration::from_secs(5);

/// A model row, and the user who edits it.
struct Stored {
    id: Uuid,
    user: Uuid,
}

/// Inserts a user, a workspace and a model with no stored state, over a calendar of the twelve
/// months of 2026.
async fn insert_model(pool: &PgPool) -> Stored {
    let user = Uuid::now_v7();
    let workspace = Uuid::now_v7();
    let id = Uuid::now_v7();
    sqlx::query("INSERT INTO users (id, email, name) VALUES ($1, $2, 'Ada')")
        .bind(user)
        .bind(format!("ada-{user}@acme.com"))
        .execute(pool)
        .await
        .unwrap();
    sqlx::query("INSERT INTO workspaces (id, name) VALUES ($1, $2)")
        .bind(workspace)
        .bind(format!("Acme {workspace}"))
        .execute(pool)
        .await
        .unwrap();
    sqlx::query(
        "INSERT INTO models (id, workspace_id, name, calendar) VALUES ($1, $2, 'Plan', $3)",
    )
    .bind(id)
    .bind(workspace)
    .bind(Json(
        json!({ "fiscal_year_start_month": 1, "first_year": 2026, "years": 1 }),
    ))
    .execute(pool)
    .await
    .unwrap();
    Stored { id, user }
}

fn line_item(module: ModuleId, name: &str, format: Format, formula: Option<&str>) -> LineItem {
    LineItem {
        id: LineItemId::new(),
        module,
        name: name.to_string(),
        ordinal: 0,
        format,
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

fn create_list(list: ListId, name: &str, items: &[ItemId]) -> Vec<Command> {
    vec![
        Command::CreateList {
            id: list,
            name: name.to_string(),
            parent: None,
            top_level_name: None,
            numbered: false,
            production_data: false,
        },
        Command::UpsertListItems {
            list,
            items: items
                .iter()
                .enumerate()
                .map(|(i, &id)| ItemSpec {
                    id,
                    code: None,
                    name: format!("{name} {i}"),
                    parent: None,
                })
                .collect(),
        },
    ]
}

/// The Sales module the tests build: units and price typed per region, revenue calculated from
/// them and a typed note.
struct Plan {
    list: ListId,
    sales: ModuleId,
    regions: Vec<ItemId>,
    units: LineItemId,
    price: LineItemId,
    revenue: LineItemId,
    note: LineItemId,
}

/// The commands that build a Sales module over `regions` regions.
fn plan(regions: usize) -> (Plan, Vec<Command>) {
    let list = ListId::new();
    let items: Vec<ItemId> = (0..regions).map(|_| ItemId::new()).collect();
    let sales = ModuleId::new();
    let units = line_item(sales, "Units", Format::number(), None);
    let price = line_item(sales, "Price", Format::number(), None);
    let revenue = line_item(sales, "Revenue", Format::number(), Some("Units * Price"));
    let note = line_item(sales, "Note", Format::Text, None);
    let plan = Plan {
        list,
        sales,
        regions: items.clone(),
        units: units.id,
        price: price.id,
        revenue: revenue.id,
        note: note.id,
    };
    let mut commands = create_list(list, "Region", &items);
    commands.extend([
        Command::CreateModule {
            id: sales,
            name: "Sales".to_string(),
            axes: vec![AxisSpec::List { list }],
            functional_area: String::new(),
        },
        Command::CreateLineItem(units),
        Command::CreateLineItem(price),
        Command::CreateLineItem(revenue),
        Command::CreateLineItem(note),
    ]);
    (plan, commands)
}

/// Sets numbers in the Sales module, one per region given.
fn numbers(line_item: LineItemId, values: impl IntoIterator<Item = (ItemId, f64)>) -> Command {
    Command::SetCells {
        line_item,
        edits: values
            .into_iter()
            .map(|(region, value)| CellEdit {
                coords: vec![CoordToken::Item(region)],
                value: Value::Number(value),
            })
            .collect(),
    }
}

fn read(model: &Model, line_item: LineItemId, region: ItemId) -> Value {
    model
        .read_cells(line_item, &[vec![CoordToken::Item(region)]])
        .unwrap()
        .remove(0)
}

/// A registry over a model with the Sales module in it, and a handle to that model.
struct Setup {
    stored: Stored,
    registry: ModelRegistry,
    handle: ModelHandle,
    plan: Plan,
}

async fn setup_with(pool: &PgPool, regions: usize, idle: Duration) -> Setup {
    let stored = insert_model(pool).await;
    let registry = ModelRegistry::new(pool.clone(), idle);
    let handle = registry.get(stored.id).await.unwrap();
    let (plan, structure) = plan(regions);
    handle.apply(stored.user, structure).await.unwrap();
    Setup {
        stored,
        registry,
        handle,
        plan,
    }
}

async fn setup(pool: &PgPool, regions: usize) -> Setup {
    setup_with(pool, regions, LONG).await
}

async fn count(pool: &PgPool, model_id: Uuid, condition: &str) -> i64 {
    sqlx::query_scalar(&format!(
        "SELECT count(*) FROM change_log WHERE model_id = $1 AND {condition}"
    ))
    .bind(model_id)
    .fetch_one(pool)
    .await
    .unwrap()
}

async fn checkpoint_seq(pool: &PgPool, model_id: Uuid) -> i64 {
    sqlx::query_scalar("SELECT checkpoint_seq FROM models WHERE id = $1")
        .bind(model_id)
        .fetch_one(pool)
        .await
        .unwrap()
}

/// Whether the model's actor still runs: a subscription to it is open.
fn is_running(handle: &ModelHandle) -> bool {
    matches!(handle.subscribe().try_recv(), Err(TryRecvError::Empty))
}

async fn next_event(events: &mut broadcast::Receiver<ModelEvent>) -> ModelEvent {
    timeout(WAIT, events.recv())
        .await
        .expect("no event arrived")
        .expect("the channel is open")
}

/// The channel is closed, after whatever events were still waiting in it, and does not leave its
/// subscribers waiting.
async fn assert_closed(events: &mut broadcast::Receiver<ModelEvent>) {
    loop {
        let received = timeout(WAIT, events.recv())
            .await
            .expect("the channel was neither closed nor used");
        match received {
            Err(RecvError::Closed) => return,
            Ok(_) | Err(RecvError::Lagged(_)) => {}
        }
    }
}

/// Waits for a checkpoint that an actor saves in the background to reach `seq`.
async fn wait_for_checkpoint(pool: &PgPool, model_id: Uuid, seq: i64) {
    timeout(WAIT, async {
        while checkpoint_seq(pool, model_id).await < seq {
            sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .expect("the checkpoint was not saved");
}

/// Gives a checkpoint that must not happen time to happen anyway.
async fn assert_no_checkpoint_follows(pool: &PgPool, model_id: Uuid, saved: i64) {
    sleep(Duration::from_millis(300)).await;
    assert_eq!(checkpoint_seq(pool, model_id).await, saved);
}

/// What the log of the test says, kept so that the test can read it.
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

/// Starts keeping the log of this test (the runtime of a test is one thread, so the tasks of the
/// registry log to it too). The log is kept until the guard is dropped.
fn capture_logs() -> (LogBuffer, tracing::subscriber::DefaultGuard) {
    let buffer = LogBuffer::default();
    let subscriber = tracing_subscriber::fmt()
        .with_writer(buffer.clone())
        .with_ansi(false)
        .finish();
    (buffer, tracing::subscriber::set_default(subscriber))
}

/// Waits until the log has said `message` `times` times.
async fn wait_for_log(logs: &LogBuffer, message: &str, times: usize) {
    timeout(WAIT, async {
        while logs.contents().matches(message).count() < times {
            sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .unwrap_or_else(|_| panic!("the log did not say \"{message}\" {times} times"));
}

fn assert_same_cells(actual: &Model, expected: &Model, plan: &Plan) {
    assert_eq!(actual.export_structure(), expected.export_structure());
    for &region in &plan.regions {
        for line_item in [plan.units, plan.price, plan.revenue] {
            assert_eq!(
                read(actual, line_item, region),
                read(expected, line_item, region)
            );
        }
    }
}

#[sqlx::test(migrator = "openplan_server::db::MIGRATOR")]
async fn concurrent_applies_are_serialized(pool: PgPool) {
    let Setup {
        stored,
        handle,
        plan,
        ..
    } = setup(&pool, 100).await;
    let prices = plan.regions.iter().map(|&region| (region, 2.0));
    handle
        .apply(stored.user, vec![numbers(plan.price, prices)])
        .await
        .unwrap();
    let generation = handle.snapshot().generation();

    let applies: Vec<_> = plan
        .regions
        .iter()
        .enumerate()
        .map(|(i, &region)| {
            let handle = handle.clone();
            let (user, units) = (stored.user, plan.units);
            tokio::spawn(async move {
                let cells = numbers(units, [(region, (i + 1) as f64)]);
                handle.apply(user, vec![cells]).await
            })
        })
        .collect();
    let mut seqs = Vec::new();
    for apply in applies {
        seqs.push(apply.await.unwrap().unwrap().seq);
    }

    let mut distinct = seqs.clone();
    distinct.sort_unstable();
    distinct.dedup();
    assert_eq!(distinct.len(), 100);
    let live = handle.snapshot();
    assert_eq!(live.generation(), generation + 100);
    // Everything the live model shows was stored: the log replays to the same cells.
    let (replayed, last_seq) = engine_store::load(&pool, stored.id).await.unwrap();
    assert_eq!(last_seq, distinct[99]);
    assert_eq!(count(&pool, stored.id, "kind = 'cells'").await, 101);
    for model in [&*live, &replayed] {
        for (i, &region) in plan.regions.iter().enumerate() {
            let units = (i + 1) as f64;
            assert_eq!(read(model, plan.units, region), Value::Number(units));
            assert_eq!(
                read(model, plan.revenue, region),
                Value::Number(2.0 * units)
            );
        }
    }
}

#[sqlx::test(migrator = "openplan_server::db::MIGRATOR")]
async fn concurrent_writes_to_one_cell_chain_their_old_values(pool: PgPool) {
    let Setup {
        stored,
        handle,
        plan,
        ..
    } = setup(&pool, 1).await;
    let region = plan.regions[0];

    let applies: Vec<_> = (1..=20)
        .map(|value| {
            let handle = handle.clone();
            let (user, units) = (stored.user, plan.units);
            tokio::spawn(async move {
                handle
                    .apply(user, vec![numbers(units, [(region, f64::from(value))])])
                    .await
            })
        })
        .collect();
    for apply in applies {
        apply.await.unwrap().unwrap();
    }

    // Each write saw the one before it: no write was lost or applied to a stale model.
    let audit: Vec<(Json<serde_json::Value>,)> = sqlx::query_as(
        "SELECT payload FROM change_log
         WHERE model_id = $1 AND kind = 'cell' AND line_item_id = $2 ORDER BY seq",
    )
    .bind(stored.id)
    .bind(plan.units.0)
    .fetch_all(&pool)
    .await
    .unwrap();
    assert_eq!(audit.len(), 20);
    let mut expected_old = 0.0;
    for (Json(change),) in &audit {
        assert_eq!(change["old"]["v"].as_f64().unwrap(), expected_old);
        expected_old = change["new"]["v"].as_f64().unwrap();
    }
    assert_eq!(
        read(&handle.snapshot(), plan.units, region),
        Value::Number(expected_old)
    );
}

#[sqlx::test(migrator = "openplan_server::db::MIGRATOR")]
async fn engine_error_writes_nothing(pool: PgPool) {
    let Setup {
        stored,
        handle,
        plan,
        ..
    } = setup(&pool, 2).await;
    let before = handle.snapshot();
    let (_, seq_before) = handle.snapshot_seq();
    let rows = count(&pool, stored.id, "true").await;
    let mut events = handle.subscribe();
    let region = plan.regions[0];

    let text_in_a_number = Command::SetCells {
        line_item: plan.units,
        edits: vec![CellEdit {
            coords: vec![CoordToken::Item(region)],
            value: Value::Text("many".into()),
        }],
    };
    let invalid = handle
        .apply(
            stored.user,
            vec![numbers(plan.units, [(region, 5.0)]), text_in_a_number],
        )
        .await
        .unwrap_err();
    let unknown_name = Command::UpdateLineItem {
        id: plan.revenue,
        patch: LineItemPatch {
            formula: Some(Some("Unitz * Price".to_string())),
            ..LineItemPatch::default()
        },
    };
    let broken = handle
        .apply(stored.user, vec![unknown_name])
        .await
        .unwrap_err();

    assert!(
        matches!(invalid, AppError::Engine(EngineError::InvalidValue { .. })),
        "{invalid:?}"
    );
    let AppError::Engine(broken) = broken else {
        panic!("expected an engine error, got {broken:?}");
    };
    assert_eq!(broken.code(), "formula.unknown_name");
    assert_eq!(count(&pool, stored.id, "true").await, rows);
    assert!(
        Arc::ptr_eq(&before, &handle.snapshot()),
        "a rejected batch publishes nothing, not even the cells before the bad one"
    );
    assert_eq!(handle.snapshot_seq().1, seq_before);
    assert!(matches!(events.try_recv(), Err(TryRecvError::Empty)));
    // The actor goes on and the next batch continues the log.
    let next = handle
        .apply(stored.user, vec![numbers(plan.units, [(region, 6.0)])])
        .await
        .unwrap();
    assert!(next.seq > seq_before);
    assert_eq!(
        read(&handle.snapshot(), plan.units, region),
        Value::Number(6.0)
    );
}

#[sqlx::test(migrator = "openplan_server::db::MIGRATOR")]
async fn snapshot_reflects_latest(pool: PgPool) {
    let Setup {
        stored,
        handle,
        plan,
        ..
    } = setup(&pool, 2).await;
    let region = plan.regions[1];
    let before = handle.snapshot();

    let first = handle
        .apply(
            stored.user,
            vec![
                numbers(plan.units, [(region, 7.0)]),
                numbers(plan.price, [(region, 3.0)]),
            ],
        )
        .await
        .unwrap();

    let (after, seq) = handle.snapshot_seq();
    assert_eq!(seq, first.seq);
    assert!(Arc::ptr_eq(&after, &handle.snapshot()));
    assert_eq!(read(&after, plan.revenue, region), Value::Number(21.0));
    assert_eq!(
        read(&before, plan.units, region),
        Value::Number(0.0),
        "a snapshot taken earlier does not change under its holder"
    );
    let second = handle
        .apply(stored.user, vec![numbers(plan.units, [(region, 10.0)])])
        .await
        .unwrap();
    assert!(second.seq > first.seq);
    let (latest, seq) = handle.snapshot_seq();
    assert_eq!(seq, second.seq);
    assert_eq!(read(&latest, plan.revenue, region), Value::Number(30.0));
    assert_eq!(read(&after, plan.revenue, region), Value::Number(21.0));
}

#[sqlx::test(migrator = "openplan_server::db::MIGRATOR")]
async fn subscribers_receive_events(pool: PgPool) {
    let Setup {
        stored,
        handle,
        plan,
        ..
    } = setup(&pool, 2).await;
    let mut first = handle.subscribe();
    let mut second = handle.subscribe();

    let renamed = Command::UpdateLineItem {
        id: plan.units,
        patch: LineItemPatch {
            notes: Some("How many we sell".to_string()),
            ..LineItemPatch::default()
        },
    };
    let structure = handle.apply(stored.user, vec![renamed]).await.unwrap();
    let cells = handle
        .apply(
            stored.user,
            vec![numbers(plan.units, [(plan.regions[0], 4.0)])],
        )
        .await
        .unwrap();

    for events in [&mut first, &mut second] {
        assert_eq!(
            next_event(events).await,
            ModelEvent::StructureChanged { seq: structure.seq }
        );
        let ModelEvent::CellsChanged {
            seq,
            line_item_ids,
            user_id,
        } = next_event(events).await
        else {
            panic!("expected the cells event");
        };
        assert_eq!(seq, cells.seq);
        assert_eq!(user_id, stored.user);
        assert!(line_item_ids.contains(&plan.units), "{line_item_ids:?}");
        assert!(
            line_item_ids.contains(&plan.revenue),
            "the calculated line item that was calculated again is named too: {line_item_ids:?}"
        );
        assert!(matches!(events.try_recv(), Err(TryRecvError::Empty)));
    }
}

#[sqlx::test(migrator = "openplan_server::db::MIGRATOR")]
async fn evict_then_reload_same_values(pool: PgPool) {
    let Setup {
        stored,
        registry,
        handle,
        plan,
    } = setup_with(&pool, 3, Duration::ZERO).await;
    let region = plan.regions[2];
    let outcome = handle
        .apply(
            stored.user,
            vec![
                numbers(plan.units, [(plan.regions[0], 1.0), (region, 9.0)]),
                numbers(plan.price, [(region, 4.0)]),
            ],
        )
        .await
        .unwrap();
    let live = handle.snapshot();

    registry.evict_idle().await;

    assert_eq!(checkpoint_seq(&pool, stored.id).await, outcome.seq);
    assert!(
        handle.apply(stored.user, vec![]).await.is_err(),
        "the evicted actor takes no more work"
    );
    assert_closed(&mut handle.subscribe()).await;
    // The log is gone, so the reload can only come from the checkpoint.
    sqlx::query("DELETE FROM change_log WHERE model_id = $1")
        .bind(stored.id)
        .execute(&pool)
        .await
        .unwrap();
    let reloaded = registry.get(stored.id).await.unwrap();
    let (model, seq) = reloaded.snapshot_seq();
    assert!(!Arc::ptr_eq(&model, &live), "a new actor was started");
    assert_eq!(seq, outcome.seq);
    assert_same_cells(&model, &live, &plan);
    assert_eq!(read(&model, plan.revenue, region), Value::Number(36.0));
}

#[sqlx::test(migrator = "openplan_server::db::MIGRATOR")]
async fn concurrent_first_get_loads_once(pool: PgPool) {
    let Setup { stored, plan, .. } = setup(&pool, 1).await;
    // A registry that has not loaded the model yet; the first one is dropped, and with it
    // its actor.
    let registry = ModelRegistry::new(pool.clone(), LONG);

    let gets: Vec<_> = (0..20)
        .map(|_| {
            let registry = registry.clone();
            tokio::spawn(async move { registry.get(stored.id).await })
        })
        .collect();
    let mut handles = Vec::new();
    for get in gets {
        handles.push(get.await.unwrap().unwrap());
    }

    let first = handles[0].snapshot();
    assert!(
        handles.iter().all(|h| Arc::ptr_eq(&first, &h.snapshot())),
        "every caller got the one actor that was loaded"
    );
    handles[7]
        .apply(
            stored.user,
            vec![numbers(plan.units, [(plan.regions[0], 8.0)])],
        )
        .await
        .unwrap();
    assert_eq!(
        read(&handles[13].snapshot(), plan.units, plan.regions[0]),
        Value::Number(8.0)
    );
}

#[sqlx::test(migrator = "openplan_server::db::MIGRATOR")]
async fn unknown_model_is_not_found(pool: PgPool) {
    let registry = ModelRegistry::new(pool, LONG);
    let id = Uuid::now_v7();

    assert!(matches!(registry.get(id).await, Err(AppError::NotFound)));
    assert!(
        matches!(registry.get(id).await, Err(AppError::NotFound)),
        "a failed load is not remembered"
    );
}

#[sqlx::test(migrator = "openplan_server::db::MIGRATOR")]
async fn an_empty_batch_writes_nothing(pool: PgPool) {
    let Setup {
        stored,
        handle,
        plan,
        ..
    } = setup(&pool, 1).await;
    let applied = handle
        .apply(
            stored.user,
            vec![numbers(plan.units, [(plan.regions[0], 1.0)])],
        )
        .await
        .unwrap();
    let rows = count(&pool, stored.id, "true").await;
    let mut events = handle.subscribe();

    let outcome = handle.apply(stored.user, vec![]).await.unwrap();

    assert_eq!(outcome.seq, applied.seq);
    assert!(!outcome.change_set.structure_changed);
    assert!(outcome.change_set.changed_line_items.is_empty());
    assert_eq!(count(&pool, stored.id, "true").await, rows);
    assert!(matches!(events.try_recv(), Err(TryRecvError::Empty)));
}

/// The name of an item of a list.
fn item_name(model: &Model, list: ListId, item: ItemId) -> String {
    let list = model.structure().list(list).unwrap();
    list.items()
        .find(|(_, candidate)| candidate.id == item)
        .unwrap()
        .1
        .name
        .clone()
}

/// A change that adds `suffix` to the name of an item, to the name the model it is made on has.
fn append_to_name(
    list: ListId,
    item: ItemId,
    suffix: char,
) -> impl FnOnce(&Model) -> AppResult<Vec<Command>> + Send + 'static {
    move |model| {
        let name = format!("{}{suffix}", item_name(model, list, item));
        Ok(vec![Command::UpsertListItems {
            list,
            items: vec![ItemSpec {
                id: item,
                code: None,
                name,
                parent: None,
            }],
        }])
    }
}

#[sqlx::test(migrator = "openplan_server::db::MIGRATOR")]
async fn concurrent_read_modify_write_closures_lose_no_update(pool: PgPool) {
    let Setup {
        stored,
        handle,
        plan,
        ..
    } = setup(&pool, 1).await;
    let item = plan.regions[0];
    let letters: Vec<char> = ('a'..='t').collect();

    let applies: Vec<_> = letters
        .iter()
        .map(|&letter| {
            let handle = handle.clone();
            let (user, list) = (stored.user, plan.list);
            tokio::spawn(async move {
                handle
                    .apply_with(user, append_to_name(list, item, letter))
                    .await
            })
        })
        .collect();
    for apply in applies {
        apply.await.unwrap().unwrap();
    }

    // Each closure saw the name the one before it left: every letter is there, once.
    let (replayed, _) = engine_store::load(&pool, stored.id).await.unwrap();
    for model in [&*handle.snapshot(), &replayed] {
        let name = item_name(model, plan.list, item);
        let mut appended: Vec<char> = name.strip_prefix("Region 0").unwrap().chars().collect();
        appended.sort_unstable();
        assert_eq!(appended, letters, "{name}");
    }
}

#[sqlx::test(migrator = "openplan_server::db::MIGRATOR")]
async fn an_error_from_a_closure_is_returned_and_nothing_is_written(pool: PgPool) {
    let Setup { stored, handle, .. } = setup(&pool, 1).await;
    let before = handle.snapshot();
    let rows = count(&pool, stored.id, "true").await;
    let mut events = handle.subscribe();

    let failed = handle
        .apply_with(stored.user, |_| Err(AppError::Forbidden))
        .await
        .unwrap_err();

    assert!(matches!(failed, AppError::Forbidden), "{failed:?}");
    assert!(Arc::ptr_eq(&before, &handle.snapshot()));
    assert_eq!(count(&pool, stored.id, "true").await, rows);
    assert!(matches!(events.try_recv(), Err(TryRecvError::Empty)));
}

#[sqlx::test(migrator = "openplan_server::db::MIGRATOR")]
async fn a_closure_with_no_commands_writes_nothing(pool: PgPool) {
    let Setup { stored, handle, .. } = setup(&pool, 1).await;
    let (before, seq) = handle.snapshot_seq();
    let rows = count(&pool, stored.id, "true").await;
    let mut events = handle.subscribe();

    let outcome = handle
        .apply_with(stored.user, |_| Ok(Vec::new()))
        .await
        .unwrap();

    assert_eq!(outcome.seq, seq);
    assert!(!outcome.change_set.structure_changed);
    assert!(outcome.change_set.changed_line_items.is_empty());
    assert!(Arc::ptr_eq(&before, &handle.snapshot()));
    assert_eq!(count(&pool, stored.id, "true").await, rows);
    assert!(matches!(events.try_recv(), Err(TryRecvError::Empty)));
}

#[sqlx::test(migrator = "openplan_server::db::MIGRATOR")]
async fn a_batch_can_set_cells_that_it_creates(pool: PgPool) {
    let Setup {
        stored,
        handle,
        plan,
        ..
    } = setup(&pool, 1).await;
    let (old_region, new_region) = (plan.regions[0], ItemId::new());
    handle
        .apply(stored.user, vec![numbers(plan.units, [(old_region, 3.0)])])
        .await
        .unwrap();
    let discount = line_item(plan.sales, "Discount", Format::number(), None);
    let discount_id = discount.id;

    // The line item and the region do not exist before the batch.
    let outcome = handle
        .apply(
            stored.user,
            vec![
                Command::CreateLineItem(discount),
                Command::UpsertListItems {
                    list: plan.list,
                    items: vec![ItemSpec {
                        id: new_region,
                        code: None,
                        name: "Region new".to_string(),
                        parent: None,
                    }],
                },
                numbers(discount_id, [(old_region, 0.25)]),
                numbers(plan.units, [(old_region, 5.0), (new_region, 7.0)]),
            ],
        )
        .await
        .unwrap();

    assert!(outcome.change_set.structure_changed);
    let old_values: Vec<(String, Json<serde_json::Value>)> = sqlx::query_as(
        "SELECT cell_key, payload FROM change_log
         WHERE model_id = $1 AND kind = 'cell' AND seq > $2 ORDER BY seq",
    )
    .bind(stored.id)
    .bind(outcome.seq)
    .fetch_all(&pool)
    .await
    .unwrap();
    let old: Vec<(&str, f64)> = old_values
        .iter()
        .map(|(key, Json(change))| (key.as_str(), change["old"]["v"].as_f64().unwrap()))
        .collect();
    let (old_key, new_key) = (
        cell_key(&[CoordToken::Item(old_region)]),
        cell_key(&[CoordToken::Item(new_region)]),
    );
    assert_eq!(
        old,
        [
            (old_key.as_str(), 0.0),
            (old_key.as_str(), 3.0),
            (new_key.as_str(), 0.0)
        ],
        "a cell that is new reads as blank, one that was there keeps its old value"
    );
    assert_eq!(
        read(&handle.snapshot(), plan.units, new_region),
        Value::Number(7.0)
    );
}

#[sqlx::test(migrator = "openplan_server::db::MIGRATOR")]
async fn a_failed_write_keeps_the_previous_model(pool: PgPool) {
    let Setup {
        stored,
        handle,
        plan,
        ..
    } = setup(&pool, 1).await;
    let region = plan.regions[0];
    handle
        .apply(stored.user, vec![numbers(plan.units, [(region, 1.0)])])
        .await
        .unwrap();
    let before = handle.snapshot();
    let mut events = handle.subscribe();
    sqlx::query("ALTER TABLE change_log RENAME TO change_log_away")
        .execute(&pool)
        .await
        .unwrap();

    let failed = handle
        .apply(stored.user, vec![numbers(plan.units, [(region, 2.0)])])
        .await
        .unwrap_err();

    assert!(matches!(failed, AppError::Internal(_)), "{failed:?}");
    assert!(Arc::ptr_eq(&before, &handle.snapshot()));
    assert!(matches!(events.try_recv(), Err(TryRecvError::Empty)));
    sqlx::query("ALTER TABLE change_log_away RENAME TO change_log")
        .execute(&pool)
        .await
        .unwrap();
    handle
        .apply(stored.user, vec![numbers(plan.units, [(region, 3.0)])])
        .await
        .unwrap();
    let (replayed, _) = engine_store::load(&pool, stored.id).await.unwrap();
    assert_eq!(read(&replayed, plan.units, region), Value::Number(3.0));
    assert_eq!(
        read(&handle.snapshot(), plan.units, region),
        Value::Number(3.0)
    );
}

#[sqlx::test(migrator = "openplan_server::db::MIGRATOR")]
async fn a_value_the_database_cannot_store_leaves_the_model_as_it_was(pool: PgPool) {
    let Setup {
        stored,
        handle,
        plan,
        ..
    } = setup(&pool, 1).await;
    let region = plan.regions[0];
    let before = handle.snapshot();
    let rows = count(&pool, stored.id, "true").await;
    // The engine refuses text with a NUL character, which a JSON document in Postgres cannot hold.
    let nul = Command::SetCells {
        line_item: plan.note,
        edits: vec![CellEdit {
            coords: vec![CoordToken::Item(region)],
            value: Value::Text("a\0b".into()),
        }],
    };

    let failed = handle.apply(stored.user, vec![nul]).await.unwrap_err();

    assert!(matches!(failed, AppError::Engine(_)), "{failed:?}");
    assert!(Arc::ptr_eq(&before, &handle.snapshot()));
    assert_eq!(count(&pool, stored.id, "true").await, rows);
    handle
        .apply(stored.user, vec![numbers(plan.units, [(region, 2.0)])])
        .await
        .unwrap();
}

#[sqlx::test(migrator = "openplan_server::db::MIGRATOR")]
async fn a_deleted_model_cannot_be_edited(pool: PgPool) {
    let Setup {
        stored,
        handle,
        plan,
        ..
    } = setup(&pool, 1).await;
    let before = handle.snapshot();
    sqlx::query("DELETE FROM models WHERE id = $1")
        .bind(stored.id)
        .execute(&pool)
        .await
        .unwrap();

    let failed = handle
        .apply(
            stored.user,
            vec![numbers(plan.units, [(plan.regions[0], 2.0)])],
        )
        .await
        .unwrap_err();

    assert!(matches!(failed, AppError::NotFound), "{failed:?}");
    assert!(Arc::ptr_eq(&before, &handle.snapshot()));
}

#[sqlx::test(migrator = "openplan_server::db::MIGRATOR")]
async fn a_commit_that_may_have_failed_restarts_the_actor_from_the_database(pool: PgPool) {
    let Setup {
        stored,
        registry,
        handle,
        plan,
    } = setup(&pool, 1).await;
    let region = plan.regions[0];
    let before = handle.snapshot();
    let mut events = handle.subscribe();
    // The insert goes through; the transaction is refused when it commits.
    sqlx::raw_sql(
        "CREATE FUNCTION refuse() RETURNS trigger LANGUAGE plpgsql AS
           $$ BEGIN RAISE EXCEPTION 'refused at commit'; END $$;
         CREATE CONSTRAINT TRIGGER refuse_commit AFTER INSERT ON change_log
           DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION refuse();",
    )
    .execute(&pool)
    .await
    .unwrap();

    let failed = handle
        .apply(stored.user, vec![numbers(plan.units, [(region, 2.0)])])
        .await
        .unwrap_err();

    assert!(matches!(failed, AppError::Internal(_)), "{failed:?}");
    assert_closed(&mut events).await;
    sqlx::raw_sql("DROP TRIGGER refuse_commit ON change_log")
        .execute(&pool)
        .await
        .unwrap();
    // Whether the batch was stored is not known to the actor, so the database decides.
    let fresh = registry.get(stored.id).await.unwrap();
    let (model, _) = fresh.snapshot_seq();
    assert!(!Arc::ptr_eq(&model, &before), "a new actor was started");
    assert_eq!(read(&model, plan.units, region), Value::Number(0.0));
    fresh
        .apply(stored.user, vec![numbers(plan.units, [(region, 4.0)])])
        .await
        .unwrap();
    assert_eq!(
        read(&fresh.snapshot(), plan.units, region),
        Value::Number(4.0)
    );
}

#[sqlx::test(migrator = "openplan_server::db::MIGRATOR")]
async fn shutdown_checkpoints_every_changed_model_and_closes_its_events(pool: PgPool) {
    let first = setup(&pool, 1).await;
    let second_stored = insert_model(&pool).await;
    let second = first.registry.get(second_stored.id).await.unwrap();
    let (plan_two, structure) = plan(1);
    second.apply(second_stored.user, structure).await.unwrap();
    let outcome = second
        .apply(
            second_stored.user,
            vec![numbers(plan_two.units, [(plan_two.regions[0], 5.0)])],
        )
        .await
        .unwrap();
    let untouched = insert_model(&pool).await;
    first.registry.get(untouched.id).await.unwrap();
    let mut events = [first.handle.subscribe(), second.subscribe()];
    let first_seq = first.handle.snapshot_seq().1;

    first.registry.shutdown().await;

    assert_eq!(checkpoint_seq(&pool, first.stored.id).await, first_seq);
    assert_eq!(checkpoint_seq(&pool, second_stored.id).await, outcome.seq);
    assert_eq!(
        checkpoint_seq(&pool, untouched.id).await,
        0,
        "a model nobody changed has nothing to checkpoint"
    );
    for events in &mut events {
        assert_closed(events).await;
    }
}

#[sqlx::test(migrator = "openplan_server::db::MIGRATOR")]
async fn evicting_a_model_nobody_changed_writes_nothing(pool: PgPool) {
    let stored = insert_model(&pool).await;
    let registry = ModelRegistry::new(pool.clone(), Duration::ZERO);
    registry.get(stored.id).await.unwrap();
    let saved_at: chrono::DateTime<chrono::Utc> =
        sqlx::query_scalar("SELECT updated_at FROM model_structure WHERE model_id = $1")
            .bind(stored.id)
            .fetch_one(&pool)
            .await
            .unwrap();

    registry.evict_idle().await;

    let now: chrono::DateTime<chrono::Utc> =
        sqlx::query_scalar("SELECT updated_at FROM model_structure WHERE model_id = $1")
            .bind(stored.id)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(now, saved_at);
}

#[sqlx::test(migrator = "openplan_server::db::MIGRATOR")]
async fn discard_drops_the_actor_without_a_checkpoint(pool: PgPool) {
    let Setup {
        stored,
        registry,
        handle,
        plan,
    } = setup(&pool, 1).await;
    handle
        .apply(
            stored.user,
            vec![numbers(plan.units, [(plan.regions[0], 1.0)])],
        )
        .await
        .unwrap();
    let mut events = handle.subscribe();

    registry.discard(stored.id).await;

    assert_eq!(checkpoint_seq(&pool, stored.id).await, 0);
    assert_closed(&mut events).await;
    assert!(handle.apply(stored.user, vec![]).await.is_err());
    // Nothing remembers the actor: the next get loads the model again.
    let reloaded = registry.get(stored.id).await.unwrap();
    assert!(!Arc::ptr_eq(&reloaded.snapshot(), &handle.snapshot()));
}

#[sqlx::test(migrator = "openplan_server::db::MIGRATOR")]
async fn a_model_with_subscribers_is_not_evicted(pool: PgPool) {
    let Setup {
        stored,
        registry,
        handle,
        plan,
    } = setup_with(&pool, 1, Duration::ZERO).await;
    assert_eq!(handle.subscribers(), 0);
    let mut events = handle.subscribe();
    assert_eq!(handle.subscribers(), 1);

    registry.evict_idle().await;

    // Nobody has used the model, but somebody follows it: the actor and its channel go on.
    let outcome = handle
        .apply(
            stored.user,
            vec![numbers(plan.units, [(plan.regions[0], 3.0)])],
        )
        .await
        .unwrap();
    assert!(matches!(
        next_event(&mut events).await,
        ModelEvent::CellsChanged { seq, .. } if seq == outcome.seq
    ));
    drop(events);
    assert_eq!(handle.subscribers(), 0);
    registry.evict_idle().await;
    assert!(!is_running(&handle), "with nobody following it, it goes");
}

#[sqlx::test(migrator = "openplan_server::db::MIGRATOR")]
async fn recently_used_models_stay_loaded(pool: PgPool) {
    let Setup {
        registry, handle, ..
    } = setup(&pool, 1).await;

    registry.evict_idle().await;

    assert!(is_running(&handle));
}

/// The idle time of the tests that wait it out: each wait is shorter than it, but two together
/// are not, so a model that was used between them must still be loaded after both.
const SHORT_IDLE: Duration = Duration::from_millis(1500);
const HALF_IDLE: Duration = Duration::from_millis(900);

#[sqlx::test(migrator = "openplan_server::db::MIGRATOR")]
async fn applying_keeps_a_model_from_going_idle(pool: PgPool) {
    let Setup {
        stored,
        registry,
        handle,
        plan,
    } = setup_with(&pool, 1, SHORT_IDLE).await;

    sleep(HALF_IDLE).await;
    handle
        .apply(
            stored.user,
            vec![numbers(plan.units, [(plan.regions[0], 1.0)])],
        )
        .await
        .unwrap();
    sleep(HALF_IDLE).await;
    registry.evict_idle().await;
    assert!(is_running(&handle), "an apply is use");

    sleep(SHORT_IDLE + Duration::from_millis(100)).await;
    registry.evict_idle().await;
    assert!(
        !is_running(&handle),
        "a model nobody used for long is evicted"
    );
}

#[sqlx::test(migrator = "openplan_server::db::MIGRATOR")]
async fn getting_keeps_a_model_from_going_idle(pool: PgPool) {
    let Setup {
        stored,
        registry,
        handle,
        ..
    } = setup_with(&pool, 1, SHORT_IDLE).await;

    sleep(HALF_IDLE).await;
    registry.get(stored.id).await.unwrap();
    sleep(HALF_IDLE).await;
    registry.evict_idle().await;

    assert!(is_running(&handle), "a get is use");
}

/// The grid the checkpoint tests fill: 750 rows by the 12 months of the calendar.
struct Grid {
    rows: Vec<ItemId>,
    value: LineItemId,
}

fn grid() -> (Grid, Vec<Command>) {
    let list = ListId::new();
    let rows: Vec<ItemId> = (0..750).map(|_| ItemId::new()).collect();
    let module = ModuleId::new();
    let value = line_item(module, "Value", Format::number(), None);
    let grid = Grid {
        rows: rows.clone(),
        value: value.id,
    };
    let mut commands = create_list(list, "Row", &rows);
    commands.extend([
        Command::CreateModule {
            id: module,
            name: "Grid".to_string(),
            axes: vec![
                AxisSpec::List { list },
                AxisSpec::Time {
                    level: TimeLevel::Month,
                    range: None,
                },
            ],
            functional_area: String::new(),
        },
        Command::CreateLineItem(value),
    ]);
    (grid, commands)
}

/// Sets `count` cells of the grid, filling it row by row from its first cell, to `base` plus 1
/// for the first and on. A cell set to what it has is not logged, so a base that differs from
/// the one before makes every edit a logged row.
fn fill(grid: &Grid, count: usize, base: f64) -> Command {
    Command::SetCells {
        line_item: grid.value,
        edits: (0..count)
            .map(|i| CellEdit {
                coords: vec![
                    CoordToken::Item(grid.rows[i / 12]),
                    CoordToken::Period(format!("{} 26", MONTHS[i % 12])),
                ],
                value: Value::Number(base + i as f64 + 1.0),
            })
            .collect(),
    }
}

/// A model whose grid is empty, and the handle of its actor, in a registry that evicts nothing.
async fn grid_model(pool: &PgPool) -> (Stored, ModelRegistry, ModelHandle, Grid) {
    let stored = insert_model(pool).await;
    let registry = ModelRegistry::new(pool.clone(), LONG);
    let handle = registry.get(stored.id).await.unwrap();
    let (grid, structure) = grid();
    handle.apply(stored.user, structure).await.unwrap();
    (stored, registry, handle, grid)
}

/// Applies the edits that bring the change log of a model that `grid_model` made to 9,002 rows:
/// one for the structure, and one for the batch and one for each of the 9,000 cells.
async fn nearly_enough_rows(stored: &Stored, handle: &ModelHandle, grid: &Grid) {
    handle
        .apply(stored.user, vec![fill(grid, 9_000, 0.0)])
        .await
        .unwrap();
}

/// Applies the edits that make the 10,000th row: 1,001 more.
async fn enough_rows(stored: &Stored, handle: &ModelHandle, grid: &Grid) -> ApplyOutcome {
    handle
        .apply(stored.user, vec![fill(grid, 1_000, 100_000.0)])
        .await
        .unwrap()
}

fn grid_value(model: &Model, grid: &Grid, cell: usize) -> Value {
    model
        .read_cells(
            grid.value,
            &[vec![
                CoordToken::Item(grid.rows[cell / 12]),
                CoordToken::Period(format!("{} 26", MONTHS[cell % 12])),
            ]],
        )
        .unwrap()
        .remove(0)
}

#[sqlx::test(migrator = "openplan_server::db::MIGRATOR")]
async fn checkpoints_after_10000_change_log_rows(pool: PgPool) {
    let (stored, _registry, handle, grid) = grid_model(&pool).await;

    nearly_enough_rows(&stored, &handle, &grid).await;
    assert_no_checkpoint_follows(&pool, stored.id, 0).await;

    let outcome = enough_rows(&stored, &handle, &grid).await;
    wait_for_checkpoint(&pool, stored.id, outcome.seq).await;
    assert_eq!(checkpoint_seq(&pool, stored.id).await, outcome.seq);
    let stored_cells: i64 =
        sqlx::query_scalar("SELECT count(*) FROM line_item_data WHERE model_id = $1")
            .bind(stored.id)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert!(stored_cells > 0);

    // The count starts again: 1,001 rows are not enough.
    let later = handle
        .apply(stored.user, vec![fill(&grid, 1_000, 200_000.0)])
        .await
        .unwrap();
    assert_no_checkpoint_follows(&pool, stored.id, outcome.seq).await;
    assert!(later.seq > outcome.seq);
}

#[sqlx::test(migrator = "openplan_server::db::MIGRATOR")]
async fn cells_that_do_not_change_are_not_counted(pool: PgPool) {
    let (stored, _registry, handle, grid) = grid_model(&pool).await;
    nearly_enough_rows(&stored, &handle, &grid).await;

    // The same values again: no cell row is logged, so these batches are 1 row each.
    for _ in 0..3 {
        handle
            .apply(stored.user, vec![fill(&grid, 9_000, 0.0)])
            .await
            .unwrap();
    }

    assert_no_checkpoint_follows(&pool, stored.id, 0).await;
}

#[sqlx::test(migrator = "openplan_server::db::MIGRATOR")]
async fn the_batches_since_the_checkpoint_count_after_a_reload(pool: PgPool) {
    let stored = insert_model(&pool).await;
    let first = ModelRegistry::new(pool.clone(), LONG);
    let handle = first.get(stored.id).await.unwrap();
    // 9,999 batches of nothing in the log, after a checkpoint that is not there yet.
    sqlx::query(
        "INSERT INTO change_log (model_id, kind, payload)
         SELECT $1, 'cells', '[]' FROM generate_series(1, 9999)",
    )
    .bind(stored.id)
    .execute(&pool)
    .await
    .unwrap();
    // The process goes away; the next one counts what the log holds.
    drop((handle, first));

    let second = ModelRegistry::new(pool.clone(), LONG);
    let handle = second.get(stored.id).await.unwrap();
    let (_, structure) = plan(1);
    let outcome = handle.apply(stored.user, structure).await.unwrap();

    wait_for_checkpoint(&pool, stored.id, outcome.seq).await;
}

#[sqlx::test(migrator = "openplan_server::db::MIGRATOR")]
async fn edits_go_on_while_a_checkpoint_is_written(pool: PgPool) {
    let (stored, _registry, handle, grid) = grid_model(&pool).await;
    nearly_enough_rows(&stored, &handle, &grid).await;
    // The checkpoint writes the structure first; somebody else holds its row.
    let mut hold = pool.begin().await.unwrap();
    sqlx::query("SELECT 1 FROM model_structure WHERE model_id = $1 FOR UPDATE")
        .bind(stored.id)
        .fetch_one(&mut *hold)
        .await
        .unwrap();

    let crossing = enough_rows(&stored, &handle, &grid).await;
    let during = timeout(
        WAIT,
        handle.apply(stored.user, vec![fill(&grid, 10, 300_000.0)]),
    )
    .await
    .expect("edits wait for the checkpoint")
    .unwrap();

    assert_eq!(checkpoint_seq(&pool, stored.id).await, 0);
    hold.rollback().await.unwrap();
    wait_for_checkpoint(&pool, stored.id, crossing.seq).await;
    assert_eq!(
        checkpoint_seq(&pool, stored.id).await,
        crossing.seq,
        "the checkpoint is of the model as it was when it began, not of the edit made meanwhile"
    );
    // The checkpoint and the edit after it make the live model.
    let (loaded, seq) = engine_store::load(&pool, stored.id).await.unwrap();
    assert_eq!(seq, during.seq);
    let live = handle.snapshot();
    for cell in [0, 5, 10, 999, 1_000, 8_999] {
        assert_eq!(
            grid_value(&loaded, &grid, cell),
            grid_value(&live, &grid, cell),
            "cell {cell}"
        );
    }
    assert_eq!(grid_value(&live, &grid, 5), Value::Number(300_006.0));
}

#[sqlx::test(migrator = "openplan_server::db::MIGRATOR")]
async fn shutdown_saves_the_last_edits_when_a_checkpoint_is_in_flight(pool: PgPool) {
    let (stored, registry, handle, grid) = grid_model(&pool).await;
    nearly_enough_rows(&stored, &handle, &grid).await;
    let mut hold = pool.begin().await.unwrap();
    sqlx::query("SELECT 1 FROM model_structure WHERE model_id = $1 FOR UPDATE")
        .bind(stored.id)
        .fetch_one(&mut *hold)
        .await
        .unwrap();
    enough_rows(&stored, &handle, &grid).await;
    let last = timeout(
        WAIT,
        handle.apply(stored.user, vec![fill(&grid, 10, 300_000.0)]),
    )
    .await
    .expect("edits wait for the checkpoint")
    .unwrap();

    let shutdown = tokio::spawn({
        let registry = registry.clone();
        async move { registry.shutdown().await }
    });
    sleep(Duration::from_millis(300)).await;
    assert!(
        !shutdown.is_finished(),
        "the checkpoint in flight is awaited"
    );
    hold.rollback().await.unwrap();
    timeout(WAIT, shutdown)
        .await
        .expect("shutdown did not finish")
        .unwrap();

    assert_eq!(checkpoint_seq(&pool, stored.id).await, last.seq);
}

#[sqlx::test(migrator = "openplan_server::db::MIGRATOR")]
async fn a_failed_checkpoint_is_tried_again_after_a_thousand_more_rows(pool: PgPool) {
    let (logs, _guard) = capture_logs();
    let (stored, _registry, handle, grid) = grid_model(&pool).await;
    nearly_enough_rows(&stored, &handle, &grid).await;
    sqlx::query("ALTER TABLE model_structure RENAME TO model_structure_away")
        .execute(&pool)
        .await
        .unwrap();
    let failure = "failed to checkpoint the model";

    enough_rows(&stored, &handle, &grid).await;
    wait_for_log(&logs, failure, 1).await;

    // Fewer than a thousand more rows: no new attempt.
    for base in 0..5 {
        handle
            .apply(
                stored.user,
                vec![fill(&grid, 10, 400_000.0 + f64::from(base))],
            )
            .await
            .unwrap();
    }
    sleep(Duration::from_millis(300)).await;
    assert_eq!(logs.contents().matches(failure).count(), 1);

    // A thousand more: one.
    handle
        .apply(stored.user, vec![fill(&grid, 1_000, 500_000.0)])
        .await
        .unwrap();
    wait_for_log(&logs, failure, 2).await;

    // The table is back and a thousand more rows later the checkpoint is saved.
    sqlx::query("ALTER TABLE model_structure_away RENAME TO model_structure")
        .execute(&pool)
        .await
        .unwrap();
    let last = handle
        .apply(stored.user, vec![fill(&grid, 1_000, 600_000.0)])
        .await
        .unwrap();
    wait_for_checkpoint(&pool, stored.id, last.seq).await;
}

#[sqlx::test(migrator = "openplan_server::db::MIGRATOR")]
async fn at_most_half_the_pool_checkpoints_at_a_time_when_models_are_stopped(pool: PgPool) {
    // Two connections: one model at a time.
    let small = PgPoolOptions::new()
        .max_connections(2)
        .connect_with((*pool.connect_options()).clone())
        .await
        .unwrap();
    let registry = ModelRegistry::new(small, LONG);
    let mut models = Vec::new();
    for _ in 0..2 {
        let stored = insert_model(&pool).await;
        let handle = registry.get(stored.id).await.unwrap();
        let (plan, structure) = plan(1);
        handle.apply(stored.user, structure).await.unwrap();
        models.push((stored, handle, plan));
    }
    let mut holds = Vec::new();
    for (stored, ..) in &models {
        let mut hold = pool.begin().await.unwrap();
        sqlx::query("SELECT 1 FROM model_structure WHERE model_id = $1 FOR UPDATE")
            .bind(stored.id)
            .fetch_one(&mut *hold)
            .await
            .unwrap();
        holds.push(hold);
    }

    let shutdown = tokio::spawn({
        let registry = registry.clone();
        async move { registry.shutdown().await }
    });
    sleep(Duration::from_millis(300)).await;

    // The one that was told to stop is busy writing its checkpoint, which waits for the lock; the
    // other has not been told yet and goes on working.
    let mut working = 0;
    for (stored, handle, plan) in &models {
        let edit = vec![numbers(plan.units, [(plan.regions[0], 1.0)])];
        if let Ok(applied) =
            timeout(Duration::from_millis(300), handle.apply(stored.user, edit)).await
        {
            applied.unwrap();
            working += 1;
        }
    }
    assert_eq!(working, 1);
    for hold in holds {
        hold.rollback().await.unwrap();
    }
    timeout(WAIT, shutdown)
        .await
        .expect("shutdown did not finish")
        .unwrap();
}

#[sqlx::test(migrator = "openplan_server::db::MIGRATOR")]
async fn discard_finishes_when_its_caller_goes_away(pool: PgPool) {
    let Setup {
        stored,
        registry,
        handle,
        plan,
    } = setup(&pool, 1).await;
    let mut events = handle.subscribe();
    // The actor is stuck in an edit that waits for the model's row, and its mailbox fills up
    // behind it, so a request to stop has to wait for room.
    let mut hold = pool.begin().await.unwrap();
    sqlx::query("SELECT id FROM models WHERE id = $1 FOR UPDATE")
        .bind(stored.id)
        .fetch_one(&mut *hold)
        .await
        .unwrap();
    let stuck = tokio::spawn({
        let handle = handle.clone();
        let edit = numbers(plan.units, [(plan.regions[0], 1.0)]);
        async move { handle.apply(stored.user, vec![edit]).await }
    });
    sleep(Duration::from_millis(100)).await;
    let queued: Vec<_> = (0..300)
        .map(|_| {
            let handle = handle.clone();
            tokio::spawn(async move { handle.apply(stored.user, vec![]).await })
        })
        .collect();
    sleep(Duration::from_millis(100)).await;

    // The request that deleted the model gives up while it waits.
    let dropped = timeout(Duration::from_millis(50), registry.discard(stored.id)).await;

    assert!(dropped.is_err(), "the caller gave up");
    hold.rollback().await.unwrap();
    assert_closed(&mut events).await;
    stuck.await.unwrap().unwrap();
    for apply in queued {
        let _ = apply.await.unwrap();
    }
}

/// Applies the commands through the actor of the model, taking a handle again each time the one
/// it reached had stopped.
async fn apply_until_it_is_taken(
    registry: &ModelRegistry,
    model_id: Uuid,
    user: Uuid,
    cmds: impl Fn() -> Vec<Command>,
) -> ApplyOutcome {
    loop {
        let handle = registry.get(model_id).await.unwrap();
        match handle.apply(user, cmds()).await {
            Ok(outcome) => return outcome,
            Err(AppError::Internal(error)) if error.to_string().contains("has stopped") => {}
            Err(other) => panic!("{other:?}"),
        }
    }
}

#[sqlx::test(migrator = "openplan_server::db::MIGRATOR")]
async fn eviction_in_a_loop_keeps_the_chain_of_a_hot_cell_unbroken(pool: PgPool) {
    let Setup {
        stored,
        registry,
        plan,
        ..
    } = setup_with(&pool, 1, Duration::ZERO).await;
    let region = plan.regions[0];
    let done = Arc::new(AtomicBool::new(false));
    let evictor = tokio::spawn({
        let (registry, done) = (registry.clone(), Arc::clone(&done));
        async move {
            while !done.load(Ordering::SeqCst) {
                registry.evict_idle().await;
                tokio::task::yield_now().await;
            }
        }
    });

    let workers: Vec<_> = (0..6)
        .map(|worker| {
            let registry = registry.clone();
            let (id, user, units) = (stored.id, stored.user, plan.units);
            tokio::spawn(async move {
                let mut written = Vec::new();
                for round in 0..10 {
                    let value = f64::from(worker * 100 + round + 1);
                    let outcome = apply_until_it_is_taken(&registry, id, user, || {
                        vec![numbers(units, [(region, value)])]
                    })
                    .await;
                    written.push((outcome.seq, value));
                }
                written
            })
        })
        .collect();
    let mut written = Vec::new();
    for worker in workers {
        written.extend(worker.await.unwrap());
    }
    done.store(true, Ordering::SeqCst);
    evictor.await.unwrap();

    // Whichever actor took a write, it began from every write before it: the log is one chain
    // of the writes that were acknowledged, in the order they were acknowledged.
    written.sort_by_key(|&(seq, _)| seq);
    let audit: Vec<(Json<serde_json::Value>,)> = sqlx::query_as(
        "SELECT payload FROM change_log
         WHERE model_id = $1 AND kind = 'cell' AND line_item_id = $2 ORDER BY seq",
    )
    .bind(stored.id)
    .bind(plan.units.0)
    .fetch_all(&pool)
    .await
    .unwrap();
    assert_eq!(audit.len(), 60, "a write that failed stored nothing");
    let mut old = 0.0;
    for ((Json(change),), (_, value)) in audit.iter().zip(&written) {
        assert_eq!(change["old"]["v"].as_f64().unwrap(), old);
        assert_eq!(change["new"]["v"].as_f64().unwrap(), *value);
        old = *value;
    }
    let (replayed, _) = engine_store::load(&pool, stored.id).await.unwrap();
    assert_eq!(read(&replayed, plan.units, region), Value::Number(old));
}

#[sqlx::test(migrator = "openplan_server::db::MIGRATOR")]
async fn the_checkpoint_covers_every_acknowledged_write_while_models_are_evicted(pool: PgPool) {
    let Setup {
        stored,
        registry,
        plan,
        ..
    } = setup_with(&pool, 25, Duration::ZERO).await;
    let mut expected: HashMap<usize, f64> = HashMap::new();
    let mut acknowledged = 0;

    for round in 0..4_u32 {
        let handle = registry.get(stored.id).await.unwrap();
        let done = Arc::new(AtomicBool::new(false));
        let evictor = tokio::spawn({
            let (registry, done) = (registry.clone(), Arc::clone(&done));
            async move {
                while !done.load(Ordering::SeqCst) {
                    registry.evict_idle().await;
                    tokio::task::yield_now().await;
                }
            }
        });
        // Every write goes through the handle that was taken before the evictions began.
        let writes: Vec<_> = (0..25_usize)
            .map(|i| {
                let handle = handle.clone();
                let (user, units, region) = (stored.user, plan.units, plan.regions[i]);
                let value = f64::from(round * 100) + i as f64 + 1.0;
                tokio::spawn(async move {
                    for _ in 0..i % 7 {
                        tokio::task::yield_now().await;
                    }
                    (
                        i,
                        value,
                        handle
                            .apply(user, vec![numbers(units, [(region, value)])])
                            .await,
                    )
                })
            })
            .collect();
        let mut last_acknowledged = 0;
        for write in writes {
            let (i, value, result) = write.await.unwrap();
            match result {
                Ok(outcome) => {
                    acknowledged += 1;
                    last_acknowledged = last_acknowledged.max(outcome.seq);
                    expected.insert(i, value);
                }
                // The actor was unloaded before it took the write.
                Err(AppError::Internal(error)) if error.to_string().contains("has stopped") => {}
                Err(other) => panic!("{other:?}"),
            }
        }
        done.store(true, Ordering::SeqCst);
        evictor.await.unwrap();
        registry.evict_idle().await;

        assert!(checkpoint_seq(&pool, stored.id).await >= last_acknowledged);
        // The log replays to what was acknowledged and nothing else...
        let (replayed, _) = engine_store::load(&pool, stored.id).await.unwrap();
        for (i, &region) in plan.regions.iter().enumerate() {
            let value = expected.get(&i).copied().unwrap_or(0.0);
            assert_eq!(read(&replayed, plan.units, region), Value::Number(value));
        }
        // ...and so does the checkpoint alone.
        sqlx::query(
            "DELETE FROM change_log
             WHERE model_id = $1 AND seq > (SELECT checkpoint_seq FROM models WHERE id = $1)",
        )
        .bind(stored.id)
        .execute(&pool)
        .await
        .unwrap();
        let (checkpointed, _) = engine_store::load(&pool, stored.id).await.unwrap();
        for (i, &region) in plan.regions.iter().enumerate() {
            let value = expected.get(&i).copied().unwrap_or(0.0);
            assert_eq!(
                read(&checkpointed, plan.units, region),
                Value::Number(value)
            );
        }
    }
    assert!(acknowledged > 0);
}

async fn setup_admin(app: &mut TestApp) -> (String, Uuid) {
    let response = app
        .post(
            "/api/v1/setup",
            Some(json!({
                "email": "admin@acme.com",
                "name": "Ada Admin",
                "password": "correct horse battery",
                "workspace_name": "Acme",
            })),
        )
        .await;
    assert_eq!(response.status, StatusCode::CREATED, "{}", response.text);
    (
        response.json["workspace"]["id"]
            .as_str()
            .unwrap()
            .to_string(),
        response.json["user"]["id"]
            .as_str()
            .unwrap()
            .parse()
            .unwrap(),
    )
}

/// Creates a model through the API and has the registry load it and edit it.
async fn model_in_use(app: &mut TestApp, workspace_id: &str, user: Uuid) -> (Uuid, ModelHandle) {
    let created = app
        .post(
            &format!("/api/v1/workspaces/{workspace_id}/models"),
            Some(json!({ "name": "Plan" })),
        )
        .await;
    assert_eq!(created.status, StatusCode::CREATED, "{}", created.text);
    let id: Uuid = created.json["id"].as_str().unwrap().parse().unwrap();
    let handle = app.state.models.get(id).await.unwrap();
    let (plan, structure) = plan(1);
    handle.apply(user, structure).await.unwrap();
    handle
        .apply(user, vec![numbers(plan.units, [(plan.regions[0], 1.0)])])
        .await
        .unwrap();
    (id, handle)
}

#[sqlx::test(migrator = "openplan_server::db::MIGRATOR")]
async fn deleting_a_model_drops_its_actor(pool: PgPool) {
    let mut app = TestApp::new(pool);
    let (workspace_id, admin) = setup_admin(&mut app).await;
    let (id, handle) = model_in_use(&mut app, &workspace_id, admin).await;
    let mut events = handle.subscribe();

    let deleted = app.delete(&format!("/api/v1/models/{id}")).await;

    assert_eq!(deleted.status, StatusCode::NO_CONTENT, "{}", deleted.text);
    assert_closed(&mut events).await;
    assert!(handle.apply(admin, vec![]).await.is_err());
    assert!(matches!(
        app.state.models.get(id).await,
        Err(AppError::NotFound)
    ));
}

#[sqlx::test(migrator = "openplan_server::db::MIGRATOR")]
async fn deleting_a_workspace_drops_the_actors_of_its_models(pool: PgPool) {
    let mut app = TestApp::new(pool);
    let (workspace_id, admin) = setup_admin(&mut app).await;
    let (id, handle) = model_in_use(&mut app, &workspace_id, admin).await;
    let mut events = handle.subscribe();

    let deleted = app
        .delete(&format!("/api/v1/workspaces/{workspace_id}"))
        .await;

    assert_eq!(deleted.status, StatusCode::NO_CONTENT, "{}", deleted.text);
    assert_closed(&mut events).await;
    assert!(matches!(
        app.state.models.get(id).await,
        Err(AppError::NotFound)
    ));
}

#[sqlx::test(migrator = "openplan_server::db::MIGRATOR")]
async fn deleting_a_workspace_drops_the_actors_of_all_its_models(pool: PgPool) {
    let mut app = TestApp::new(pool);
    let (workspace_id, admin) = setup_admin(&mut app).await;
    let (_, first) = model_in_use(&mut app, &workspace_id, admin).await;
    let created = app
        .post(
            &format!("/api/v1/workspaces/{workspace_id}/models"),
            Some(json!({ "name": "Other plan" })),
        )
        .await;
    assert_eq!(created.status, StatusCode::CREATED, "{}", created.text);
    let second_id: Uuid = created.json["id"].as_str().unwrap().parse().unwrap();
    let second = app.state.models.get(second_id).await.unwrap();
    let (_, structure) = plan(1);
    second.apply(admin, structure).await.unwrap();
    let mut first_events = first.subscribe();
    let mut second_events = second.subscribe();

    let deleted = app
        .delete(&format!("/api/v1/workspaces/{workspace_id}"))
        .await;

    assert_eq!(deleted.status, StatusCode::NO_CONTENT, "{}", deleted.text);
    assert_closed(&mut first_events).await;
    assert_closed(&mut second_events).await;
    assert!(matches!(
        app.state.models.get(second_id).await,
        Err(AppError::NotFound)
    ));
}
