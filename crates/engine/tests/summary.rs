use std::sync::Arc;

use openplan_engine::{
    Axis, AxisSpec, Calendar, CellEdit, Column, Command, CoordToken, EngineError, Format, ItemId,
    ItemSpec, LevelSpec, LineItem, LineItemId, LineItemPatch, ListId, Model, ModuleId, Shape,
    SubsetId, SummaryMethod, TimeLevel, TimeRangeId, TimeScale, Value, VersionsScope, aggregate,
};

fn calendar() -> Calendar {
    Calendar {
        fiscal_year_start_month: 1,
        first_year: 2026,
        years: 2,
        current_month: None,
    }
}

fn item_spec(id: ItemId, name: &str, parent: Option<ItemId>) -> ItemSpec {
    ItemSpec {
        id,
        code: None,
        name: name.to_string(),
        parent,
    }
}

/// Regions {North America, Europe} (top level "All Regions") over Countries {US, CA in North
/// America; DE in Europe}.
struct World {
    model: Model,
    regions: ListId,
    countries: ListId,
    na: ItemId,
    eu: ItemId,
    us: ItemId,
    ca: ItemId,
    de: ItemId,
}

fn world() -> World {
    let mut model = Model::new(calendar());
    let regions = ListId::new();
    let countries = ListId::new();
    let [na, eu, us, ca, de] = std::array::from_fn(|_| ItemId::new());
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
                items: vec![
                    item_spec(na, "North America", None),
                    item_spec(eu, "Europe", None),
                ],
            },
            Command::UpsertListItems {
                list: countries,
                items: vec![
                    item_spec(us, "US", Some(na)),
                    item_spec(ca, "CA", Some(na)),
                    item_spec(de, "DE", Some(eu)),
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
    }
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

fn line_item(module: ModuleId, name: &str, format: Format, summary: SummaryMethod) -> LineItem {
    LineItem {
        id: LineItemId::new(),
        module,
        name: name.to_string(),
        ordinal: 0,
        format,
        formula: None,
        summary,
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

fn add(model: &mut Model, line_item: LineItem) -> LineItemId {
    let id = line_item.id;
    model.apply(Command::CreateLineItem(line_item)).unwrap();
    id
}

fn add_number(
    model: &mut Model,
    module: ModuleId,
    name: &str,
    summary: SummaryMethod,
) -> LineItemId {
    add(model, line_item(module, name, Format::number(), summary))
}

fn countries_module(world: &mut World, name: &str) -> ModuleId {
    let axes = vec![AxisSpec::List {
        list: world.countries,
    }];
    new_module(&mut world.model, name, axes)
}

fn month_axis() -> AxisSpec {
    AxisSpec::Time {
        level: TimeLevel::Month,
        range: None,
    }
}

fn time(level: TimeLevel) -> Axis {
    Axis::Time { level, range: None }
}

fn levels(axes: Vec<Axis>) -> LevelSpec {
    LevelSpec(axes)
}

fn item(id: ItemId) -> CoordToken {
    CoordToken::Item(id)
}

fn period(label: &str) -> CoordToken {
    CoordToken::Period(label.to_string())
}

fn top() -> CoordToken {
    period("top")
}

fn month(index: u32) -> CoordToken {
    CoordToken::Period(calendar().label(TimeLevel::Month, index))
}

fn num(value: f64) -> Value {
    Value::Number(value)
}

fn set(model: &mut Model, line_item: LineItemId, coords: Vec<CoordToken>, value: Value) {
    set_many(model, line_item, vec![(coords, value)]);
}

fn set_many(model: &mut Model, line_item: LineItemId, cells: Vec<(Vec<CoordToken>, Value)>) {
    let edits = cells
        .into_iter()
        .map(|(coords, value)| CellEdit { coords, value })
        .collect();
    model.apply(Command::SetCells { line_item, edits }).unwrap();
}

fn set_countries(world: &mut World, line_item: LineItemId, us: f64, ca: f64, de: f64) {
    let cells = vec![
        (vec![item(world.us)], num(us)),
        (vec![item(world.ca)], num(ca)),
        (vec![item(world.de)], num(de)),
    ];
    set_many(&mut world.model, line_item, cells);
}

fn read(
    model: &Model,
    line_item: LineItemId,
    coords: Vec<CoordToken>,
    levels: &LevelSpec,
) -> Value {
    model.read_summary(line_item, &coords, levels).unwrap()
}

fn read_error(
    model: &Model,
    line_item: LineItemId,
    coords: Vec<CoordToken>,
    levels: &LevelSpec,
) -> EngineError {
    model.read_summary(line_item, &coords, levels).unwrap_err()
}

#[test]
fn sum_to_parent_and_top() {
    let mut world = world();
    let module = countries_module(&mut world, "Sales");
    let units = add_number(&mut world.model, module, "Units", SummaryMethod::Sum);
    set_countries(&mut world, units, 1.0, 2.0, 4.0);

    let by_region = levels(vec![Axis::List(world.regions)]);
    assert_eq!(
        read(&world.model, units, vec![item(world.na)], &by_region),
        num(3.0)
    );
    assert_eq!(
        read(&world.model, units, vec![item(world.eu)], &by_region),
        num(4.0)
    );
    let region_top = levels(vec![Axis::ListTop(world.regions)]);
    assert_eq!(
        read(&world.model, units, vec![top()], &region_top),
        num(7.0)
    );
    let country_top = levels(vec![Axis::ListTop(world.countries)]);
    assert_eq!(
        read(&world.model, units, vec![top()], &country_top),
        num(7.0)
    );
    let leaves = levels(vec![Axis::List(world.countries)]);
    assert_eq!(
        read(&world.model, units, vec![item(world.us)], &leaves),
        num(1.0)
    );
}

#[test]
fn average_of_leaves_not_averages() {
    let mut world = world();
    let module = countries_module(&mut world, "Prices");
    let price = add_number(&mut world.model, module, "Price", SummaryMethod::Average);
    set_countries(&mut world, price, 1.0, 2.0, 6.0);

    let by_region = levels(vec![Axis::List(world.regions)]);
    assert_eq!(
        read(&world.model, price, vec![item(world.na)], &by_region),
        num(1.5)
    );
    assert_eq!(
        read(&world.model, price, vec![item(world.eu)], &by_region),
        num(6.0)
    );
    let region_top = levels(vec![Axis::ListTop(world.regions)]);
    assert_eq!(
        read(&world.model, price, vec![top()], &region_top),
        num(3.0)
    );
}

#[test]
fn time_quarter_year_total() {
    let mut model = Model::new(calendar());
    let module = new_module(&mut model, "Cash", vec![month_axis()]);
    let flow = add_number(&mut model, module, "Flow", SummaryMethod::Sum);
    let cells = (0..24)
        .map(|index| (vec![month(index)], num(f64::from(index + 1))))
        .collect();
    set_many(&mut model, flow, cells);

    let read_at = |level, label: &str| {
        read(
            &model,
            flow,
            vec![period(label)],
            &levels(vec![time(level)]),
        )
    };
    assert_eq!(read_at(TimeLevel::Quarter, "Q1 FY26"), num(6.0));
    assert_eq!(read_at(TimeLevel::Quarter, "Q1 FY27"), num(42.0));
    assert_eq!(read_at(TimeLevel::HalfYear, "H1 FY26"), num(21.0));
    assert_eq!(read_at(TimeLevel::Year, "FY26"), num(78.0));
    assert_eq!(read_at(TimeLevel::Year, "FY27"), num(222.0));
    assert_eq!(read_at(TimeLevel::All, "Total"), num(300.0));
    assert_eq!(read_at(TimeLevel::Month, "Mar 26"), num(3.0));
}

#[test]
fn closing_and_opening_along_time() {
    let mut model = Model::new(calendar());
    let module = new_module(&mut model, "Balance", vec![month_axis()]);
    let closing = add_number(&mut model, module, "Closing", SummaryMethod::Closing);
    let opening = add_number(&mut model, module, "Opening", SummaryMethod::Opening);
    let first = add_number(&mut model, module, "First", SummaryMethod::First);
    let last = add_number(&mut model, module, "Last", SummaryMethod::Last);
    for line_item in [closing, opening, first, last] {
        let cells = (0..24)
            .map(|index| (vec![month(index)], num(f64::from(index + 1) * 10.0)))
            .collect();
        set_many(&mut model, line_item, cells);
    }

    let quarter = levels(vec![time(TimeLevel::Quarter)]);
    let year = levels(vec![time(TimeLevel::Year)]);
    let all = levels(vec![time(TimeLevel::All)]);
    let q1 = || vec![period("Q1 FY26")];
    assert_eq!(read(&model, closing, q1(), &quarter), num(30.0));
    assert_eq!(read(&model, opening, q1(), &quarter), num(10.0));
    assert_eq!(read(&model, last, q1(), &quarter), num(30.0));
    assert_eq!(read(&model, first, q1(), &quarter), num(10.0));
    assert_eq!(
        read(&model, closing, vec![period("FY26")], &year),
        num(120.0)
    );
    assert_eq!(
        read(&model, opening, vec![period("FY27")], &year),
        num(130.0)
    );
    assert_eq!(
        read(&model, closing, vec![period("Total")], &all),
        num(240.0)
    );
    assert_eq!(
        read(&model, opening, vec![period("Total")], &all),
        num(10.0)
    );
}

#[test]
fn positional_methods_sum_over_lists() {
    let mut world = world();
    let axes = vec![
        AxisSpec::List {
            list: world.countries,
        },
        month_axis(),
    ];
    let module = new_module(&mut world.model, "Headcount", axes);
    let closing = add_number(&mut world.model, module, "Closing", SummaryMethod::Closing);
    let mut with_time = line_item(
        module,
        "Sum then close",
        Format::number(),
        SummaryMethod::Sum,
    );
    with_time.time_summary = Some(SummaryMethod::Closing);
    let with_time = add(&mut world.model, with_time);
    for line_item in [closing, with_time] {
        let mut cells = Vec::new();
        for (country, base) in [(world.us, 1.0), (world.ca, 10.0), (world.de, 100.0)] {
            for index in 0..24 {
                cells.push((
                    vec![item(country), month(index)],
                    num(base * f64::from(index + 1)),
                ));
            }
        }
        set_many(&mut world.model, line_item, cells);
    }

    let target = levels(vec![Axis::List(world.regions), time(TimeLevel::Quarter)]);
    for line_item in [closing, with_time] {
        let na_q1 = vec![item(world.na), period("Q1 FY26")];
        assert_eq!(read(&world.model, line_item, na_q1, &target), num(33.0));
        let eu_q2 = vec![item(world.eu), period("Q2 FY26")];
        assert_eq!(read(&world.model, line_item, eu_q2, &target), num(600.0));
    }
    let region_top_months = levels(vec![Axis::ListTop(world.regions), time(TimeLevel::Month)]);
    let mar = vec![top(), period("Mar 26")];
    assert_eq!(
        read(&world.model, closing, mar, &region_top_months),
        num(333.0)
    );
}

#[test]
fn ratio_summary() {
    let mut world = world();
    let module = countries_module(&mut world, "Profitability");
    let revenue = add_number(&mut world.model, module, "Revenue", SummaryMethod::Sum);
    let profit = add_number(&mut world.model, module, "Profit", SummaryMethod::Sum);
    let margin = add_number(
        &mut world.model,
        module,
        "Margin",
        SummaryMethod::Ratio {
            numerator: profit,
            denominator: revenue,
        },
    );
    set_countries(&mut world, revenue, 100.0, 300.0, 200.0);
    set_countries(&mut world, profit, 20.0, 30.0, 100.0);
    set_countries(&mut world, margin, 0.2, 0.1, 0.5);

    let by_region = levels(vec![Axis::List(world.regions)]);
    assert_eq!(
        read(&world.model, margin, vec![item(world.na)], &by_region),
        num(0.125)
    );
    assert_eq!(
        read(&world.model, margin, vec![item(world.eu)], &by_region),
        num(0.5)
    );
    let region_top = levels(vec![Axis::ListTop(world.regions)]);
    assert_eq!(
        read(&world.model, margin, vec![top()], &region_top),
        num(0.25)
    );

    set_countries(&mut world, revenue, 0.0, 0.0, 200.0);
    assert_eq!(
        read(&world.model, margin, vec![item(world.na)], &by_region),
        num(0.0)
    );
}

#[test]
fn min_max() {
    let mut world = world();
    let module = countries_module(&mut world, "Extremes");
    let low = add_number(&mut world.model, module, "Low", SummaryMethod::Min);
    let high = add_number(&mut world.model, module, "High", SummaryMethod::Max);
    for line_item in [low, high] {
        set_countries(&mut world, line_item, 5.0, -2.0, 7.0);
    }

    let by_region = levels(vec![Axis::List(world.regions)]);
    let region_top = levels(vec![Axis::ListTop(world.regions)]);
    let north_america = world.na;
    let na = || vec![item(north_america)];
    assert_eq!(read(&world.model, low, na(), &by_region), num(-2.0));
    assert_eq!(read(&world.model, high, na(), &by_region), num(5.0));
    assert_eq!(read(&world.model, low, vec![top()], &region_top), num(-2.0));
    assert_eq!(read(&world.model, high, vec![top()], &region_top), num(7.0));

    let all_negative = add_number(&mut world.model, module, "Negative", SummaryMethod::Max);
    set_countries(&mut world, all_negative, -5.0, -2.0, -7.0);
    assert_eq!(
        read(&world.model, all_negative, na(), &by_region),
        num(-2.0)
    );
}

#[test]
fn unfilled_cells_count_as_zero() {
    let mut world = world();
    let module = countries_module(&mut world, "Sparse");
    let low = add_number(&mut world.model, module, "Low", SummaryMethod::Min);
    let mean = add_number(&mut world.model, module, "Mean", SummaryMethod::Average);
    for line_item in [low, mean] {
        set(&mut world.model, line_item, vec![item(world.us)], num(4.0));
    }

    let by_region = levels(vec![Axis::List(world.regions)]);
    assert_eq!(
        read(&world.model, low, vec![item(world.na)], &by_region),
        num(0.0)
    );
    assert_eq!(
        read(&world.model, mean, vec![item(world.na)], &by_region),
        num(2.0)
    );
}

#[test]
fn none_is_blank() {
    let mut world = world();
    let axes = vec![
        AxisSpec::List {
            list: world.countries,
        },
        month_axis(),
    ];
    let module = new_module(&mut world.model, "Flags", axes);
    let hidden = add_number(&mut world.model, module, "Hidden", SummaryMethod::None);
    let mut no_time = line_item(module, "No time", Format::number(), SummaryMethod::Sum);
    no_time.time_summary = Some(SummaryMethod::None);
    let no_time = add(&mut world.model, no_time);
    for line_item in [hidden, no_time] {
        let mut cells = Vec::new();
        for country in [world.us, world.ca, world.de] {
            cells.push((vec![item(country), month(0)], num(5.0)));
            cells.push((vec![item(country), month(1)], num(7.0)));
        }
        set_many(&mut world.model, line_item, cells);
    }

    let by_region = levels(vec![Axis::List(world.regions), time(TimeLevel::Month)]);
    let na_jan = || vec![item(world.na), month(0)];
    assert_eq!(read(&world.model, hidden, na_jan(), &by_region), num(0.0));
    assert_eq!(read(&world.model, no_time, na_jan(), &by_region), num(10.0));

    let by_quarter = levels(vec![Axis::List(world.countries), time(TimeLevel::Quarter)]);
    let us_q1 = || vec![item(world.us), period("Q1 FY26")];
    assert_eq!(read(&world.model, hidden, us_q1(), &by_quarter), num(0.0));
    assert_eq!(read(&world.model, no_time, us_q1(), &by_quarter), num(0.0));

    let leaves = levels(vec![Axis::List(world.countries), time(TimeLevel::Month)]);
    let us_feb = vec![item(world.us), month(1)];
    assert_eq!(read(&world.model, hidden, us_feb, &leaves), num(7.0));
}

#[test]
fn mixed_levels() {
    let mut world = world();
    let axes = vec![
        AxisSpec::List {
            list: world.countries,
        },
        month_axis(),
    ];
    let module = new_module(&mut world.model, "Sales", axes);
    let units = add_number(&mut world.model, module, "Units", SummaryMethod::Sum);
    let price = add_number(&mut world.model, module, "Price", SummaryMethod::Average);
    for (line_item, bases) in [(units, [1.0, 2.0, 4.0]), (price, [1.0, 2.0, 6.0])] {
        let mut cells = Vec::new();
        for (country, base) in [world.us, world.ca, world.de].into_iter().zip(bases) {
            for index in 0..24 {
                cells.push((vec![item(country), month(index)], num(base)));
            }
        }
        set_many(&mut world.model, line_item, cells);
    }

    let regional_quarters = levels(vec![Axis::List(world.regions), time(TimeLevel::Quarter)]);
    let na_q1 = || vec![item(world.na), period("Q1 FY26")];
    assert_eq!(
        read(&world.model, units, na_q1(), &regional_quarters),
        num(9.0)
    );
    assert_eq!(
        read(&world.model, price, na_q1(), &regional_quarters),
        num(1.5)
    );

    let top_year = levels(vec![Axis::ListTop(world.regions), time(TimeLevel::Year)]);
    let top_fy26 = || vec![top(), period("FY26")];
    assert_eq!(read(&world.model, units, top_fy26(), &top_year), num(84.0));
    assert_eq!(read(&world.model, price, top_fy26(), &top_year), num(3.0));

    let grand_total = levels(vec![Axis::ListTop(world.countries), time(TimeLevel::All)]);
    let total = || vec![top(), period("Total")];
    assert_eq!(read(&world.model, units, total(), &grand_total), num(168.0));
    assert_eq!(read(&world.model, price, total(), &grand_total), num(3.0));

    let country_years = levels(vec![Axis::List(world.countries), time(TimeLevel::Year)]);
    let ca_fy27 = vec![item(world.ca), period("FY27")];
    assert_eq!(
        read(&world.model, units, ca_fy27, &country_years),
        num(24.0)
    );

    let region_months = levels(vec![Axis::List(world.regions), time(TimeLevel::Month)]);
    let eu_may = vec![item(world.eu), month(4)];
    assert_eq!(read(&world.model, units, eu_may, &region_months), num(4.0));
}

#[test]
fn time_summary_applies_before_list_summary() {
    let world = world();
    let shape = Shape::new(
        vec![Axis::List(world.countries), time(TimeLevel::Quarter)],
        vec![3, 8],
    );
    let mut values = vec![0.0; 24];
    for quarter in 0..8 {
        values[quarter] = [1.0, 5.0][quarter % 2];
        values[8 + quarter] = [5.0, 1.0][quarter % 2];
        values[16 + quarter] = 3.0;
    }
    let column = Column::Number(values);
    let target = levels(vec![Axis::List(world.regions), time(TimeLevel::Year)]);

    let (out_shape, out) = aggregate(
        world.model.structure(),
        &shape,
        &column,
        &SummaryMethod::Sum,
        &SummaryMethod::Min,
        &target,
        None,
    )
    .unwrap();
    assert_eq!(out_shape.axes, target.0);
    assert_eq!(out_shape.lens, vec![2, 2]);
    assert_eq!(out, Column::Number(vec![2.0, 2.0, 3.0, 3.0]));
}

#[test]
fn three_level_hierarchy_aggregates_from_leaves() {
    let mut model = Model::new(calendar());
    let [regions, countries, cities] = std::array::from_fn(|_| ListId::new());
    let [r1, r2, c1, c2, c3, a, b, c, d] = std::array::from_fn(|_| ItemId::new());
    let create = |id, name: &str, parent| Command::CreateList {
        id,
        name: name.to_string(),
        parent,
        top_level_name: None,
        numbered: false,
        production_data: false,
    };
    model
        .apply_batch(vec![
            create(regions, "Regions", None),
            create(countries, "Countries", Some(regions)),
            create(cities, "Cities", Some(countries)),
            Command::UpsertListItems {
                list: regions,
                items: vec![item_spec(r1, "R1", None), item_spec(r2, "R2", None)],
            },
            Command::UpsertListItems {
                list: countries,
                items: vec![
                    item_spec(c1, "C1", Some(r1)),
                    item_spec(c2, "C2", Some(r1)),
                    item_spec(c3, "C3", Some(r2)),
                ],
            },
            Command::UpsertListItems {
                list: cities,
                items: vec![
                    item_spec(a, "a", Some(c1)),
                    item_spec(b, "b", Some(c1)),
                    item_spec(c, "c", Some(c2)),
                    item_spec(d, "d", Some(c3)),
                ],
            },
        ])
        .unwrap();
    let module = new_module(&mut model, "Cities", vec![AxisSpec::List { list: cities }]);
    let mean = add_number(&mut model, module, "Mean", SummaryMethod::Average);
    let cells = [(a, 1.0), (b, 2.0), (c, 3.0), (d, 10.0)]
        .into_iter()
        .map(|(city, value)| (vec![item(city)], num(value)))
        .collect();
    set_many(&mut model, mean, cells);

    let by_country = levels(vec![Axis::List(countries)]);
    assert_eq!(read(&model, mean, vec![item(c1)], &by_country), num(1.5));
    let by_region = levels(vec![Axis::List(regions)]);
    assert_eq!(read(&model, mean, vec![item(r1)], &by_region), num(2.0));
    assert_eq!(read(&model, mean, vec![item(r2)], &by_region), num(10.0));
    let city_top = levels(vec![Axis::ListTop(regions)]);
    assert_eq!(read(&model, mean, vec![top()], &city_top), num(4.0));
}

#[test]
fn deleted_items_take_no_part() {
    let mut world = world();
    let module = countries_module(&mut world, "Prices");
    let price = add_number(&mut world.model, module, "Price", SummaryMethod::Average);
    set_countries(&mut world, price, 1.0, 2.0, 6.0);
    let by_region = levels(vec![Axis::List(world.regions)]);
    assert_eq!(
        read(&world.model, price, vec![item(world.na)], &by_region),
        num(1.5)
    );

    world
        .model
        .apply(Command::DeleteListItems {
            list: world.countries,
            ids: vec![world.ca],
        })
        .unwrap();
    assert_eq!(
        read(&world.model, price, vec![item(world.na)], &by_region),
        num(1.0)
    );
    let region_top = levels(vec![Axis::ListTop(world.regions)]);
    assert_eq!(
        read(&world.model, price, vec![top()], &region_top),
        num(3.5)
    );
}

#[test]
fn booleans_support_any_and_all() {
    let mut world = world();
    let module = countries_module(&mut world, "Flags");
    let any = add(
        &mut world.model,
        line_item(module, "Any", Format::Boolean, SummaryMethod::Any),
    );
    let all = add(
        &mut world.model,
        line_item(module, "All", Format::Boolean, SummaryMethod::All),
    );
    let sum = add(
        &mut world.model,
        line_item(module, "Sum", Format::Boolean, SummaryMethod::Sum),
    );
    for line_item in [any, all, sum] {
        let cells = vec![
            (vec![item(world.us)], Value::Boolean(true)),
            (vec![item(world.ca)], Value::Boolean(false)),
            (vec![item(world.de)], Value::Boolean(true)),
        ];
        set_many(&mut world.model, line_item, cells);
    }

    let by_region = levels(vec![Axis::List(world.regions)]);
    let region_top = levels(vec![Axis::ListTop(world.regions)]);
    let at = |line_item, region| read(&world.model, line_item, vec![item(region)], &by_region);
    assert_eq!(at(any, world.na), Value::Boolean(true));
    assert_eq!(at(all, world.na), Value::Boolean(false));
    assert_eq!(at(all, world.eu), Value::Boolean(true));
    assert_eq!(at(sum, world.eu), Value::Boolean(false));
    assert_eq!(
        read(&world.model, any, vec![top()], &region_top),
        Value::Boolean(true)
    );
    assert_eq!(
        read(&world.model, all, vec![top()], &region_top),
        Value::Boolean(false)
    );
}

#[test]
fn text_dates_items_and_periods_summarize_to_blank() {
    let mut world = world();
    let module = countries_module(&mut world, "Details");
    let note = add(
        &mut world.model,
        line_item(module, "Note", Format::Text, SummaryMethod::Sum),
    );
    let started = add(
        &mut world.model,
        line_item(module, "Started", Format::Date, SummaryMethod::Max),
    );
    let lead = add(
        &mut world.model,
        line_item(
            module,
            "Lead",
            Format::List {
                list: world.countries,
            },
            SummaryMethod::First,
        ),
    );
    let due = add(
        &mut world.model,
        line_item(
            module,
            "Due",
            Format::TimePeriod {
                level: TimeLevel::Quarter,
            },
            SummaryMethod::Last,
        ),
    );
    set(
        &mut world.model,
        note,
        vec![item(world.us)],
        Value::Text(Arc::from("hello")),
    );
    set(
        &mut world.model,
        lead,
        vec![item(world.us)],
        Value::Item(Some(world.ca)),
    );
    set(
        &mut world.model,
        due,
        vec![item(world.us)],
        Value::Period(Some((TimeLevel::Quarter, 2))),
    );

    let by_region = levels(vec![Axis::List(world.regions)]);
    let na = || vec![item(world.na)];
    assert_eq!(
        read(&world.model, note, na(), &by_region),
        Value::Text(Arc::from(""))
    );
    assert_eq!(
        read(&world.model, started, na(), &by_region),
        Value::Date(None)
    );
    assert_eq!(
        read(&world.model, lead, na(), &by_region),
        Value::Item(None)
    );
    assert_eq!(
        read(&world.model, due, na(), &by_region),
        Value::Period(None)
    );
    let leaves = levels(vec![Axis::List(world.countries)]);
    assert_eq!(
        read(&world.model, note, vec![item(world.us)], &leaves),
        Value::Text(Arc::from("hello"))
    );
}

#[test]
fn subsets_summarize_to_top_and_ancestor_lists() {
    let mut world = world();
    let subset = SubsetId::new();
    world
        .model
        .apply(Command::CreateSubset {
            id: subset,
            list: world.countries,
            name: "Focus".to_string(),
            items: vec![world.de, world.us],
        })
        .unwrap();
    let module = new_module(
        &mut world.model,
        "Focus plan",
        vec![AxisSpec::Subset { subset }],
    );
    let units = add_number(&mut world.model, module, "Units", SummaryMethod::Sum);
    set(&mut world.model, units, vec![item(world.de)], num(4.0));
    set(&mut world.model, units, vec![item(world.us)], num(1.0));

    let subset_top = levels(vec![Axis::ListTop(world.countries)]);
    assert_eq!(
        read(&world.model, units, vec![top()], &subset_top),
        num(5.0)
    );
    let by_region = levels(vec![Axis::List(world.regions)]);
    assert_eq!(
        read(&world.model, units, vec![item(world.na)], &by_region),
        num(1.0)
    );
    assert_eq!(
        read(&world.model, units, vec![item(world.eu)], &by_region),
        num(4.0)
    );
    let same = levels(vec![Axis::Subset(subset)]);
    assert_eq!(
        read(&world.model, units, vec![item(world.de)], &same),
        num(4.0)
    );
    let own_list = levels(vec![Axis::List(world.countries)]);
    let error = read_error(&world.model, units, vec![item(world.de)], &own_list);
    assert_eq!(error.code(), "structure.invalid");
}

fn new_products(model: &mut Model) -> (ListId, [ItemId; 3]) {
    let products = ListId::new();
    let items = std::array::from_fn(|_| ItemId::new());
    model
        .apply_batch(vec![
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
                    .enumerate()
                    .map(|(position, id)| item_spec(*id, &format!("P{position}"), None))
                    .collect(),
            },
        ])
        .unwrap();
    (products, items)
}

fn new_subset(model: &mut Model, list: ListId, name: &str, items: &[ItemId]) -> SubsetId {
    let id = SubsetId::new();
    model
        .apply(Command::CreateSubset {
            id,
            list,
            name: name.to_string(),
            items: items.to_vec(),
        })
        .unwrap();
    id
}

#[test]
fn kept_subset_axis_survives_a_list_axis_roll_up() {
    let mut world = world();
    let (products, products_items) = new_products(&mut world.model);
    let base = |country: ItemId| {
        if country == world.us {
            1.0
        } else if country == world.ca {
            10.0
        } else {
            100.0
        }
    };
    for (name, members) in [
        ("Focus A", [world.de, world.us]),
        ("Focus B", [world.ca, world.us]),
    ] {
        let subset = new_subset(&mut world.model, world.countries, name, &members);
        let axes = vec![
            AxisSpec::Subset { subset },
            AxisSpec::List { list: products },
        ];
        let module = new_module(&mut world.model, name, axes);
        let units = add_number(&mut world.model, module, "Units", SummaryMethod::Sum);
        let mut cells = Vec::new();
        for member in members {
            for (number, product) in products_items.iter().enumerate() {
                let value = base(member) * (number as f64 + 1.0);
                cells.push((vec![item(member), item(*product)], num(value)));
            }
        }
        set_many(&mut world.model, units, cells);

        let target = levels(vec![Axis::Subset(subset), Axis::ListTop(products)]);
        for member in members {
            assert_eq!(
                read(&world.model, units, vec![item(member), top()], &target),
                num(base(member) * 6.0),
                "{name}"
            );
        }
    }
}

#[test]
fn kept_subset_axis_survives_a_hierarchy_roll_up() {
    let mut world = world();
    let (products, [p1, p2, p3]) = new_products(&mut world.model);
    let base = |country: ItemId| {
        if country == world.us {
            1.0
        } else if country == world.ca {
            10.0
        } else {
            100.0
        }
    };
    for (name, picks) in [("Picks A", [p3, p1]), ("Picks B", [p2, p1])] {
        let picks_subset = new_subset(&mut world.model, products, name, &picks);
        let axes = vec![
            AxisSpec::List {
                list: world.countries,
            },
            AxisSpec::Subset {
                subset: picks_subset,
            },
        ];
        let module = new_module(&mut world.model, name, axes);
        let units = add_number(&mut world.model, module, "Units", SummaryMethod::Sum);
        let number_of =
            |product: ItemId| [p1, p2, p3].iter().position(|p| *p == product).unwrap() as f64 + 1.0;
        let mut cells = Vec::new();
        for country in [world.us, world.ca, world.de] {
            for product in picks {
                let value = base(country) * number_of(product);
                cells.push((vec![item(country), item(product)], num(value)));
            }
        }
        set_many(&mut world.model, units, cells);

        let target = levels(vec![Axis::List(world.regions), Axis::Subset(picks_subset)]);
        for product in picks {
            let number = number_of(product);
            let at = |region| vec![item(region), item(product)];
            assert_eq!(
                read(&world.model, units, at(world.na), &target),
                num(11.0 * number),
                "{name}"
            );
            assert_eq!(
                read(&world.model, units, at(world.eu), &target),
                num(100.0 * number),
                "{name}"
            );
        }
    }
}

fn april_calendar() -> Calendar {
    Calendar {
        fiscal_year_start_month: 4,
        first_year: 2027,
        years: 2,
        current_month: None,
    }
}

#[test]
fn non_january_fiscal_years_roll_up_by_fiscal_period() {
    let calendar = april_calendar();
    let mut model = Model::new(calendar);
    let module = new_module(&mut model, "Cash", vec![month_axis()]);
    let flow = add_number(&mut model, module, "Flow", SummaryMethod::Sum);
    let cells = (0..24)
        .map(|index| {
            (
                vec![period(&calendar.label(TimeLevel::Month, index))],
                num(f64::from(index + 1)),
            )
        })
        .collect();
    set_many(&mut model, flow, cells);

    let read_at = |level, label: &str| {
        read(
            &model,
            flow,
            vec![period(label)],
            &levels(vec![time(level)]),
        )
    };
    assert_eq!(read_at(TimeLevel::Month, "Apr 26"), num(1.0));
    assert_eq!(read_at(TimeLevel::Quarter, "Q1 FY27"), num(6.0));
    assert_eq!(read_at(TimeLevel::Quarter, "Q4 FY27"), num(33.0));
    assert_eq!(read_at(TimeLevel::Quarter, "Q1 FY28"), num(42.0));
    assert_eq!(read_at(TimeLevel::HalfYear, "H1 FY27"), num(21.0));
    assert_eq!(read_at(TimeLevel::HalfYear, "H2 FY28"), num(129.0));
    assert_eq!(read_at(TimeLevel::Year, "FY27"), num(78.0));
    assert_eq!(read_at(TimeLevel::Year, "FY28"), num(222.0));
    assert_eq!(read_at(TimeLevel::All, "Total"), num(300.0));
}

#[test]
fn non_january_quarter_scaled_line_items_roll_up_period_by_period() {
    let calendar = april_calendar();
    let mut model = Model::new(calendar);
    let module = new_module(&mut model, "Plan", vec![month_axis()]);
    let mut quarterly = line_item(module, "Quarterly", Format::number(), SummaryMethod::Sum);
    quarterly.time_scale = TimeScale::Level(TimeLevel::Quarter);
    let quarterly = add(&mut model, quarterly);
    let mut stock = line_item(module, "Stock", Format::number(), SummaryMethod::Closing);
    stock.time_scale = TimeScale::Level(TimeLevel::Quarter);
    let stock = add(&mut model, stock);
    for line_item in [quarterly, stock] {
        let cells = (0..8)
            .map(|quarter| {
                (
                    vec![period(&calendar.label(TimeLevel::Quarter, quarter))],
                    num(f64::from(quarter + 1)),
                )
            })
            .collect();
        set_many(&mut model, line_item, cells);
    }

    let half = levels(vec![time(TimeLevel::HalfYear)]);
    let year = levels(vec![time(TimeLevel::Year)]);
    assert_eq!(
        read(&model, quarterly, vec![period("H2 FY27")], &half),
        num(7.0)
    );
    assert_eq!(
        read(&model, quarterly, vec![period("FY28")], &year),
        num(26.0)
    );
    assert_eq!(
        read(&model, stock, vec![period("H1 FY28")], &half),
        num(6.0)
    );
    assert_eq!(read(&model, stock, vec![period("FY27")], &year), num(4.0));
}

#[test]
fn non_january_time_ranges_roll_up_within_their_own_fiscal_years() {
    let calendar = april_calendar();
    let mut model = Model::new(calendar);
    let range = TimeRangeId::new();
    model
        .apply(Command::CreateTimeRange {
            id: range,
            name: "Later".to_string(),
            first_year: 2028,
            years: 1,
        })
        .unwrap();
    let module = new_module(
        &mut model,
        "Later plan",
        vec![AxisSpec::Time {
            level: TimeLevel::Month,
            range: Some(range),
        }],
    );
    let flow = add_number(&mut model, module, "Flow", SummaryMethod::Sum);
    let range_calendar = Calendar {
        first_year: 2028,
        years: 1,
        ..calendar
    };
    let cells = (0..12)
        .map(|index| {
            (
                vec![period(&range_calendar.label(TimeLevel::Month, index))],
                num(f64::from(index + 1)),
            )
        })
        .collect();
    set_many(&mut model, flow, cells);

    let ranged = |level| {
        levels(vec![Axis::Time {
            level,
            range: Some(range),
        }])
    };
    let read_at = |level, label: &str| read(&model, flow, vec![period(label)], &ranged(level));
    assert_eq!(read_at(TimeLevel::Month, "Apr 27"), num(1.0));
    assert_eq!(read_at(TimeLevel::Quarter, "Q1 FY28"), num(6.0));
    assert_eq!(read_at(TimeLevel::Quarter, "Q4 FY28"), num(33.0));
    assert_eq!(read_at(TimeLevel::Year, "FY28"), num(78.0));
}

#[test]
fn coarser_time_scale_rolls_up_period_by_period() {
    let mut model = Model::new(calendar());
    let module = new_module(&mut model, "Plan", vec![month_axis()]);
    let mut quarterly = line_item(module, "Quarterly", Format::number(), SummaryMethod::Sum);
    quarterly.time_scale = TimeScale::Level(TimeLevel::Quarter);
    let quarterly = add(&mut model, quarterly);
    let mut stock = line_item(module, "Stock", Format::number(), SummaryMethod::Closing);
    stock.time_scale = TimeScale::Level(TimeLevel::Quarter);
    let stock = add(&mut model, stock);
    for line_item in [quarterly, stock] {
        let cells = (0..8)
            .map(|quarter| {
                (
                    vec![period(&calendar().label(TimeLevel::Quarter, quarter))],
                    num(f64::from(quarter + 1)),
                )
            })
            .collect();
        set_many(&mut model, line_item, cells);
    }

    let half = levels(vec![time(TimeLevel::HalfYear)]);
    let year = levels(vec![time(TimeLevel::Year)]);
    let all = levels(vec![time(TimeLevel::All)]);
    assert_eq!(
        read(&model, quarterly, vec![period("H2 FY26")], &half),
        num(7.0)
    );
    assert_eq!(
        read(&model, quarterly, vec![period("FY27")], &year),
        num(26.0)
    );
    assert_eq!(
        read(&model, quarterly, vec![period("Total")], &all),
        num(36.0)
    );
    assert_eq!(
        read(&model, stock, vec![period("H1 FY27")], &half),
        num(6.0)
    );
    assert_eq!(read(&model, stock, vec![period("FY26")], &year), num(4.0));
    assert_eq!(read(&model, stock, vec![period("Total")], &all), num(8.0));
}

#[test]
fn time_ranges_aggregate_within_their_own_calendar() {
    let mut model = Model::new(calendar());
    let range = TimeRangeId::new();
    model
        .apply(Command::CreateTimeRange {
            id: range,
            name: "Later".to_string(),
            first_year: 2027,
            years: 1,
        })
        .unwrap();
    let module = new_module(
        &mut model,
        "Later plan",
        vec![AxisSpec::Time {
            level: TimeLevel::Month,
            range: Some(range),
        }],
    );
    let flow = add_number(&mut model, module, "Flow", SummaryMethod::Sum);
    let range_calendar = Calendar {
        first_year: 2027,
        years: 1,
        ..calendar()
    };
    let cells = (0..12)
        .map(|index| {
            (
                vec![period(&range_calendar.label(TimeLevel::Month, index))],
                num(f64::from(index + 1)),
            )
        })
        .collect();
    set_many(&mut model, flow, cells);

    let ranged = |level| {
        levels(vec![Axis::Time {
            level,
            range: Some(range),
        }])
    };
    assert_eq!(
        read(
            &model,
            flow,
            vec![period("Q1 FY27")],
            &ranged(TimeLevel::Quarter)
        ),
        num(6.0)
    );
    assert_eq!(
        read(&model, flow, vec![period("FY27")], &ranged(TimeLevel::Year)),
        num(78.0)
    );
    let error = read_error(
        &model,
        flow,
        vec![period("FY27")],
        &levels(vec![time(TimeLevel::Year)]),
    );
    assert_eq!(error.code(), "structure.invalid");
}

#[test]
fn versions_stay_and_other_axes_aggregate() {
    let mut world = world();
    let axes = vec![
        AxisSpec::List {
            list: world.countries,
        },
        AxisSpec::Versions,
    ];
    let module = new_module(&mut world.model, "Scenarios", axes);
    let units = add_number(&mut world.model, module, "Units", SummaryMethod::Sum);
    let version = |name: &str| {
        let version = world.model.structure().version_by_name(name).unwrap();
        CoordToken::Item(ItemId(version.id.0))
    };
    let (budget, forecast) = (version("Budget"), version("Forecast"));
    set_many(
        &mut world.model,
        units,
        vec![
            (vec![item(world.us), budget.clone()], num(1.0)),
            (vec![item(world.ca), budget.clone()], num(2.0)),
            (vec![item(world.us), forecast.clone()], num(10.0)),
        ],
    );

    let by_region = levels(vec![Axis::List(world.regions), Axis::Versions]);
    assert_eq!(
        read(
            &world.model,
            units,
            vec![item(world.na), budget.clone()],
            &by_region
        ),
        num(3.0)
    );
    assert_eq!(
        read(
            &world.model,
            units,
            vec![item(world.na), forecast],
            &by_region
        ),
        num(10.0)
    );
    let aggregated_versions = levels(vec![Axis::List(world.regions), time(TimeLevel::All)]);
    let error = read_error(
        &world.model,
        units,
        vec![item(world.na), period("Total")],
        &aggregated_versions,
    );
    assert_eq!(error.code(), "structure.invalid");
}

#[test]
fn levels_that_are_not_coarser_are_rejected() {
    let mut world = world();
    let other = ListId::new();
    world
        .model
        .apply(Command::CreateList {
            id: other,
            name: "Other".to_string(),
            parent: None,
            top_level_name: None,
            numbered: false,
            production_data: false,
        })
        .unwrap();
    let axes = vec![
        AxisSpec::List {
            list: world.countries,
        },
        month_axis(),
    ];
    let module = new_module(&mut world.model, "Sales", axes);
    let units = add_number(&mut world.model, module, "Units", SummaryMethod::Sum);
    let month_level = time(TimeLevel::Month);
    let country = Axis::List(world.countries);

    let bad = [
        levels(vec![country.clone()]),
        levels(vec![country.clone(), month_level.clone(), Axis::Versions]),
        levels(vec![month_level.clone(), country.clone()]),
        levels(vec![Axis::List(other), month_level.clone()]),
        levels(vec![Axis::ListTop(other), month_level.clone()]),
        levels(vec![Axis::List(world.regions), Axis::List(world.regions)]),
        levels(vec![country.clone(), Axis::Versions]),
    ];
    for (position, target) in bad.iter().enumerate() {
        let error = read_error(&world.model, units, Vec::new(), target);
        assert_eq!(error.code(), "structure.invalid", "target {position}");
    }

    let mut quarterly = line_item(module, "Quarterly", Format::number(), SummaryMethod::Sum);
    quarterly.time_scale = TimeScale::Level(TimeLevel::Quarter);
    let quarterly = add(&mut world.model, quarterly);
    let finer = levels(vec![country, month_level]);
    let error = read_error(&world.model, quarterly, Vec::new(), &finer);
    assert_eq!(error.code(), "structure.invalid");
}

#[test]
fn formula_summaries_are_not_aggregated() {
    let mut world = world();
    let module = countries_module(&mut world, "Sales");
    let units = add_number(&mut world.model, module, "Units", SummaryMethod::Formula);
    set_countries(&mut world, units, 1.0, 2.0, 4.0);

    let leaves = levels(vec![Axis::List(world.countries)]);
    assert_eq!(
        read(&world.model, units, vec![item(world.ca)], &leaves),
        num(2.0)
    );
    let by_region = levels(vec![Axis::List(world.regions)]);
    let error = read_error(&world.model, units, vec![item(world.na)], &by_region);
    assert_eq!(error.code(), "structure.invalid");
}

#[test]
fn formula_summaries_are_rejected_for_every_column_type() {
    let mut world = world();
    let axes = vec![
        AxisSpec::List {
            list: world.countries,
        },
        month_axis(),
    ];
    let module = new_module(&mut world.model, "Details", axes);
    let formats = [
        Format::number(),
        Format::Boolean,
        Format::Text,
        Format::Date,
        Format::List {
            list: world.countries,
        },
        Format::TimePeriod {
            level: TimeLevel::Quarter,
        },
    ];
    let by_region = levels(vec![Axis::List(world.regions), time(TimeLevel::Month)]);
    let by_quarter = levels(vec![Axis::List(world.countries), time(TimeLevel::Quarter)]);
    let leaves = levels(vec![Axis::List(world.countries), time(TimeLevel::Month)]);
    for (position, format) in formats.into_iter().enumerate() {
        let name = format!("Formula {position}");
        let formula = add(
            &mut world.model,
            line_item(module, &name, format.clone(), SummaryMethod::Formula),
        );
        let mut formula_in_time = line_item(
            module,
            &format!("Time formula {position}"),
            format,
            SummaryMethod::Sum,
        );
        formula_in_time.time_summary = Some(SummaryMethod::Formula);
        let formula_in_time = add(&mut world.model, formula_in_time);

        let leaf = || vec![item(world.us), month(0)];
        world.model.read_summary(formula, &leaf(), &leaves).unwrap();
        let on_lists = vec![item(world.na), month(0)];
        let error = read_error(&world.model, formula, on_lists, &by_region);
        assert_eq!(error.code(), "structure.invalid", "{name}");
        let on_time = vec![item(world.us), period("Q1 FY26")];
        let error = read_error(&world.model, formula_in_time, on_time, &by_quarter);
        assert_eq!(error.code(), "structure.invalid", "{name}");
        let lists_only = vec![item(world.na), month(0)];
        world
            .model
            .read_summary(formula_in_time, &lists_only, &by_region)
            .unwrap();
    }
}

#[test]
fn identity_reads_ignore_ratio_parts() {
    let mut world = world();
    let regional = new_module(
        &mut world.model,
        "Regional",
        vec![AxisSpec::List {
            list: world.regions,
        }],
    );
    let revenue = add_number(&mut world.model, regional, "Revenue", SummaryMethod::Sum);
    let profit = add_number(&mut world.model, regional, "Profit", SummaryMethod::Sum);
    let national = countries_module(&mut world, "National");
    let margin = add_number(
        &mut world.model,
        national,
        "Margin",
        SummaryMethod::Ratio {
            numerator: profit,
            denominator: revenue,
        },
    );
    let mut conflicting = line_item(
        national,
        "Conflicting",
        Format::number(),
        SummaryMethod::Ratio {
            numerator: profit,
            denominator: revenue,
        },
    );
    conflicting.time_summary = Some(SummaryMethod::Ratio {
        numerator: revenue,
        denominator: profit,
    });
    let conflicting = add(&mut world.model, conflicting);
    set_countries(&mut world, margin, 0.2, 0.1, 0.5);
    set_countries(&mut world, conflicting, 0.3, 0.4, 0.6);

    let leaves = levels(vec![Axis::List(world.countries)]);
    let us = || vec![item(world.us)];
    assert_eq!(read(&world.model, margin, us(), &leaves), num(0.2));
    assert_eq!(read(&world.model, conflicting, us(), &leaves), num(0.3));
    let by_region = levels(vec![Axis::List(world.regions)]);
    for line_item in [margin, conflicting] {
        let error = read_error(&world.model, line_item, vec![item(world.na)], &by_region);
        assert_eq!(error.code(), "structure.invalid");
    }
}

#[test]
fn aggregate_works_on_any_shape_and_column() {
    let world = world();
    let shape = Shape::new(
        vec![Axis::List(world.countries), time(TimeLevel::Quarter)],
        vec![3, 8],
    );
    let values: Vec<f64> = (0..3)
        .flat_map(|country| (0..8).map(move |quarter| f64::from((country + 1) * (quarter + 1))))
        .collect();
    let column = Column::Number(values);
    let target = levels(vec![Axis::List(world.regions), time(TimeLevel::Year)]);

    let aggregate_with = |method: &SummaryMethod, time_method: &SummaryMethod| {
        aggregate(
            world.model.structure(),
            &shape,
            &column,
            method,
            time_method,
            &target,
            None,
        )
        .unwrap()
    };
    let (out_shape, sums) = aggregate_with(&SummaryMethod::Sum, &SummaryMethod::Sum);
    assert_eq!(out_shape.axes, target.0);
    assert_eq!(out_shape.lens, vec![2, 2]);
    assert_eq!(sums, Column::Number(vec![30.0, 78.0, 30.0, 78.0]));
    let (_, closing) = aggregate_with(&SummaryMethod::Sum, &SummaryMethod::Closing);
    assert_eq!(closing, Column::Number(vec![12.0, 24.0, 12.0, 24.0]));
    let (_, mean) = aggregate_with(&SummaryMethod::Average, &SummaryMethod::Sum);
    assert_eq!(mean, Column::Number(vec![15.0, 39.0, 30.0, 78.0]));

    let identity = levels(vec![Axis::List(world.countries), time(TimeLevel::Quarter)]);
    let (same_shape, same) = aggregate(
        world.model.structure(),
        &shape,
        &column,
        &SummaryMethod::Sum,
        &SummaryMethod::Sum,
        &identity,
        None,
    )
    .unwrap();
    assert_eq!(same_shape, shape);
    assert_eq!(same, column);
}

#[test]
fn aggregate_checks_columns_and_ratio_parts() {
    let world = world();
    let shape = Shape::new(vec![Axis::List(world.countries)], vec![3]);
    let column = Column::Number(vec![0.2, 0.1, 0.5]);
    let target = levels(vec![Axis::ListTop(world.regions)]);
    let ratio = SummaryMethod::Ratio {
        numerator: LineItemId::new(),
        denominator: LineItemId::new(),
    };
    let run = |column: &Column, parts: Option<(&Column, &Column)>| {
        aggregate(
            world.model.structure(),
            &shape,
            column,
            &ratio,
            &ratio,
            &target,
            parts,
        )
    };

    let numerator = Column::Number(vec![20.0, 30.0, 100.0]);
    let denominator = Column::Number(vec![100.0, 300.0, 200.0]);
    let (_, ok) = run(&column, Some((&numerator, &denominator))).unwrap();
    assert_eq!(ok, Column::Number(vec![0.25]));

    let invalid = [
        run(&column, None).unwrap_err(),
        run(&Column::Number(vec![0.2]), Some((&numerator, &denominator))).unwrap_err(),
        run(&column, Some((&Column::Number(vec![1.0]), &denominator))).unwrap_err(),
        run(&column, Some((&numerator, &Column::Boolean(vec![true; 3])))).unwrap_err(),
    ];
    for error in invalid {
        assert_eq!(error.code(), "structure.invalid", "{error}");
    }
}

#[test]
fn ratio_parts_are_summed_whichever_axis_uses_the_ratio() {
    let world = world();
    let shape = Shape::new(
        vec![Axis::List(world.countries), time(TimeLevel::Quarter)],
        vec![3, 8],
    );
    let repeat = |per_country: [f64; 3]| {
        Column::Number(
            per_country
                .into_iter()
                .flat_map(|value| [value; 8])
                .collect(),
        )
    };
    let numerator = repeat([1.0, 2.0, 3.0]);
    let denominator = repeat([2.0, 8.0, 6.0]);
    let cells = repeat([9.0, 9.0, 9.0]);
    let target = levels(vec![Axis::ListTop(world.regions), time(TimeLevel::Year)]);
    let ratio = SummaryMethod::Ratio {
        numerator: LineItemId::new(),
        denominator: LineItemId::new(),
    };
    let run = |method: &SummaryMethod, time_method: &SummaryMethod| {
        aggregate(
            world.model.structure(),
            &shape,
            &cells,
            method,
            time_method,
            &target,
            Some((&numerator, &denominator)),
        )
        .unwrap()
        .1
    };

    let ratio_of_totals = Column::Number(vec![0.375, 0.375]);
    assert_eq!(run(&ratio, &ratio), ratio_of_totals);
    assert_eq!(run(&ratio, &SummaryMethod::Sum), ratio_of_totals);
    assert_eq!(
        run(&SummaryMethod::Sum, &ratio),
        Column::Number(vec![1.25, 1.25])
    );
}

#[test]
fn identity_levels_return_the_stored_values() {
    let mut world = world();
    let module = countries_module(&mut world, "Sales");
    let units = add_number(&mut world.model, module, "Units", SummaryMethod::None);
    set_countries(&mut world, units, 1.0, 2.0, 4.0);

    let leaves = levels(vec![Axis::List(world.countries)]);
    for (country, expected) in [(world.us, 1.0), (world.ca, 2.0), (world.de, 4.0)] {
        assert_eq!(
            read(&world.model, units, vec![item(country)], &leaves),
            num(expected)
        );
    }
}

#[test]
fn calculated_line_items_summarize_to_blank() {
    let mut world = world();
    let module = countries_module(&mut world, "Sales");
    let mut calculated = line_item(module, "Calc", Format::number(), SummaryMethod::Sum);
    calculated.formula = Some("1".to_string());
    let calculated = add(&mut world.model, calculated);

    let by_region = levels(vec![Axis::List(world.regions)]);
    assert_eq!(
        read(&world.model, calculated, vec![item(world.na)], &by_region),
        num(0.0)
    );
}

#[test]
fn bad_tokens_are_invalid_coordinates() {
    let mut world = world();
    let module = countries_module(&mut world, "Sales");
    let units = add_number(&mut world.model, module, "Units", SummaryMethod::Sum);
    let by_region = levels(vec![Axis::List(world.regions)]);
    let region_top = levels(vec![Axis::ListTop(world.regions)]);

    let cases = [
        read_error(&world.model, units, Vec::new(), &by_region),
        read_error(&world.model, units, vec![top()], &by_region),
        read_error(&world.model, units, vec![item(world.us)], &by_region),
        read_error(&world.model, units, vec![item(world.na)], &region_top),
        read_error(&world.model, units, vec![period("bottom")], &region_top),
    ];
    for error in cases {
        assert_eq!(error.code(), "cells.invalid_coordinate", "{error}");
    }
    let missing = read_error(
        &world.model,
        LineItemId::new(),
        vec![item(world.na)],
        &by_region,
    );
    assert_eq!(missing.code(), "structure.not_found");
    assert_eq!(
        read(&world.model, units, vec![period("TOP")], &region_top),
        num(0.0)
    );
}

#[test]
fn cache_invalidated_on_edit() {
    let mut world = world();
    let module = countries_module(&mut world, "Sales");
    let units = add_number(&mut world.model, module, "Units", SummaryMethod::Sum);
    set_countries(&mut world, units, 1.0, 2.0, 4.0);
    let by_region = levels(vec![Axis::List(world.regions)]);
    let region_top = levels(vec![Axis::ListTop(world.regions)]);
    let na = || vec![item(world.na)];
    assert_eq!(read(&world.model, units, na(), &by_region), num(3.0));
    assert_eq!(
        read(&world.model, units, vec![top()], &region_top),
        num(7.0)
    );
    assert_eq!(read(&world.model, units, na(), &by_region), num(3.0));

    set(&mut world.model, units, vec![item(world.us)], num(10.0));
    assert_eq!(read(&world.model, units, na(), &by_region), num(12.0));
    assert_eq!(
        read(&world.model, units, vec![top()], &region_top),
        num(16.0)
    );

    world
        .model
        .apply(Command::SetCells {
            line_item: units,
            edits: vec![CellEdit {
                coords: vec![item(world.ca)],
                value: Value::Text(Arc::from("x")),
            }],
        })
        .unwrap_err();
    assert_eq!(read(&world.model, units, na(), &by_region), num(12.0));
}

#[test]
fn cache_invalidated_by_edits_of_ratio_parts() {
    let mut world = world();
    let module = countries_module(&mut world, "Profitability");
    let revenue = add_number(&mut world.model, module, "Revenue", SummaryMethod::Sum);
    let profit = add_number(&mut world.model, module, "Profit", SummaryMethod::Sum);
    let margin = add_number(
        &mut world.model,
        module,
        "Margin",
        SummaryMethod::Ratio {
            numerator: profit,
            denominator: revenue,
        },
    );
    set_countries(&mut world, revenue, 100.0, 300.0, 200.0);
    set_countries(&mut world, profit, 20.0, 30.0, 100.0);
    let by_region = levels(vec![Axis::List(world.regions)]);
    let na = || vec![item(world.na)];
    assert_eq!(read(&world.model, margin, na(), &by_region), num(0.125));

    set(&mut world.model, revenue, vec![item(world.ca)], num(100.0));
    assert_eq!(read(&world.model, margin, na(), &by_region), num(0.25));
    set(&mut world.model, profit, vec![item(world.us)], num(100.0));
    assert_eq!(read(&world.model, margin, na(), &by_region), num(0.65));
}

#[test]
fn cache_invalidated_by_summary_method_change() {
    let mut world = world();
    let module = countries_module(&mut world, "Sales");
    let units = add_number(&mut world.model, module, "Units", SummaryMethod::Sum);
    set_countries(&mut world, units, 1.0, 2.0, 4.0);
    let by_region = levels(vec![Axis::List(world.regions)]);
    let na = || vec![item(world.na)];
    assert_eq!(read(&world.model, units, na(), &by_region), num(3.0));

    world
        .model
        .apply(Command::UpdateLineItem {
            id: units,
            patch: LineItemPatch {
                summary: Some(SummaryMethod::Max),
                ..LineItemPatch::default()
            },
        })
        .unwrap();
    assert_eq!(read(&world.model, units, na(), &by_region), num(2.0));
}

#[test]
fn cache_invalidated_by_hierarchy_change() {
    let mut world = world();
    let module = countries_module(&mut world, "Sales");
    let units = add_number(&mut world.model, module, "Units", SummaryMethod::Sum);
    set_countries(&mut world, units, 1.0, 2.0, 4.0);
    let by_region = levels(vec![Axis::List(world.regions)]);
    let (na, eu) = (world.na, world.eu);
    assert_eq!(
        read(&world.model, units, vec![item(na)], &by_region),
        num(3.0)
    );

    world
        .model
        .apply(Command::UpsertListItems {
            list: world.countries,
            items: vec![item_spec(world.ca, "CA", Some(eu))],
        })
        .unwrap();
    assert_eq!(
        read(&world.model, units, vec![item(na)], &by_region),
        num(1.0)
    );
    assert_eq!(
        read(&world.model, units, vec![item(eu)], &by_region),
        num(6.0)
    );
}

#[test]
fn clones_with_diverging_edits_never_share_stale_summaries() {
    let mut world = world();
    let module = countries_module(&mut world, "Sales");
    let units = add_number(&mut world.model, module, "Units", SummaryMethod::Sum);
    set_countries(&mut world, units, 1.0, 2.0, 4.0);
    let by_region = levels(vec![Axis::List(world.regions)]);
    let na = || vec![item(world.na)];
    assert_eq!(read(&world.model, units, na(), &by_region), num(3.0));

    let mut left = world.model.clone();
    let mut right = world.model.clone();
    set(&mut left, units, vec![item(world.us)], num(10.0));
    set(&mut right, units, vec![item(world.us)], num(20.0));
    assert_eq!(left.generation(), right.generation());
    assert_eq!(read(&left, units, na(), &by_region), num(12.0));
    assert_eq!(read(&right, units, na(), &by_region), num(22.0));
    assert_eq!(read(&left, units, na(), &by_region), num(12.0));
    assert_eq!(read(&world.model, units, na(), &by_region), num(3.0));
}

#[test]
fn rejected_batch_leaves_summaries_valid() {
    let mut world = world();
    let module = countries_module(&mut world, "Sales");
    let units = add_number(&mut world.model, module, "Units", SummaryMethod::Sum);
    set_countries(&mut world, units, 1.0, 2.0, 4.0);
    let by_region = levels(vec![Axis::List(world.regions)]);
    assert_eq!(
        read(&world.model, units, vec![item(world.na)], &by_region),
        num(3.0)
    );

    let batch = vec![
        Command::SetCells {
            line_item: units,
            edits: vec![CellEdit {
                coords: vec![item(world.us)],
                value: num(100.0),
            }],
        },
        Command::DeleteList { id: world.regions },
    ];
    world.model.apply_batch(batch).unwrap_err();
    assert_eq!(
        read(&world.model, units, vec![item(world.na)], &by_region),
        num(3.0)
    );
}
