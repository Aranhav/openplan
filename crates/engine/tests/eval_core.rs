use std::sync::Arc;
use std::time::Instant;

use chrono::NaiveDate;
use openplan_engine::{
    Axis, AxisSpec, Calendar, CellEdit, Command, CoordToken, Format, FormulaError, ItemId,
    ItemSpec, LevelSpec, LineItem, LineItemId, LineItemPatch, ListId, Model, ModuleId, SubsetId,
    SummaryMethod, TimeLevel, TimeRangeId, TimeScale, Value, VersionsScope,
};

fn calendar(years: u8) -> Calendar {
    Calendar {
        fiscal_year_start_month: 1,
        first_year: 2026,
        years,
        current_month: None,
    }
}

/// A model under construction, with the commands it takes to build one spelled shortly.
struct Fx {
    model: Model,
}

impl Fx {
    fn new(years: u8) -> Fx {
        Fx {
            model: Model::new(calendar(years)),
        }
    }

    fn list(&mut self, name: &str, parent: Option<ListId>, top: Option<&str>) -> ListId {
        let id = ListId::new();
        self.model
            .apply(Command::CreateList {
                id,
                name: name.to_string(),
                parent,
                top_level_name: top.map(str::to_string),
                numbered: false,
                production_data: false,
            })
            .unwrap();
        id
    }

    fn items(&mut self, list: ListId, items: &[(&str, Option<ItemId>)]) -> Vec<ItemId> {
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
        self.model
            .apply(Command::UpsertListItems { list, items: specs })
            .unwrap();
        ids
    }

    fn subset(&mut self, name: &str, list: ListId, items: &[ItemId]) -> SubsetId {
        let id = SubsetId::new();
        self.model
            .apply(Command::CreateSubset {
                id,
                list,
                name: name.to_string(),
                items: items.to_vec(),
            })
            .unwrap();
        id
    }

    fn module(&mut self, name: &str, axes: Vec<AxisSpec>) -> ModuleId {
        let id = ModuleId::new();
        self.model
            .apply(Command::CreateModule {
                id,
                name: name.to_string(),
                axes,
                functional_area: String::new(),
            })
            .unwrap();
        id
    }

    fn add(&mut self, line_item: LineItem) -> LineItemId {
        let id = line_item.id;
        self.model
            .apply(Command::CreateLineItem(line_item))
            .unwrap();
        id
    }

    fn input(&mut self, module: ModuleId, name: &str, format: Format) -> LineItemId {
        self.add(line_item(module, name, format, None))
    }

    fn calc(&mut self, module: ModuleId, name: &str, format: Format, formula: &str) -> LineItemId {
        self.add(line_item(module, name, format, Some(formula)))
    }

    fn number(&mut self, module: ModuleId, name: &str) -> LineItemId {
        self.input(module, name, Format::number())
    }

    fn calc_number(&mut self, module: ModuleId, name: &str, formula: &str) -> LineItemId {
        self.calc(module, name, Format::number(), formula)
    }

    fn set(&mut self, line_item: LineItemId, coords: Vec<CoordToken>, value: Value) {
        self.model
            .apply(Command::SetCells {
                line_item,
                edits: vec![CellEdit { coords, value }],
            })
            .unwrap();
    }

    fn set_number(&mut self, line_item: LineItemId, coords: Vec<CoordToken>, value: f64) {
        self.set(line_item, coords, Value::Number(value));
    }

    fn recalc(&mut self) {
        self.model.recalc_all().unwrap();
    }

    fn get(&self, line_item: LineItemId, coords: Vec<CoordToken>) -> Value {
        self.model
            .read_cells(line_item, &[coords])
            .unwrap()
            .pop()
            .unwrap()
    }

    fn number_at(&self, line_item: LineItemId, coords: Vec<CoordToken>) -> f64 {
        match self.get(line_item, coords) {
            Value::Number(number) => number,
            other => panic!("expected a number, found {other:?}"),
        }
    }

    fn text_at(&self, line_item: LineItemId, coords: Vec<CoordToken>) -> String {
        match self.get(line_item, coords) {
            Value::Text(text) => text.to_string(),
            other => panic!("expected text, found {other:?}"),
        }
    }

    fn errors(&self, line_item: LineItemId) -> Vec<FormulaError> {
        self.model
            .line_item_errors(line_item)
            .expect("the line item should be in error")
            .to_vec()
    }

    fn version(&self, name: &str) -> CoordToken {
        let version = self.model.structure().version_by_name(name).unwrap();
        CoordToken::Item(ItemId(version.id.0))
    }
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

fn list_axis(list: ListId) -> AxisSpec {
    AxisSpec::List { list }
}

fn time_axis(level: TimeLevel) -> AxisSpec {
    AxisSpec::Time { level, range: None }
}

fn month_axis() -> AxisSpec {
    time_axis(TimeLevel::Month)
}

fn item(id: ItemId) -> CoordToken {
    CoordToken::Item(id)
}

fn period(label: &str) -> CoordToken {
    CoordToken::Period(label.to_string())
}

fn list_format(list: ListId) -> Format {
    Format::List { list }
}

fn text(value: &str) -> Value {
    Value::Text(Arc::from(value))
}

fn assert_close(actual: f64, expected: f64) {
    assert!(
        (actual - expected).abs() < 1e-9,
        "expected {expected}, found {actual}"
    );
}

/// Regions {North America, Europe} (top level "All Regions") over Countries {US, CA in North
/// America; DE in Europe}, which has no top level.
struct World {
    fx: Fx,
    regions: ListId,
    countries: ListId,
    na: ItemId,
    eu: ItemId,
    us: ItemId,
    ca: ItemId,
    de: ItemId,
}

fn world() -> World {
    let mut fx = Fx::new(1);
    let regions = fx.list("Regions", None, Some("All Regions"));
    let countries = fx.list("Countries", Some(regions), None);
    let [na, eu] = fx.items(regions, &[("North America", None), ("Europe", None)])[..] else {
        unreachable!()
    };
    let [us, ca, de] = fx.items(
        countries,
        &[("US", Some(na)), ("CA", Some(na)), ("DE", Some(eu))],
    )[..] else {
        unreachable!()
    };
    World {
        fx,
        regions,
        countries,
        na,
        eu,
        us,
        ca,
        de,
    }
}

#[test]
fn price_times_volume() {
    let mut fx = Fx::new(1);
    let products = fx.list("Products", None, None);
    let [widget, gadget] = fx.items(products, &[("Widget", None), ("Gadget", None)])[..] else {
        unreachable!()
    };
    let sales = fx.module("Sales", vec![list_axis(products), month_axis()]);
    let units = fx.number(sales, "Units");
    let price = fx.number(sales, "Price");
    let revenue = fx.calc_number(sales, "Revenue", "Units * Price");
    fx.set_number(units, vec![item(widget), period("Jan 26")], 10.0);
    fx.set_number(price, vec![item(widget), period("Jan 26")], 2.5);
    fx.set_number(units, vec![item(gadget), period("Feb 26")], 4.0);
    fx.set_number(price, vec![item(gadget), period("Feb 26")], 3.0);
    fx.set_number(units, vec![item(gadget), period("Mar 26")], 7.0);

    fx.recalc();

    assert_eq!(
        fx.number_at(revenue, vec![item(widget), period("Jan 26")]),
        25.0
    );
    assert_eq!(
        fx.number_at(revenue, vec![item(gadget), period("Feb 26")]),
        12.0
    );
    // A cell with units but no price is zero, and so is one with neither.
    assert_eq!(
        fx.number_at(revenue, vec![item(gadget), period("Mar 26")]),
        0.0
    );
    assert_eq!(
        fx.number_at(revenue, vec![item(widget), period("Dec 26")]),
        0.0
    );
    assert!(fx.model.line_item_errors(revenue).is_none());
}

#[test]
fn division_by_zero_is_zero() {
    let mut fx = Fx::new(1);
    let module = fx.module("Ratios", vec![month_axis()]);
    let top = fx.number(module, "Top");
    let bottom = fx.number(module, "Bottom");
    let ratio = fx.calc_number(module, "Ratio", "Top / Bottom");
    let by_zero = fx.calc_number(module, "By Zero", "Top / 0");
    let negated = fx.calc_number(module, "Negated", "-Top / Bottom");
    fx.set_number(top, vec![period("Jan 26")], 10.0);
    fx.set_number(bottom, vec![period("Jan 26")], 4.0);
    fx.set_number(top, vec![period("Feb 26")], 10.0);

    fx.recalc();

    assert_eq!(fx.number_at(ratio, vec![period("Jan 26")]), 2.5);
    assert_eq!(fx.number_at(ratio, vec![period("Feb 26")]), 0.0);
    assert_eq!(fx.number_at(by_zero, vec![period("Jan 26")]), 0.0);
    assert_eq!(fx.number_at(negated, vec![period("Jan 26")]), -2.5);
    assert_eq!(fx.number_at(negated, vec![period("Feb 26")]), 0.0);
}

#[test]
fn if_selects_per_cell() {
    let mut fx = Fx::new(1);
    let module = fx.module("Checks", vec![month_axis()]);
    let units = fx.number(module, "Units");
    let picked = fx.calc_number(module, "Picked", "IF Units > 10 THEN Units * 2 ELSE -1");
    let big = fx.calc(
        module,
        "Big",
        Format::Boolean,
        "Units > 10 AND NOT (Units >= 100)",
    );
    let label = fx.calc(
        module,
        "Label",
        Format::Text,
        "IF Units > 10 THEN \"big\" ELSE \"small\"",
    );
    fx.set_number(units, vec![period("Jan 26")], 5.0);
    fx.set_number(units, vec![period("Feb 26")], 20.0);
    fx.set_number(units, vec![period("Mar 26")], 100.0);

    fx.recalc();

    assert_eq!(fx.number_at(picked, vec![period("Jan 26")]), -1.0);
    assert_eq!(fx.number_at(picked, vec![period("Feb 26")]), 40.0);
    assert_eq!(fx.number_at(picked, vec![period("Mar 26")]), 200.0);
    assert_eq!(fx.get(big, vec![period("Jan 26")]), Value::Boolean(false));
    assert_eq!(fx.get(big, vec![period("Feb 26")]), Value::Boolean(true));
    assert_eq!(fx.get(big, vec![period("Mar 26")]), Value::Boolean(false));
    assert_eq!(fx.text_at(label, vec![period("Jan 26")]), "small");
    assert_eq!(fx.text_at(label, vec![period("Feb 26")]), "big");
}

#[test]
fn broadcast_constant_and_target_only_axis() {
    let mut fx = Fx::new(1);
    let products = fx.list("Products", None, None);
    let [widget, gadget] = fx.items(products, &[("Widget", None), ("Gadget", None)])[..] else {
        unreachable!()
    };
    let settings = fx.module("Settings", Vec::new());
    let tax = fx.number(settings, "Tax");
    let rates = fx.module("Rates", vec![month_axis()]);
    let rate = fx.number(rates, "Rate");
    let sales = fx.module("Sales", vec![list_axis(products), month_axis()]);
    let units = fx.number(sales, "Units");
    let adjusted = fx.calc_number(sales, "Adjusted", "Units * Rate * Tax + 1");
    fx.set_number(tax, Vec::new(), 3.0);
    fx.set_number(rate, vec![period("Jan 26")], 2.0);
    fx.set_number(rate, vec![period("Feb 26")], 5.0);
    fx.set_number(units, vec![item(widget), period("Jan 26")], 10.0);
    fx.set_number(units, vec![item(gadget), period("Jan 26")], 20.0);
    fx.set_number(units, vec![item(gadget), period("Feb 26")], 1.0);

    fx.recalc();

    // The source has no Products axis, so every product reads the same rate; the source
    // without any axis reaches every cell; the constant is the same everywhere.
    assert_eq!(
        fx.number_at(adjusted, vec![item(widget), period("Jan 26")]),
        61.0
    );
    assert_eq!(
        fx.number_at(adjusted, vec![item(gadget), period("Jan 26")]),
        121.0
    );
    assert_eq!(
        fx.number_at(adjusted, vec![item(gadget), period("Feb 26")]),
        16.0
    );
    assert_eq!(
        fx.number_at(adjusted, vec![item(widget), period("Mar 26")]),
        1.0
    );
}

#[test]
fn aggregate_finer_list_to_parent() {
    let mut w = world();
    let detail = w.fx.module("Detail", vec![list_axis(w.countries)]);
    let revenue = w.fx.number(detail, "Revenue");
    let mut price = line_item(detail, "Price", Format::number(), None);
    price.summary = SummaryMethod::Average;
    let price = w.fx.add(price);
    let summary = w.fx.module("Summary", vec![list_axis(w.regions)]);
    let total = w.fx.calc_number(summary, "Total Revenue", "Revenue");
    let average = w.fx.calc_number(summary, "Average Price", "Price");
    for (country, amount, unit_price) in [(w.us, 10.0, 4.0), (w.ca, 20.0, 6.0), (w.de, 5.0, 9.0)] {
        w.fx.set_number(revenue, vec![item(country)], amount);
        w.fx.set_number(price, vec![item(country)], unit_price);
    }

    w.fx.recalc();

    assert_eq!(w.fx.number_at(total, vec![item(w.na)]), 30.0);
    assert_eq!(w.fx.number_at(total, vec![item(w.eu)]), 5.0);
    // The source's own summary method decides how the countries combine.
    assert_eq!(w.fx.number_at(average, vec![item(w.na)]), 5.0);
    assert_eq!(w.fx.number_at(average, vec![item(w.eu)]), 9.0);
}

#[test]
fn lookup_parent_value_from_child() {
    let mut w = world();
    let targets = w.fx.module("Targets", vec![list_axis(w.regions)]);
    let target = w.fx.number(targets, "Target");
    let detail = w.fx.module("Detail", vec![list_axis(w.countries)]);
    let regional = w.fx.calc_number(detail, "Regional Target", "Target");
    w.fx.set_number(target, vec![item(w.na)], 100.0);
    w.fx.set_number(target, vec![item(w.eu)], 50.0);

    w.fx.recalc();

    assert_eq!(w.fx.number_at(regional, vec![item(w.us)]), 100.0);
    assert_eq!(w.fx.number_at(regional, vec![item(w.ca)]), 100.0);
    assert_eq!(w.fx.number_at(regional, vec![item(w.de)]), 50.0);
}

#[test]
fn source_only_list_uses_top_level() {
    let mut w = world();
    let by_region =
        w.fx.module("By Region", vec![list_axis(w.regions), month_axis()]);
    let sales = w.fx.number(by_region, "Sales");
    let company = w.fx.module("Company", vec![month_axis()]);
    let total = w.fx.calc_number(company, "Total Sales", "Sales");
    let scalar = w.fx.module("Scalar", Vec::new());
    let grand = w.fx.calc_number(scalar, "Grand Total", "Sales");
    w.fx.set_number(sales, vec![item(w.na), period("Jan 26")], 30.0);
    w.fx.set_number(sales, vec![item(w.eu), period("Jan 26")], 5.0);
    w.fx.set_number(sales, vec![item(w.eu), period("Feb 26")], 7.0);

    w.fx.recalc();

    assert_eq!(w.fx.number_at(total, vec![period("Jan 26")]), 35.0);
    assert_eq!(w.fx.number_at(total, vec![period("Feb 26")]), 7.0);
    // The source's time axis is added up as well when the target has none.
    assert_eq!(w.fx.number_at(grand, Vec::new()), 42.0);
}

#[test]
fn source_only_list_without_top_level_errors() {
    let mut w = world();
    let detail = w.fx.module("Detail", vec![list_axis(w.countries)]);
    let revenue = w.fx.number(detail, "Revenue");
    let company = w.fx.module("Company", Vec::new());
    let total = w.fx.calc_number(company, "Total", "Revenue");
    w.fx.set_number(revenue, vec![item(w.us)], 10.0);

    let changes = w.fx.model.recalc_all().unwrap();

    let errors = w.fx.errors(total);
    assert_eq!(errors.len(), 1);
    assert_eq!(errors[0].code, "formula.dimension");
    assert_eq!(
        errors[0].message,
        "Use SUM, LOOKUP or SELECT to map dimension 'Countries'."
    );
    assert_eq!((errors[0].start, errors[0].end), (0, 7));
    assert_eq!(w.fx.number_at(total, Vec::new()), 0.0);
    assert!(changes.changed_line_items.contains(&total));
}

#[test]
fn time_coarser_source_applies_to_each_month() {
    let mut fx = Fx::new(2);
    let annual = fx.module("Annual", vec![time_axis(TimeLevel::Year)]);
    let budget = fx.number(annual, "Annual Budget");
    let quarterly = fx.module("Quarterly", vec![time_axis(TimeLevel::Quarter)]);
    let target = fx.number(quarterly, "Quarter Target");
    let monthly = fx.module("Monthly", vec![month_axis()]);
    let applied = fx.calc_number(monthly, "Budget Applied", "Annual Budget");
    let per_month = fx.calc_number(monthly, "Monthly Budget", "Annual Budget / 12");
    let quarter_applied = fx.calc_number(monthly, "Quarter Applied", "Quarter Target");
    fx.set_number(budget, vec![period("FY26")], 120.0);
    fx.set_number(budget, vec![period("FY27")], 240.0);
    fx.set_number(target, vec![period("Q1 FY26")], 30.0);
    fx.set_number(target, vec![period("Q2 FY26")], 60.0);

    fx.recalc();

    for label in ["Jan 26", "Jun 26", "Dec 26"] {
        assert_eq!(fx.number_at(applied, vec![period(label)]), 120.0, "{label}");
        assert_eq!(
            fx.number_at(per_month, vec![period(label)]),
            10.0,
            "{label}"
        );
    }
    for label in ["Jan 27", "Dec 27"] {
        assert_eq!(fx.number_at(applied, vec![period(label)]), 240.0, "{label}");
        assert_eq!(
            fx.number_at(per_month, vec![period(label)]),
            20.0,
            "{label}"
        );
    }
    for label in ["Jan 26", "Feb 26", "Mar 26"] {
        assert_eq!(fx.number_at(quarter_applied, vec![period(label)]), 30.0);
    }
    assert_eq!(fx.number_at(quarter_applied, vec![period("Apr 26")]), 60.0);
    assert_eq!(fx.number_at(quarter_applied, vec![period("Jul 26")]), 0.0);
}

#[test]
fn time_finer_source_aggregates() {
    let mut fx = Fx::new(2);
    let monthly = fx.module("Monthly", vec![month_axis()]);
    let revenue = fx.number(monthly, "Revenue");
    let mut balance = line_item(monthly, "Balance", Format::number(), None);
    balance.time_summary = Some(SummaryMethod::Last);
    let balance = fx.add(balance);
    let annual = fx.module("Annual", vec![time_axis(TimeLevel::Year)]);
    let yearly = fx.calc_number(annual, "Yearly Revenue", "Revenue");
    let closing = fx.calc_number(annual, "Closing Balance", "Balance");
    let everything = fx.module("Everything", Vec::new());
    let all_time = fx.calc_number(everything, "All Time Revenue", "Revenue");
    for month in 0..12 {
        let label = calendar(2).label(TimeLevel::Month, month);
        fx.set_number(revenue, vec![period(&label)], f64::from(month + 1));
        fx.set_number(balance, vec![period(&label)], 100.0 + f64::from(month));
    }
    fx.set_number(revenue, vec![period("Jan 27")], 1000.0);
    fx.set_number(balance, vec![period("Dec 27")], 7.0);

    fx.recalc();

    assert_eq!(fx.number_at(yearly, vec![period("FY26")]), 78.0);
    assert_eq!(fx.number_at(yearly, vec![period("FY27")]), 1000.0);
    // The time summary of the source decides: the last month, not the sum.
    assert_eq!(fx.number_at(closing, vec![period("FY26")]), 111.0);
    assert_eq!(fx.number_at(closing, vec![period("FY27")]), 7.0);
    assert_eq!(fx.number_at(all_time, Vec::new()), 1078.0);
}

#[test]
fn versions_switchover_reads_actual() {
    let mut fx = Fx::new(1);
    let module = fx.module("Finance", vec![month_axis(), AxisSpec::Versions]);
    let amount = fx.number(module, "Amount");
    let doubled = fx.calc_number(module, "Doubled", "Amount * 2");
    let budget = fx.model.structure().version_by_name("Budget").unwrap().id;
    fx.model
        .apply(Command::UpsertVersion {
            id: budget,
            name: "Budget".to_string(),
            is_actual: false,
            is_current: true,
            switchover: Some(3),
        })
        .unwrap();
    let (actual, budget, forecast) = (
        fx.version("Actual"),
        fx.version("Budget"),
        fx.version("Forecast"),
    );
    fx.set_number(amount, vec![period("Jan 26"), actual.clone()], 100.0);
    fx.set_number(amount, vec![period("Mar 26"), actual.clone()], 30.0);
    fx.set_number(amount, vec![period("Apr 26"), actual.clone()], 50.0);
    fx.set_number(amount, vec![period("Apr 26"), budget.clone()], 200.0);
    fx.set_number(amount, vec![period("Jan 26"), forecast.clone()], 9.0);

    fx.recalc();

    // The months before the switchover show Actual in the budget; the others do not.
    assert_eq!(
        fx.number_at(doubled, vec![period("Jan 26"), budget.clone()]),
        200.0
    );
    assert_eq!(
        fx.number_at(doubled, vec![period("Mar 26"), budget.clone()]),
        60.0
    );
    assert_eq!(
        fx.number_at(doubled, vec![period("Apr 26"), budget.clone()]),
        400.0
    );
    assert_eq!(
        fx.number_at(doubled, vec![period("Jan 26"), actual.clone()]),
        200.0
    );
    assert_eq!(fx.number_at(doubled, vec![period("Apr 26"), actual]), 100.0);
    assert_eq!(
        fx.number_at(doubled, vec![period("Jan 26"), forecast]),
        18.0
    );
}

#[test]
fn select_version_and_item() {
    let mut fx = Fx::new(1);
    let products = fx.list("Products", None, None);
    let [widget, gadget] = fx.items(products, &[("Widget", None), ("Gadget", None)])[..] else {
        unreachable!()
    };
    let fin = fx.module(
        "Finance",
        vec![list_axis(products), month_axis(), AxisSpec::Versions],
    );
    let revenue = fx.number(fin, "Revenue");
    let report = fx.module("Report", vec![month_axis()]);
    let budget_widget = fx.calc_number(
        report,
        "Budget Widget",
        "Revenue[SELECT: Versions.Budget, SELECT: Products.Widget]",
    );
    let actual_widget = fx.calc_number(
        report,
        "Actual Widget",
        "Revenue[SELECT: Products.Widget][SELECT: Versions.Actual]",
    );
    let (actual, budget) = (fx.version("Actual"), fx.version("Budget"));
    fx.set_number(
        revenue,
        vec![item(widget), period("Jan 26"), actual.clone()],
        100.0,
    );
    fx.set_number(
        revenue,
        vec![item(widget), period("Jan 26"), budget.clone()],
        150.0,
    );
    fx.set_number(
        revenue,
        vec![item(gadget), period("Jan 26"), budget.clone()],
        70.0,
    );
    fx.set_number(revenue, vec![item(widget), period("Feb 26"), budget], 8.0);

    fx.recalc();

    assert_eq!(fx.number_at(budget_widget, vec![period("Jan 26")]), 150.0);
    assert_eq!(fx.number_at(budget_widget, vec![period("Feb 26")]), 8.0);
    assert_eq!(fx.number_at(actual_widget, vec![period("Jan 26")]), 100.0);
    assert_eq!(fx.number_at(actual_widget, vec![period("Feb 26")]), 0.0);
}

#[test]
fn select_a_time_period() {
    let mut fx = Fx::new(1);
    let monthly = fx.module("Monthly", vec![month_axis()]);
    let revenue = fx.number(monthly, "Revenue");
    let year = fx.module("Year", vec![time_axis(TimeLevel::Year)]);
    let march = fx.calc_number(monthly, "March", "Revenue[SELECT: Time.'Mar 26']");
    let whole = fx.calc_number(year, "Whole Year", "Revenue[SELECT: Time.'FY26']");
    for month in 0..12 {
        let label = calendar(1).label(TimeLevel::Month, month);
        fx.set_number(revenue, vec![period(&label)], f64::from(month + 1));
    }

    fx.recalc();

    assert_eq!(fx.number_at(march, vec![period("Jan 26")]), 3.0);
    assert_eq!(fx.number_at(march, vec![period("Dec 26")]), 3.0);
    assert_eq!(fx.number_at(whole, vec![period("FY26")]), 78.0);
}

#[test]
fn a_source_with_versions_needs_a_selection() {
    let mut fx = Fx::new(1);
    let fin = fx.module("Finance", vec![month_axis(), AxisSpec::Versions]);
    let amount = fx.number(fin, "Amount");
    let report = fx.module("Report", vec![month_axis()]);
    let bad = fx.calc_number(report, "Unselected", "Amount");
    fx.set_number(amount, vec![period("Jan 26"), fx.version("Budget")], 5.0);

    fx.recalc();

    let errors = fx.errors(bad);
    assert_eq!(errors[0].code, "formula.dimension");
    assert_eq!(errors[0].message, "Use SELECT to choose a version.");
    assert_eq!(fx.number_at(bad, vec![period("Jan 26")]), 0.0);
}

#[test]
fn lookup_modifier() {
    let mut fx = Fx::new(1);
    let segments = fx.list("Segments", None, None);
    let [gold, silver] = fx.items(segments, &[("Gold", None), ("Silver", None)])[..] else {
        unreachable!()
    };
    let customers = fx.list("Customers", None, None);
    let [c1, c2, c3] = fx.items(customers, &[("C1", None), ("C2", None), ("C3", None)])[..] else {
        unreachable!()
    };
    let rates = fx.module("Segment Rates", vec![list_axis(segments)]);
    let discount = fx.number(rates, "Discount");
    let data = fx.module("Customer Data", vec![list_axis(customers)]);
    let segment = fx.input(data, "Segment", list_format(segments));
    let customer_discount = fx.calc_number(data, "Customer Discount", "Discount[LOOKUP: Segment]");
    fx.set_number(discount, vec![item(gold)], 0.1);
    fx.set_number(discount, vec![item(silver)], 0.05);
    fx.set(segment, vec![item(c1)], Value::Item(Some(gold)));
    fx.set(segment, vec![item(c2)], Value::Item(Some(silver)));

    fx.recalc();

    assert_close(fx.number_at(customer_discount, vec![item(c1)]), 0.1);
    assert_close(fx.number_at(customer_discount, vec![item(c2)]), 0.05);
    // A customer without a segment looks up nothing.
    assert_eq!(fx.number_at(customer_discount, vec![item(c3)]), 0.0);
}

#[test]
fn lookup_modifier_with_period_mapping() {
    let mut fx = Fx::new(1);
    let orders = fx.list("Orders", None, None);
    let [o1, o2] = fx.items(orders, &[("O1", None), ("O2", None)])[..] else {
        unreachable!()
    };
    let rates = fx.module("Rates", vec![month_axis()]);
    let rate = fx.number(rates, "Rate");
    let data = fx.module("Order Data", vec![list_axis(orders)]);
    let order_month = fx.input(
        data,
        "Order Month",
        Format::TimePeriod {
            level: TimeLevel::Month,
        },
    );
    let order_rate = fx.calc_number(data, "Order Rate", "Rate[LOOKUP: Order Month]");
    fx.set_number(rate, vec![period("Feb 26")], 7.0);
    fx.set_number(rate, vec![period("Mar 26")], 8.0);
    fx.set(
        order_month,
        vec![item(o1)],
        Value::Period(Some((TimeLevel::Month, 1))),
    );

    fx.recalc();

    assert_eq!(fx.number_at(order_rate, vec![item(o1)]), 7.0);
    assert_eq!(fx.number_at(order_rate, vec![item(o2)]), 0.0);
}

#[test]
fn sum_modifier_employee_to_department() {
    let mut fx = Fx::new(1);
    let employees = fx.list("Employees", None, None);
    let [ann, bob, cy] = fx.items(employees, &[("Ann", None), ("Bob", None), ("Cy", None)])[..]
    else {
        unreachable!()
    };
    let departments = fx.list("Departments", None, None);
    let [sales, eng] = fx.items(departments, &[("Sales", None), ("Eng", None)])[..] else {
        unreachable!()
    };
    let staff = fx.module("Staff", vec![list_axis(employees), month_axis()]);
    let salary = fx.number(staff, "Salary");
    let info = fx.module("Staff Info", vec![list_axis(employees)]);
    let dept = fx.input(info, "Dept", list_format(departments));
    let costs = fx.module("Costs", vec![list_axis(departments), month_axis()]);
    let payroll = fx.calc_number(costs, "Payroll", "Salary[SUM: Dept]");
    for (employee, department) in [(ann, sales), (bob, eng), (cy, sales)] {
        fx.set(dept, vec![item(employee)], Value::Item(Some(department)));
    }
    fx.set_number(salary, vec![item(ann), period("Jan 26")], 100.0);
    fx.set_number(salary, vec![item(bob), period("Jan 26")], 200.0);
    fx.set_number(salary, vec![item(cy), period("Jan 26")], 50.0);
    fx.set_number(salary, vec![item(ann), period("Feb 26")], 110.0);

    fx.recalc();

    assert_eq!(
        fx.number_at(payroll, vec![item(sales), period("Jan 26")]),
        150.0
    );
    assert_eq!(
        fx.number_at(payroll, vec![item(eng), period("Jan 26")]),
        200.0
    );
    assert_eq!(
        fx.number_at(payroll, vec![item(sales), period("Feb 26")]),
        110.0
    );
    assert_eq!(
        fx.number_at(payroll, vec![item(eng), period("Feb 26")]),
        0.0
    );
}

#[test]
fn aggregating_modifiers_combine_mapped_cells() {
    let mut fx = Fx::new(1);
    let employees = fx.list("Employees", None, None);
    let [ann, bob, cy, dee, fay, gus] = fx.items(
        employees,
        &[
            ("Ann", None),
            ("Bob", None),
            ("Cy", None),
            ("Dee", None),
            ("Fay", None),
            ("Gus", None),
        ],
    )[..] else {
        unreachable!()
    };
    let departments = fx.list("Departments", None, None);
    let [sales, eng, ops] = fx.items(
        departments,
        &[("Sales", None), ("Eng", None), ("Ops", None)],
    )[..] else {
        unreachable!()
    };
    let staff = fx.module("Staff", vec![list_axis(employees)]);
    let dept = fx.input(staff, "Dept", list_format(departments));
    let salary = fx.number(staff, "Salary");
    let active = fx.input(staff, "Active", Format::Boolean);
    let title = fx.input(staff, "Title", Format::Text);
    let costs = fx.module("Costs", vec![list_axis(departments)]);
    let average = fx.calc_number(costs, "Average Salary", "Salary[AVERAGE: Dept]");
    let lowest = fx.calc_number(costs, "Lowest", "Salary[MIN: Dept]");
    let highest = fx.calc_number(costs, "Highest", "Salary[MAX: Dept]");
    let any_active = fx.calc(costs, "Any Active", Format::Boolean, "Active[ANY: Dept]");
    let all_active = fx.calc(costs, "All Active", Format::Boolean, "Active[ALL: Dept]");
    let first = fx.calc(
        costs,
        "First Title",
        Format::Text,
        "Title[FIRSTNONBLANK: Dept]",
    );
    let last = fx.calc(
        costs,
        "Last Title",
        Format::Text,
        "Title[LASTNONBLANK: Dept]",
    );
    let titles = fx.calc(costs, "Titles", Format::Text, "Title[TEXTLIST: Dept]");
    let rows = [
        (ann, Some(sales), 100.0, true, "Lead"),
        (bob, Some(eng), 200.0, false, "Dev"),
        (cy, Some(sales), 50.0, false, ""),
        (dee, Some(sales), 70.0, true, "Intern"),
        (fay, Some(ops), 10.0, true, "Ops Lead"),
        (gus, None, 999.0, true, "Nobody"),
    ];
    for (employee, department, pay, is_active, name) in rows {
        if let Some(department) = department {
            fx.set(dept, vec![item(employee)], Value::Item(Some(department)));
        }
        fx.set_number(salary, vec![item(employee)], pay);
        fx.set(active, vec![item(employee)], Value::Boolean(is_active));
        fx.set(title, vec![item(employee)], text(name));
    }

    fx.recalc();

    assert_close(
        fx.number_at(average, vec![item(sales)]),
        (100.0 + 50.0 + 70.0) / 3.0,
    );
    assert_eq!(fx.number_at(average, vec![item(eng)]), 200.0);
    assert_eq!(fx.number_at(lowest, vec![item(sales)]), 50.0);
    assert_eq!(fx.number_at(highest, vec![item(sales)]), 100.0);
    assert_eq!(fx.get(any_active, vec![item(sales)]), Value::Boolean(true));
    assert_eq!(fx.get(any_active, vec![item(eng)]), Value::Boolean(false));
    assert_eq!(fx.get(all_active, vec![item(sales)]), Value::Boolean(false));
    assert_eq!(fx.get(all_active, vec![item(ops)]), Value::Boolean(true));
    assert_eq!(fx.text_at(first, vec![item(sales)]), "Lead");
    assert_eq!(fx.text_at(last, vec![item(sales)]), "Intern");
    assert_eq!(fx.text_at(titles, vec![item(sales)]), "Lead, Intern");
    assert_eq!(fx.text_at(titles, vec![item(ops)]), "Ops Lead");
    // Gus has no department, so nobody's salary includes his.
    assert_eq!(fx.number_at(highest, vec![item(ops)]), 10.0);
}

#[test]
fn sum_modifier_with_time_period_mapping() {
    let mut fx = Fx::new(1);
    let transactions = fx.list("Transactions", None, None);
    let [t1, t2, t3, t4] = fx.items(
        transactions,
        &[("T1", None), ("T2", None), ("T3", None), ("T4", None)],
    )[..] else {
        unreachable!()
    };
    let ledger = fx.module("Ledger", vec![list_axis(transactions)]);
    let amount = fx.number(ledger, "Amount");
    let booked = fx.input(
        ledger,
        "Booked In",
        Format::TimePeriod {
            level: TimeLevel::Month,
        },
    );
    let monthly = fx.module("Monthly", vec![month_axis()]);
    let total = fx.calc_number(monthly, "Total", "Amount[SUM: Booked In]");
    let jan = Value::Period(Some((TimeLevel::Month, 0)));
    let feb = Value::Period(Some((TimeLevel::Month, 1)));
    for (transaction, value, month) in [
        (t1, 10.0, Some(jan.clone())),
        (t2, 20.0, Some(jan)),
        (t3, 5.0, Some(feb)),
        (t4, 99.0, None),
    ] {
        fx.set_number(amount, vec![item(transaction)], value);
        if let Some(month) = month {
            fx.set(booked, vec![item(transaction)], month);
        }
    }

    fx.recalc();

    assert_eq!(fx.number_at(total, vec![period("Jan 26")]), 30.0);
    assert_eq!(fx.number_at(total, vec![period("Feb 26")]), 5.0);
    assert_eq!(fx.number_at(total, vec![period("Mar 26")]), 0.0);
}

#[test]
fn subset_axis_alignment() {
    let mut fx = Fx::new(1);
    let products = fx.list("Products", None, None);
    let [a, b, c] = fx.items(products, &[("A", None), ("B", None), ("C", None)])[..] else {
        unreachable!()
    };
    let core = fx.subset("Core", products, &[c, a]);
    let full = fx.module("Full", vec![list_axis(products)]);
    let units = fx.number(full, "Units");
    let core_module = fx.module("Core View", vec![AxisSpec::Subset { subset: core }]);
    let bonus = fx.number(core_module, "Bonus");
    let core_units = fx.calc_number(core_module, "Core Units", "Units");
    let full_bonus = fx.calc_number(full, "Full Bonus", "Bonus");
    fx.set_number(units, vec![item(a)], 1.0);
    fx.set_number(units, vec![item(b)], 2.0);
    fx.set_number(units, vec![item(c)], 3.0);
    fx.set_number(bonus, vec![item(a)], 10.0);
    fx.set_number(bonus, vec![item(c)], 30.0);

    fx.recalc();

    // The subset lists C before A; items are matched by identity, not by position.
    assert_eq!(fx.number_at(core_units, vec![item(a)]), 1.0);
    assert_eq!(fx.number_at(core_units, vec![item(c)]), 3.0);
    assert_eq!(fx.number_at(full_bonus, vec![item(a)]), 10.0);
    assert_eq!(fx.number_at(full_bonus, vec![item(c)]), 30.0);
    // An item outside the subset has nothing to read.
    assert_eq!(fx.number_at(full_bonus, vec![item(b)]), 0.0);
}

#[test]
fn subset_of_a_parent_list_aggregates_from_children() {
    let mut w = world();
    let europe_only = w.fx.subset("Europe Only", w.regions, &[w.eu]);
    let detail = w.fx.module("Detail", vec![list_axis(w.countries)]);
    let revenue = w.fx.number(detail, "Revenue");
    let view = w.fx.module(
        "View",
        vec![AxisSpec::Subset {
            subset: europe_only,
        }],
    );
    let total = w.fx.calc_number(view, "Regional Revenue", "Revenue");
    w.fx.set_number(revenue, vec![item(w.us)], 10.0);
    w.fx.set_number(revenue, vec![item(w.de)], 5.0);
    w.fx.set_number(revenue, vec![item(w.ca)], 1.0);

    w.fx.recalc();

    assert_eq!(w.fx.number_at(total, vec![item(w.eu)]), 5.0);
}

#[test]
fn text_concat_with_name() {
    let mut w = world();
    let detail = w.fx.module("Detail", vec![list_axis(w.countries)]);
    let region = w.fx.input(detail, "Home Region", list_format(w.regions));
    let label = w.fx.calc(
        detail,
        "Label",
        Format::Text,
        "\"Region: \" & Home Region & \" / \" & Regions.Europe & \" / \" & 5",
    );
    w.fx.set(region, vec![item(w.us)], Value::Item(Some(w.na)));

    w.fx.recalc();

    assert_eq!(
        w.fx.text_at(label, vec![item(w.us)]),
        "Region: North America / Europe / 5"
    );
    // A blank item reads as empty text.
    assert_eq!(
        w.fx.text_at(label, vec![item(w.de)]),
        "Region:  / Europe / 5"
    );
}

#[test]
fn item_and_period_constants_compare_with_cell_values() {
    let mut w = world();
    let detail =
        w.fx.module("Detail", vec![list_axis(w.regions), month_axis()]);
    let flagged = w.fx.calc(
        detail,
        "Flagged",
        Format::Boolean,
        "Regions.Europe = Regions.Europe AND Time.'Mar 26' > Time.'Feb 26'",
    );
    let owner = w.fx.input(detail, "Owner", list_format(w.regions));
    let owned = w.fx.calc(
        detail,
        "Owned By Europe",
        Format::Boolean,
        "Owner = Regions.Europe",
    );
    w.fx.set(
        owner,
        vec![item(w.na), period("Jan 26")],
        Value::Item(Some(w.eu)),
    );

    w.fx.recalc();

    assert_eq!(
        w.fx.get(flagged, vec![item(w.na), period("Jan 26")]),
        Value::Boolean(true)
    );
    assert_eq!(
        w.fx.get(owned, vec![item(w.na), period("Jan 26")]),
        Value::Boolean(true)
    );
    assert_eq!(
        w.fx.get(owned, vec![item(w.na), period("Feb 26")]),
        Value::Boolean(false)
    );
}

#[test]
fn time_ranges_align_by_calendar_month() {
    let mut fx = Fx::new(2);
    let range = TimeRangeId::new();
    fx.model
        .apply(Command::CreateTimeRange {
            id: range,
            name: "Second year".to_string(),
            first_year: 2027,
            years: 1,
        })
        .unwrap();
    let actuals = fx.module("Actuals", vec![month_axis()]);
    let revenue = fx.number(actuals, "Revenue");
    let plan = fx.module(
        "Plan",
        vec![AxisSpec::Time {
            level: TimeLevel::Month,
            range: Some(range),
        }],
    );
    let plan_input = fx.number(plan, "Plan Input");
    let plan_revenue = fx.calc_number(plan, "Plan Revenue", "Revenue");
    let back = fx.calc_number(actuals, "Back In", "Plan Input");
    fx.set_number(revenue, vec![period("Jan 26")], 1.0);
    fx.set_number(revenue, vec![period("Jan 27")], 2.0);
    fx.set_number(revenue, vec![period("Dec 27")], 3.0);
    fx.set_number(plan_input, vec![period("Feb 27")], 9.0);

    fx.recalc();

    assert_eq!(fx.number_at(plan_revenue, vec![period("Jan 27")]), 2.0);
    assert_eq!(fx.number_at(plan_revenue, vec![period("Dec 27")]), 3.0);
    assert_eq!(fx.number_at(back, vec![period("Feb 27")]), 9.0);
    assert_eq!(fx.number_at(back, vec![period("Feb 26")]), 0.0);
}

#[test]
fn restricted_versions_align_by_version() {
    let mut fx = Fx::new(1);
    let module = fx.module("Finance", vec![month_axis(), AxisSpec::Versions]);
    let amount = fx.number(module, "Amount");
    let forecast_id = fx.model.structure().version_by_name("Forecast").unwrap().id;
    let budget_id = fx.model.structure().version_by_name("Budget").unwrap().id;
    let mut narrow = line_item(module, "Narrow", Format::number(), Some("Amount * 1"));
    narrow.versions = VersionsScope::Only(vec![forecast_id, budget_id]);
    let narrow = fx.add(narrow);
    let mut limited = line_item(module, "Limited", Format::number(), None);
    limited.versions = VersionsScope::Only(vec![budget_id]);
    let limited = fx.add(limited);
    let widened = fx.calc_number(module, "Widened", "Limited");
    let (actual, budget, forecast) = (
        fx.version("Actual"),
        fx.version("Budget"),
        fx.version("Forecast"),
    );
    fx.set_number(amount, vec![period("Jan 26"), actual.clone()], 1.0);
    fx.set_number(amount, vec![period("Jan 26"), budget.clone()], 2.0);
    fx.set_number(amount, vec![period("Jan 26"), forecast.clone()], 3.0);
    fx.set_number(limited, vec![period("Jan 26"), budget.clone()], 4.0);

    fx.recalc();

    assert_eq!(
        fx.number_at(narrow, vec![period("Jan 26"), forecast.clone()]),
        3.0
    );
    assert_eq!(
        fx.number_at(narrow, vec![period("Jan 26"), budget.clone()]),
        2.0
    );
    assert_eq!(fx.number_at(widened, vec![period("Jan 26"), budget]), 4.0);
    assert_eq!(fx.number_at(widened, vec![period("Jan 26"), actual]), 0.0);
    assert_eq!(fx.number_at(widened, vec![period("Jan 26"), forecast]), 0.0);
}

#[test]
fn item_gives_the_coordinate_of_the_calculated_cell() {
    let mut fx = Fx::new(1);
    let products = fx.list("Products", None, None);
    let [widget, gadget, gizmo] = fx.items(
        products,
        &[("Widget", None), ("Gadget", None), ("Gizmo", None)],
    )[..] else {
        unreachable!()
    };
    let core = fx.subset("Core", products, &[gizmo, widget]);
    let module = fx.module(
        "Finance",
        vec![list_axis(products), month_axis(), AxisSpec::Versions],
    );
    let is_widget = fx.calc(
        module,
        "Is Widget",
        Format::Boolean,
        "ITEM(Products) = Products.Widget",
    );
    let is_budget = fx.calc(
        module,
        "Is Budget",
        Format::Boolean,
        "ITEM(Versions) = Versions.Budget",
    );
    let is_march = fx.calc(
        module,
        "Is March",
        Format::Boolean,
        "ITEM(Time) = Time.'Mar 26'",
    );
    let forecast_id = fx.model.structure().version_by_name("Forecast").unwrap().id;
    let budget_id = fx.model.structure().version_by_name("Budget").unwrap().id;
    let mut narrow = line_item(
        module,
        "Narrow Budget",
        Format::Boolean,
        Some("ITEM(Versions) = Versions.Budget"),
    );
    narrow.versions = VersionsScope::Only(vec![forecast_id, budget_id]);
    let narrow = fx.add(narrow);
    let core_module = fx.module("Core View", vec![AxisSpec::Subset { subset: core }]);
    let is_gizmo = fx.calc(
        core_module,
        "Is Gizmo",
        Format::Boolean,
        "ITEM(Products) = Products.Gizmo",
    );
    let (actual, budget, forecast) = (
        fx.version("Actual"),
        fx.version("Budget"),
        fx.version("Forecast"),
    );

    fx.recalc();

    let cell = |product: ItemId, month: &str, version: &CoordToken| {
        vec![item(product), period(month), version.clone()]
    };
    assert_eq!(
        fx.get(is_widget, cell(widget, "Jan 26", &actual)),
        Value::Boolean(true)
    );
    assert_eq!(
        fx.get(is_widget, cell(gadget, "Jan 26", &actual)),
        Value::Boolean(false)
    );
    assert_eq!(
        fx.get(is_budget, cell(gadget, "Feb 26", &budget)),
        Value::Boolean(true)
    );
    assert_eq!(
        fx.get(is_budget, cell(gadget, "Feb 26", &forecast)),
        Value::Boolean(false)
    );
    assert_eq!(
        fx.get(is_march, cell(gizmo, "Mar 26", &actual)),
        Value::Boolean(true)
    );
    assert_eq!(
        fx.get(is_march, cell(gizmo, "Apr 26", &actual)),
        Value::Boolean(false)
    );
    // A restricted Versions axis still names the version itself, not its position.
    assert_eq!(
        fx.get(narrow, cell(widget, "Jan 26", &budget)),
        Value::Boolean(true)
    );
    assert_eq!(
        fx.get(narrow, cell(widget, "Jan 26", &forecast)),
        Value::Boolean(false)
    );
    // A subset axis names the item, not its place in the subset.
    assert_eq!(fx.get(is_gizmo, vec![item(gizmo)]), Value::Boolean(true));
    assert_eq!(fx.get(is_gizmo, vec![item(widget)]), Value::Boolean(false));
}

#[test]
fn item_of_a_dimension_the_line_item_lacks_is_a_dimension_error() {
    let mut w = world();
    let products = w.fx.list("Products", None, None);
    w.fx.items(products, &[("Widget", None)]);
    let module = w.fx.module("Plain", vec![month_axis(), AxisSpec::Versions]);
    let detail = w.fx.module("Detail", vec![list_axis(w.countries)]);
    let no_list = w.fx.calc(
        module,
        "No List",
        Format::Boolean,
        "ITEM(Products) = Products.Widget",
    );
    let no_versions = w.fx.calc(
        detail,
        "No Versions",
        Format::Boolean,
        "ITEM(Versions) = Versions.Budget",
    );
    // A list in the same hierarchy as a dimension of the line item is not that dimension.
    let no_regions = w.fx.calc(
        detail,
        "No Regions",
        Format::Boolean,
        "ITEM(Regions) = Regions.Europe",
    );
    let fine = w.fx.calc(
        detail,
        "Fine",
        Format::Boolean,
        "ITEM(Countries) = Countries.US",
    );

    w.fx.recalc();

    let errors = w.fx.errors(no_list);
    assert_eq!(errors.len(), 1);
    assert_eq!(errors[0].code, "formula.dimension");
    assert_eq!(
        errors[0].message,
        "This formula's line item has no 'Products' dimension."
    );
    assert_eq!((errors[0].start, errors[0].end), (5, 13));
    let errors = w.fx.errors(no_versions);
    assert_eq!(errors[0].code, "formula.dimension");
    assert_eq!(
        errors[0].message,
        "This formula's line item has no 'Versions' dimension."
    );
    assert_eq!((errors[0].start, errors[0].end), (5, 13));
    let errors = w.fx.errors(no_regions);
    assert_eq!(
        errors[0].message,
        "This formula's line item has no 'Regions' dimension."
    );
    assert!(w.fx.model.line_item_errors(fine).is_none());
    assert_eq!(w.fx.get(fine, vec![item(w.us)]), Value::Boolean(true));
}

#[test]
fn axes_in_another_order_are_matched_by_dimension() {
    let mut w = world();
    let products = w.fx.list("Products", None, None);
    let [widget, gadget] = w.fx.items(products, &[("Widget", None), ("Gadget", None)])[..] else {
        unreachable!()
    };
    let by_product = w.fx.module(
        "By Product",
        vec![list_axis(products), list_axis(w.countries)],
    );
    let units = w.fx.number(by_product, "Units");
    let by_country = w.fx.module(
        "By Country",
        vec![list_axis(w.countries), list_axis(products)],
    );
    let swapped = w.fx.calc_number(by_country, "Swapped Units", "Units");
    w.fx.set_number(units, vec![item(widget), item(w.us)], 1.0);
    w.fx.set_number(units, vec![item(gadget), item(w.us)], 2.0);
    w.fx.set_number(units, vec![item(widget), item(w.de)], 3.0);

    w.fx.recalc();

    assert_eq!(w.fx.number_at(swapped, vec![item(w.us), item(widget)]), 1.0);
    assert_eq!(w.fx.number_at(swapped, vec![item(w.us), item(gadget)]), 2.0);
    assert_eq!(w.fx.number_at(swapped, vec![item(w.de), item(widget)]), 3.0);
    assert_eq!(w.fx.number_at(swapped, vec![item(w.de), item(gadget)]), 0.0);
}

#[test]
fn switchover_applies_to_sources_without_time() {
    let mut fx = Fx::new(1);
    let rates = fx.module("Rates", vec![AxisSpec::Versions]);
    let rate = fx.number(rates, "Rate");
    let module = fx.module("Finance", vec![month_axis(), AxisSpec::Versions]);
    let scaled = fx.calc_number(module, "Scaled", "Rate * 10");
    let budget_id = fx.model.structure().version_by_name("Budget").unwrap().id;
    fx.model
        .apply(Command::UpsertVersion {
            id: budget_id,
            name: "Budget".to_string(),
            is_actual: false,
            is_current: true,
            switchover: Some(2),
        })
        .unwrap();
    let (actual, budget) = (fx.version("Actual"), fx.version("Budget"));
    fx.set_number(rate, vec![actual.clone()], 1.0);
    fx.set_number(rate, vec![budget.clone()], 2.0);

    fx.recalc();

    assert_eq!(
        fx.number_at(scaled, vec![period("Feb 26"), budget.clone()]),
        10.0
    );
    assert_eq!(fx.number_at(scaled, vec![period("Mar 26"), budget]), 20.0);
    assert_eq!(fx.number_at(scaled, vec![period("Feb 26"), actual]), 10.0);
}

#[test]
fn concat_writes_numbers_and_dates_as_text() {
    let mut fx = Fx::new(1);
    let module = fx.module("Notes", vec![month_axis()]);
    let amount = fx.number(module, "Amount");
    let start = fx.input(module, "Start", Format::Date);
    let note = fx.calc(
        module,
        "Note",
        Format::Text,
        "Amount & \" from \" & Start & \"!\"",
    );
    fx.set_number(amount, vec![period("Jan 26")], 1.5);
    fx.set_number(amount, vec![period("Feb 26")], 0.1 + 0.2);
    fx.set(
        start,
        vec![period("Jan 26")],
        Value::Date(NaiveDate::from_ymd_opt(2026, 4, 1)),
    );

    fx.recalc();

    assert_eq!(
        fx.text_at(note, vec![period("Jan 26")]),
        "1.5 from 2026-04-01!"
    );
    assert_eq!(
        fx.text_at(note, vec![period("Feb 26")]),
        "0.30000000000000004 from !"
    );
    assert_eq!(fx.text_at(note, vec![period("Mar 26")]), "0 from !");
}

#[test]
fn structural_changes_drop_stale_calculated_values_until_recalculation() {
    let mut fx = Fx::new(1);
    let products = fx.list("Products", None, None);
    let [widget] = fx.items(products, &[("Widget", None)])[..] else {
        unreachable!()
    };
    let module = fx.module("Sales", vec![list_axis(products)]);
    let units = fx.number(module, "Units");
    let doubled = fx.calc_number(module, "Doubled", "Units * 2");
    fx.set_number(units, vec![item(widget)], 4.0);
    fx.recalc();
    assert_eq!(fx.number_at(doubled, vec![item(widget)]), 8.0);

    let gadget = fx.items(products, &[("Gadget", None)])[0];

    // The calculated cells no longer fit the line item's cells, so they read as blank.
    assert_eq!(fx.number_at(doubled, vec![item(widget)]), 0.0);
    assert_eq!(fx.number_at(doubled, vec![item(gadget)]), 0.0);
    fx.recalc();
    assert_eq!(fx.number_at(doubled, vec![item(widget)]), 8.0);
    assert_eq!(fx.number_at(doubled, vec![item(gadget)]), 0.0);

    fx.model
        .apply(Command::DeleteLineItem { id: units })
        .unwrap();
    fx.recalc();
    let errors = fx.errors(doubled);
    assert_eq!(errors[0].code, "formula.unknown_name");
    assert_eq!(fx.number_at(doubled, vec![item(widget)]), 0.0);
}

#[test]
fn a_formula_that_does_not_resolve_leaves_the_line_item_in_error() {
    let mut fx = Fx::new(1);
    let module = fx.module("Sales", vec![month_axis()]);
    let units = fx.number(module, "Units");
    let broken = fx.calc_number(module, "Broken", "Unitz + 1");
    fx.set_number(units, vec![period("Jan 26")], 4.0);

    fx.recalc();

    let errors = fx.errors(broken);
    assert_eq!(errors[0].code, "formula.unknown_name");
    assert_eq!(fx.number_at(broken, vec![period("Jan 26")]), 0.0);
    assert!(fx.model.line_item_errors(units).is_none());

    fx.model
        .apply(Command::UpdateLineItem {
            id: broken,
            patch: LineItemPatch {
                formula: Some(Some("Units + 1".to_string())),
                ..LineItemPatch::default()
            },
        })
        .unwrap();
    fx.recalc();

    assert!(fx.model.line_item_errors(broken).is_none());
    assert_eq!(fx.number_at(broken, vec![period("Jan 26")]), 5.0);
}

#[test]
fn functions_are_reported_as_not_available_yet() {
    let mut fx = Fx::new(1);
    let module = fx.module("Sales", vec![month_axis()]);
    let units = fx.number(module, "Units");
    let wrapped = fx.calc_number(module, "Wrapped", "ABS(Units)");
    fx.set_number(units, vec![period("Jan 26")], -4.0);

    fx.recalc();

    let errors = fx.errors(wrapped);
    assert_eq!(errors[0].message, "Function ABS is not available yet.");
    assert_eq!(fx.number_at(wrapped, vec![period("Jan 26")]), 0.0);
}

#[test]
fn recalculation_reports_the_line_items_it_computed() {
    let mut fx = Fx::new(1);
    let module = fx.module("Sales", vec![month_axis()]);
    let units = fx.number(module, "Units");
    let doubled = fx.calc_number(module, "Doubled", "Units * 2");
    let tripled = fx.calc_number(module, "Tripled", "Units * 3");
    let before = fx.model.generation();

    let changes = fx.model.recalc_all().unwrap();

    assert!(changes.changed_line_items.contains(&doubled));
    assert!(changes.changed_line_items.contains(&tripled));
    assert!(!changes.changed_line_items.contains(&units));
    assert!(!changes.structure_changed);
    assert_eq!(changes.generation, fx.model.generation());
    assert!(changes.generation > before);
}

#[test]
fn summaries_of_calculated_line_items_follow_recalculation() {
    let mut w = world();
    let detail = w.fx.module("Detail", vec![list_axis(w.countries)]);
    let revenue = w.fx.number(detail, "Revenue");
    let doubled = w.fx.calc_number(detail, "Doubled", "Revenue * 2");
    w.fx.set_number(revenue, vec![item(w.us)], 10.0);
    w.fx.set_number(revenue, vec![item(w.ca)], 20.0);
    let by_region = LevelSpec(vec![Axis::List(w.regions)]);
    let read = |fx: &Fx| match fx
        .model
        .read_summary(doubled, &[item(w.na)], &by_region)
        .unwrap()
    {
        Value::Number(number) => number,
        other => panic!("expected a number, found {other:?}"),
    };

    assert_eq!(read(&w.fx), 0.0);
    w.fx.recalc();
    assert_eq!(read(&w.fx), 60.0);
    w.fx.set_number(revenue, vec![item(w.us)], 15.0);
    w.fx.recalc();
    assert_eq!(read(&w.fx), 70.0);
}

#[test]
fn chaining_formulas_uses_calculated_sources() {
    let mut fx = Fx::new(1);
    let module = fx.module("Sales", vec![month_axis()]);
    let units = fx.number(module, "Units");
    let doubled = fx.calc_number(module, "Doubled", "Units * 2");
    let plus_one = fx.calc_number(module, "Plus One", "Doubled + 1");
    let yearly = fx.module("Yearly", vec![time_axis(TimeLevel::Year)]);
    let total = fx.calc_number(yearly, "Total Plus One", "Plus One");
    fx.set_number(units, vec![period("Jan 26")], 3.0);
    fx.set_number(units, vec![period("Feb 26")], 4.0);

    fx.recalc();

    assert_eq!(fx.number_at(doubled, vec![period("Jan 26")]), 6.0);
    assert_eq!(fx.number_at(plus_one, vec![period("Jan 26")]), 7.0);
    assert_eq!(fx.number_at(plus_one, vec![period("Mar 26")]), 1.0);
    assert_eq!(fx.number_at(total, vec![period("FY26")]), 7.0 + 9.0 + 10.0);
}

#[test]
fn a_million_cells_evaluate_in_chunks() {
    let mut fx = Fx::new(20);
    let products = fx.list("Products", None, None);
    let names: Vec<String> = (0..5000).map(|n| format!("P{n}")).collect();
    let specs: Vec<(&str, Option<ItemId>)> =
        names.iter().map(|name| (name.as_str(), None)).collect();
    let ids = fx.items(products, &specs);
    let sales = fx.module("Sales", vec![list_axis(products), month_axis()]);
    let units = fx.number(sales, "Units");
    let price = fx.number(sales, "Price");
    let revenue = fx.calc_number(sales, "Revenue", "Units * Price");
    let last = ids.len() - 1;
    let cells = [
        (0, "Jan 26"),
        (1, "Feb 26"),
        (2500, "Jun 30"),
        (last, "Dec 45"),
    ];
    for (position, (product, label)) in cells.into_iter().enumerate() {
        let coords = vec![item(ids[product]), period(label)];
        fx.set_number(units, coords.clone(), 2.0 + position as f64);
        fx.set_number(price, coords, 10.0);
    }
    assert_eq!(fx.model.structure().calendar.months(), 240);

    let started = Instant::now();
    fx.recalc();
    println!(
        "Revenue = Units * Price over {} cells: {:?}",
        5000 * 240,
        started.elapsed()
    );

    for (position, (product, label)) in cells.into_iter().enumerate() {
        let expected = (2.0 + position as f64) * 10.0;
        let coords = vec![item(ids[product]), period(label)];
        assert_eq!(fx.number_at(revenue, coords), expected);
    }
    assert_eq!(
        fx.number_at(revenue, vec![item(ids[last]), period("Nov 45")]),
        0.0
    );
}
