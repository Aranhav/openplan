use std::sync::Arc;

use chrono::NaiveDate;
use openplan_engine::{
    Axis, AxisSpec, Calendar, CellEdit, ChangeSet, Command, CoordToken, EngineError, Format,
    ItemId, ItemSpec, LineItem, LineItemId, LineItemPatch, ListId, Model, ModuleId, SubsetId,
    SummaryMethod, TimeLevel, TimeRangeId, TimeScale, Value, VersionId, VersionsScope,
};
use serde_json::json;

fn calendar() -> Calendar {
    Calendar {
        fiscal_year_start_month: 1,
        first_year: 2026,
        years: 2,
        current_month: None,
    }
}

fn model() -> Model {
    Model::new(calendar())
}

fn new_list(model: &mut Model, name: &str) -> ListId {
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
    id
}

fn item_spec(name: &str) -> ItemSpec {
    ItemSpec {
        id: ItemId::new(),
        code: None,
        name: name.to_string(),
        parent: None,
    }
}

fn new_items(model: &mut Model, list: ListId, names: &[&str]) -> Vec<ItemId> {
    let specs: Vec<ItemSpec> = names.iter().map(|name| item_spec(name)).collect();
    let ids = specs.iter().map(|spec| spec.id).collect();
    model
        .apply(Command::UpsertListItems { list, items: specs })
        .unwrap();
    ids
}

fn new_module(model: &mut Model, name: &str, axes: Vec<AxisSpec>) -> ModuleId {
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

fn line_item(module: ModuleId, name: &str, format: Format) -> LineItem {
    LineItem {
        id: LineItemId::new(),
        module,
        name: name.to_string(),
        ordinal: 0,
        format,
        formula: None,
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

fn add_line_item(model: &mut Model, module: ModuleId, name: &str, format: Format) -> LineItemId {
    let li = line_item(module, name, format);
    let id = li.id;
    model.apply(Command::CreateLineItem(li)).unwrap();
    id
}

fn new_number(model: &mut Model, module: ModuleId, name: &str) -> LineItemId {
    add_line_item(model, module, name, Format::number())
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

fn item(id: ItemId) -> CoordToken {
    CoordToken::Item(id)
}

fn period(label: &str) -> CoordToken {
    CoordToken::Period(label.to_string())
}

fn version_token(model: &Model, name: &str) -> CoordToken {
    let version = model.structure().version_by_name(name).unwrap();
    CoordToken::Item(ItemId(version.id.0))
}

fn version_id(model: &Model, name: &str) -> VersionId {
    model.structure().version_by_name(name).unwrap().id
}

fn num(value: f64) -> Value {
    Value::Number(value)
}

fn text(value: &str) -> Value {
    Value::Text(Arc::from(value))
}

fn edit(coords: Vec<CoordToken>, value: Value) -> CellEdit {
    CellEdit { coords, value }
}

fn set_cell(
    model: &mut Model,
    line_item: LineItemId,
    coords: Vec<CoordToken>,
    value: Value,
) -> Result<ChangeSet, EngineError> {
    model.apply(Command::SetCells {
        line_item,
        edits: vec![edit(coords, value)],
    })
}

fn read_one(model: &Model, line_item: LineItemId, coords: Vec<CoordToken>) -> Value {
    model
        .read_cells(line_item, &[coords])
        .unwrap()
        .pop()
        .unwrap()
}

fn error_code<T: std::fmt::Debug>(result: Result<T, EngineError>) -> &'static str {
    result.unwrap_err().code()
}

/// Everything observable about a model that a failed command must leave untouched.
fn snapshot(model: &Model) -> (u64, String) {
    (model.generation(), format!("{:?}", model.structure()))
}

#[test]
fn default_versions() {
    let model = model();
    let versions: Vec<_> = model
        .structure()
        .versions()
        .iter()
        .map(|v| (v.name.as_str(), v.is_actual, v.is_current, v.switchover))
        .collect();
    assert_eq!(
        versions,
        [
            ("Actual", true, false, None),
            ("Budget", false, true, None),
            ("Forecast", false, false, None),
        ]
    );
    assert_eq!(model.generation(), 0);
    assert_eq!(model.structure().calendar, calendar());
}

#[test]
fn create_hierarchy_lists_and_items() {
    let mut model = model();
    let regions = ListId::new();
    let countries = ListId::new();
    model
        .apply(Command::CreateList {
            id: regions,
            name: "Regions".to_string(),
            parent: None,
            top_level_name: Some("All Regions".to_string()),
            numbered: false,
            production_data: false,
        })
        .unwrap();
    model
        .apply(Command::CreateList {
            id: countries,
            name: "Countries".to_string(),
            parent: Some(regions),
            top_level_name: None,
            numbered: false,
            production_data: false,
        })
        .unwrap();
    let east = ItemSpec {
        code: Some("E".to_string()),
        ..item_spec("East")
    };
    let east_id = east.id;
    model
        .apply(Command::UpsertListItems {
            list: regions,
            items: vec![east, item_spec("West")],
        })
        .unwrap();

    let orphan = model.apply(Command::UpsertListItems {
        list: countries,
        items: vec![item_spec("France")],
    });
    assert_eq!(error_code(orphan), "structure.invalid");
    let stranger = model.apply(Command::UpsertListItems {
        list: countries,
        items: vec![ItemSpec {
            parent: Some(ItemId::new()),
            ..item_spec("France")
        }],
    });
    assert_eq!(error_code(stranger), "structure.invalid");
    let top_with_parent = model.apply(Command::UpsertListItems {
        list: regions,
        items: vec![ItemSpec {
            parent: Some(east_id),
            ..item_spec("North")
        }],
    });
    assert_eq!(error_code(top_with_parent), "structure.invalid");
    assert_eq!(model.structure().list(countries).unwrap().len_dense(), 0);

    let france = ItemSpec {
        parent: Some(east_id),
        ..item_spec("France")
    };
    let spain = ItemSpec {
        parent: Some(east_id),
        ..item_spec("Spain")
    };
    model
        .apply(Command::UpsertListItems {
            list: countries,
            items: vec![france, spain],
        })
        .unwrap();

    let structure = model.structure();
    let countries_list = structure.list(countries).unwrap();
    let listed: Vec<_> = countries_list
        .items()
        .map(|(idx, item)| (idx, item.name.as_str(), item.parent))
        .collect();
    assert_eq!(
        listed,
        [(0, "France", Some(east_id)), (1, "Spain", Some(east_id))]
    );
    assert_eq!(countries_list.parent, Some(regions));
    let regions_list = structure.list(regions).unwrap();
    assert_eq!(regions_list.top_level_name.as_deref(), Some("All Regions"));
    assert_eq!(regions_list.find("west"), Some(1));
    assert_eq!(regions_list.find("E"), Some(0));
    assert_eq!(regions_list.find("e"), None);
    assert_eq!(structure.list_by_name(" COUNTRIES ").unwrap().id, countries);

    let unknown_parent = model.apply(Command::CreateList {
        id: ListId::new(),
        name: "Cities".to_string(),
        parent: Some(ListId::new()),
        top_level_name: None,
        numbered: false,
        production_data: false,
    });
    assert_eq!(error_code(unknown_parent), "structure.not_found");
    let own_parent = ListId::new();
    let self_parent = model.apply(Command::CreateList {
        id: own_parent,
        name: "Loop".to_string(),
        parent: Some(own_parent),
        top_level_name: None,
        numbered: false,
        production_data: false,
    });
    assert_eq!(error_code(self_parent), "structure.invalid");
}

#[test]
fn the_id_of_the_versions_dimension_is_reserved() {
    let mut model = model();
    let before = snapshot(&model);
    let versions = model.apply(Command::CreateList {
        id: ListId::VERSIONS,
        name: "Releases".to_string(),
        parent: None,
        top_level_name: None,
        numbered: false,
        production_data: false,
    });
    assert_eq!(error_code(versions), "structure.invalid");
    assert_eq!(snapshot(&model), before);
    assert!(model.structure().list(ListId::VERSIONS).is_none());
    // The same goes for a batch, which is rolled back whole.
    let batch = model.apply_batch(vec![
        Command::CreateList {
            id: ListId::new(),
            name: "Products".to_string(),
            parent: None,
            top_level_name: None,
            numbered: false,
            production_data: false,
        },
        Command::CreateList {
            id: ListId::VERSIONS,
            name: "Releases".to_string(),
            parent: None,
            top_level_name: None,
            numbered: false,
            production_data: false,
        },
    ]);
    assert_eq!(error_code(batch), "structure.invalid");
    assert_eq!(snapshot(&model), before);
}

#[test]
fn versions_and_time_are_reserved_list_names() {
    let mut model = model();
    let existing = new_list(&mut model, "Products");
    let before = snapshot(&model);
    let create = |name: &str| Command::CreateList {
        id: ListId::new(),
        name: name.to_string(),
        parent: None,
        top_level_name: None,
        numbered: false,
        production_data: false,
    };
    for (name, message) in [
        ("Versions", "'Versions' is a reserved name."),
        ("  versions ", "'Versions' is a reserved name."),
        ("TIME", "'Time' is a reserved name."),
        ("time", "'Time' is a reserved name."),
    ] {
        let created = model.apply(create(name)).unwrap_err();
        assert_eq!(created.code(), "structure.invalid", "{name}");
        assert_eq!(created.to_string(), message, "{name}");
        let renamed = model
            .apply(Command::UpdateList {
                id: existing,
                name: Some(name.to_string()),
                top_level_name: None,
                production_data: None,
                selective_access: None,
            })
            .unwrap_err();
        assert_eq!(renamed.code(), "structure.invalid", "{name}");
        assert_eq!(renamed.to_string(), message, "{name}");
    }
    assert_eq!(snapshot(&model), before);
    // Names that merely contain the reserved words are fine.
    new_list(&mut model, "Time Zones");
    new_list(&mut model, "Versions Archive");
}

#[test]
fn upsert_updates_existing_items_and_appends_new_ones_in_order() {
    let mut model = model();
    let products = new_list(&mut model, "Products");
    let ids = new_items(&mut model, products, &["Widget", "Gadget"]);
    model
        .apply(Command::UpsertListItems {
            list: products,
            items: vec![
                ItemSpec {
                    id: ids[0],
                    code: Some("W1".to_string()),
                    name: "Widget XL".to_string(),
                    parent: None,
                },
                item_spec("Gizmo"),
            ],
        })
        .unwrap();
    let list = model.structure().list(products).unwrap();
    let names: Vec<_> = list
        .items()
        .map(|(_, item)| (item.name.as_str(), item.code.as_deref()))
        .collect();
    assert_eq!(
        names,
        [("Widget XL", Some("W1")), ("Gadget", None), ("Gizmo", None)]
    );
    assert_eq!(list.idx(ids[1]), Some(1));
    assert_eq!(list.item(2).name, "Gizmo");

    let duplicate_id = model.apply(Command::UpsertListItems {
        list: products,
        items: vec![
            ItemSpec {
                id: ids[0],
                ..item_spec("A")
            },
            ItemSpec {
                id: ids[0],
                ..item_spec("B")
            },
        ],
    });
    assert_eq!(error_code(duplicate_id), "structure.invalid");
}

#[test]
fn duplicate_names_rejected_case_insensitive() {
    let mut model = model();
    let products = new_list(&mut model, "Products");
    let again = model.apply(Command::CreateList {
        id: ListId::new(),
        name: "  products ".to_string(),
        parent: None,
        top_level_name: None,
        numbered: false,
        production_data: false,
    });
    assert_eq!(error_code(again), "structure.name_taken");

    new_items(&mut model, products, &["Widget"]);
    let item_clash = model.apply(Command::UpsertListItems {
        list: products,
        items: vec![item_spec("WIDGET")],
    });
    assert_eq!(error_code(item_clash), "structure.name_taken");
    let batch_clash = model.apply(Command::UpsertListItems {
        list: products,
        items: vec![item_spec("Gadget"), item_spec("gadget")],
    });
    assert_eq!(error_code(batch_clash), "structure.name_taken");
    assert_eq!(model.structure().list(products).unwrap().len_dense(), 1);

    let sales = new_module(&mut model, "Sales", vec![list_axis(products)]);
    let clash = model.apply(Command::CreateModule {
        id: ModuleId::new(),
        name: "SALES".to_string(),
        axes: Vec::new(),
        functional_area: String::new(),
    });
    assert_eq!(error_code(clash), "structure.name_taken");

    new_number(&mut model, sales, "Units");
    let li_clash = model.apply(Command::CreateLineItem(line_item(
        sales,
        "units",
        Format::number(),
    )));
    assert_eq!(error_code(li_clash), "structure.name_taken");
    let costs = new_module(&mut model, "Costs", Vec::new());
    new_number(&mut model, costs, "Units");

    for bad in ["", "   ", &"x".repeat(81)] {
        let invalid = model.apply(Command::CreateList {
            id: ListId::new(),
            name: bad.to_string(),
            parent: None,
            top_level_name: None,
            numbered: false,
            production_data: false,
        });
        assert_eq!(error_code(invalid), "structure.invalid", "name {bad:?}");
    }
    let max_length = model.apply(Command::CreateList {
        id: ListId::new(),
        name: "x".repeat(80),
        parent: None,
        top_level_name: None,
        numbered: false,
        production_data: false,
    });
    assert!(max_length.is_ok());
}

#[test]
fn numbered_lists_allow_repeated_names_but_not_repeated_codes() {
    let mut model = model();
    let invoices = ListId::new();
    model
        .apply(Command::CreateList {
            id: invoices,
            name: "Invoices".to_string(),
            parent: None,
            top_level_name: None,
            numbered: true,
            production_data: true,
        })
        .unwrap();
    let coded = |code: &str, name: &str| ItemSpec {
        code: Some(code.to_string()),
        ..item_spec(name)
    };
    model
        .apply(Command::UpsertListItems {
            list: invoices,
            items: vec![coded("INV-1", "Acme"), coded("INV-2", "Acme")],
        })
        .unwrap();
    let repeated_code = model.apply(Command::UpsertListItems {
        list: invoices,
        items: vec![coded("INV-1", "Globex")],
    });
    assert_eq!(error_code(repeated_code), "structure.name_taken");
    let list = model.structure().list(invoices).unwrap();
    assert_eq!(list.len_dense(), 2);
    assert_eq!(list.find("INV-2"), Some(1));
    assert_eq!(list.find("acme"), Some(0));
    assert!(list.production_data && list.numbered);
}

#[test]
fn module_shape_with_time_and_versions() {
    let mut model = model();
    let products = new_list(&mut model, "Products");
    new_items(&mut model, products, &["A", "B", "C", "D"]);
    let module = new_module(
        &mut model,
        "Sales",
        vec![AxisSpec::Versions, month_axis(), list_axis(products)],
    );
    let units = new_number(&mut model, module, "Units");
    let shape = model.structure().line_item_shape(units).unwrap();
    assert_eq!(
        shape.axes,
        vec![
            Axis::List(products),
            Axis::Time {
                level: TimeLevel::Month,
                range: None
            },
            Axis::Versions,
        ]
    );
    assert_eq!(shape.lens, vec![4, 24, 3]);
    assert_eq!(shape.size(), 288);

    let unknown = model.structure().line_item_shape(LineItemId::new());
    assert_eq!(error_code(unknown), "structure.not_found");
}

#[test]
fn applies_to_and_time_scale_override() {
    let mut model = model();
    let products = new_list(&mut model, "Products");
    new_items(&mut model, products, &["A", "B", "C", "D"]);
    let regions = new_list(&mut model, "Regions");
    new_items(&mut model, regions, &["East", "West"]);
    let module = new_module(
        &mut model,
        "Sales",
        vec![list_axis(products), month_axis(), AxisSpec::Versions],
    );
    let lens_of = |model: &Model, li: LineItemId| model.structure().line_item_shape(li).unwrap();

    let yearly = {
        let mut li = line_item(module, "Yearly", Format::number());
        li.time_scale = TimeScale::Level(TimeLevel::Year);
        let id = li.id;
        model.apply(Command::CreateLineItem(li)).unwrap();
        id
    };
    let shape = lens_of(&model, yearly);
    assert_eq!(shape.lens, vec![4, 2, 3]);
    assert_eq!(
        shape.axes[1],
        Axis::Time {
            level: TimeLevel::Year,
            range: None
        }
    );

    let by_region = {
        let mut li = line_item(module, "By region", Format::number());
        li.applies_to = Some(vec![list_axis(regions)]);
        let id = li.id;
        model.apply(Command::CreateLineItem(li)).unwrap();
        id
    };
    assert_eq!(lens_of(&model, by_region).lens, vec![2, 24, 3]);

    let flat = {
        let mut li = line_item(module, "Flat", Format::number());
        li.applies_to = Some(Vec::new());
        li.time_scale = TimeScale::None;
        li.versions = VersionsScope::None;
        let id = li.id;
        model.apply(Command::CreateLineItem(li)).unwrap();
        id
    };
    let shape = lens_of(&model, flat);
    assert!(shape.axes.is_empty());
    assert_eq!(shape.size(), 1);

    let budget_only = {
        let mut li = line_item(module, "Budget only", Format::number());
        li.versions = VersionsScope::Only(vec![version_id(&model, "Budget")]);
        li.time_scale = TimeScale::Level(TimeLevel::Quarter);
        let id = li.id;
        model.apply(Command::CreateLineItem(li)).unwrap();
        id
    };
    assert_eq!(lens_of(&model, budget_only).lens, vec![4, 8, 1]);

    let time_in_applies_to = {
        let mut li = line_item(module, "Bad", Format::number());
        li.applies_to = Some(vec![month_axis()]);
        model.apply(Command::CreateLineItem(li))
    };
    assert_eq!(error_code(time_in_applies_to), "structure.invalid");
    let unknown_version = {
        let mut li = line_item(module, "Bad", Format::number());
        li.versions = VersionsScope::Only(vec![VersionId::new()]);
        model.apply(Command::CreateLineItem(li))
    };
    assert_eq!(error_code(unknown_version), "structure.not_found");
}

#[test]
fn module_without_time_ignores_line_item_time_scale() {
    let mut model = model();
    let products = new_list(&mut model, "Products");
    new_items(&mut model, products, &["A", "B"]);
    let module = new_module(&mut model, "Catalog", vec![list_axis(products)]);
    let mut li = line_item(module, "Price", Format::number());
    li.time_scale = TimeScale::Level(TimeLevel::Month);
    li.versions = VersionsScope::Module;
    let id = li.id;
    model.apply(Command::CreateLineItem(li)).unwrap();
    let shape = model.structure().line_item_shape(id).unwrap();
    assert_eq!(shape.axes, vec![Axis::List(products)]);
    assert_eq!(shape.lens, vec![2]);
}

#[test]
fn module_axes_are_validated() {
    let mut model = model();
    let products = new_list(&mut model, "Products");
    let items = new_items(&mut model, products, &["A", "B"]);
    let subset = SubsetId::new();
    model
        .apply(Command::CreateSubset {
            id: subset,
            list: products,
            name: "Top".to_string(),
            items: vec![items[0]],
        })
        .unwrap();
    let create = |model: &mut Model, axes: Vec<AxisSpec>| {
        model.apply(Command::CreateModule {
            id: ModuleId::new(),
            name: format!("M{}", ModuleId::new().0),
            axes,
            functional_area: String::new(),
        })
    };
    let two_times = create(&mut model, vec![month_axis(), month_axis()]);
    assert_eq!(error_code(two_times), "structure.invalid");
    let two_versions = create(&mut model, vec![AxisSpec::Versions, AxisSpec::Versions]);
    assert_eq!(error_code(two_versions), "structure.invalid");
    let same_list_twice = create(&mut model, vec![list_axis(products), list_axis(products)]);
    assert_eq!(error_code(same_list_twice), "structure.invalid");
    let list_and_its_subset = create(
        &mut model,
        vec![list_axis(products), AxisSpec::Subset { subset }],
    );
    assert_eq!(error_code(list_and_its_subset), "structure.invalid");
    let missing_list = create(&mut model, vec![list_axis(ListId::new())]);
    assert_eq!(error_code(missing_list), "structure.not_found");
    let missing_subset = create(
        &mut model,
        vec![AxisSpec::Subset {
            subset: SubsetId::new(),
        }],
    );
    assert_eq!(error_code(missing_subset), "structure.not_found");
    let missing_range = create(
        &mut model,
        vec![AxisSpec::Time {
            level: TimeLevel::Month,
            range: Some(TimeRangeId::new()),
        }],
    );
    assert_eq!(error_code(missing_range), "structure.not_found");
    assert!(create(&mut model, vec![AxisSpec::Subset { subset }]).is_ok());
}

#[test]
fn set_and_read_input_cells() {
    let mut model = model();
    let products = new_list(&mut model, "Products");
    let items = new_items(&mut model, products, &["A", "B"]);
    let module = new_module(
        &mut model,
        "Sales",
        vec![list_axis(products), month_axis(), AxisSpec::Versions],
    );
    let units = new_number(&mut model, module, "Units");
    let budget = version_token(&model, "Budget");

    let coords = |product: ItemId, month: &str| vec![item(product), period(month), budget.clone()];
    let before = model.generation();
    let changes = set_cell(&mut model, units, coords(items[1], "Mar 27"), num(42.5)).unwrap();
    assert_eq!(changes.changed_line_items, vec![units]);
    assert!(!changes.structure_changed);
    assert_eq!(changes.generation, before + 1);
    assert_eq!(model.generation(), before + 1);

    assert_eq!(
        read_one(&model, units, coords(items[1], "Mar 27")),
        num(42.5)
    );
    assert_eq!(
        read_one(&model, units, coords(items[0], "Mar 27")),
        num(0.0)
    );
    assert_eq!(
        read_one(&model, units, coords(items[1], "Apr 27")),
        num(0.0)
    );
    assert_eq!(
        read_one(
            &model,
            units,
            vec![
                item(items[1]),
                period("Mar 27"),
                version_token(&model, "Forecast")
            ]
        ),
        num(0.0)
    );

    let read = model
        .read_cells(
            units,
            &[coords(items[1], "Mar 27"), coords(items[0], "Jan 26")],
        )
        .unwrap();
    assert_eq!(read, vec![num(42.5), num(0.0)]);

    let overwrite = model
        .apply(Command::SetCells {
            line_item: units,
            edits: vec![
                edit(coords(items[1], "Mar 27"), num(1.0)),
                edit(coords(items[1], "Mar 27"), num(2.0)),
            ],
        })
        .unwrap();
    assert_eq!(overwrite.generation, before + 2);
    assert_eq!(
        read_one(&model, units, coords(items[1], "Mar 27")),
        num(2.0)
    );
}

#[test]
fn set_and_read_every_value_type() {
    let mut model = model();
    let products = new_list(&mut model, "Products");
    let items = new_items(&mut model, products, &["A", "B"]);
    let module = new_module(&mut model, "Attributes", vec![list_axis(products)]);
    let flag = add_line_item(&mut model, module, "Active", Format::Boolean);
    let label = add_line_item(&mut model, module, "Label", Format::Text);
    let launch = add_line_item(&mut model, module, "Launch", Format::Date);
    let twin = add_line_item(&mut model, module, "Twin", Format::List { list: products });
    let start = add_line_item(
        &mut model,
        module,
        "Start",
        Format::TimePeriod {
            level: TimeLevel::Quarter,
        },
    );
    let cell = |product: usize| vec![item(items[product])];

    let date = NaiveDate::from_ymd_opt(2026, 4, 1);
    set_cell(&mut model, flag, cell(0), Value::Boolean(true)).unwrap();
    set_cell(&mut model, label, cell(0), text("hello")).unwrap();
    set_cell(&mut model, launch, cell(0), Value::Date(date)).unwrap();
    set_cell(&mut model, twin, cell(0), Value::Item(Some(items[1]))).unwrap();
    set_cell(
        &mut model,
        start,
        cell(0),
        Value::Period(Some((TimeLevel::Quarter, 5))),
    )
    .unwrap();

    assert_eq!(read_one(&model, flag, cell(0)), Value::Boolean(true));
    assert_eq!(read_one(&model, label, cell(0)), text("hello"));
    assert_eq!(read_one(&model, launch, cell(0)), Value::Date(date));
    assert_eq!(read_one(&model, twin, cell(0)), Value::Item(Some(items[1])));
    assert_eq!(
        read_one(&model, start, cell(0)),
        Value::Period(Some((TimeLevel::Quarter, 5)))
    );

    assert_eq!(read_one(&model, flag, cell(1)), Value::Boolean(false));
    assert_eq!(read_one(&model, label, cell(1)), text(""));
    assert_eq!(read_one(&model, launch, cell(1)), Value::Date(None));
    assert_eq!(read_one(&model, twin, cell(1)), Value::Item(None));
    assert_eq!(read_one(&model, start, cell(1)), Value::Period(None));

    set_cell(&mut model, twin, cell(0), Value::Item(None)).unwrap();
    assert_eq!(read_one(&model, twin, cell(0)), Value::Item(None));

    let wrong_level = set_cell(
        &mut model,
        start,
        cell(1),
        Value::Period(Some((TimeLevel::Month, 0))),
    );
    assert_eq!(error_code(wrong_level), "cells.invalid_value");
    let out_of_calendar = set_cell(
        &mut model,
        start,
        cell(1),
        Value::Period(Some((TimeLevel::Quarter, 8))),
    );
    assert_eq!(error_code(out_of_calendar), "cells.invalid_value");
    let foreign_item = set_cell(&mut model, twin, cell(1), Value::Item(Some(ItemId::new())));
    assert_eq!(error_code(foreign_item), "cells.invalid_value");
    let mismatched = set_cell(&mut model, flag, cell(1), num(1.0));
    assert_eq!(error_code(mismatched), "cells.invalid_value");
    let not_finite = set_cell(&mut model, flag, cell(1), num(f64::NAN));
    assert_eq!(error_code(not_finite), "cells.invalid_value");
}

#[test]
fn set_cells_batch_atomic() {
    let mut model = model();
    let products = new_list(&mut model, "Products");
    let items = new_items(&mut model, products, &["A", "B", "C"]);
    let module = new_module(&mut model, "Sales", vec![list_axis(products)]);
    let units = new_number(&mut model, module, "Units");
    let before = model.generation();

    let result = model.apply(Command::SetCells {
        line_item: units,
        edits: vec![
            edit(vec![item(items[0])], num(1.0)),
            edit(vec![item(items[1])], text("many")),
            edit(vec![item(items[2])], num(3.0)),
        ],
    });
    match result.unwrap_err() {
        EngineError::InvalidValue { cells } => {
            assert_eq!(cells.len(), 1);
            assert_eq!(cells[0].index, 1);
        }
        other => panic!("expected InvalidValue, got {other:?}"),
    }
    assert_eq!(model.generation(), before);
    for id in &items {
        assert_eq!(read_one(&model, units, vec![item(*id)]), num(0.0));
    }

    let two_bad = model.apply(Command::SetCells {
        line_item: units,
        edits: vec![
            edit(vec![item(items[0])], Value::Boolean(true)),
            edit(vec![item(items[1])], num(2.0)),
            edit(vec![item(items[2])], text("x")),
        ],
    });
    match two_bad.unwrap_err() {
        EngineError::InvalidValue { cells } => {
            let indices: Vec<_> = cells.iter().map(|cell| cell.index).collect();
            assert_eq!(indices, vec![0, 2]);
        }
        other => panic!("expected InvalidValue, got {other:?}"),
    }
    assert_eq!(read_one(&model, units, vec![item(items[1])]), num(0.0));
}

#[test]
fn set_cells_rejects_bad_coordinates_without_writing() {
    let mut model = model();
    let products = new_list(&mut model, "Products");
    let items = new_items(&mut model, products, &["A", "B"]);
    let module = new_module(&mut model, "Sales", vec![list_axis(products), month_axis()]);
    let units = new_number(&mut model, module, "Units");
    let before = model.generation();
    let good = edit(vec![item(items[0]), period("Jan 26")], num(5.0));
    let cases: Vec<(&str, Vec<CoordToken>)> = vec![
        ("too few", vec![item(items[0])]),
        (
            "too many",
            vec![item(items[0]), period("Jan 26"), period("Feb 26")],
        ),
        ("unknown item", vec![item(ItemId::new()), period("Jan 26")]),
        (
            "period on list axis",
            vec![period("Jan 26"), period("Jan 26")],
        ),
        ("item on time axis", vec![item(items[0]), item(items[1])]),
        (
            "unparseable period",
            vec![item(items[0]), period("January")],
        ),
        ("outside calendar", vec![item(items[0]), period("Jan 30")]),
        ("wrong level", vec![item(items[0]), period("FY26")]),
    ];
    for (name, coords) in cases {
        let result = model.apply(Command::SetCells {
            line_item: units,
            edits: vec![good.clone(), edit(coords.clone(), num(1.0))],
        });
        assert_eq!(error_code(result), "cells.invalid_coordinate", "{name}");
        let read = model.read_cells(units, &[coords]);
        assert_eq!(error_code(read), "cells.invalid_coordinate", "{name}");
    }
    assert_eq!(
        read_one(&model, units, vec![item(items[0]), period("Jan 26")]),
        num(0.0)
    );
    assert_eq!(model.generation(), before);

    let unknown_line_item = model.apply(Command::SetCells {
        line_item: LineItemId::new(),
        edits: Vec::new(),
    });
    assert_eq!(error_code(unknown_line_item), "structure.not_found");
    assert_eq!(
        error_code(model.read_cells(LineItemId::new(), &[])),
        "structure.not_found"
    );
}

#[test]
fn set_cells_on_formula_line_item_rejected() {
    let mut model = model();
    let module = new_module(&mut model, "Calc", Vec::new());
    let mut li = line_item(module, "Constant", Format::number());
    li.formula = Some("1".to_string());
    let id = li.id;
    model.apply(Command::CreateLineItem(li)).unwrap();

    let result = set_cell(&mut model, id, Vec::new(), num(2.0));
    assert_eq!(error_code(result), "cells.not_input");
    assert_eq!(read_one(&model, id, Vec::new()), num(1.0));

    let input = new_number(&mut model, module, "Input");
    set_cell(&mut model, input, Vec::new(), num(7.0)).unwrap();
    assert_eq!(read_one(&model, input, Vec::new()), num(7.0));
}

#[test]
fn delete_list_in_use_rejected() {
    let mut model = model();
    let products = new_list(&mut model, "Products");
    let items = new_items(&mut model, products, &["A", "B"]);
    let sales = new_module(&mut model, "Sales", vec![list_axis(products)]);
    let delete = |model: &mut Model| model.apply(Command::DeleteList { id: products });

    let error = delete(&mut model).unwrap_err();
    assert_eq!(error.code(), "structure.in_use");
    assert!(error.to_string().contains("Sales"), "{error}");

    model.apply(Command::DeleteModule { id: sales }).unwrap();
    let subset = SubsetId::new();
    model
        .apply(Command::CreateSubset {
            id: subset,
            list: products,
            name: "Hot".to_string(),
            items: vec![items[0]],
        })
        .unwrap();
    let error = delete(&mut model).unwrap_err();
    assert_eq!(error.code(), "structure.in_use");
    assert!(error.to_string().contains("Hot"), "{error}");
    model.apply(Command::DeleteSubset { id: subset }).unwrap();

    let other = new_module(&mut model, "Attributes", Vec::new());
    let favourite = add_line_item(
        &mut model,
        other,
        "Favourite",
        Format::List { list: products },
    );
    let error = delete(&mut model).unwrap_err();
    assert_eq!(error.code(), "structure.in_use");
    assert!(error.to_string().contains("Favourite"), "{error}");
    model
        .apply(Command::DeleteLineItem { id: favourite })
        .unwrap();

    let applies = {
        let mut li = line_item(other, "Count", Format::number());
        li.applies_to = Some(vec![list_axis(products)]);
        let id = li.id;
        model.apply(Command::CreateLineItem(li)).unwrap();
        id
    };
    let error = delete(&mut model).unwrap_err();
    assert_eq!(error.code(), "structure.in_use");
    assert!(error.to_string().contains("Count"), "{error}");
    model
        .apply(Command::DeleteLineItem { id: applies })
        .unwrap();

    let children = ListId::new();
    model
        .apply(Command::CreateList {
            id: children,
            name: "Variants".to_string(),
            parent: Some(products),
            top_level_name: None,
            numbered: false,
            production_data: false,
        })
        .unwrap();
    let error = delete(&mut model).unwrap_err();
    assert_eq!(error.code(), "structure.in_use");
    assert!(error.to_string().contains("Variants"), "{error}");
    model.apply(Command::DeleteList { id: children }).unwrap();

    let changes = delete(&mut model).unwrap();
    assert!(changes.structure_changed);
    assert!(model.structure().list(products).is_none());
}

#[test]
fn delete_item_blanks_list_cells_and_drops_cells() {
    let mut model = model();
    let products = new_list(&mut model, "Products");
    let items = new_items(&mut model, products, &["A", "B", "C"]);
    let module = new_module(&mut model, "Catalog", vec![list_axis(products)]);
    let units = new_number(&mut model, module, "Units");
    let best = add_line_item(
        &mut model,
        module,
        "Best seller",
        Format::List { list: products },
    );
    for (position, id) in items.iter().enumerate() {
        set_cell(
            &mut model,
            units,
            vec![item(*id)],
            num(10.0 * (position + 1) as f64),
        )
        .unwrap();
    }
    set_cell(
        &mut model,
        best,
        vec![item(items[0])],
        Value::Item(Some(items[1])),
    )
    .unwrap();
    set_cell(
        &mut model,
        best,
        vec![item(items[2])],
        Value::Item(Some(items[2])),
    )
    .unwrap();

    let changes = model
        .apply(Command::DeleteListItems {
            list: products,
            ids: vec![items[1]],
        })
        .unwrap();
    assert!(changes.structure_changed);
    assert!(changes.changed_line_items.contains(&best));

    let list = model.structure().list(products).unwrap();
    assert_eq!(list.len_dense(), 3);
    assert_eq!(list.items().count(), 2);
    assert_eq!(list.idx(items[1]), None);
    assert!(list.item(1).deleted);

    assert_eq!(
        read_one(&model, best, vec![item(items[0])]),
        Value::Item(None)
    );
    assert_eq!(
        read_one(&model, best, vec![item(items[2])]),
        Value::Item(Some(items[2]))
    );
    assert_eq!(read_one(&model, units, vec![item(items[0])]), num(10.0));
    assert_eq!(read_one(&model, units, vec![item(items[2])]), num(30.0));
    assert_eq!(
        error_code(model.read_cells(units, &[vec![item(items[1])]])),
        "cells.invalid_coordinate"
    );
    let write_deleted = set_cell(&mut model, units, vec![item(items[1])], num(1.0));
    assert_eq!(error_code(write_deleted), "cells.invalid_coordinate");
    let point_at_deleted = set_cell(
        &mut model,
        best,
        vec![item(items[0])],
        Value::Item(Some(items[1])),
    );
    assert_eq!(error_code(point_at_deleted), "cells.invalid_value");

    let revive = model.apply(Command::UpsertListItems {
        list: products,
        items: vec![ItemSpec {
            id: items[1],
            ..item_spec("B again")
        }],
    });
    assert_eq!(error_code(revive), "structure.invalid");
    let delete_twice = model.apply(Command::DeleteListItems {
        list: products,
        ids: vec![items[1]],
    });
    assert_eq!(error_code(delete_twice), "structure.not_found");

    let name_reused = new_items(&mut model, products, &["B"]);
    assert_eq!(
        model
            .structure()
            .list(products)
            .unwrap()
            .idx(name_reused[0]),
        Some(3)
    );
    assert_eq!(
        read_one(&model, units, vec![item(name_reused[0])]),
        num(0.0)
    );
}

#[test]
fn deleting_an_item_with_children_is_rejected() {
    let mut model = model();
    let regions = new_list(&mut model, "Regions");
    let region_ids = new_items(&mut model, regions, &["East", "West"]);
    let countries = ListId::new();
    model
        .apply(Command::CreateList {
            id: countries,
            name: "Countries".to_string(),
            parent: Some(regions),
            top_level_name: None,
            numbered: false,
            production_data: false,
        })
        .unwrap();
    let france = ItemSpec {
        parent: Some(region_ids[0]),
        ..item_spec("France")
    };
    let france_id = france.id;
    model
        .apply(Command::UpsertListItems {
            list: countries,
            items: vec![france],
        })
        .unwrap();

    let blocked = model.apply(Command::DeleteListItems {
        list: regions,
        ids: vec![region_ids[0], region_ids[1]],
    });
    let error = blocked.unwrap_err();
    assert_eq!(error.code(), "structure.invalid");
    assert!(error.to_string().contains("France"), "{error}");
    assert_eq!(model.structure().list(regions).unwrap().items().count(), 2);

    model
        .apply(Command::DeleteListItems {
            list: countries,
            ids: vec![france_id],
        })
        .unwrap();
    model
        .apply(Command::DeleteListItems {
            list: regions,
            ids: vec![region_ids[0]],
        })
        .unwrap();
    assert_eq!(model.structure().list(regions).unwrap().items().count(), 1);
}

#[test]
fn adding_items_preserves_values() {
    let mut model = model();
    let products = new_list(&mut model, "Products");
    let items = new_items(&mut model, products, &["A", "B"]);
    let module = new_module(
        &mut model,
        "Sales",
        vec![list_axis(products), month_axis(), AxisSpec::Versions],
    );
    let units = new_number(&mut model, module, "Units");
    let budget = version_token(&model, "Budget");
    let coords = |product: ItemId, month: &str| vec![item(product), period(month), budget.clone()];
    set_cell(&mut model, units, coords(items[0], "Jan 26"), num(1.0)).unwrap();
    set_cell(&mut model, units, coords(items[1], "Dec 27"), num(2.0)).unwrap();

    let changes = model
        .apply(Command::UpsertListItems {
            list: products,
            items: vec![item_spec("C")],
        })
        .unwrap();
    assert!(changes.changed_line_items.contains(&units));
    let added = model
        .structure()
        .list(products)
        .unwrap()
        .items()
        .last()
        .unwrap()
        .1
        .id;

    assert_eq!(
        model.structure().line_item_shape(units).unwrap().lens,
        vec![3, 24, 3]
    );
    assert_eq!(
        read_one(&model, units, coords(items[0], "Jan 26")),
        num(1.0)
    );
    assert_eq!(
        read_one(&model, units, coords(items[1], "Dec 27")),
        num(2.0)
    );
    assert_eq!(read_one(&model, units, coords(added, "Dec 27")), num(0.0));
    set_cell(&mut model, units, coords(added, "Dec 27"), num(3.0)).unwrap();
    assert_eq!(read_one(&model, units, coords(added, "Dec 27")), num(3.0));

    model
        .apply(Command::UpsertListItems {
            list: products,
            items: vec![ItemSpec {
                id: items[0],
                ..item_spec("A renamed")
            }],
        })
        .unwrap();
    assert_eq!(
        read_one(&model, units, coords(items[0], "Jan 26")),
        num(1.0)
    );
}

#[test]
fn adding_a_version_preserves_values() {
    let mut model = model();
    let module = new_module(&mut model, "Plan", vec![month_axis(), AxisSpec::Versions]);
    let revenue = new_number(&mut model, module, "Revenue");
    let coords =
        |model: &Model, version: &str| vec![period("Feb 26"), version_token(model, version)];
    let forecast = coords(&model, "Forecast");
    set_cell(&mut model, revenue, forecast.clone(), num(9.0)).unwrap();

    let scenario = VersionId::new();
    model
        .apply(Command::UpsertVersion {
            id: scenario,
            name: "Stretch".to_string(),
            is_actual: false,
            is_current: false,
            switchover: None,
        })
        .unwrap();
    assert_eq!(
        model.structure().line_item_shape(revenue).unwrap().lens,
        vec![24, 4]
    );
    assert_eq!(read_one(&model, revenue, forecast), num(9.0));
    let stretch = vec![period("Feb 26"), CoordToken::Item(ItemId(scenario.0))];
    set_cell(&mut model, revenue, stretch.clone(), num(11.0)).unwrap();
    assert_eq!(read_one(&model, revenue, stretch), num(11.0));

    model
        .apply(Command::DeleteVersion { id: scenario })
        .unwrap();
    assert_eq!(
        model.structure().line_item_shape(revenue).unwrap().lens,
        vec![24, 3]
    );
    assert_eq!(
        read_one(&model, revenue, coords(&model, "Forecast")),
        num(9.0)
    );
}

#[test]
fn changing_axes_clears_inputs() {
    let mut model = model();
    let products = new_list(&mut model, "Products");
    let items = new_items(&mut model, products, &["A", "B"]);
    let module = new_module(&mut model, "Sales", vec![list_axis(products), month_axis()]);
    let units = new_number(&mut model, module, "Units");
    let cell = vec![item(items[0]), period("Jan 26")];
    set_cell(&mut model, units, cell.clone(), num(5.0)).unwrap();

    let changes = model
        .apply(Command::UpdateModule {
            id: module,
            name: Some("Sales plan".to_string()),
            axes: None,
            functional_area: Some("Revenue".to_string()),
        })
        .unwrap();
    assert!(!changes.changed_line_items.contains(&units));
    assert_eq!(read_one(&model, units, cell.clone()), num(5.0));

    let changes = model
        .apply(Command::UpdateModule {
            id: module,
            name: None,
            axes: Some(vec![list_axis(products), month_axis(), AxisSpec::Versions]),
            functional_area: None,
        })
        .unwrap();
    assert!(changes.changed_line_items.contains(&units));
    let with_budget = vec![
        item(items[0]),
        period("Jan 26"),
        version_token(&model, "Budget"),
    ];
    assert_eq!(read_one(&model, units, with_budget), num(0.0));
    assert_eq!(
        model.structure().line_item_shape(units).unwrap().lens,
        vec![2, 24, 3]
    );

    let with_forecast = vec![
        item(items[0]),
        period("Jan 26"),
        version_token(&model, "Forecast"),
    ];
    set_cell(&mut model, units, with_forecast.clone(), num(8.0)).unwrap();
    model
        .apply(Command::UpdateLineItem {
            id: units,
            patch: LineItemPatch {
                time_scale: Some(TimeScale::Level(TimeLevel::Year)),
                ..LineItemPatch::default()
            },
        })
        .unwrap();
    assert_eq!(
        model.structure().line_item_shape(units).unwrap().lens,
        vec![2, 2, 3]
    );
    let yearly = vec![
        item(items[0]),
        period("FY26"),
        version_token(&model, "Forecast"),
    ];
    assert_eq!(read_one(&model, units, yearly.clone()), num(0.0));

    set_cell(&mut model, units, yearly.clone(), num(4.0)).unwrap();
    let only_forecast = VersionsScope::Only(vec![version_id(&model, "Forecast")]);
    model
        .apply(Command::UpdateLineItem {
            id: units,
            patch: LineItemPatch {
                versions: Some(only_forecast),
                ..LineItemPatch::default()
            },
        })
        .unwrap();
    assert_eq!(
        model.structure().line_item_shape(units).unwrap().lens,
        vec![2, 2, 1]
    );
    assert_eq!(read_one(&model, units, yearly), num(0.0));

    model
        .apply(Command::UpdateLineItem {
            id: units,
            patch: LineItemPatch {
                applies_to: Some(Some(Vec::new())),
                ..LineItemPatch::default()
            },
        })
        .unwrap();
    assert_eq!(
        model.structure().line_item_shape(units).unwrap().lens,
        vec![2, 1]
    );
}

#[test]
fn changing_calendar_clears_time_dimensioned_inputs_only() {
    let mut model = model();
    let monthly_module = new_module(&mut model, "Monthly", vec![month_axis()]);
    let monthly = new_number(&mut model, monthly_module, "Revenue");
    let flat_module = new_module(&mut model, "Flat", Vec::new());
    let flat = new_number(&mut model, flat_module, "Rate");
    let start = add_line_item(
        &mut model,
        flat_module,
        "Start",
        Format::TimePeriod {
            level: TimeLevel::Quarter,
        },
    );
    let fifth_quarter = Value::Period(Some((TimeLevel::Quarter, 5)));
    set_cell(&mut model, monthly, vec![period("Jan 26")], num(1.0)).unwrap();
    set_cell(&mut model, flat, Vec::new(), num(2.0)).unwrap();
    set_cell(&mut model, start, Vec::new(), fifth_quarter.clone()).unwrap();

    let renamed = Calendar {
        first_year: 2030,
        current_month: Some(3),
        ..calendar()
    };
    let changes = model
        .apply(Command::SetCalendar { calendar: renamed })
        .unwrap();
    assert!(changes.structure_changed);
    assert!(changes.changed_line_items.is_empty());
    assert_eq!(read_one(&model, monthly, vec![period("Jan 30")]), num(1.0));
    assert_eq!(read_one(&model, start, Vec::new()), fifth_quarter);
    assert_eq!(model.structure().calendar, renamed);

    let longer = Calendar {
        years: 3,
        ..renamed
    };
    let changes = model
        .apply(Command::SetCalendar { calendar: longer })
        .unwrap();
    assert_eq!(changes.changed_line_items.len(), 2);
    assert!(changes.changed_line_items.contains(&monthly));
    assert!(changes.changed_line_items.contains(&start));
    assert_eq!(
        model.structure().line_item_shape(monthly).unwrap().lens,
        vec![36]
    );
    assert_eq!(read_one(&model, monthly, vec![period("Jan 30")]), num(0.0));
    assert_eq!(read_one(&model, start, Vec::new()), Value::Period(None));
    assert_eq!(read_one(&model, flat, Vec::new()), num(2.0));

    set_cell(&mut model, monthly, vec![period("Jan 30")], num(5.0)).unwrap();
    set_cell(&mut model, start, Vec::new(), fifth_quarter).unwrap();
    let april = Calendar {
        fiscal_year_start_month: 4,
        ..longer
    };
    model
        .apply(Command::SetCalendar { calendar: april })
        .unwrap();
    assert_eq!(read_one(&model, monthly, vec![period("Apr 29")]), num(0.0));
    assert_eq!(read_one(&model, start, Vec::new()), Value::Period(None));
    assert_eq!(read_one(&model, flat, Vec::new()), num(2.0));
}

#[test]
fn set_calendar_is_validated() {
    let mut model = model();
    let invalid = [
        Calendar {
            years: 0,
            ..calendar()
        },
        Calendar {
            fiscal_year_start_month: 13,
            ..calendar()
        },
        Calendar {
            current_month: Some(24),
            ..calendar()
        },
    ];
    for bad in invalid {
        let result = model.apply(Command::SetCalendar { calendar: bad });
        assert_eq!(error_code(result), "structure.invalid", "{bad:?}");
    }
    assert_eq!(model.structure().calendar, calendar());
    assert_eq!(model.generation(), 0);
    let last_month = Calendar {
        current_month: Some(23),
        ..calendar()
    };
    model
        .apply(Command::SetCalendar {
            calendar: last_month,
        })
        .unwrap();
    assert_eq!(model.structure().calendar.current_month, Some(23));

    let budget = version_id(&model, "Budget");
    model
        .apply(Command::UpsertVersion {
            id: budget,
            name: "Budget".to_string(),
            is_actual: false,
            is_current: true,
            switchover: Some(20),
        })
        .unwrap();
    let shorter = Calendar {
        years: 1,
        current_month: None,
        ..calendar()
    };
    let result = model.apply(Command::SetCalendar { calendar: shorter });
    assert_eq!(error_code(result), "structure.invalid");
}

#[test]
fn switchover_cells_locked() {
    let mut model = model();
    let module = new_module(&mut model, "Plan", vec![month_axis(), AxisSpec::Versions]);
    let revenue = new_number(&mut model, module, "Revenue");
    let budget_id = version_id(&model, "Budget");
    model
        .apply(Command::UpsertVersion {
            id: budget_id,
            name: "Budget".to_string(),
            is_actual: false,
            is_current: true,
            switchover: Some(3),
        })
        .unwrap();
    let budget_version = version_token(&model, "Budget");
    let budget = |month: &str| vec![period(month), budget_version.clone()];

    let locked = set_cell(&mut model, revenue, budget("Feb 26"), num(1.0));
    match locked.unwrap_err() {
        EngineError::InvalidValue { cells } => {
            assert_eq!(cells.len(), 1);
            assert_eq!(cells[0].index, 0);
            assert_eq!(
                cells[0].message,
                "Periods before the switchover show Actual values."
            );
        }
        other => panic!("expected InvalidValue, got {other:?}"),
    }
    let mixed = model.apply(Command::SetCells {
        line_item: revenue,
        edits: vec![
            edit(budget("Apr 26"), num(2.0)),
            edit(budget("Mar 26"), num(3.0)),
        ],
    });
    match mixed.unwrap_err() {
        EngineError::InvalidValue { cells } => {
            assert_eq!(cells.len(), 1);
            assert_eq!(cells[0].index, 1);
        }
        other => panic!("expected InvalidValue, got {other:?}"),
    }
    assert_eq!(read_one(&model, revenue, budget("Apr 26")), num(0.0));

    set_cell(&mut model, revenue, budget("Apr 26"), num(2.0)).unwrap();
    assert_eq!(read_one(&model, revenue, budget("Apr 26")), num(2.0));
    for version in ["Actual", "Forecast"] {
        let coords = vec![period("Feb 26"), version_token(&model, version)];
        set_cell(&mut model, revenue, coords, num(4.0)).unwrap();
    }
    let budget_token = version_token(&model, "Budget");

    let yearly = {
        let mut li = line_item(module, "Yearly", Format::number());
        li.time_scale = TimeScale::Level(TimeLevel::Year);
        let id = li.id;
        model.apply(Command::CreateLineItem(li)).unwrap();
        id
    };
    set_cell(
        &mut model,
        yearly,
        vec![period("FY26"), budget_token.clone()],
        num(5.0),
    )
    .unwrap();
    let quarterly = {
        let mut li = line_item(module, "Quarterly", Format::number());
        li.time_scale = TimeScale::Level(TimeLevel::Quarter);
        let id = li.id;
        model.apply(Command::CreateLineItem(li)).unwrap();
        id
    };
    let first_quarter = set_cell(
        &mut model,
        quarterly,
        vec![period("Q1 FY26"), budget_token.clone()],
        num(7.0),
    );
    assert_eq!(error_code(first_quarter), "cells.invalid_value");
    set_cell(
        &mut model,
        quarterly,
        vec![period("Q2 FY26"), budget_token.clone()],
        num(7.0),
    )
    .unwrap();
    let timeless = {
        let mut li = line_item(module, "Timeless", Format::number());
        li.time_scale = TimeScale::None;
        let id = li.id;
        model.apply(Command::CreateLineItem(li)).unwrap();
        id
    };
    set_cell(&mut model, timeless, vec![budget_token], num(6.0)).unwrap();

    let actual_with_switchover = model.apply(Command::UpsertVersion {
        id: version_id(&model, "Actual"),
        name: "Actual".to_string(),
        is_actual: true,
        is_current: false,
        switchover: Some(2),
    });
    assert_eq!(error_code(actual_with_switchover), "structure.invalid");
    let out_of_range = model.apply(Command::UpsertVersion {
        id: budget_id,
        name: "Budget".to_string(),
        is_actual: false,
        is_current: true,
        switchover: Some(24),
    });
    assert_eq!(error_code(out_of_range), "structure.invalid");
}

#[test]
fn version_flags_and_deletion_rules() {
    let mut model = model();
    let actual = version_id(&model, "Actual");
    let budget = version_id(&model, "Budget");
    let forecast = version_id(&model, "Forecast");
    let flags = |model: &Model| -> Vec<(bool, bool)> {
        model
            .structure()
            .versions()
            .iter()
            .map(|v| (v.is_actual, v.is_current))
            .collect()
    };

    model
        .apply(Command::UpsertVersion {
            id: forecast,
            name: "Forecast".to_string(),
            is_actual: false,
            is_current: true,
            switchover: None,
        })
        .unwrap();
    assert_eq!(
        flags(&model),
        [(true, false), (false, false), (false, true)]
    );

    let unflag_only_current = model.apply(Command::UpsertVersion {
        id: forecast,
        name: "Forecast".to_string(),
        is_actual: false,
        is_current: false,
        switchover: None,
    });
    assert_eq!(error_code(unflag_only_current), "structure.invalid");
    let unflag_only_actual = model.apply(Command::UpsertVersion {
        id: actual,
        name: "Actual".to_string(),
        is_actual: false,
        is_current: false,
        switchover: None,
    });
    assert_eq!(error_code(unflag_only_actual), "structure.invalid");
    let renamed_clash = model.apply(Command::UpsertVersion {
        id: budget,
        name: "forecast".to_string(),
        is_actual: false,
        is_current: false,
        switchover: None,
    });
    assert_eq!(error_code(renamed_clash), "structure.name_taken");

    model
        .apply(Command::UpsertVersion {
            id: budget,
            name: "Budget v2".to_string(),
            is_actual: true,
            is_current: false,
            switchover: None,
        })
        .unwrap();
    assert_eq!(
        flags(&model),
        [(false, false), (true, false), (false, true)]
    );
    assert_eq!(model.structure().versions()[1].name, "Budget v2");

    for protected in [budget, forecast] {
        let result = model.apply(Command::DeleteVersion { id: protected });
        assert_eq!(error_code(result), "structure.invalid");
    }
    let module = new_module(&mut model, "Plan", vec![AxisSpec::Versions]);
    let mut li = line_item(module, "Revenue", Format::number());
    li.versions = VersionsScope::Only(vec![actual]);
    model.apply(Command::CreateLineItem(li)).unwrap();
    let in_use = model.apply(Command::DeleteVersion { id: actual });
    assert_eq!(error_code(in_use), "structure.in_use");
    assert_eq!(
        error_code(model.apply(Command::DeleteVersion {
            id: VersionId::new()
        })),
        "structure.not_found"
    );
}

#[test]
fn subsets_define_axes_and_follow_item_changes() {
    let mut model = model();
    let products = new_list(&mut model, "Products");
    let items = new_items(&mut model, products, &["A", "B", "C"]);
    let subset = SubsetId::new();
    model
        .apply(Command::CreateSubset {
            id: subset,
            list: products,
            name: "Focus".to_string(),
            items: vec![items[2], items[0]],
        })
        .unwrap();
    let module = new_module(&mut model, "Focus plan", vec![AxisSpec::Subset { subset }]);
    let units = new_number(&mut model, module, "Units");
    let shape = model.structure().line_item_shape(units).unwrap();
    assert_eq!(shape.axes, vec![Axis::Subset(subset)]);
    assert_eq!(shape.lens, vec![2]);
    assert_eq!(model.structure().subsets().count(), 1);

    set_cell(&mut model, units, vec![item(items[2])], num(3.0)).unwrap();
    set_cell(&mut model, units, vec![item(items[0])], num(1.0)).unwrap();
    let outside = set_cell(&mut model, units, vec![item(items[1])], num(2.0));
    assert_eq!(error_code(outside), "cells.invalid_coordinate");

    model
        .apply(Command::UpdateSubset {
            id: subset,
            name: Some("Focus list".to_string()),
            items: Some(vec![items[0], items[1], items[2]]),
        })
        .unwrap();
    assert_eq!(
        model.structure().line_item_shape(units).unwrap().lens,
        vec![3]
    );
    assert_eq!(read_one(&model, units, vec![item(items[0])]), num(1.0));
    assert_eq!(read_one(&model, units, vec![item(items[1])]), num(0.0));
    assert_eq!(read_one(&model, units, vec![item(items[2])]), num(3.0));

    model
        .apply(Command::DeleteListItems {
            list: products,
            ids: vec![items[0]],
        })
        .unwrap();
    assert_eq!(
        model.structure().subset(subset).unwrap().items,
        vec![items[1], items[2]]
    );
    assert_eq!(read_one(&model, units, vec![item(items[2])]), num(3.0));

    let foreign = model.apply(Command::UpdateSubset {
        id: subset,
        name: None,
        items: Some(vec![ItemId::new()]),
    });
    assert_eq!(error_code(foreign), "structure.not_found");
    let in_use = model.apply(Command::DeleteSubset { id: subset });
    assert_eq!(error_code(in_use), "structure.in_use");
    let duplicated = model.apply(Command::CreateSubset {
        id: SubsetId::new(),
        list: products,
        name: "Dup".to_string(),
        items: vec![items[1], items[1]],
    });
    assert_eq!(error_code(duplicated), "structure.invalid");
}

#[test]
fn time_ranges_define_time_axes() {
    let mut model = model();
    let range = TimeRangeId::new();
    model
        .apply(Command::CreateTimeRange {
            id: range,
            name: "Plan year".to_string(),
            first_year: 2027,
            years: 1,
        })
        .unwrap();
    let module = new_module(
        &mut model,
        "Plan",
        vec![
            AxisSpec::Time {
                level: TimeLevel::Month,
                range: Some(range),
            },
            AxisSpec::Versions,
        ],
    );
    let revenue = new_number(&mut model, module, "Revenue");
    assert_eq!(model.structure().time_ranges().count(), 1);
    let shape = model.structure().line_item_shape(revenue).unwrap();
    assert_eq!(shape.lens, vec![12, 3]);
    assert_eq!(
        shape.axes[0],
        Axis::Time {
            level: TimeLevel::Month,
            range: Some(range)
        }
    );
    let budget = version_token(&model, "Budget");
    set_cell(
        &mut model,
        revenue,
        vec![period("Jan 27"), budget.clone()],
        num(1.0),
    )
    .unwrap();
    assert_eq!(
        read_one(&model, revenue, vec![period("Jan 27"), budget.clone()]),
        num(1.0)
    );
    let outside = set_cell(
        &mut model,
        revenue,
        vec![period("Dec 26"), budget.clone()],
        num(1.0),
    );
    assert_eq!(error_code(outside), "cells.invalid_coordinate");

    let quarterly = {
        let mut li = line_item(module, "Quarterly", Format::number());
        li.time_scale = TimeScale::Level(TimeLevel::Quarter);
        let id = li.id;
        model.apply(Command::CreateLineItem(li)).unwrap();
        id
    };
    assert_eq!(
        model.structure().line_item_shape(quarterly).unwrap().lens,
        vec![4, 3]
    );
    set_cell(
        &mut model,
        quarterly,
        vec![period("Q4 FY27"), budget],
        num(2.0),
    )
    .unwrap();

    let in_use = model.apply(Command::DeleteTimeRange { id: range });
    assert_eq!(error_code(in_use), "structure.in_use");
    model.apply(Command::DeleteModule { id: module }).unwrap();
    model.apply(Command::DeleteTimeRange { id: range }).unwrap();
    assert!(model.structure().time_range(range).is_none());

    for (years, first_year) in [(0, 2026), (21, 2026), (1, 0)] {
        let invalid = model.apply(Command::CreateTimeRange {
            id: TimeRangeId::new(),
            name: format!("Bad {years} {first_year}"),
            first_year,
            years,
        });
        assert_eq!(error_code(invalid), "structure.invalid");
    }
}

#[test]
fn update_line_item_patch() {
    let mut model = model();
    let products = new_list(&mut model, "Products");
    let items = new_items(&mut model, products, &["A"]);
    let module = new_module(&mut model, "Sales", vec![list_axis(products)]);
    let units = new_number(&mut model, module, "Units");
    let other = new_number(&mut model, module, "Other");
    let cell = vec![item(items[0])];
    set_cell(&mut model, units, cell.clone(), num(5.0)).unwrap();

    let patch = |f: &dyn Fn(&mut LineItemPatch)| {
        let mut patch = LineItemPatch::default();
        f(&mut patch);
        patch
    };
    let changes = model
        .apply(Command::UpdateLineItem {
            id: units,
            patch: patch(&|p| {
                p.name = Some("Volume".to_string());
                p.notes = Some("Monthly volume".to_string());
                p.ordinal = Some(3);
                p.code = Some(Some("VOL".to_string()));
                p.summary = Some(SummaryMethod::Average);
                p.time_summary = Some(Some(SummaryMethod::Last));
                p.format = Some(Format::Number {
                    decimals: 2,
                    thousands_sep: false,
                    unit: openplan_engine::NumberUnit::Percent,
                    negative: openplan_engine::NegativeStyle::Parens,
                });
            }),
        })
        .unwrap();
    assert!(!changes.changed_line_items.contains(&units));
    let renamed = model.structure().line_item(units).unwrap();
    assert_eq!(renamed.name, "Volume");
    assert_eq!(renamed.ordinal, 3);
    assert_eq!(renamed.code.as_deref(), Some("VOL"));
    assert_eq!(renamed.time_summary, Some(SummaryMethod::Last));
    assert_eq!(read_one(&model, units, cell.clone()), num(5.0));
    assert_eq!(
        model
            .structure()
            .line_item_by_name(Some(module), "volume")
            .unwrap()
            .id,
        units
    );
    assert_eq!(
        model
            .structure()
            .line_item_by_name(None, "VOLUME")
            .unwrap()
            .id,
        units
    );
    assert!(
        model
            .structure()
            .line_item_by_name(Some(module), "Units")
            .is_none()
    );

    let clash = model.apply(Command::UpdateLineItem {
        id: other,
        patch: patch(&|p| p.name = Some("volume".to_string())),
    });
    assert_eq!(error_code(clash), "structure.name_taken");
    let keep_own_name = model.apply(Command::UpdateLineItem {
        id: units,
        patch: patch(&|p| p.name = Some("VOLUME".to_string())),
    });
    assert!(keep_own_name.is_ok());

    model
        .apply(Command::UpdateLineItem {
            id: units,
            patch: patch(&|p| p.format = Some(Format::Text)),
        })
        .unwrap();
    assert_eq!(read_one(&model, units, cell.clone()), text(""));
    set_cell(&mut model, units, cell.clone(), text("abc")).unwrap();

    let changes = model
        .apply(Command::UpdateLineItem {
            id: units,
            patch: patch(&|p| p.formula = Some(Some("\"x\"".to_string()))),
        })
        .unwrap();
    assert!(changes.changed_line_items.contains(&units));
    assert_eq!(
        error_code(set_cell(&mut model, units, cell.clone(), text("y"))),
        "cells.not_input"
    );
    assert_eq!(read_one(&model, units, cell.clone()), text("x"));

    model
        .apply(Command::UpdateLineItem {
            id: units,
            patch: patch(&|p| p.formula = Some(None)),
        })
        .unwrap();
    set_cell(&mut model, units, cell.clone(), text("back")).unwrap();
    assert_eq!(read_one(&model, units, cell), text("back"));

    let ratio = model.apply(Command::UpdateLineItem {
        id: units,
        patch: patch(&|p| {
            p.summary = Some(SummaryMethod::Ratio {
                numerator: other,
                denominator: LineItemId::new(),
            })
        }),
    });
    assert_eq!(error_code(ratio), "structure.not_found");
    let missing = model.apply(Command::UpdateLineItem {
        id: LineItemId::new(),
        patch: LineItemPatch::default(),
    });
    assert_eq!(error_code(missing), "structure.not_found");
}

#[test]
fn deleting_modules_and_line_items() {
    let mut model = model();
    let module = new_module(&mut model, "Sales", Vec::new());
    let revenue = new_number(&mut model, module, "Revenue");
    let cost = new_number(&mut model, module, "Cost");
    let mut margin = line_item(module, "Margin", Format::number());
    margin.summary = SummaryMethod::Ratio {
        numerator: revenue,
        denominator: cost,
    };
    margin.read_access_driver = Some(cost);
    let margin_id = margin.id;
    model.apply(Command::CreateLineItem(margin)).unwrap();

    let in_use = model.apply(Command::DeleteLineItem { id: revenue });
    assert_eq!(error_code(in_use), "structure.in_use");
    let other_module = new_module(&mut model, "Other", Vec::new());
    let mut outside = line_item(other_module, "Outside", Format::number());
    outside.write_access_driver = Some(margin_id);
    let outside_id = outside.id;
    model.apply(Command::CreateLineItem(outside)).unwrap();
    let margin_in_use = model.apply(Command::DeleteLineItem { id: margin_id });
    assert_eq!(error_code(margin_in_use), "structure.in_use");
    let module_in_use = model.apply(Command::DeleteModule { id: module });
    assert_eq!(error_code(module_in_use), "structure.in_use");

    model
        .apply(Command::DeleteLineItem { id: outside_id })
        .unwrap();
    model
        .apply(Command::DeleteLineItem { id: margin_id })
        .unwrap();
    assert!(model.structure().line_item(margin_id).is_none());
    model
        .apply(Command::DeleteLineItem { id: revenue })
        .unwrap();
    assert_eq!(
        error_code(model.read_cells(revenue, &[Vec::new()])),
        "structure.not_found"
    );

    set_cell(&mut model, cost, Vec::new(), num(3.0)).unwrap();
    model.apply(Command::DeleteModule { id: module }).unwrap();
    assert!(model.structure().module(module).is_none());
    assert_eq!(model.structure().line_items_in(module).count(), 0);
    assert_eq!(
        error_code(model.read_cells(cost, &[Vec::new()])),
        "structure.not_found"
    );
    let missing = model.apply(Command::DeleteModule { id: module });
    assert_eq!(error_code(missing), "structure.not_found");
}

#[test]
fn apply_batch_rolls_back_on_error() {
    let mut model = model();
    let products = new_list(&mut model, "Products");
    let items = new_items(&mut model, products, &["A"]);
    let module = new_module(&mut model, "Sales", vec![list_axis(products)]);
    let units = new_number(&mut model, module, "Units");
    set_cell(&mut model, units, vec![item(items[0])], num(1.0)).unwrap();
    let before = snapshot(&model);

    let regions = ListId::new();
    let result = model.apply_batch(vec![
        Command::CreateList {
            id: regions,
            name: "Regions".to_string(),
            parent: None,
            top_level_name: None,
            numbered: false,
            production_data: false,
        },
        Command::SetCells {
            line_item: units,
            edits: vec![edit(vec![item(items[0])], num(99.0))],
        },
        Command::CreateList {
            id: ListId::new(),
            name: "regions".to_string(),
            parent: None,
            top_level_name: None,
            numbered: false,
            production_data: false,
        },
    ]);
    assert_eq!(error_code(result), "structure.name_taken");
    assert_eq!(snapshot(&model), before);
    assert!(model.structure().list(regions).is_none());
    assert_eq!(read_one(&model, units, vec![item(items[0])]), num(1.0));

    let changes = model
        .apply_batch(vec![
            Command::CreateList {
                id: regions,
                name: "Regions".to_string(),
                parent: None,
                top_level_name: None,
                numbered: false,
                production_data: false,
            },
            Command::SetCells {
                line_item: units,
                edits: vec![edit(vec![item(items[0])], num(99.0))],
            },
        ])
        .unwrap();
    assert_eq!(changes.generation, before.0 + 1);
    assert_eq!(model.generation(), before.0 + 1);
    assert!(changes.structure_changed);
    assert_eq!(changes.changed_line_items, vec![units]);
    assert!(model.structure().list(regions).is_some());
    assert_eq!(read_one(&model, units, vec![item(items[0])]), num(99.0));

    let empty = model.apply_batch(Vec::new()).unwrap();
    assert_eq!(empty.generation, before.0 + 1);
    assert!(empty.changed_line_items.is_empty());
    assert!(!empty.structure_changed);
}

#[test]
fn failed_commands_leave_the_model_untouched() {
    let mut model = model();
    let regions = new_list(&mut model, "Regions");
    let region_ids = new_items(&mut model, regions, &["East", "West"]);
    let module = new_module(&mut model, "Sales", vec![list_axis(regions)]);
    let units = new_number(&mut model, module, "Units");
    set_cell(&mut model, units, vec![item(region_ids[0])], num(4.0)).unwrap();
    let before = snapshot(&model);

    let failing = vec![
        Command::DeleteList { id: regions },
        Command::CreateList {
            id: ListId::new(),
            name: "REGIONS".to_string(),
            parent: None,
            top_level_name: None,
            numbered: false,
            production_data: false,
        },
        Command::UpsertListItems {
            list: regions,
            items: vec![item_spec("North"), item_spec("east")],
        },
        Command::DeleteListItems {
            list: regions,
            ids: vec![region_ids[0], ItemId::new()],
        },
        Command::UpdateModule {
            id: module,
            name: Some("Other".to_string()),
            axes: Some(vec![list_axis(ListId::new())]),
            functional_area: None,
        },
        Command::CreateLineItem(line_item(ModuleId::new(), "Orphan", Format::number())),
        Command::CreateLineItem(line_item(module, "units", Format::number())),
        Command::SetCells {
            line_item: units,
            edits: vec![
                edit(vec![item(region_ids[1])], num(1.0)),
                edit(Vec::new(), num(2.0)),
            ],
        },
        Command::DeleteModule {
            id: ModuleId::new(),
        },
        Command::UpdateList {
            id: regions,
            name: Some(String::new()),
            top_level_name: None,
            production_data: None,
            selective_access: None,
        },
    ];
    for command in failing {
        let description = format!("{command:?}");
        assert!(model.apply(command).is_err(), "{description}");
        assert_eq!(snapshot(&model), before, "{description}");
        assert_eq!(
            read_one(&model, units, vec![item(region_ids[0])]),
            num(4.0),
            "{description}"
        );
    }
}

#[test]
fn properties_module_autocreated() {
    let mut model = model();
    let employees = new_list(&mut model, "Employees");
    let people = new_items(&mut model, employees, &["Ann", "Bob"]);
    let properties = ModuleId::for_list_properties(employees);
    assert!(model.structure().properties_module(employees).is_none());

    let mut salary = line_item(properties, "Salary", Format::number());
    salary.summary = SummaryMethod::Average;
    let salary_id = salary.id;
    let changes = model.apply(Command::CreateLineItem(salary)).unwrap();
    assert!(changes.structure_changed);
    assert!(changes.changed_line_items.contains(&salary_id));

    let module = model.structure().properties_module(employees).unwrap();
    assert_eq!(module.id, properties);
    assert_eq!(module.name, "Employees Properties");
    assert_eq!(module.axes, vec![list_axis(employees)]);
    assert_eq!(
        model
            .structure()
            .module_by_name("employees properties")
            .unwrap()
            .id,
        properties
    );

    let manager = add_line_item(
        &mut model,
        properties,
        "Manager",
        Format::List { list: employees },
    );
    assert_eq!(model.structure().modules().count(), 1);
    assert_eq!(model.structure().line_items_in(properties).count(), 2);
    set_cell(&mut model, salary_id, vec![item(people[0])], num(50_000.0)).unwrap();
    set_cell(
        &mut model,
        manager,
        vec![item(people[1])],
        Value::Item(Some(people[0])),
    )
    .unwrap();
    assert_eq!(
        read_one(&model, salary_id, vec![item(people[0])]),
        num(50_000.0)
    );

    let unrelated = model.apply(Command::CreateLineItem(line_item(
        ModuleId::new(),
        "Nowhere",
        Format::number(),
    )));
    assert_eq!(error_code(unrelated), "structure.not_found");

    model
        .apply(Command::UpdateList {
            id: employees,
            name: Some("Staff".to_string()),
            top_level_name: Some(Some("All staff".to_string())),
            production_data: Some(true),
            selective_access: Some(true),
        })
        .unwrap();
    assert_eq!(
        model.structure().module(properties).unwrap().name,
        "Staff Properties"
    );
    let staff = model.structure().list(employees).unwrap();
    assert_eq!(staff.name, "Staff");
    assert_eq!(staff.top_level_name.as_deref(), Some("All staff"));
    assert!(staff.production_data && staff.selective_access);

    let rename_module = model.apply(Command::UpdateModule {
        id: properties,
        name: Some("Renamed".to_string()),
        axes: None,
        functional_area: None,
    });
    assert_eq!(error_code(rename_module), "structure.invalid");
    let reshape_module = model.apply(Command::UpdateModule {
        id: properties,
        name: None,
        axes: Some(vec![month_axis()]),
        functional_area: None,
    });
    assert_eq!(error_code(reshape_module), "structure.invalid");

    let blocker = new_module(&mut model, "Staff costs", vec![list_axis(employees)]);
    let blocked = model
        .apply(Command::DeleteList { id: employees })
        .unwrap_err();
    assert_eq!(blocked.code(), "structure.in_use");
    assert!(blocked.to_string().contains("Staff costs"), "{blocked}");
    assert!(!blocked.to_string().contains("Properties"), "{blocked}");
    model.apply(Command::DeleteModule { id: blocker }).unwrap();

    let changes = model.apply(Command::DeleteList { id: employees }).unwrap();
    assert!(changes.changed_line_items.contains(&salary_id));
    assert!(model.structure().properties_module(employees).is_none());
    assert_eq!(model.structure().modules().count(), 0);
    assert_eq!(model.structure().line_items().count(), 0);
    assert_eq!(
        error_code(model.read_cells(salary_id, &[vec![item(people[0])]])),
        "structure.not_found"
    );
}

#[test]
fn properties_module_name_must_be_free() {
    let mut model = model();
    let employees = new_list(&mut model, "Employees");
    new_module(&mut model, "employees properties", Vec::new());
    let result = model.apply(Command::CreateLineItem(line_item(
        ModuleId::for_list_properties(employees),
        "Salary",
        Format::number(),
    )));
    assert_eq!(error_code(result), "structure.name_taken");
    assert!(model.structure().properties_module(employees).is_none());
}

#[test]
fn commands_roundtrip_through_json() {
    let list = ListId::new();
    let update = Command::UpdateList {
        id: list,
        name: None,
        top_level_name: Some(None),
        production_data: Some(true),
        selective_access: None,
    };
    let json = serde_json::to_value(&update).unwrap();
    assert_eq!(
        json,
        json!({
            "type": "update_list",
            "id": list.0.to_string(),
            "top_level_name": null,
            "production_data": true,
        })
    );
    let back: Command = serde_json::from_value(json.clone()).unwrap();
    assert_eq!(serde_json::to_value(&back).unwrap(), json);
    match back {
        Command::UpdateList {
            name,
            top_level_name,
            ..
        } => {
            assert_eq!(name, None);
            assert_eq!(top_level_name, Some(None));
        }
        other => panic!("unexpected {other:?}"),
    }

    let renamed: Command = serde_json::from_value(json!({
        "type": "update_list",
        "id": list.0.to_string(),
        "top_level_name": "Everything",
    }))
    .unwrap();
    match renamed {
        Command::UpdateList { top_level_name, .. } => {
            assert_eq!(top_level_name, Some(Some("Everything".to_string())));
        }
        other => panic!("unexpected {other:?}"),
    }

    let module = ModuleId::new();
    let mut li = line_item(module, "Revenue", Format::number());
    li.summary = SummaryMethod::Ratio {
        numerator: LineItemId::new(),
        denominator: LineItemId::new(),
    };
    li.time_scale = TimeScale::Level(TimeLevel::HalfYear);
    li.versions = VersionsScope::Only(vec![VersionId::new()]);
    li.applies_to = Some(vec![list_axis(list), month_axis(), AxisSpec::Versions]);
    let create = Command::CreateLineItem(li);
    let json = serde_json::to_value(&create).unwrap();
    assert_eq!(json["type"], "create_line_item");
    assert_eq!(json["summary"]["method"], "ratio");
    assert_eq!(json["time_scale"], json!({"level": "half_year"}));
    assert_eq!(json["applies_to"][0]["kind"], "list");
    assert_eq!(json["applies_to"][2], json!({"kind": "versions"}));
    let back: Command = serde_json::from_value(json.clone()).unwrap();
    assert_eq!(serde_json::to_value(&back).unwrap(), json);

    let patch = Command::UpdateLineItem {
        id: LineItemId::new(),
        patch: LineItemPatch {
            formula: Some(None),
            applies_to: Some(None),
            ..LineItemPatch::default()
        },
    };
    let json = serde_json::to_value(&patch).unwrap();
    assert_eq!(json["patch"], json!({"formula": null, "applies_to": null}));
    let back: Command = serde_json::from_value(json).unwrap();
    match back {
        Command::UpdateLineItem { patch, .. } => {
            assert_eq!(patch.formula, Some(None));
            assert_eq!(patch.applies_to, Some(None));
            assert_eq!(patch.name, None);
        }
        other => panic!("unexpected {other:?}"),
    }

    let item_id = ItemId::new();
    let cells: Command = serde_json::from_value(json!({
        "type": "set_cells",
        "line_item": LineItemId::new().0.to_string(),
        "edits": [{
            "coords": [item_id.0.to_string(), "Jan 26"],
            "value": {"t": "number", "v": 5.0},
        }],
    }))
    .unwrap();
    match cells {
        Command::SetCells { edits, .. } => {
            assert_eq!(edits.len(), 1);
            assert!(matches!(edits[0].coords[0], CoordToken::Item(id) if id == item_id));
            assert!(matches!(&edits[0].coords[1], CoordToken::Period(label) if label == "Jan 26"));
            assert_eq!(edits[0].value, Value::Number(5.0));
        }
        other => panic!("unexpected {other:?}"),
    }

    let calendar_command = Command::SetCalendar {
        calendar: calendar(),
    };
    let json = serde_json::to_value(&calendar_command).unwrap();
    assert_eq!(json["type"], "set_calendar");
    assert_eq!(json["calendar"]["years"], 2);
}

#[test]
fn change_set_reports_generation_and_flags() {
    let mut model = model();
    let first = model
        .apply(Command::CreateList {
            id: ListId::new(),
            name: "A".to_string(),
            parent: None,
            top_level_name: None,
            numbered: false,
            production_data: false,
        })
        .unwrap();
    assert_eq!(
        first,
        ChangeSet {
            generation: 1,
            changed_line_items: Vec::new(),
            structure_changed: true,
        }
    );
    let failed = model.apply(Command::DeleteList { id: ListId::new() });
    assert!(failed.is_err());
    assert_eq!(model.generation(), 1);
}

#[test]
fn model_clone_is_independent() {
    let mut model = model();
    let module = new_module(&mut model, "Flat", Vec::new());
    let value = new_number(&mut model, module, "Value");
    set_cell(&mut model, value, Vec::new(), num(1.0)).unwrap();
    let copy = model.clone();
    set_cell(&mut model, value, Vec::new(), num(2.0)).unwrap();
    new_list(&mut model, "Extra");
    assert_eq!(read_one(&copy, value, Vec::new()), num(1.0));
    assert_eq!(read_one(&model, value, Vec::new()), num(2.0));
    assert_eq!(copy.structure().lists().count(), 0);
    assert_eq!(copy.generation(), 3);
}

#[test]
fn time_scale_cannot_be_finer_than_the_module() {
    let mut model = model();
    let module = new_module(
        &mut model,
        "Quarterly",
        vec![AxisSpec::Time {
            level: TimeLevel::Quarter,
            range: None,
        }],
    );
    let with_scale = |scale: TimeScale| {
        let mut li = line_item(module, &format!("LI {scale:?}"), Format::number());
        li.time_scale = scale;
        li
    };
    let too_fine = model.apply(Command::CreateLineItem(with_scale(TimeScale::Level(
        TimeLevel::Month,
    ))));
    assert_eq!(error_code(too_fine), "structure.invalid");
    for scale in [
        TimeScale::Level(TimeLevel::Quarter),
        TimeScale::Level(TimeLevel::Year),
        TimeScale::Level(TimeLevel::All),
        TimeScale::None,
        TimeScale::Module,
    ] {
        model
            .apply(Command::CreateLineItem(with_scale(scale)))
            .unwrap();
    }

    let quarterly = model
        .structure()
        .line_item_by_name(Some(module), "LI Level(Quarter)")
        .unwrap()
        .id;
    let patch_too_fine = model.apply(Command::UpdateLineItem {
        id: quarterly,
        patch: LineItemPatch {
            time_scale: Some(TimeScale::Level(TimeLevel::Month)),
            ..LineItemPatch::default()
        },
    });
    assert_eq!(error_code(patch_too_fine), "structure.invalid");

    let coarser_module = model.apply(Command::UpdateModule {
        id: module,
        name: None,
        axes: Some(vec![AxisSpec::Time {
            level: TimeLevel::Year,
            range: None,
        }]),
        functional_area: None,
    });
    assert_eq!(error_code(coarser_module), "structure.invalid");
    assert_eq!(
        model.structure().module(module).unwrap().axes,
        vec![AxisSpec::Time {
            level: TimeLevel::Quarter,
            range: None
        }]
    );
}

#[test]
fn modules_and_lists_cannot_share_ids() {
    let mut model = model();
    let products = new_list(&mut model, "Products");
    let module = new_module(&mut model, "Sales", Vec::new());

    let module_with_list_id = model.apply(Command::CreateModule {
        id: ModuleId::for_list_properties(products),
        name: "Imposter".to_string(),
        axes: Vec::new(),
        functional_area: String::new(),
    });
    assert_eq!(error_code(module_with_list_id), "structure.invalid");
    let list_with_module_id = model.apply(Command::CreateList {
        id: ListId(module.0),
        name: "Imposter".to_string(),
        parent: None,
        top_level_name: None,
        numbered: false,
        production_data: false,
    });
    assert_eq!(error_code(list_with_module_id), "structure.invalid");
    assert_eq!(model.structure().modules().count(), 1);
    assert_eq!(model.structure().lists().count(), 1);

    let salary = line_item(
        ModuleId::for_list_properties(products),
        "Salary",
        Format::number(),
    );
    assert!(model.apply(Command::CreateLineItem(salary)).is_ok());
}

#[test]
fn line_item_cannot_refer_to_itself() {
    let mut model = model();
    let module = new_module(&mut model, "Sales", Vec::new());
    let other = new_number(&mut model, module, "Other");

    let make = |change: &dyn Fn(&mut LineItem, LineItemId)| {
        let mut li = line_item(module, "Self", Format::number());
        let id = li.id;
        change(&mut li, id);
        li
    };
    let cases: Vec<(&str, LineItem)> = vec![
        (
            "read driver",
            make(&|li, id| li.read_access_driver = Some(id)),
        ),
        (
            "write driver",
            make(&|li, id| li.write_access_driver = Some(id)),
        ),
        (
            "ratio numerator",
            make(&|li, id| {
                li.summary = SummaryMethod::Ratio {
                    numerator: id,
                    denominator: other,
                }
            }),
        ),
        (
            "ratio denominator",
            make(&|li, id| {
                li.summary = SummaryMethod::Ratio {
                    numerator: other,
                    denominator: id,
                }
            }),
        ),
        (
            "time summary ratio",
            make(&|li, id| {
                li.time_summary = Some(SummaryMethod::Ratio {
                    numerator: id,
                    denominator: other,
                })
            }),
        ),
    ];
    for (name, li) in cases {
        let result = model.apply(Command::CreateLineItem(li));
        assert_eq!(error_code(result), "structure.invalid", "{name}");
    }
    assert_eq!(model.structure().line_items_in(module).count(), 1);

    let own_id = other;
    let patched = model.apply(Command::UpdateLineItem {
        id: own_id,
        patch: LineItemPatch {
            read_access_driver: Some(Some(own_id)),
            ..LineItemPatch::default()
        },
    });
    assert_eq!(error_code(patched), "structure.invalid");
    let ratio_patch = model.apply(Command::UpdateLineItem {
        id: own_id,
        patch: LineItemPatch {
            summary: Some(SummaryMethod::Ratio {
                numerator: own_id,
                denominator: own_id,
            }),
            ..LineItemPatch::default()
        },
    });
    assert_eq!(error_code(ratio_patch), "structure.invalid");
}

#[test]
fn blank_item_codes_become_none() {
    let mut model = model();
    let products = new_list(&mut model, "Products");
    let coded = |code: Option<&str>, name: &str| ItemSpec {
        code: code.map(str::to_string),
        ..item_spec(name)
    };
    let first = coded(Some("  "), "A");
    let second = coded(Some(""), "B");
    let third = coded(Some(" X1 "), "C");
    let ids = [first.id, second.id, third.id];
    model
        .apply(Command::UpsertListItems {
            list: products,
            items: vec![first, second, third],
        })
        .unwrap();
    let list = model.structure().list(products).unwrap();
    let codes: Vec<_> = list.items().map(|(_, item)| item.code.as_deref()).collect();
    assert_eq!(codes, [None, None, Some("X1")]);

    model
        .apply(Command::UpsertListItems {
            list: products,
            items: vec![ItemSpec {
                id: ids[2],
                ..coded(Some("   "), "C")
            }],
        })
        .unwrap();
    let list = model.structure().list(products).unwrap();
    assert_eq!(list.item(2).code, None);
    assert_eq!(list.find("X1"), None);
    model
        .apply(Command::UpsertListItems {
            list: products,
            items: vec![coded(Some("X1"), "D")],
        })
        .unwrap();
}

#[test]
fn names_are_found_ignoring_case_and_follow_every_change() {
    let mut model = model();
    let countries = new_list(&mut model, "Countries");
    let sales = new_module(&mut model, "Sales", vec![list_axis(countries)]);
    let costs = new_module(&mut model, "Costs", vec![list_axis(countries)]);
    let units = new_number(&mut model, sales, "Units");
    let cost_units = new_number(&mut model, costs, "units");

    let structure = model.structure();
    assert_eq!(structure.list_by_name(" COUNTRIES ").unwrap().id, countries);
    assert_eq!(structure.module_by_name("sales").unwrap().id, sales);
    assert_eq!(
        structure
            .line_item_by_name(Some(sales), "UNITS")
            .unwrap()
            .id,
        units
    );
    assert_eq!(
        structure
            .line_item_by_name(Some(costs), " Units")
            .unwrap()
            .id,
        cost_units
    );
    assert_eq!(
        structure.line_item_by_name(None, "units").unwrap().id,
        units.min(cost_units),
        "a search of every module finds the first line item in id order"
    );
    assert!(structure.line_item_by_name(Some(sales), "Cost").is_none());

    let same_name = model.apply(Command::UpdateLineItem {
        id: units,
        patch: LineItemPatch {
            name: Some("UNITS".to_string()),
            ..LineItemPatch::default()
        },
    });
    assert!(
        same_name.is_ok(),
        "a line item can change the case of its name"
    );
    let rejected = model.apply(Command::CreateLineItem(line_item(
        sales,
        "UNITS",
        Format::number(),
    )));
    assert!(matches!(rejected, Err(EngineError::NameTaken { .. })));
    assert_eq!(
        model
            .structure()
            .line_item_by_name(Some(sales), "units")
            .unwrap()
            .id,
        units
    );

    model
        .apply(Command::UpdateLineItem {
            id: units,
            patch: LineItemPatch {
                name: Some("Volume".to_string()),
                ..LineItemPatch::default()
            },
        })
        .unwrap();
    model
        .apply(Command::UpdateModule {
            id: sales,
            name: Some("Revenue".to_string()),
            axes: None,
            functional_area: None,
        })
        .unwrap();
    model
        .apply(Command::UpdateList {
            id: countries,
            name: Some("Markets".to_string()),
            top_level_name: None,
            production_data: None,
            selective_access: None,
        })
        .unwrap();
    let structure = model.structure();
    assert!(structure.line_item_by_name(Some(sales), "Units").is_none());
    assert_eq!(
        structure
            .line_item_by_name(Some(sales), "volume")
            .unwrap()
            .id,
        units
    );
    assert_eq!(
        structure.line_item_by_name(None, "units").unwrap().id,
        cost_units
    );
    assert!(structure.module_by_name("Sales").is_none());
    assert_eq!(structure.module_by_name("REVENUE").unwrap().id, sales);
    assert!(structure.list_by_name("Countries").is_none());
    assert_eq!(structure.list_by_name("markets").unwrap().id, countries);

    model
        .apply(Command::DeleteLineItem { id: cost_units })
        .unwrap();
    model.apply(Command::DeleteModule { id: costs }).unwrap();
    let structure = model.structure();
    assert!(structure.line_item_by_name(None, "units").is_none());
    assert!(structure.module_by_name("Costs").is_none());
}
