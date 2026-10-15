//! Reading cells at any level of their dimensions, writing coordinates the way the calendar does,
//! and the limits on the text and the names a model accepts.

use std::sync::Arc;

use openplan_engine::{
    AxisSpec, Calendar, CellEdit, Command, CoordToken, EngineError, Format, ItemId, ItemSpec,
    LineItem, LineItemId, LineItemPatch, ListId, Model, ModuleId, SubsetId, SummaryMethod,
    TimeLevel, TimeRangeId, TimeScale, Value, VersionId, VersionsScope,
};

fn calendar() -> Calendar {
    Calendar {
        fiscal_year_start_month: 1,
        first_year: 2026,
        years: 2,
        current_month: None,
    }
}

fn item(id: ItemId) -> CoordToken {
    CoordToken::Item(id)
}

fn period(label: &str) -> CoordToken {
    CoordToken::Period(label.to_string())
}

fn num(value: f64) -> Value {
    Value::Number(value)
}

fn text(value: &str) -> Value {
    Value::Text(Arc::from(value))
}

/// Regions {North America, Europe} (top level "All Regions") over Countries {US, CA in North
/// America; DE, FR in Europe}.
struct World {
    model: Model,
    regions: ListId,
    countries: ListId,
    na: ItemId,
    eu: ItemId,
    us: ItemId,
    ca: ItemId,
    de: ItemId,
    fr: ItemId,
}

fn spec(id: ItemId, name: &str, parent: Option<ItemId>) -> ItemSpec {
    ItemSpec {
        id,
        code: None,
        name: name.to_string(),
        parent,
    }
}

fn world() -> World {
    let mut model = Model::new(calendar());
    let (regions, countries) = (ListId::new(), ListId::new());
    let [na, eu, us, ca, de, fr] = std::array::from_fn(|_| ItemId::new());
    model
        .apply_batch(vec![
            Command::CreateList {
                id: regions,
                name: "Regions".to_string(),
                parent: None,
                top_level_name: Some("All Regions".to_string()),
                numbered: false,
                production_data: false,
            },
            Command::CreateList {
                id: countries,
                name: "Countries".to_string(),
                parent: Some(regions),
                top_level_name: None,
                numbered: false,
                production_data: false,
            },
            Command::UpsertListItems {
                list: regions,
                items: vec![spec(na, "North America", None), spec(eu, "Europe", None)],
            },
            Command::UpsertListItems {
                list: countries,
                items: vec![
                    spec(us, "US", Some(na)),
                    spec(ca, "CA", Some(na)),
                    spec(de, "DE", Some(eu)),
                    spec(fr, "FR", Some(eu)),
                ],
            },
        ])
        .unwrap();
    World {
        model,
        regions,
        countries,
        na,
        eu,
        us,
        ca,
        de,
        fr,
    }
}

fn month_axis() -> AxisSpec {
    AxisSpec::Time {
        level: TimeLevel::Month,
        range: None,
    }
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

fn input(model: &mut Model, module: ModuleId, name: &str, format: Format) -> LineItemId {
    let line_item = line_item(module, name, format, None);
    let id = line_item.id;
    model.apply(Command::CreateLineItem(line_item)).unwrap();
    id
}

fn number(model: &mut Model, module: ModuleId, name: &str) -> LineItemId {
    input(model, module, name, Format::number())
}

fn calculated(model: &mut Model, module: ModuleId, name: &str, formula: &str) -> LineItemId {
    let line_item = line_item(module, name, Format::number(), Some(formula));
    let id = line_item.id;
    model.apply(Command::CreateLineItem(line_item)).unwrap();
    id
}

fn set(model: &mut Model, line_item: LineItemId, cells: Vec<(Vec<CoordToken>, Value)>) {
    model
        .apply(Command::SetCells {
            line_item,
            edits: cells
                .into_iter()
                .map(|(coords, value)| CellEdit { coords, value })
                .collect(),
        })
        .unwrap();
}

fn read_one(model: &Model, line_item: LineItemId, coords: Vec<CoordToken>) -> Value {
    model
        .read(line_item, &[coords])
        .unwrap()
        .pop()
        .expect("one value for one cell")
}

fn read_error(model: &Model, line_item: LineItemId, cells: &[Vec<CoordToken>]) -> EngineError {
    model.read(line_item, cells).unwrap_err()
}

fn version(model: &Model, name: &str) -> CoordToken {
    CoordToken::Item(ItemId(
        model.structure().version_by_name(name).unwrap().id.0,
    ))
}

/// Units per country: US 1, CA 2, DE 4, FR 8.
fn units_by_country() -> (World, LineItemId) {
    let mut world = world();
    let sales = module(
        &mut world.model,
        "Sales",
        vec![AxisSpec::List {
            list: world.countries,
        }],
    );
    let units = number(&mut world.model, sales, "Units");
    let cells = vec![
        (vec![item(world.us)], num(1.0)),
        (vec![item(world.ca)], num(2.0)),
        (vec![item(world.de)], num(4.0)),
        (vec![item(world.fr)], num(8.0)),
    ];
    set(&mut world.model, units, cells);
    (world, units)
}

/// Amount per month: January 1, February 2, March 4, April 8.
fn amount_by_month() -> (Model, LineItemId) {
    let mut model = Model::new(calendar());
    let monthly = module(&mut model, "Monthly", vec![month_axis()]);
    let amount = number(&mut model, monthly, "Amount");
    let cells = ["Jan 26", "Feb 26", "Mar 26", "Apr 26"]
        .iter()
        .zip([1.0, 2.0, 4.0, 8.0])
        .map(|(label, value)| (vec![period(label)], num(value)))
        .collect();
    set(&mut model, amount, cells);
    (model, amount)
}

#[test]
fn leaf_cells_read_as_they_are_stored() {
    let (world, units) = units_by_country();

    let values = world
        .model
        .read(units, &[vec![item(world.de)], vec![item(world.us)]])
        .unwrap();

    assert_eq!(values, vec![num(4.0), num(1.0)]);
    assert_eq!(
        values,
        world
            .model
            .read_cells(units, &[vec![item(world.de)], vec![item(world.us)]])
            .unwrap()
    );
    assert_eq!(world.model.read(units, &[]).unwrap(), Vec::<Value>::new());
}

#[test]
fn an_item_of_a_list_above_reads_the_total_of_its_children() {
    let (world, units) = units_by_country();

    assert_eq!(
        read_one(&world.model, units, vec![item(world.na)]),
        num(3.0)
    );
    assert_eq!(
        read_one(&world.model, units, vec![item(world.eu)]),
        num(12.0)
    );
}

#[test]
fn top_reads_the_total_of_every_item_whatever_the_case() {
    let (world, units) = units_by_country();

    for token in ["top", "Top", " TOP "] {
        assert_eq!(
            read_one(&world.model, units, vec![period(token)]),
            num(15.0),
            "{token:?}"
        );
    }
}

#[test]
fn one_call_mixes_leaf_and_rolled_up_cells_and_keeps_their_order() {
    let (world, units) = units_by_country();

    let values = world
        .model
        .read(
            units,
            &[
                vec![item(world.eu)],
                vec![item(world.fr)],
                vec![period("top")],
                vec![item(world.na)],
            ],
        )
        .unwrap();

    assert_eq!(values, vec![num(12.0), num(8.0), num(15.0), num(3.0)]);
}

#[test]
fn a_time_label_at_any_level_reads_the_total_of_its_months() {
    let (model, amount) = amount_by_month();

    let read = |label: &str| read_one(&model, amount, vec![period(label)]);

    assert_eq!(read("Feb 26"), num(2.0));
    assert_eq!(read("Q1 FY26"), num(7.0));
    assert_eq!(read("Q2 FY26"), num(8.0));
    assert_eq!(read("H1 FY26"), num(15.0));
    assert_eq!(read("FY26"), num(15.0));
    assert_eq!(read("FY27"), num(0.0));
    assert_eq!(read("Total"), num(15.0));
}

#[test]
fn period_labels_are_read_without_regard_to_case_or_spacing() {
    let (model, amount) = amount_by_month();

    assert_eq!(read_one(&model, amount, vec![period("feb 26")]), num(2.0));
    assert_eq!(read_one(&model, amount, vec![period("q1  fy26")]), num(7.0));
    assert_eq!(read_one(&model, amount, vec![period("TOTAL")]), num(15.0));
}

#[test]
fn each_axis_is_read_at_its_own_level() {
    let mut world = world();
    let grid = module(
        &mut world.model,
        "Grid",
        vec![
            AxisSpec::List {
                list: world.countries,
            },
            month_axis(),
        ],
    );
    let sales = number(&mut world.model, grid, "Sales");
    let mut cells = Vec::new();
    for (country, base) in [
        (world.us, 1.0),
        (world.ca, 2.0),
        (world.de, 4.0),
        (world.fr, 8.0),
    ] {
        for (month, factor) in [("Jan 26", 1.0), ("Feb 26", 10.0), ("Apr 26", 100.0)] {
            cells.push((vec![item(country), period(month)], num(base * factor)));
        }
    }
    set(&mut world.model, sales, cells);

    let read =
        |first: CoordToken, label: &str| read_one(&world.model, sales, vec![first, period(label)]);

    assert_eq!(read(item(world.us), "Jan 26"), num(1.0));
    assert_eq!(read(item(world.na), "Jan 26"), num(3.0));
    assert_eq!(read(item(world.us), "Q1 FY26"), num(11.0));
    assert_eq!(read(item(world.na), "Q1 FY26"), num(33.0));
    assert_eq!(read(item(world.eu), "Q2 FY26"), num(1200.0));
    assert_eq!(read(period("top"), "Jan 26"), num(15.0));
    assert_eq!(read(period("top"), "Total"), num(1665.0));
}

#[test]
fn versions_stay_a_dimension_of_the_cell() {
    let mut model = Model::new(calendar());
    let plan = module(&mut model, "Plan", vec![month_axis(), AxisSpec::Versions]);
    let revenue = number(&mut model, plan, "Revenue");
    let (actual, budget) = (version(&model, "Actual"), version(&model, "Budget"));
    set(
        &mut model,
        revenue,
        vec![
            (vec![period("Jan 26"), actual.clone()], num(5.0)),
            (vec![period("Feb 26"), actual.clone()], num(6.0)),
            (vec![period("Jan 26"), budget.clone()], num(50.0)),
        ],
    );

    assert_eq!(
        read_one(&model, revenue, vec![period("Q1 FY26"), actual]),
        num(11.0)
    );
    assert_eq!(
        read_one(&model, revenue, vec![period("Q1 FY26"), budget]),
        num(50.0)
    );
}

#[test]
fn a_subset_axis_reads_its_members_and_the_lists_above_them() {
    let (mut world, _) = units_by_country();
    let europe = SubsetId::new();
    world
        .model
        .apply(Command::CreateSubset {
            id: europe,
            list: world.countries,
            name: "Europe only".to_string(),
            items: vec![world.de, world.fr],
        })
        .unwrap();
    let focus = module(
        &mut world.model,
        "Focus",
        vec![AxisSpec::Subset { subset: europe }],
    );
    let units = number(&mut world.model, focus, "Units");
    set(
        &mut world.model,
        units,
        vec![
            (vec![item(world.de)], num(4.0)),
            (vec![item(world.fr)], num(8.0)),
        ],
    );

    assert_eq!(
        read_one(&world.model, units, vec![item(world.fr)]),
        num(8.0)
    );
    assert_eq!(
        read_one(&world.model, units, vec![item(world.eu)]),
        num(12.0)
    );
    assert_eq!(
        read_one(&world.model, units, vec![item(world.na)]),
        num(0.0)
    );
    assert_eq!(
        read_one(&world.model, units, vec![period("top")]),
        num(12.0)
    );
}

#[test]
fn calculated_line_items_roll_up_with_their_summary_method() {
    let (mut world, units) = units_by_country();
    let sales = world.model.structure().line_item(units).unwrap().module;
    let double = calculated(&mut world.model, sales, "Double", "Units * 2");

    assert_eq!(
        read_one(&world.model, double, vec![item(world.de)]),
        num(8.0)
    );
    assert_eq!(
        read_one(&world.model, double, vec![item(world.eu)]),
        num(24.0)
    );
    assert_eq!(
        read_one(&world.model, double, vec![period("top")]),
        num(30.0)
    );
}

#[test]
fn a_line_item_without_axes_reads_with_no_coordinates() {
    let mut model = Model::new(calendar());
    let settings = module(&mut model, "Settings", Vec::new());
    let rate = number(&mut model, settings, "Rate");
    set(&mut model, rate, vec![(Vec::new(), num(0.25))]);

    assert_eq!(read_one(&model, rate, Vec::new()), num(0.25));
}

#[test]
fn tokens_that_fit_no_level_of_their_axis_are_invalid_coordinates() {
    let (world, units) = units_by_country();
    let (model, amount) = amount_by_month();
    let stranger = ItemId::new();

    let unknown_item = read_error(
        &world.model,
        units,
        &[vec![item(world.us)], vec![item(stranger)]],
    );
    assert_eq!(unknown_item.code(), "cells.invalid_coordinate");
    assert!(
        unknown_item.to_string().starts_with("Cell 1: "),
        "{unknown_item}"
    );

    let too_many = read_error(
        &world.model,
        units,
        &[vec![item(world.us), period("Jan 26")]],
    );
    assert_eq!(too_many.code(), "cells.invalid_coordinate");
    assert_eq!(
        too_many.to_string(),
        "Cell 0: Expected 1 coordinates but got 2."
    );

    let too_few = read_error(&world.model, units, &[Vec::new()]);
    assert_eq!(too_few.code(), "cells.invalid_coordinate");

    let label = read_error(&world.model, units, &[vec![period("Jan 26")]]);
    assert_eq!(label.code(), "cells.invalid_coordinate");

    let top_of_time = read_error(&model, amount, &[vec![period("top")]]);
    assert_eq!(top_of_time.code(), "cells.invalid_coordinate");

    let outside_the_calendar = read_error(&model, amount, &[vec![period("Jan 40")]]);
    assert_eq!(outside_the_calendar.code(), "cells.invalid_coordinate");

    let item_for_time = read_error(&model, amount, &[vec![item(stranger)]]);
    assert_eq!(item_for_time.code(), "cells.invalid_coordinate");
}

#[test]
fn a_list_below_the_axis_is_not_one_of_its_levels() {
    let mut world = world();
    let by_region = module(
        &mut world.model,
        "By region",
        vec![AxisSpec::List {
            list: world.regions,
        }],
    );
    let budget = number(&mut world.model, by_region, "Budget");

    let error = read_error(&world.model, budget, &[vec![item(world.us)]]);

    assert_eq!(error.code(), "cells.invalid_coordinate");
    assert_eq!(
        read_one(&world.model, budget, vec![item(world.na)]),
        num(0.0),
        "an item of the axis's own list is a leaf"
    );
}

#[test]
fn a_period_finer_than_the_axis_is_invalid() {
    let mut model = Model::new(calendar());
    let quarterly = module(
        &mut model,
        "Quarterly",
        vec![AxisSpec::Time {
            level: TimeLevel::Quarter,
            range: None,
        }],
    );
    let spend = number(&mut model, quarterly, "Spend");
    set(&mut model, spend, vec![(vec![period("Q1 FY26")], num(7.0))]);

    assert_eq!(read_one(&model, spend, vec![period("FY26")]), num(7.0));
    let error = read_error(&model, spend, &[vec![period("Jan 26")]]);
    assert_eq!(error.code(), "cells.invalid_coordinate");
}

#[test]
fn a_line_item_that_does_not_exist_is_not_found() {
    let (world, _) = units_by_country();

    let error = world.model.read(LineItemId::new(), &[]).unwrap_err();

    assert_eq!(error.code(), "structure.not_found");
}

fn switchover_model() -> (Model, LineItemId, LineItemId, VersionId) {
    let mut model = Model::new(calendar());
    let plan = module(&mut model, "Plan", vec![month_axis(), AxisSpec::Versions]);
    let revenue = number(&mut model, plan, "Revenue");
    let doubled = calculated(&mut model, plan, "Doubled", "Revenue * 2");
    let budget = model.structure().version_by_name("Budget").unwrap().id;
    model
        .apply(Command::UpsertVersion {
            id: budget,
            name: "Budget".to_string(),
            is_actual: false,
            is_current: true,
            switchover: Some(2),
        })
        .unwrap();
    let (actual, budget_token) = (version(&model, "Actual"), version(&model, "Budget"));
    set(
        &mut model,
        revenue,
        vec![
            (vec![period("Jan 26"), actual.clone()], num(100.0)),
            (vec![period("Feb 26"), actual.clone()], num(50.0)),
            (vec![period("Mar 26"), actual], num(5.0)),
            (vec![period("Mar 26"), budget_token], num(1.0)),
        ],
    );
    (model, revenue, doubled, budget)
}

#[test]
fn leaf_cells_before_a_switchover_show_the_actual_version() {
    let (model, revenue, doubled, _) = switchover_model();
    let (actual, budget) = (version(&model, "Actual"), version(&model, "Budget"));
    let forecast = version(&model, "Forecast");
    let at = |month: &str, version: &CoordToken| vec![period(month), version.clone()];

    // The Budget switches over at March: January and February show the actual version.
    assert_eq!(read_one(&model, revenue, at("Jan 26", &budget)), num(100.0));
    assert_eq!(read_one(&model, revenue, at("Feb 26", &budget)), num(50.0));
    assert_eq!(read_one(&model, revenue, at("Mar 26", &budget)), num(1.0));
    assert_eq!(read_one(&model, doubled, at("Jan 26", &budget)), num(200.0));
    assert_eq!(read_one(&model, doubled, at("Mar 26", &budget)), num(2.0));
    // Other versions show their own cells, and the actual version always does.
    assert_eq!(read_one(&model, revenue, at("Jan 26", &forecast)), num(0.0));
    assert_eq!(read_one(&model, revenue, at("Jan 26", &actual)), num(100.0));

    // The stored cells are untouched.
    assert_eq!(
        model.read_cells(revenue, &[at("Jan 26", &budget)]).unwrap(),
        vec![num(0.0)]
    );
}

#[test]
fn leaf_reads_agree_with_the_totals_of_a_switchover() {
    let (model, revenue, _, _) = switchover_model();
    let budget = version(&model, "Budget");

    let months: f64 = ["Jan 26", "Feb 26", "Mar 26"]
        .iter()
        .map(
            |label| match read_one(&model, revenue, vec![period(label), budget.clone()]) {
                Value::Number(number) => number,
                other => panic!("expected a number, found {other:?}"),
            },
        )
        .sum();

    assert_eq!(
        read_one(&model, revenue, vec![period("Q1 FY26"), budget]),
        num(months)
    );
}

#[test]
fn a_switchover_is_read_in_the_calendar_of_a_time_range() {
    let mut model = Model::new(calendar());
    let range = TimeRangeId::new();
    model
        .apply(Command::CreateTimeRange {
            id: range,
            name: "Second year".to_string(),
            first_year: 2027,
            years: 1,
        })
        .unwrap();
    let plan = module(
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
    let revenue = number(&mut model, plan, "Revenue");
    let budget_id = model.structure().version_by_name("Budget").unwrap().id;
    // Month 13 is February 2027, the second month of the range.
    model
        .apply(Command::UpsertVersion {
            id: budget_id,
            name: "Budget".to_string(),
            is_actual: false,
            is_current: true,
            switchover: Some(13),
        })
        .unwrap();
    let (actual, budget) = (version(&model, "Actual"), version(&model, "Budget"));
    set(
        &mut model,
        revenue,
        vec![
            (vec![period("Jan 27"), actual.clone()], num(9.0)),
            (vec![period("Feb 27"), actual], num(8.0)),
        ],
    );

    assert_eq!(
        read_one(&model, revenue, vec![period("Jan 27"), budget.clone()]),
        num(9.0)
    );
    assert_eq!(
        read_one(&model, revenue, vec![period("Feb 27"), budget]),
        num(0.0)
    );
}

#[test]
fn canonical_coords_write_period_labels_as_the_calendar_does() {
    let (world, _) = units_by_country();
    let mut model = world.model;
    let grid = module(
        &mut model,
        "Grid",
        vec![
            AxisSpec::List {
                list: world.countries,
            },
            month_axis(),
            AxisSpec::Versions,
        ],
    );
    let sales = number(&mut model, grid, "Sales");
    let budget = version(&model, "Budget");

    let canonical = model
        .canonical_coords(
            sales,
            &[
                vec![item(world.us), period("jan 26"), budget.clone()],
                vec![item(world.ca), period("  FEB   26 "), budget.clone()],
                vec![item(world.de), period("Mar 26"), budget.clone()],
            ],
        )
        .unwrap();

    assert_eq!(
        canonical,
        vec![
            vec![item(world.us), period("Jan 26"), budget.clone()],
            vec![item(world.ca), period("Feb 26"), budget.clone()],
            vec![item(world.de), period("Mar 26"), budget],
        ]
    );
}

#[test]
fn canonical_coords_leave_what_the_calendar_does_not_know_for_the_edit_to_reject() {
    let (model, amount) = amount_by_month();

    let kept = model
        .canonical_coords(
            amount,
            &[
                vec![period("q1 fy26")],
                vec![period("nonsense")],
                vec![period("jan 40")],
                vec![item(ItemId::new())],
                vec![period("jan 26"), period("feb 26")],
                Vec::new(),
            ],
        )
        .unwrap();

    assert_eq!(kept[0], vec![period("q1 fy26")]);
    assert_eq!(kept[1], vec![period("nonsense")]);
    assert_eq!(kept[2], vec![period("jan 40")]);
    assert!(matches!(kept[3][0], CoordToken::Item(_)));
    assert_eq!(kept[4], vec![period("Jan 26"), period("feb 26")]);
    assert_eq!(kept[5], Vec::new());
}

#[test]
fn canonical_coords_follow_the_calendar_of_a_time_range() {
    let mut model = Model::new(Calendar {
        fiscal_year_start_month: 4,
        first_year: 2026,
        years: 2,
        current_month: None,
    });
    let range = TimeRangeId::new();
    model
        .apply(Command::CreateTimeRange {
            id: range,
            name: "Second year".to_string(),
            first_year: 2027,
            years: 1,
        })
        .unwrap();
    let plan = module(
        &mut model,
        "Plan",
        vec![AxisSpec::Time {
            level: TimeLevel::Month,
            range: Some(range),
        }],
    );
    let revenue = number(&mut model, plan, "Revenue");

    let canonical = model
        .canonical_coords(revenue, &[vec![period("apr 26")]])
        .unwrap();

    assert_eq!(canonical, vec![vec![period("Apr 26")]]);
}

#[test]
fn canonical_coords_of_a_line_item_that_does_not_exist_is_not_found() {
    let (model, _) = amount_by_month();

    let error = model
        .canonical_coords(LineItemId::new(), &[Vec::new()])
        .unwrap_err();

    assert_eq!(error.code(), "structure.not_found");
}

fn text_line_item() -> (Model, LineItemId) {
    let mut model = Model::new(calendar());
    let notes = module(&mut model, "Notes", Vec::new());
    let comment = input(&mut model, notes, "Comment", Format::Text);
    (model, comment)
}

fn set_text(model: &mut Model, line_item: LineItemId, value: &str) -> Result<(), EngineError> {
    model
        .apply(Command::SetCells {
            line_item,
            edits: vec![CellEdit {
                coords: Vec::new(),
                value: text(value),
            }],
        })
        .map(drop)
}

fn issues(error: EngineError) -> Vec<(usize, String)> {
    match error {
        EngineError::InvalidValue { cells } => cells
            .into_iter()
            .map(|cell| (cell.index, cell.message))
            .collect(),
        other => panic!("expected InvalidValue, got {other:?}"),
    }
}

#[test]
fn text_cells_hold_at_most_10000_characters() {
    let (mut model, comment) = text_line_item();

    set_text(&mut model, comment, &"x".repeat(10_000)).unwrap();
    assert_eq!(
        read_one(&model, comment, Vec::new()),
        text(&"x".repeat(10_000))
    );

    let before = model.generation();
    let error = set_text(&mut model, comment, &"x".repeat(10_001)).unwrap_err();
    assert_eq!(error.code(), "cells.invalid_value");
    assert_eq!(
        issues(error),
        vec![(0, "Text is limited to 10,000 characters.".to_string())]
    );
    assert_eq!(model.generation(), before);
    assert_eq!(
        read_one(&model, comment, Vec::new()),
        text(&"x".repeat(10_000))
    );
}

#[test]
fn the_text_limit_counts_characters_and_not_bytes() {
    let (mut model, comment) = text_line_item();

    set_text(&mut model, comment, &"é".repeat(10_000)).unwrap();
    let error = set_text(&mut model, comment, &"é".repeat(10_001)).unwrap_err();

    assert_eq!(error.code(), "cells.invalid_value");
}

#[test]
fn text_cells_cannot_contain_nul() {
    let (mut model, comment) = text_line_item();

    let error = set_text(&mut model, comment, "before\0after").unwrap_err();

    assert_eq!(error.code(), "cells.invalid_value");
    assert_eq!(
        issues(error),
        vec![(0, "Text can't contain the NUL character.".to_string())]
    );
    assert_eq!(read_one(&model, comment, Vec::new()), text(""));
}

#[test]
fn a_batch_with_bad_text_changes_nothing_and_names_every_bad_cell() {
    let mut model = Model::new(calendar());
    let monthly = module(&mut model, "Notes by month", vec![month_axis()]);
    let comment = input(&mut model, monthly, "Comment", Format::Text);
    let edit = |label: &str, value: String| CellEdit {
        coords: vec![period(label)],
        value: Value::Text(Arc::from(value)),
    };

    let error = model
        .apply(Command::SetCells {
            line_item: comment,
            edits: vec![
                edit("Jan 26", "fine".to_string()),
                edit("Feb 26", "x".repeat(10_001)),
                edit("Mar 26", "a\0b".to_string()),
            ],
        })
        .unwrap_err();

    assert_eq!(
        issues(error),
        vec![
            (1, "Text is limited to 10,000 characters.".to_string()),
            (2, "Text can't contain the NUL character.".to_string()),
        ]
    );
    assert_eq!(read_one(&model, comment, vec![period("Jan 26")]), text(""));
}

#[test]
fn the_text_limits_do_not_hide_a_type_mismatch() {
    let mut model = Model::new(calendar());
    let settings = module(&mut model, "Settings", Vec::new());
    let rate = number(&mut model, settings, "Rate");

    let error = model
        .apply(Command::SetCells {
            line_item: rate,
            edits: vec![CellEdit {
                coords: Vec::new(),
                value: text(&"x".repeat(10_001)),
            }],
        })
        .unwrap_err();

    assert_eq!(issues(error), vec![(0, "Expected a number.".to_string())]);
}

fn rejected(model: &mut Model, command: Command) {
    let before = model.generation();
    let error = model.apply(command).unwrap_err();
    assert_eq!(error.code(), "structure.invalid", "{error}");
    assert!(error.to_string().contains("NUL"), "{error}");
    assert_eq!(model.generation(), before);
}

#[test]
fn names_cannot_contain_nul() {
    let (mut world, _) = units_by_country();
    let sales = world.model.structure().module_by_name("Sales").unwrap().id;
    let units = world
        .model
        .structure()
        .line_item_by_name(Some(sales), "Units")
        .unwrap()
        .id;
    let bad = "Bad\0name";
    let model = &mut world.model;

    rejected(
        model,
        Command::CreateList {
            id: ListId::new(),
            name: bad.to_string(),
            parent: None,
            top_level_name: None,
            numbered: false,
            production_data: false,
        },
    );
    rejected(
        model,
        Command::CreateList {
            id: ListId::new(),
            name: "Fine".to_string(),
            parent: None,
            top_level_name: Some(bad.to_string()),
            numbered: false,
            production_data: false,
        },
    );
    rejected(
        model,
        Command::UpdateList {
            id: world.regions,
            name: Some(bad.to_string()),
            top_level_name: None,
            production_data: None,
            selective_access: None,
        },
    );
    rejected(
        model,
        Command::UpsertListItems {
            list: world.countries,
            items: vec![spec(ItemId::new(), bad, Some(world.na))],
        },
    );
    rejected(
        model,
        Command::UpsertListItems {
            list: world.countries,
            items: vec![spec(world.us, bad, Some(world.na))],
        },
    );
    rejected(
        model,
        Command::CreateSubset {
            id: SubsetId::new(),
            list: world.countries,
            name: bad.to_string(),
            items: vec![world.us],
        },
    );
    rejected(
        model,
        Command::UpsertVersion {
            id: VersionId::new(),
            name: bad.to_string(),
            is_actual: false,
            is_current: false,
            switchover: None,
        },
    );
    rejected(
        model,
        Command::CreateTimeRange {
            id: TimeRangeId::new(),
            name: bad.to_string(),
            first_year: 2026,
            years: 1,
        },
    );
    rejected(
        model,
        Command::CreateModule {
            id: ModuleId::new(),
            name: bad.to_string(),
            axes: Vec::new(),
            functional_area: String::new(),
        },
    );
    rejected(
        model,
        Command::CreateModule {
            id: ModuleId::new(),
            name: "Fine".to_string(),
            axes: Vec::new(),
            functional_area: bad.to_string(),
        },
    );
    rejected(
        model,
        Command::CreateLineItem(line_item(sales, bad, Format::number(), None)),
    );
    rejected(
        model,
        Command::UpdateLineItem {
            id: units,
            patch: LineItemPatch {
                name: Some(bad.to_string()),
                ..Default::default()
            },
        },
    );
}

#[test]
fn check_cells_accepts_what_apply_accepts_and_changes_nothing() {
    let (mut world, units) = units_by_country();
    let before = world.model.generation();
    let edits = vec![
        CellEdit {
            coords: vec![item(world.us)],
            value: num(5.0),
        },
        CellEdit {
            coords: vec![item(world.fr)],
            value: num(9.0),
        },
    ];

    world.model.check_cells(units, &edits).unwrap();

    assert_eq!(world.model.generation(), before);
    assert_eq!(
        read_one(&world.model, units, vec![item(world.us)]),
        num(1.0)
    );
    world
        .model
        .apply(Command::SetCells {
            line_item: units,
            edits,
        })
        .unwrap();
    assert_eq!(
        read_one(&world.model, units, vec![item(world.us)]),
        num(5.0)
    );
}

#[test]
fn check_cells_numbers_the_edits_the_way_apply_does() {
    let (world, units) = units_by_country();
    let edit = |country: ItemId, value: Value| CellEdit {
        coords: vec![item(country)],
        value,
    };
    let edits = vec![
        edit(world.us, num(1.0)),
        edit(world.ca, text("many")),
        edit(world.de, num(3.0)),
        edit(world.fr, Value::Boolean(true)),
    ];

    let checked = world.model.check_cells(units, &edits).unwrap_err();
    let applied = world
        .model
        .clone()
        .apply(Command::SetCells {
            line_item: units,
            edits,
        })
        .unwrap_err();

    assert_eq!(checked.code(), "cells.invalid_value");
    assert_eq!(
        issues(checked),
        vec![
            (1, "Expected a number.".to_string()),
            (3, "Expected a number.".to_string()),
        ]
    );
    assert_eq!(applied.code(), "cells.invalid_value");
}

#[test]
fn check_cells_reports_bad_coordinates_calculated_and_missing_line_items() {
    let (mut world, units) = units_by_country();
    let sales = world.model.structure().line_item(units).unwrap().module;
    let double = calculated(&mut world.model, sales, "Double", "Units * 2");
    let edit = |coords: Vec<CoordToken>| CellEdit {
        coords,
        value: num(1.0),
    };

    let coordinates = world
        .model
        .check_cells(
            units,
            &[edit(vec![item(world.us)]), edit(vec![period("top")])],
        )
        .unwrap_err();
    assert_eq!(coordinates.code(), "cells.invalid_coordinate");
    assert!(
        matches!(
            coordinates,
            EngineError::InvalidCoordinate { index: Some(1), .. }
        ),
        "{coordinates:?}"
    );
    assert!(
        coordinates.to_string().starts_with("Edit 1: "),
        "{coordinates}"
    );
    let not_input = world
        .model
        .check_cells(double, &[edit(vec![item(world.us)])])
        .unwrap_err();
    assert_eq!(not_input.code(), "cells.not_input");
    let missing = world.model.check_cells(LineItemId::new(), &[]).unwrap_err();
    assert_eq!(missing.code(), "structure.not_found");
}
