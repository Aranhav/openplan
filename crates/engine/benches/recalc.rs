//! Performance of the engine against its targets (release build): one edit of a million-cell
//! model recalculates in under 50 ms, ten million stored cells load in under 5 s, a
//! calculated line item of a hundred thousand cells rounds in under 10 ms, and a window of 100
//! rows by 40 columns of a view of the million-cell model is queried in under 50 ms.

use std::sync::{LazyLock, Mutex};

use criterion::{BatchSize, Criterion, criterion_group, criterion_main};
use openplan_engine::{
    AxisSpec, Calendar, CellEdit, Command, CoordToken, Format, InputChunk, ItemId, ItemSpec,
    LineItem, LineItemId, ListId, Model, ModuleId, PageSelection, StructureDoc, SummaryMethod,
    TimeLevel, TimeScale, Value, VersionsScope, ViewDim, ViewQuery, Window, view,
};

const MONTHS: [&str; 12] = [
    "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

fn calendar(years: u8) -> Calendar {
    Calendar {
        fiscal_year_start_month: 1,
        first_year: 2026,
        years,
        current_month: None,
    }
}

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

fn create(model: &mut Model, line_item: LineItem) -> LineItemId {
    let id = line_item.id;
    model.apply(Command::CreateLineItem(line_item)).unwrap();
    id
}

fn module(model: &mut Model, name: &str, axes: Vec<AxisSpec>) -> ModuleId {
    let id = ModuleId::new();
    model
        .apply(Command::CreateModule {
            id,
            name: name.to_string(),
            axes,
            functional_area: String::new(),
        })
        .unwrap();
    id
}

fn list_with_items(model: &mut Model, name: &str, count: usize) -> (ListId, Vec<ItemId>) {
    let id = ListId::new();
    model
        .apply(Command::CreateList {
            id,
            name: name.to_string(),
            parent: None,
            top_level_name: None,
            numbered: false,
            production_data: false,
        })
        .unwrap();
    let items: Vec<ItemSpec> = (0..count)
        .map(|i| ItemSpec {
            id: ItemId::new(),
            code: None,
            name: format!("{name} {i}"),
            parent: None,
        })
        .collect();
    let ids = items.iter().map(|item| item.id).collect();
    model
        .apply(Command::UpsertListItems { list: id, items })
        .unwrap();
    (id, ids)
}

/// Products over the months of some years and the versions of the model.
struct Sales {
    model: Model,
    module: ModuleId,
    list: ListId,
    products: Vec<ItemId>,
    months: Vec<String>,
    versions: Vec<ItemId>,
}

fn sales(products: usize, years: u8) -> Sales {
    let mut model = Model::new(calendar(years));
    let (list, products) = list_with_items(&mut model, "Products", products);
    let module = module(
        &mut model,
        "Sales",
        vec![
            AxisSpec::List { list },
            AxisSpec::Time {
                level: TimeLevel::Month,
                range: None,
            },
            AxisSpec::Versions,
        ],
    );
    let months = (0..usize::from(years) * 12)
        .map(|m| format!("{} {}", MONTHS[m % 12], 26 + m / 12))
        .collect();
    let versions = model
        .structure()
        .versions()
        .iter()
        .map(|version| ItemId(version.id.0))
        .collect();
    Sales {
        model,
        module,
        list,
        products,
        months,
        versions,
    }
}

impl Sales {
    fn coords(&self, product: usize, month: usize, version: usize) -> Vec<CoordToken> {
        vec![
            CoordToken::Item(self.products[product]),
            CoordToken::Period(self.months[month].clone()),
            CoordToken::Item(self.versions[version]),
        ]
    }

    /// Types a number into every cell of an input line item, 500 products to a command.
    fn fill(&mut self, line_item: LineItemId, value: impl Fn(usize, usize) -> f64) {
        for first in (0..self.products.len()).step_by(500) {
            let last = (first + 500).min(self.products.len());
            let mut edits = Vec::new();
            for product in first..last {
                for month in 0..self.months.len() {
                    for version in 0..self.versions.len() {
                        edits.push(CellEdit {
                            coords: self.coords(product, month, version),
                            value: Value::Number(value(product, month)),
                        });
                    }
                }
            }
            self.model
                .apply(Command::SetCells { line_item, edits })
                .unwrap();
        }
    }
}

/// 10,000 products over 36 months and 3 versions, with two input line items filled and four
/// calculated ones over them: a million cells each.
fn million_cells() -> (Sales, LineItemId) {
    let mut sales = sales(10_000, 3);
    let units = create(&mut sales.model, line_item(sales.module, "Units", None));
    let price = create(&mut sales.model, line_item(sales.module, "Price", None));
    sales.fill(units, |product, month| {
        10.0 + ((product + month) % 5) as f64
    });
    sales.fill(price, |_, month| 2.0 + (month % 5) as f64);
    for (name, formula) in [
        ("Revenue", "Units * Price"),
        ("Cost", "Revenue * 0.6"),
        ("Margin", "Revenue - Cost"),
        ("Cumulative Margin", "CUMULATE(Margin)"),
    ] {
        create(
            &mut sales.model,
            line_item(sales.module, name, Some(formula)),
        );
    }
    (sales, units)
}

/// The model of a million cells, and the cell that is edited.
struct Edit {
    model: Model,
    units: LineItemId,
    at: Vec<CoordToken>,
    next: f64,
}

fn edit_fixture() -> Edit {
    let (sales, units) = million_cells();
    let at = sales.coords(4_321, 7, 1);
    Edit {
        model: sales.model,
        units,
        at,
        next: 100.0,
    }
}

fn edit_1m_cells(c: &mut Criterion) {
    let fixture = LazyLock::new(|| Mutex::new(edit_fixture()));
    c.bench_function("edit_1m_cells", |b| {
        let mut guard = fixture.lock().unwrap();
        let Edit {
            model,
            units,
            at,
            next,
        } = &mut *guard;
        b.iter(|| {
            *next += 1.0;
            model
                .apply(Command::SetCells {
                    line_item: *units,
                    edits: vec![CellEdit {
                        coords: at.clone(),
                        value: Value::Number(*next),
                    }],
                })
                .unwrap()
        })
    });
}

/// The million-cell model and a query for a window of its products over the periods of its
/// time, years and total included, at the current version and the first line item.
fn query_fixture() -> (Model, ViewQuery) {
    let (sales, _) = million_cells();
    let q = ViewQuery {
        module: sales.module,
        line_items: None,
        rows: vec![ViewDim::List { list: sales.list }],
        columns: vec![ViewDim::Time],
        pages: [ViewDim::Versions, ViewDim::LineItems]
            .into_iter()
            .map(|dim| PageSelection { dim, key: None })
            .collect(),
        show_summaries: true,
        collapsed: Vec::new(),
        hidden: Vec::new(),
        filters: Vec::new(),
        window: Window {
            row_offset: 5_000,
            row_limit: 100,
            col_offset: 0,
            col_limit: 40,
        },
    };
    let result = view::query(&sales.model, &q).unwrap();
    assert_eq!(result.total_rows, 10_000);
    assert_eq!(result.total_columns, 58);
    assert_eq!(result.rows.len(), 100);
    assert!(result.cells.iter().all(|row| row.len() == 40));
    (sales.model, q)
}

fn query_window(c: &mut Criterion) {
    let fixture = LazyLock::new(query_fixture);
    c.bench_function("query_window", |b| {
        let (model, q) = &*fixture;
        b.iter(|| view::query(model, q).unwrap())
    });
}

fn units_at(product: usize, month: usize) -> f64 {
    1.0 + ((product + month) % 17) as f64
}

fn price_at(product: usize) -> f64 {
    2.0 + (product % 9) as f64
}

fn discount_at(product: usize) -> f64 {
    0.01 * (1 + product % 20) as f64
}

/// A stored model of 10.8 million input cells with two calculated line items over them.
struct Stored {
    doc: StructureDoc,
    chunks: Vec<InputChunk>,
}

/// Fills a model, stores it, and checks that loading the store gives back what was stored.
fn stored_10m_cells() -> Stored {
    let mut sales = sales(25_000, 3);
    let inputs: Vec<LineItemId> = ["Units", "Price", "Unit cost", "Discount"]
        .iter()
        .map(|name| create(&mut sales.model, line_item(sales.module, name, None)))
        .collect();
    sales.fill(inputs[0], units_at);
    sales.fill(inputs[1], |product, _| price_at(product));
    sales.fill(inputs[2], |_, month| 1.0 + (month % 3) as f64);
    sales.fill(inputs[3], |product, _| discount_at(product));

    let chunks = sales.model.export_inputs();
    let mut doc = sales.model.export_structure();
    let revenue = line_item(
        sales.module,
        "Revenue",
        Some("Units * Price * (1 - Discount)"),
    );
    let revenue_id = revenue.id;
    let margin = line_item(
        sales.module,
        "Margin",
        Some("Revenue - Units * 'Unit cost'"),
    );
    doc.line_items.extend([revenue, margin]);

    let (product, month) = (12_345, 20);
    let loaded = Model::from_parts(doc.clone(), chunks.clone()).unwrap();
    assert_eq!(loaded.load_warnings(), 0);
    assert_eq!(loaded.last_recalc_stats().line_items, 2);
    assert_eq!(
        loaded
            .read_cells(revenue_id, &[sales.coords(product, month, 2)])
            .unwrap(),
        [Value::Number(
            units_at(product, month) * price_at(product) * (1.0 - discount_at(product))
        )]
    );
    Stored { doc, chunks }
}

fn load_10m_cells(c: &mut Criterion) {
    let stored = LazyLock::new(stored_10m_cells);
    c.bench_function("load_10m_cells", |b| {
        let Stored { doc, chunks } = &*stored;
        b.iter_batched(
            || (doc.clone(), chunks.clone()),
            |(doc, chunks)| Model::from_parts(doc, chunks).unwrap(),
            BatchSize::PerIteration,
        )
    });
}

/// A deterministic stream of numbers between 0 and 10,000 with many decimals.
fn random_amounts(count: usize) -> Vec<f64> {
    let mut state = 0x9e37_79b9_7f4a_7c15_u64;
    (0..count)
        .map(|_| {
            state = state.wrapping_add(0x9e37_79b9_7f4a_7c15);
            let mut z = state;
            z = (z ^ (z >> 30)).wrapping_mul(0xbf58_476d_1ce4_e5b9);
            z = (z ^ (z >> 27)).wrapping_mul(0x94d0_49bb_1331_11eb);
            z ^= z >> 31;
            (z >> 11) as f64 / (1u64 << 53) as f64 * 10_000.0
        })
        .collect()
}

fn rounding_fixture() -> Model {
    const ROWS: usize = 100_000;
    let mut model = Model::new(calendar(1));
    let (list, rows) = list_with_items(&mut model, "Rows", ROWS);
    let module = module(&mut model, "Amounts", vec![AxisSpec::List { list }]);
    let amount = create(&mut model, line_item(module, "Amount", None));
    let amounts = random_amounts(ROWS);
    for (block, values) in rows.chunks(10_000).zip(amounts.chunks(10_000)) {
        let edits = block
            .iter()
            .zip(values)
            .map(|(&row, &value)| CellEdit {
                coords: vec![CoordToken::Item(row)],
                value: Value::Number(value),
            })
            .collect();
        model
            .apply(Command::SetCells {
                line_item: amount,
                edits,
            })
            .unwrap();
    }
    create(
        &mut model,
        line_item(module, "Rounded", Some("ROUND(Amount, 2)")),
    );
    model
}

fn round_100k_cells(c: &mut Criterion) {
    let fixture = LazyLock::new(|| Mutex::new(rounding_fixture()));
    c.bench_function("round_100k_cells", |b| {
        let mut model = fixture.lock().unwrap();
        b.iter(|| model.recalc_all().unwrap())
    });
}

/// An input line item and 400 calculated ones, each reading the one before it, created one
/// command at a time.
fn chain_of_400() -> Model {
    let mut model = Model::new(calendar(1));
    let module = module(
        &mut model,
        "Chain",
        vec![AxisSpec::Time {
            level: TimeLevel::Month,
            range: None,
        }],
    );
    create(&mut model, line_item(module, "Step0", None));
    for step in 1..=400 {
        let formula = format!("Step{} + 1", step - 1);
        create(
            &mut model,
            line_item(module, &format!("Step{step}"), Some(&formula)),
        );
    }
    model
}

fn create_400_chained_line_items(c: &mut Criterion) {
    c.bench_function("create_400_chained_line_items", |b| b.iter(chain_of_400));
}

criterion_group! {
    name = benches;
    config = Criterion::default().sample_size(10);
    targets = edit_1m_cells, query_window, load_10m_cells, round_100k_cells, create_400_chained_line_items
}
criterion_main!(benches);
