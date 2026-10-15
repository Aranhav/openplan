use chrono::NaiveDate;
use openplan_engine::{
    AxisSpec, Calendar, CellEdit, Command, CoordToken, EngineError, Format, InputChunk, ItemId,
    ItemSpec, LineItem, LineItemId, LineItemPatch, ListId, Model, ModuleId, StructureDoc, SubsetId,
    SummaryMethod, TimeLevel, TimeRangeId, TimeScale, Value, VersionId, VersionsScope,
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

fn month_label(month: usize) -> String {
    format!("{} {}", MONTHS[month % 12], 26 + month / 12)
}

fn month_token(month: usize) -> CoordToken {
    CoordToken::Period(month_label(month))
}

fn item(id: ItemId) -> CoordToken {
    CoordToken::Item(id)
}

fn version_token(id: VersionId) -> CoordToken {
    CoordToken::Item(ItemId(id.0))
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

/// A model under construction.
struct Book {
    model: Model,
}

impl Book {
    fn new(years: u8) -> Book {
        Book {
            model: Model::new(calendar(years)),
        }
    }

    fn apply(&mut self, command: Command) {
        self.model.apply(command).unwrap();
    }

    fn list(
        &mut self,
        name: &str,
        parent: Option<ListId>,
        items: &[(&str, Option<ItemId>)],
    ) -> (ListId, Vec<ItemId>) {
        let id = ListId::new();
        self.apply(Command::CreateList {
            id,
            name: name.to_string(),
            parent,
            top_level_name: None,
            numbered: false,
            production_data: false,
        });
        let specs: Vec<ItemSpec> = items
            .iter()
            .map(|(name, parent)| ItemSpec {
                id: ItemId::new(),
                code: None,
                name: name.to_string(),
                parent: *parent,
            })
            .collect();
        let ids = specs.iter().map(|spec| spec.id).collect();
        self.apply(Command::UpsertListItems {
            list: id,
            items: specs,
        });
        (id, ids)
    }

    fn module(&mut self, name: &str, axes: Vec<AxisSpec>) -> ModuleId {
        let id = ModuleId::new();
        self.apply(Command::CreateModule {
            id,
            name: name.to_string(),
            axes,
            functional_area: String::new(),
        });
        id
    }

    fn add(&mut self, line_item: LineItem) -> LineItemId {
        let id = line_item.id;
        self.apply(Command::CreateLineItem(line_item));
        id
    }

    fn set(&mut self, line_item: LineItemId, edits: Vec<(Vec<CoordToken>, Value)>) {
        let edits = edits
            .into_iter()
            .map(|(coords, value)| CellEdit { coords, value })
            .collect();
        self.apply(Command::SetCells { line_item, edits });
    }

    fn version_ids(&self) -> Vec<VersionId> {
        self.model
            .structure()
            .versions()
            .iter()
            .map(|version| version.id)
            .collect()
    }
}

fn list_axis(list: ListId) -> AxisSpec {
    AxisSpec::List { list }
}

fn month_axis() -> AxisSpec {
    AxisSpec::Time {
        level: TimeLevel::Month,
        range: None,
    }
}

/// A model that uses every part of the structure and every kind of input cell.
struct Rich {
    model: Model,
    /// The products that were not deleted.
    products: Vec<ItemId>,
    /// The cells of the Sales module: products, months and versions.
    grid: Vec<Vec<CoordToken>>,
    inputs: Vec<LineItemId>,
    revenue: LineItemId,
    cumulative: LineItemId,
    units: LineItemId,
    weight: LineItemId,
}

fn rich() -> Rich {
    let mut book = Book::new(2);
    let (regions, region_items) = book.list("Regions", None, &[("EMEA", None), ("APAC", None)]);
    let (countries, _) = book.list(
        "Countries",
        Some(regions),
        &[
            ("France", Some(region_items[0])),
            ("Japan", Some(region_items[1])),
        ],
    );
    book.apply(Command::UpdateList {
        id: regions,
        name: None,
        top_level_name: Some(Some("All regions".to_string())),
        production_data: None,
        selective_access: Some(true),
    });
    let (products, product_items) = book.list(
        "Products",
        None,
        &[
            ("Widget", None),
            ("Gadget", None),
            ("Gizmo", None),
            ("Doohickey", None),
        ],
    );
    let orders = ListId::new();
    book.apply(Command::CreateList {
        id: orders,
        name: "Orders".to_string(),
        parent: None,
        top_level_name: None,
        numbered: true,
        production_data: true,
    });
    book.apply(Command::UpsertListItems {
        list: orders,
        items: ["A", "B"]
            .into_iter()
            .map(|code| ItemSpec {
                id: ItemId::new(),
                code: Some(code.to_string()),
                name: "Rush order".to_string(),
                parent: None,
            })
            .collect(),
    });
    book.apply(Command::CreateSubset {
        id: SubsetId::new(),
        list: products,
        name: "Top products".to_string(),
        items: vec![product_items[0], product_items[3]],
    });
    book.apply(Command::CreateTimeRange {
        id: TimeRangeId::new(),
        name: "Plan".to_string(),
        first_year: 2026,
        years: 1,
    });
    book.apply(Command::UpsertVersion {
        id: VersionId::new(),
        name: "Scenario".to_string(),
        is_actual: false,
        is_current: false,
        switchover: Some(3),
    });
    book.module("Geo", vec![list_axis(countries), month_axis()]);
    let sales = book.module(
        "Sales",
        vec![list_axis(products), month_axis(), AxisSpec::Versions],
    );

    let number = Format::number;
    let units = book.add(line_item(sales, "Units", number(), None));
    let price = book.add(line_item(sales, "Price", number(), None));
    let revenue = book.add(line_item(sales, "Revenue", number(), Some("Units * Price")));
    let cumulative = book.add(line_item(
        sales,
        "Cumulative revenue",
        number(),
        Some("CUMULATE(Revenue)"),
    ));
    let active = book.add(line_item(sales, "Active", Format::Boolean, None));
    let note = book.add(line_item(sales, "Note", Format::Text, None));
    let launch = book.add(line_item(sales, "Launch", Format::Date, None));
    let lead = book.add(line_item(
        sales,
        "Lead product",
        Format::List { list: products },
        None,
    ));
    let start = book.add(line_item(
        sales,
        "Start",
        Format::TimePeriod {
            level: TimeLevel::Month,
        },
        None,
    ));
    let mut share = line_item(sales, "Share", number(), Some("Units / Price"));
    share.summary = SummaryMethod::Ratio {
        numerator: units,
        denominator: price,
    };
    let share = book.add(share);
    book.apply(Command::UpdateLineItem {
        id: units,
        patch: LineItemPatch {
            read_access_driver: Some(Some(share)),
            notes: Some("Typed in by planners".to_string()),
            ..LineItemPatch::default()
        },
    });
    let weight = book.add(line_item(
        ModuleId::for_list_properties(products),
        "Weight",
        number(),
        None,
    ));

    book.apply(Command::UpdateModule {
        id: ModuleId::for_list_properties(products),
        name: None,
        axes: None,
        functional_area: Some("Master data".to_string()),
    });
    let region_code = book.add(line_item(
        ModuleId::for_list_properties(countries),
        "Region code",
        Format::Text,
        None,
    ));
    book.apply(Command::DeleteLineItem { id: region_code });

    let versions = book.version_ids();
    let mut cells = Vec::new();
    for (p, &product) in product_items.iter().enumerate() {
        for m in 3..9 {
            for &version in &versions {
                let coords = vec![item(product), month_token(m), version_token(version)];
                cells.push((p, m, coords));
            }
        }
    }
    let each = |book: &mut Book, line_item: LineItemId, value: &dyn Fn(usize, usize) -> Value| {
        let edits = cells
            .iter()
            .map(|(p, m, coords)| (coords.clone(), value(*p, *m)))
            .collect();
        book.set(line_item, edits);
    };
    each(&mut book, units, &|p, m| {
        Value::Number((p * 10 + m) as f64 + 0.25)
    });
    each(&mut book, price, &|p, _| Value::Number(2.0 + p as f64));
    each(&mut book, active, &|p, m| Value::Boolean((p + m) % 2 == 0));
    each(&mut book, note, &|p, m| {
        Value::Text(format!("n{p}/{m} é").into())
    });
    each(&mut book, launch, &|p, m| {
        Value::Date(NaiveDate::from_ymd_opt(
            2026,
            1 + (m % 12) as u32,
            1 + p as u32,
        ))
    });
    each(&mut book, lead, &|p, _| {
        Value::Item(Some(product_items[(p + 1) % 4]))
    });
    each(&mut book, start, &|_, m| {
        Value::Period(Some((TimeLevel::Month, m as u32)))
    });
    book.set(
        weight,
        vec![(vec![item(product_items[0])], Value::Number(2.5))],
    );
    book.apply(Command::DeleteListItems {
        list: products,
        ids: vec![product_items[2]],
    });

    let live: Vec<ItemId> = product_items
        .iter()
        .copied()
        .filter(|id| *id != product_items[2])
        .collect();
    let mut grid = Vec::new();
    for &product in &live {
        for m in 0..24 {
            for &version in &versions {
                grid.push(vec![item(product), month_token(m), version_token(version)]);
            }
        }
    }
    Rich {
        model: book.model,
        products: live,
        grid,
        inputs: vec![units, price, active, note, launch, lead, start],
        revenue,
        cumulative,
        units,
        weight,
    }
}

fn read(model: &Model, line_item: LineItemId, coords: &[Vec<CoordToken>]) -> Vec<Value> {
    model.read_cells(line_item, coords).unwrap()
}

fn code(error: EngineError) -> &'static str {
    error.code()
}

#[test]
fn structure_roundtrip_json() {
    let rich = rich();
    let doc = rich.model.export_structure();
    assert_eq!(doc.format_version, 1);

    let json = serde_json::to_string(&doc).unwrap();
    let parsed: StructureDoc = serde_json::from_str(&json).unwrap();
    assert_eq!(parsed, doc);
    let value: serde_json::Value = serde_json::from_str(&json).unwrap();
    for key in [
        "format_version",
        "calendar",
        "lists",
        "subsets",
        "versions",
        "time_ranges",
        "modules",
        "line_items",
    ] {
        assert!(value.get(key).is_some(), "missing {key}");
    }
    assert!(value["lists"][0].get("top_level_name").is_some());

    let loaded = Model::from_parts(parsed, Vec::new()).unwrap();
    assert_eq!(loaded.export_structure(), doc);
    assert_eq!(loaded.load_warnings(), 0);
}

#[test]
fn deleted_items_are_not_in_the_document_and_the_rest_keep_their_order() {
    let rich = rich();
    let doc = rich.model.export_structure();
    let products = doc
        .lists
        .iter()
        .find(|list| list.name == "Products")
        .unwrap();
    let names: Vec<&str> = products
        .items
        .iter()
        .map(|item| item.name.as_str())
        .collect();
    assert_eq!(names, ["Widget", "Gadget", "Doohickey"]);
    assert!(!serde_json::to_string(&doc).unwrap().contains("Gizmo"));

    let loaded = Model::from_parts(doc, Vec::new()).unwrap();
    let list = loaded
        .structure()
        .list_by_name("Products")
        .expect("the list is loaded");
    assert_eq!(list.len_dense(), 3);
    let ids: Vec<ItemId> = list.items().map(|(_, item)| item.id).collect();
    assert_eq!(ids, rich.products);
}

#[test]
fn inputs_roundtrip_equal_values() {
    let rich = rich();
    let doc = rich.model.export_structure();
    let chunks = rich.model.export_inputs();

    let mut stored: Vec<LineItemId> = chunks.iter().map(|chunk| chunk.line_item).collect();
    stored.dedup();
    let mut expected: Vec<LineItemId> = rich.inputs.clone();
    expected.push(rich.weight);
    expected.sort();
    assert_eq!(
        stored, expected,
        "one chunk for each input line item with cells, none for the rest"
    );

    let loaded = Model::from_parts(doc, chunks).unwrap();
    assert_eq!(loaded.load_warnings(), 0);
    for &line_item in &rich.inputs {
        assert_eq!(
            read(&loaded, line_item, &rich.grid),
            read(&rich.model, line_item, &rich.grid),
            "{line_item:?}"
        );
    }
    let weights: Vec<Vec<CoordToken>> = rich.products.iter().map(|&p| vec![item(p)]).collect();
    assert_eq!(
        read(&loaded, rich.weight, &weights),
        read(&rich.model, rich.weight, &weights)
    );
    let units = read(&loaded, rich.units, &rich.grid);
    assert!(units.contains(&Value::Number(0.25 + 3.0)));
    assert!(units.contains(&Value::Number(0.0)));
}

#[test]
fn from_parts_recalculates() {
    let rich = rich();
    let chunks = rich.model.export_inputs();
    let mut loaded = Model::from_parts(rich.model.export_structure(), chunks).unwrap();

    for line_item in [rich.revenue, rich.cumulative] {
        assert_eq!(
            read(&loaded, line_item, &rich.grid),
            read(&rich.model, line_item, &rich.grid)
        );
    }
    let revenue = read(&loaded, rich.revenue, &rich.grid);
    assert!(revenue.iter().any(|value| *value != Value::Number(0.0)));
    assert!(loaded.last_recalc_stats().evaluated_cells > 0);

    // The first product in May 26, in the second version, where units and price are typed in.
    let at = vec![rich.grid[4 * 4 + 1].clone()];
    let before = read(&loaded, rich.revenue, &at);
    loaded
        .apply(Command::SetCells {
            line_item: rich.units,
            edits: vec![CellEdit {
                coords: at[0].clone(),
                value: Value::Number(1000.0),
            }],
        })
        .unwrap();
    assert_ne!(read(&loaded, rich.revenue, &at), before);
}

#[test]
fn a_loaded_model_accepts_cells_for_line_items_that_had_none() {
    let mut book = Book::new(1);
    let (list, products) = book.list("Products", None, &[("Widget", None)]);
    let grid = book.module("Grid", vec![list_axis(list)]);
    let empty = book.add(line_item(grid, "Empty", Format::number(), None));
    let mut loaded = Model::from_parts(book.model.export_structure(), Vec::new()).unwrap();
    loaded
        .apply(Command::SetCells {
            line_item: empty,
            edits: vec![CellEdit {
                coords: vec![item(products[0])],
                value: Value::Number(4.0),
            }],
        })
        .unwrap();
    assert_eq!(
        read(&loaded, empty, &[vec![item(products[0])]]),
        vec![Value::Number(4.0)]
    );
}

#[test]
fn chunks_survive_item_reorder() {
    let rich = rich();
    let chunks = rich.model.export_inputs();
    let mut doc = rich.model.export_structure();
    for list in &mut doc.lists {
        list.items.reverse();
    }
    let loaded = Model::from_parts(doc, chunks).unwrap();

    assert_eq!(loaded.load_warnings(), 0);
    let reversed: Vec<ItemId> = loaded
        .structure()
        .list_by_name("Products")
        .unwrap()
        .items()
        .map(|(_, item)| item.id)
        .collect();
    let mut expected = rich.products.clone();
    expected.reverse();
    assert_eq!(reversed, expected);
    for &line_item in &rich.inputs {
        assert_eq!(
            read(&loaded, line_item, &rich.grid),
            read(&rich.model, line_item, &rich.grid),
            "{line_item:?}"
        );
    }
    assert_eq!(
        read(&loaded, rich.cumulative, &rich.grid),
        read(&rich.model, rich.cumulative, &rich.grid)
    );
}

/// Four products, three versions and the months of a year: `Units` over all of them and `Pick`,
/// which picks a product for each product.
struct Grid {
    book: Book,
    products: Vec<ItemId>,
    units: LineItemId,
    pick: LineItemId,
    cells: Vec<Vec<CoordToken>>,
}

fn grid() -> Grid {
    let mut book = Book::new(1);
    let (products_list, products) = book.list(
        "Products",
        None,
        &[("P0", None), ("P1", None), ("P2", None), ("P3", None)],
    );
    let sales = book.module(
        "Sales",
        vec![list_axis(products_list), month_axis(), AxisSpec::Versions],
    );
    let picks = book.module("Picks", vec![list_axis(products_list)]);
    let units = book.add(line_item(sales, "Units", Format::number(), None));
    let pick = book.add(line_item(
        picks,
        "Pick",
        Format::List {
            list: products_list,
        },
        None,
    ));
    let versions = book.version_ids();
    let mut cells = Vec::new();
    for &product in &products {
        for m in 0..12 {
            for &version in &versions {
                cells.push(vec![item(product), month_token(m), version_token(version)]);
            }
        }
    }
    let edits = cells
        .iter()
        .enumerate()
        .map(|(i, coords)| (coords.clone(), Value::Number(1.0 + i as f64)))
        .collect();
    book.set(units, edits);
    book.set(
        pick,
        vec![
            (vec![item(products[0])], Value::Item(Some(products[1]))),
            (vec![item(products[1])], Value::Item(Some(products[3]))),
            (vec![item(products[2])], Value::Item(Some(products[0]))),
        ],
    );
    Grid {
        book,
        products,
        units,
        pick,
        cells,
    }
}

#[test]
fn unknown_coordinates_skipped_with_warning() {
    let grid = grid();
    let chunks = grid.book.model.export_inputs();
    let mut doc = grid.book.model.export_structure();
    let products = doc
        .lists
        .iter_mut()
        .find(|list| list.name == "Products")
        .unwrap();
    products.items.retain(|item| item.id != grid.products[3]);
    let forecast = doc
        .versions
        .iter()
        .find(|version| version.name == "Forecast")
        .unwrap()
        .id;
    doc.versions.retain(|version| version.id != forecast);

    let loaded = Model::from_parts(doc, chunks).unwrap();

    // Of 4 products x 12 months x 3 versions, those of P3 or of Forecast are gone: 144 - 3 x 12 x 2.
    // The one pick of P3 by another product is gone as well.
    assert_eq!(loaded.load_warnings(), 72 + 1);
    let kept: Vec<Vec<CoordToken>> = grid
        .cells
        .iter()
        .filter(|coords| {
            coords[0] != item(grid.products[3]) && coords[2] != version_token(forecast)
        })
        .cloned()
        .collect();
    assert_eq!(kept.len(), 72);
    assert_eq!(
        read(&loaded, grid.units, &kept),
        read(&grid.book.model, grid.units, &kept)
    );
    let picks: Vec<Vec<CoordToken>> = grid.products[..3].iter().map(|&p| vec![item(p)]).collect();
    assert_eq!(
        read(&loaded, grid.pick, &picks),
        vec![
            Value::Item(Some(grid.products[1])),
            Value::Item(None),
            Value::Item(Some(grid.products[0])),
        ]
    );
}

#[test]
fn a_model_that_was_not_loaded_has_no_warnings() {
    let grid = grid();
    assert_eq!(grid.book.model.load_warnings(), 0);
    let loaded = Model::from_parts(
        grid.book.model.export_structure(),
        grid.book.model.export_inputs(),
    )
    .unwrap();
    assert_eq!(loaded.load_warnings(), 0);
}

#[test]
fn chunks_of_other_line_items_and_kinds_are_skipped_with_warning() {
    let grid = grid();
    let chunks = grid.book.model.export_inputs_for(grid.units);
    assert_eq!(chunks.len(), 1);
    let cells = 4 * 12 * 3;

    let mut calculated = grid.book.model.export_structure();
    let units = calculated
        .line_items
        .iter_mut()
        .find(|li| li.id == grid.units)
        .unwrap();
    units.formula = Some("1".to_string());
    let loaded = Model::from_parts(calculated, chunks.clone()).unwrap();
    assert_eq!(loaded.load_warnings(), cells);

    let mut text = grid.book.model.export_structure();
    let units = text
        .line_items
        .iter_mut()
        .find(|li| li.id == grid.units)
        .unwrap();
    units.format = Format::Text;
    let loaded = Model::from_parts(text, chunks.clone()).unwrap();
    assert_eq!(loaded.load_warnings(), cells);
    assert_eq!(
        read(&loaded, grid.units, &grid.cells[..1]),
        vec![Value::Text("".into())]
    );

    let stray = InputChunk {
        line_item: LineItemId::new(),
        ..chunks[0].clone()
    };
    let loaded = Model::from_parts(grid.book.model.export_structure(), vec![stray]).unwrap();
    assert_eq!(loaded.load_warnings(), cells);
}

#[test]
fn blank_cells_are_not_stored() {
    let mut grid = grid();
    assert!(
        grid.book
            .model
            .export_inputs_for(LineItemId::new())
            .is_empty()
    );

    let blank = Book::new(1);
    assert!(blank.model.export_inputs().is_empty());

    let at = grid.cells[5].clone();
    grid.book.set(grid.units, vec![(at, Value::Number(0.0))]);
    let units = grid.book.model.export_inputs_for(grid.units);
    let loaded = Model::from_parts(grid.book.model.export_structure(), units).unwrap();
    assert_eq!(
        read(&loaded, grid.units, &grid.cells[5..6]),
        vec![Value::Number(0.0)]
    );

    let edits = grid
        .cells
        .iter()
        .map(|coords| (coords.clone(), Value::Number(0.0)))
        .collect();
    grid.book.set(grid.units, edits);
    assert!(grid.book.model.export_inputs_for(grid.units).is_empty());
}

#[test]
fn calculated_line_items_have_no_chunks() {
    let rich = rich();
    assert!(rich.model.export_inputs_for(rich.revenue).is_empty());
    assert!(
        rich.model
            .export_inputs()
            .iter()
            .all(|chunk| chunk.line_item != rich.revenue && chunk.line_item != rich.cumulative)
    );
}

#[test]
fn chunks_come_in_order_and_do_not_change_between_exports() {
    let rich = rich();
    let chunks = rich.model.export_inputs();
    assert_eq!(chunks, rich.model.export_inputs());
    let keys: Vec<(LineItemId, u32)> = chunks.iter().map(|c| (c.line_item, c.chunk)).collect();
    let mut sorted = keys.clone();
    sorted.sort();
    assert_eq!(keys, sorted);
}

#[test]
fn damaged_chunks_are_refused() {
    let grid = grid();
    let doc = grid.book.model.export_structure();
    let good = grid.book.model.export_inputs_for(grid.units).remove(0);

    let with = |data: Vec<u8>| InputChunk {
        data,
        ..good.clone()
    };
    let truncated = good.data[..good.data.len() / 2].to_vec();
    let not_a_chunk = zstd::bulk::compress(&[9u8; 20], 3).unwrap();
    let mut flipped = good.data.clone();
    let middle = flipped.len() / 2;
    flipped[middle] ^= 0xff;
    let too_short = {
        let raw = zstd::bulk::decompress(&good.data, 1 << 20).unwrap();
        zstd::bulk::compress(&raw[..raw.len() - 8], 3).unwrap()
    };
    for (what, data) in [
        ("garbage", vec![1, 2, 3]),
        ("empty", Vec::new()),
        ("truncated", truncated),
        ("not a chunk", not_a_chunk),
        ("short of values", too_short),
    ] {
        let error = Model::from_parts(doc.clone(), vec![with(data)]).unwrap_err();
        assert_eq!(code(error), "structure.invalid", "{what}");
    }
    if let Ok(model) = Model::from_parts(doc.clone(), vec![with(flipped)]) {
        assert!(model.load_warnings() <= 144);
    }

    let stray = InputChunk {
        line_item: LineItemId::new(),
        chunk: 0,
        data: vec![1, 2, 3],
    };
    assert!(Model::from_parts(doc, vec![stray]).is_err());
}

#[test]
fn inconsistent_structures_are_refused() {
    let rich = rich();
    let good = rich.model.export_structure();
    let refused = |doc: StructureDoc, what: &str| {
        let error = Model::from_parts(doc, Vec::new()).unwrap_err();
        assert!(
            matches!(error.code(), "structure.invalid" | "structure.not_found"),
            "{what}: {error}"
        );
    };

    let mut doc = good.clone();
    doc.format_version = 2;
    refused(doc, "an unknown format");

    let mut doc = good.clone();
    doc.line_items[0].module = ModuleId::new();
    refused(doc, "a line item of a module that does not exist");

    let mut doc = good.clone();
    doc.versions.retain(|version| !version.is_actual);
    refused(doc, "no actual version");

    let mut doc = good.clone();
    doc.versions[0].switchover = Some(1);
    refused(doc, "an actual version with a switchover");

    let mut doc = good.clone();
    let countries = doc
        .lists
        .iter_mut()
        .find(|list| list.name == "Countries")
        .unwrap();
    countries.parent = Some(countries.id);
    refused(doc, "a list that is its own parent");

    let mut doc = good.clone();
    doc.subsets[0].items.push(ItemId::new());
    refused(doc, "a subset of an item that does not exist");

    let mut doc = good.clone();
    doc.line_items.push(doc.line_items[0].clone());
    refused(doc, "a line item twice");
}

#[test]
fn a_million_cells_fill_a_chunk_and_the_next_cell_starts_another() {
    const CELLS: usize = 1_000_001;
    let mut book = Book::new(20);
    let mut specs: Vec<ItemSpec> = Vec::new();
    for i in 0..CELLS.div_ceil(240) {
        specs.push(ItemSpec {
            id: ItemId::new(),
            code: None,
            name: format!("P{i}"),
            parent: None,
        });
    }
    let ids: Vec<ItemId> = specs.iter().map(|spec| spec.id).collect();
    let (products, _) = book.list("Products", None, &[]);
    book.apply(Command::UpsertListItems {
        list: products,
        items: specs,
    });
    let module = book.module("Big", vec![list_axis(products), month_axis()]);
    let flags = book.add(line_item(module, "Flag", Format::Boolean, None));
    let mut written = 0;
    for block in ids.chunks(2_000) {
        let edits: Vec<CellEdit> = block
            .iter()
            .flat_map(|&product| {
                (0..240).map(move |m| CellEdit {
                    coords: vec![item(product), month_token(m)],
                    value: Value::Boolean(true),
                })
            })
            .take(CELLS - written)
            .collect();
        written += edits.len();
        book.apply(Command::SetCells {
            line_item: flags,
            edits,
        });
    }
    assert_eq!(written, CELLS);

    let chunks = book.model.export_inputs_for(flags);
    assert_eq!(
        chunks.iter().map(|chunk| chunk.chunk).collect::<Vec<_>>(),
        [0, 1]
    );
    let loaded = Model::from_parts(book.model.export_structure(), chunks).unwrap();
    assert_eq!(loaded.load_warnings(), 0);
    let last = vec![item(ids[CELLS / 240]), month_token(CELLS % 240 - 1)];
    assert_eq!(read(&loaded, flags, &[last]), vec![Value::Boolean(true)]);
}

#[test]
fn subsets_time_ranges_restricted_versions_and_scalars_round_trip() {
    let mut book = Book::new(2);
    let (products, items) = book.list("Products", None, &[("A", None), ("B", None), ("C", None)]);
    let subset = SubsetId::new();
    book.apply(Command::CreateSubset {
        id: subset,
        list: products,
        name: "Chosen".to_string(),
        items: vec![items[2], items[0]],
    });
    let range = TimeRangeId::new();
    book.apply(Command::CreateTimeRange {
        id: range,
        name: "Next year".to_string(),
        first_year: 2027,
        years: 1,
    });
    let plan = book.module(
        "Plan",
        vec![
            AxisSpec::Subset { subset },
            AxisSpec::Time {
                level: TimeLevel::Quarter,
                range: Some(range),
            },
            AxisSpec::Versions,
        ],
    );
    let target = book.add(line_item(plan, "Target", Format::number(), None));
    let current = book
        .model
        .structure()
        .versions()
        .iter()
        .find(|version| version.is_current)
        .unwrap()
        .id;
    let mut budget_only = line_item(plan, "Budget only", Format::number(), None);
    budget_only.versions = VersionsScope::Only(vec![current]);
    let budget_only = book.add(budget_only);
    let settings = book.module("Settings", Vec::new());
    let rate = book.add(line_item(settings, "Rate", Format::number(), None));

    let versions = book.version_ids();
    let mut every = Vec::new();
    let mut restricted = Vec::new();
    for &item_id in &[items[2], items[0]] {
        for quarter in 1..=4 {
            let label = CoordToken::Period(format!("Q{quarter} FY27"));
            for &version in &versions {
                every.push(vec![item(item_id), label.clone(), version_token(version)]);
            }
            restricted.push(vec![item(item_id), label.clone(), version_token(current)]);
        }
    }
    let numbered = |cells: &[Vec<CoordToken>]| {
        cells
            .iter()
            .enumerate()
            .map(|(i, coords)| (coords.clone(), Value::Number(1.5 + i as f64)))
            .collect()
    };
    book.set(target, numbered(&every));
    book.set(budget_only, numbered(&restricted));
    book.set(rate, vec![(Vec::new(), Value::Number(0.07))]);

    let chunks = book.model.export_inputs();
    assert_eq!(chunks.len(), 3);
    let loaded = Model::from_parts(book.model.export_structure(), chunks).unwrap();

    assert_eq!(loaded.load_warnings(), 0);
    assert_eq!(
        read(&loaded, target, &every),
        read(&book.model, target, &every)
    );
    assert_eq!(
        read(&loaded, budget_only, &restricted),
        read(&book.model, budget_only, &restricted)
    );
    assert_eq!(
        read(&loaded, rate, &[Vec::new()]),
        vec![Value::Number(0.07)]
    );
    assert_eq!(read(&loaded, target, &every[..1]), vec![Value::Number(1.5)]);
}
