//! The time, version, rank and finance functions (spec §4.5), evaluated through the model.

use std::collections::HashSet;
use std::sync::Arc;

use chrono::NaiveDate;
use openplan_engine::{
    AxisSpec, Calendar, CellEdit, Command, CoordToken, EngineError, Format, FormulaError, ItemId,
    ItemSpec, LineItem, LineItemId, ListId, Model, ModuleId, SubsetId, SummaryMethod, TimeLevel,
    TimeRangeId, TimeScale, Value, VersionsScope, functions,
};

fn calendar(fiscal_year_start_month: u8, first_year: i32, years: u8) -> Calendar {
    Calendar {
        fiscal_year_start_month,
        first_year,
        years,
        current_month: None,
    }
}

fn item(id: ItemId) -> CoordToken {
    CoordToken::Item(id)
}

fn text(value: &str) -> Value {
    Value::Text(Arc::from(value))
}

fn date(year: i32, month: u32, day: u32) -> Option<NaiveDate> {
    NaiveDate::from_ymd_opt(year, month, day)
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

fn assert_close(actual: f64, expected: f64) {
    assert!(
        (actual - expected).abs() <= 1e-9 * expected.abs().max(1.0),
        "expected {expected}, found {actual}"
    );
}

fn assert_all_close(actual: &[f64], expected: &[f64]) {
    assert_eq!(actual.len(), expected.len());
    for (actual, expected) in actual.iter().zip(expected) {
        assert_close(*actual, *expected);
    }
}

/// A model with the module `Sheet` on a monthly Time axis, where inputs are set in the first
/// months and formulas are read back.
struct Book {
    model: Model,
    cal: Calendar,
    sheet: ModuleId,
    outputs: usize,
}

impl Book {
    /// Jan 26 to Dec 27.
    fn new() -> Book {
        Book::with_calendar(calendar(1, 2026, 2))
    }

    fn with_calendar(cal: Calendar) -> Book {
        let mut book = Book {
            model: Model::new(cal),
            cal,
            sheet: ModuleId::new(),
            outputs: 0,
        };
        book.sheet = book.module("Sheet", vec![month_axis()]);
        book
    }

    /// The coordinate of the `i`th period of `level` of the model calendar.
    fn level(&self, level: TimeLevel, i: usize) -> CoordToken {
        CoordToken::Period(self.cal.label(level, i as u32))
    }

    fn month(&self, i: usize) -> CoordToken {
        self.level(TimeLevel::Month, i)
    }

    fn version(&self, name: &str) -> CoordToken {
        let version = self.model.structure().version_by_name(name).unwrap();
        CoordToken::Item(ItemId(version.id.0))
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

    fn list(&mut self, name: &str, items: &[&str]) -> (ListId, Vec<ItemId>) {
        let list = ListId::new();
        self.model
            .apply(Command::CreateList {
                id: list,
                name: name.to_string(),
                parent: None,
                top_level_name: None,
                numbered: false,
                production_data: false,
            })
            .unwrap();
        let specs: Vec<ItemSpec> = items
            .iter()
            .map(|name| ItemSpec {
                id: ItemId::new(),
                code: None,
                name: (*name).to_string(),
                parent: None,
            })
            .collect();
        let ids = specs.iter().map(|spec| spec.id).collect();
        self.model
            .apply(Command::UpsertListItems { list, items: specs })
            .unwrap();
        (list, ids)
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

    fn set(&mut self, line_item: LineItemId, coords: Vec<CoordToken>, value: Value) {
        self.set_all(line_item, vec![(coords, value)]);
    }

    fn set_number(&mut self, line_item: LineItemId, coords: Vec<CoordToken>, value: f64) {
        self.set(line_item, coords, Value::Number(value));
    }

    fn set_all(&mut self, line_item: LineItemId, cells: Vec<(Vec<CoordToken>, Value)>) {
        let edits = cells
            .into_iter()
            .map(|(coords, value)| CellEdit { coords, value })
            .collect();
        self.model
            .apply(Command::SetCells { line_item, edits })
            .unwrap();
    }

    fn recalc(&mut self) {
        self.model.recalc_all().unwrap();
    }

    /// An input of `Sheet` holding `values` in its first months.
    fn input_series(&mut self, name: &str, format: Format, values: Vec<Value>) -> LineItemId {
        let id = self.input(self.sheet, name, format);
        let cells = values
            .into_iter()
            .enumerate()
            .map(|(i, value)| (vec![self.month(i)], value))
            .collect();
        self.set_all(id, cells);
        id
    }

    fn series(&mut self, name: &str, values: &[f64]) -> LineItemId {
        let values = values.iter().map(|&number| Value::Number(number)).collect();
        self.input_series(name, Format::number(), values)
    }

    /// A calculated line item, which must be valid, with its values calculated.
    fn calc_in(&mut self, module: ModuleId, format: Format, formula: &str) -> LineItemId {
        let id = self.errors_in_id(module, format, formula);
        if let Some(errors) = self.model.line_item_errors(id) {
            panic!("{formula} should be valid: {errors:?}");
        }
        id
    }

    fn errors_in_id(&mut self, module: ModuleId, format: Format, formula: &str) -> LineItemId {
        self.outputs += 1;
        let name = format!("Out {}", self.outputs);
        let id = self.add(line_item(module, &name, format, Some(formula)));
        self.recalc();
        id
    }

    /// What is wrong with a formula, which the model refuses for a new line item.
    fn errors_in(&mut self, module: ModuleId, format: Format, formula: &str) -> Vec<FormulaError> {
        self.outputs += 1;
        let name = format!("Out {}", self.outputs);
        let line_item = line_item(module, &name, format, Some(formula));
        match self.model.apply(Command::CreateLineItem(line_item)) {
            Err(EngineError::Formula(errors)) => errors,
            other => panic!("{formula} should be rejected, found {other:?}"),
        }
    }

    fn read(&self, line_item: LineItemId, coords: Vec<Vec<CoordToken>>) -> Vec<Value> {
        self.model.read_cells(line_item, &coords).unwrap()
    }

    fn value_at(&self, line_item: LineItemId, coords: Vec<CoordToken>) -> Value {
        self.read(line_item, vec![coords]).pop().unwrap()
    }

    fn number_at(&self, line_item: LineItemId, coords: Vec<CoordToken>) -> f64 {
        match self.value_at(line_item, coords) {
            Value::Number(number) => number,
            other => panic!("expected a number, found {other:?}"),
        }
    }

    fn numbers_at(&self, line_item: LineItemId, coords: Vec<Vec<CoordToken>>) -> Vec<f64> {
        self.read(line_item, coords)
            .into_iter()
            .map(|value| match value {
                Value::Number(number) => number,
                other => panic!("expected a number, found {other:?}"),
            })
            .collect()
    }

    /// The first `count` months of a formula on `Sheet`, which must be valid.
    fn calc(&mut self, format: Format, formula: &str, count: usize) -> Vec<Value> {
        let sheet = self.sheet;
        let id = self.calc_in(sheet, format, formula);
        let coords = (0..count).map(|i| vec![self.month(i)]).collect();
        self.read(id, coords)
    }

    fn numbers(&mut self, formula: &str, count: usize) -> Vec<f64> {
        self.calc(Format::number(), formula, count)
            .into_iter()
            .map(|value| match value {
                Value::Number(number) => number,
                other => panic!("expected a number, found {other:?}"),
            })
            .collect()
    }

    fn texts(&mut self, formula: &str, count: usize) -> Vec<String> {
        self.calc(Format::Text, formula, count)
            .into_iter()
            .map(|value| match value {
                Value::Text(text) => text.to_string(),
                other => panic!("expected text, found {other:?}"),
            })
            .collect()
    }

    fn flags(&mut self, formula: &str, count: usize) -> Vec<bool> {
        self.calc(Format::Boolean, formula, count)
            .into_iter()
            .map(|value| match value {
                Value::Boolean(flag) => flag,
                other => panic!("expected a boolean, found {other:?}"),
            })
            .collect()
    }

    fn dates(&mut self, formula: &str, count: usize) -> Vec<Option<NaiveDate>> {
        self.calc(Format::Date, formula, count)
            .into_iter()
            .map(|value| match value {
                Value::Date(date) => date,
                other => panic!("expected a date, found {other:?}"),
            })
            .collect()
    }
}

/// 1, 2, ... 24: one number per month of the two-year calendar.
fn sequence() -> Vec<f64> {
    (1..=24).map(f64::from).collect()
}

#[test]
fn previous_and_offset_defaults() {
    let mut book = Book::new();
    book.series("Rev", &[10.0, 20.0, 30.0, 40.0]);

    assert_eq!(
        book.numbers("PREVIOUS(Rev)", 6),
        [0.0, 10.0, 20.0, 30.0, 40.0, 0.0]
    );
    assert_eq!(
        book.numbers("NEXT(Rev)", 6),
        [20.0, 30.0, 40.0, 0.0, 0.0, 0.0]
    );
    assert_eq!(
        book.numbers("PREVIOUS(PREVIOUS(Rev))", 6),
        [0.0, 0.0, 10.0, 20.0, 30.0, 40.0]
    );

    // OFFSET and LEAD read forwards when the number is positive, LAG backwards; beyond the
    // timeline they give the default.
    assert_eq!(
        book.numbers("OFFSET(Rev, -1, 99)", 5),
        [99.0, 10.0, 20.0, 30.0, 40.0]
    );
    assert_eq!(
        book.numbers("OFFSET(Rev, 1, 99)", 4),
        [20.0, 30.0, 40.0, 0.0]
    );
    assert_eq!(book.numbers("OFFSET(Rev, 1, 99)", 24)[23], 99.0);
    assert_eq!(
        book.numbers("LAG(Rev, 2, 7)", 6),
        [7.0, 7.0, 10.0, 20.0, 30.0, 40.0]
    );
    let lead = book.numbers("LEAD(Rev, 2, 5)", 24);
    assert_eq!(lead[..4], [30.0, 40.0, 0.0, 0.0]);
    assert_eq!(lead[22..], [5.0, 5.0]);
    assert_eq!(
        book.numbers("OFFSET(Rev, 0, 99)", 5),
        [10.0, 20.0, 30.0, 40.0, 0.0]
    );
}

#[test]
fn offsets_may_vary_by_cell() {
    let mut book = Book::new();
    book.series("Rev", &[10.0, 20.0, 30.0, 40.0]);
    book.series("Shift", &[1.0, 0.0, -1.0, 2.0, 0.0]);

    // Cells 0 to 4 read the cells 1, 1, 1, 5 and 4.
    assert_eq!(
        book.numbers("OFFSET(Rev, Shift, -1)", 5),
        [20.0, 20.0, 20.0, 0.0, 0.0]
    );
    // The default is a value per cell too.
    assert_eq!(
        book.numbers("OFFSET(Rev, -1, Rev * 2)", 5),
        [20.0, 10.0, 20.0, 30.0, 40.0]
    );
    // A number of periods is whole: a fraction is dropped towards zero.
    assert_eq!(
        book.numbers("OFFSET(Rev, 1.9, 0)", 4),
        [20.0, 30.0, 40.0, 0.0]
    );
    assert_eq!(
        book.numbers("OFFSET(Rev, -1.9, 0)", 4),
        [0.0, 10.0, 20.0, 30.0]
    );
    // And one that reaches past any timeline is just beyond it.
    assert_eq!(book.numbers("OFFSET(Rev, 1.7e308, 5)", 2), [5.0, 5.0]);
    assert_eq!(book.numbers("LAG(Rev, 1.7e308, 5)", 2), [5.0, 5.0]);
    assert_eq!(book.numbers("LEAD(Rev, -1.7e308, 5)", 2), [5.0, 5.0]);
}

#[test]
fn previous_and_offset_of_other_types() {
    let mut book = Book::new();
    book.input_series("Label", Format::Text, vec![text("a"), text("b"), text("c")]);
    book.input_series(
        "Flag",
        Format::Boolean,
        vec![
            Value::Boolean(true),
            Value::Boolean(false),
            Value::Boolean(true),
        ],
    );
    book.input_series(
        "Invoice Date",
        Format::Date,
        vec![
            Value::Date(date(2026, 1, 15)),
            Value::Date(date(2026, 2, 20)),
        ],
    );

    assert_eq!(book.texts("PREVIOUS(Label)", 4), ["", "a", "b", "c"]);
    assert_eq!(
        book.texts("OFFSET(Label, -1, \"none\")", 4),
        ["none", "a", "b", "c"]
    );
    assert_eq!(book.flags("PREVIOUS(Flag)", 4), [false, true, false, true]);
    assert_eq!(
        book.flags("LAG(Flag, 1, TRUE)", 4),
        [true, true, false, true]
    );
    assert_eq!(
        book.dates("PREVIOUS(Invoice Date)", 3),
        [None, date(2026, 1, 15), date(2026, 2, 20)]
    );
}

#[test]
fn shifts_follow_the_conditions_around_them() {
    let mut book = Book::new();
    book.series("Rev", &[10.0, 20.0, 30.0, 40.0]);

    assert_eq!(
        book.numbers("Rev + PREVIOUS(Rev) * 2", 4),
        [10.0, 40.0, 70.0, 100.0]
    );
    assert_eq!(
        book.numbers("IF PREVIOUS(Rev) > 15 THEN 1 ELSE 0", 4),
        [0.0, 0.0, 1.0, 1.0]
    );
    assert_eq!(
        book.numbers("IF Rev > 25 THEN PREVIOUS(Rev) ELSE NEXT(Rev)", 4),
        [20.0, 30.0, 20.0, 30.0]
    );
}

#[test]
fn cumulate_and_movingsum() {
    let mut book = Book::new();
    book.series("Rev", &[10.0, 20.0, 30.0, 40.0]);
    book.series("Seq", &sequence());

    assert_eq!(
        book.numbers("CUMULATE(Rev)", 6),
        [10.0, 30.0, 60.0, 100.0, 100.0, 100.0]
    );
    assert_eq!(
        book.numbers("MOVINGSUM(Rev, -1, 0)", 6),
        [10.0, 30.0, 50.0, 70.0, 40.0, 0.0]
    );
    assert_eq!(
        book.numbers("MOVINGSUM(Rev, 0, 2)", 6),
        [60.0, 90.0, 70.0, 40.0, 0.0, 0.0]
    );

    // The window is clipped to the timeline at both ends, and it is empty when it ends before it
    // starts.
    let seq = sequence();
    for (from, to) in [
        (-2, 0),
        (0, 2),
        (-1, 1),
        (3, 5),
        (-5, -3),
        (-30, 30),
        (2, -2),
    ] {
        let expected: Vec<f64> = (0..24_i64)
            .map(|t| {
                (t + from..=t + to)
                    .filter(|&at| (0..24).contains(&at))
                    .map(|at| seq[at as usize])
                    .sum()
            })
            .collect();
        let formula = format!("MOVINGSUM(Seq, {from}, {to})");
        assert_eq!(book.numbers(&formula, 24), expected, "{formula}");
    }
    assert_eq!(book.numbers("MOVINGSUM(Seq, -2, 0)", 24)[23], 69.0);
    assert_eq!(book.numbers("MOVINGSUM(Seq, 0, 2)", 24)[23], 24.0);
}

#[test]
fn movingsum_windows_may_vary_by_cell() {
    let mut book = Book::new();
    book.series("Seq", &sequence());
    book.series("Back", &[0.0, 1.0, 2.0, 3.0]);

    // Cell `t` adds up the months from `t - Back` to `t`, clipped to the timeline.
    assert_eq!(
        book.numbers("MOVINGSUM(Seq, -Back, 0)", 4),
        [1.0, 3.0, 6.0, 10.0]
    );
    // A window can reach past any timeline without trouble.
    assert_eq!(
        book.numbers("MOVINGSUM(Seq, -1.7e308, 1.7e308)", 2),
        [300.0, 300.0]
    );
}

#[test]
fn running_totals_that_overflow_start_again_from_zero() {
    let mut book = Book::new();

    assert_eq!(
        book.numbers("CUMULATE(1.7e308)", 4),
        [1.7e308, 0.0, 1.7e308, 0.0]
    );
}

#[test]
fn scans_work_per_line_of_the_other_axes() {
    let mut book = Book::new();
    let (products, ids) = book.list("Products", &["A", "B"]);
    let sales = book.module(
        "Sales",
        vec![list_axis(products), month_axis(), AxisSpec::Versions],
    );
    let units = book.input(sales, "Units", Format::number());
    let (actual, budget) = (book.version("Actual"), book.version("Budget"));
    for (product, month, version, value) in [
        (0, 0, &actual, 1.0),
        (0, 1, &actual, 2.0),
        (0, 0, &budget, 10.0),
        (0, 1, &budget, 20.0),
        (1, 0, &actual, 100.0),
        (1, 1, &actual, 200.0),
    ] {
        let coords = vec![item(ids[product]), book.month(month), version.clone()];
        book.set_number(units, coords, value);
    }
    let cumulative = book.calc_in(sales, Format::number(), "CUMULATE(Units)");
    let previous = book.calc_in(sales, Format::number(), "PREVIOUS(Units)");
    let window = book.calc_in(sales, Format::number(), "MOVINGSUM(Units, -1, 0)");
    let year = book.calc_in(sales, Format::number(), "YEARVALUE(Units)");
    let to_date = book.calc_in(sales, Format::number(), "YEARTODATE(Units)");

    let at = |book: &Book, line_item, product: usize, month: usize, version: &CoordToken| {
        book.number_at(
            line_item,
            vec![item(ids[product]), book.month(month), version.clone()],
        )
    };
    // Every product and every version is its own line through time.
    assert_eq!(at(&book, cumulative, 0, 1, &actual), 3.0);
    assert_eq!(at(&book, cumulative, 0, 1, &budget), 30.0);
    assert_eq!(at(&book, cumulative, 1, 1, &actual), 300.0);
    assert_eq!(at(&book, cumulative, 1, 0, &actual), 100.0);
    assert_eq!(at(&book, cumulative, 1, 5, &budget), 0.0);
    assert_eq!(at(&book, previous, 0, 0, &actual), 0.0);
    assert_eq!(at(&book, previous, 0, 1, &budget), 10.0);
    assert_eq!(at(&book, previous, 1, 0, &actual), 0.0);
    assert_eq!(at(&book, previous, 1, 1, &actual), 100.0);
    assert_eq!(at(&book, window, 0, 1, &budget), 30.0);
    assert_eq!(at(&book, window, 1, 0, &actual), 100.0);
    assert_eq!(at(&book, year, 0, 0, &actual), 3.0);
    assert_eq!(at(&book, year, 0, 9, &actual), 3.0);
    assert_eq!(at(&book, year, 0, 5, &budget), 30.0);
    assert_eq!(at(&book, year, 1, 11, &actual), 300.0);
    assert_eq!(at(&book, year, 1, 11, &budget), 0.0);
    assert_eq!(at(&book, year, 0, 12, &actual), 0.0);
    assert_eq!(at(&book, to_date, 0, 1, &budget), 30.0);
    assert_eq!(at(&book, to_date, 0, 7, &actual), 3.0);
    assert_eq!(at(&book, to_date, 1, 0, &actual), 100.0);
    assert_eq!(at(&book, to_date, 1, 1, &actual), 300.0);
}

#[test]
fn shifts_and_scans_work_over_more_than_one_chunk() {
    const PRODUCTS: usize = 300;
    let mut book = Book::new();
    let names: Vec<String> = (0..PRODUCTS).map(|i| format!("P{i}")).collect();
    let names: Vec<&str> = names.iter().map(String::as_str).collect();
    let (products, ids) = book.list("Products", &names);
    let sales = book.module("Sales", vec![list_axis(products), month_axis()]);
    let units = book.input(sales, "Units", Format::number());
    let value = |product: usize, month: usize| (product * 100 + month + 1) as f64;
    let mut cells = Vec::new();
    for (product, id) in ids.iter().enumerate() {
        for month in 0..24 {
            cells.push((
                vec![item(*id), book.month(month)],
                Value::Number(value(product, month)),
            ));
        }
    }
    book.set_all(units, cells);
    let previous = book.calc_in(sales, Format::number(), "PREVIOUS(Units)");
    let cumulative = book.calc_in(sales, Format::number(), "CUMULATE(Units)");
    let ytd = book.calc_in(sales, Format::number(), "YEARTODATE(Units)");
    let year = book.calc_in(sales, Format::number(), "YEARVALUE(Units)");
    let window = book.calc_in(sales, Format::number(), "MOVINGSUM(Units, -2, 1)");

    let coords: Vec<Vec<CoordToken>> = ids
        .iter()
        .flat_map(|id| (0..24).map(|month| vec![item(*id), book.month(month)]))
        .collect();
    let read = |li| book.numbers_at(li, coords.clone());
    let (previous, cumulative, ytd, year, window) = (
        read(previous),
        read(cumulative),
        read(ytd),
        read(year),
        read(window),
    );
    for product in 0..PRODUCTS {
        let column = |month: usize| product * 24 + month;
        for month in 0..24 {
            let upto = |from: usize, to: usize| -> f64 {
                (from..=to.min(23)).map(|m| value(product, m)).sum()
            };
            let at = column(month);
            let expected_previous = if month == 0 {
                0.0
            } else {
                value(product, month - 1)
            };
            assert_eq!(
                previous[at], expected_previous,
                "PREVIOUS {product} {month}"
            );
            assert_eq!(cumulative[at], upto(0, month), "CUMULATE {product} {month}");
            assert_eq!(
                ytd[at],
                upto(month / 12 * 12, month),
                "YTD {product} {month}"
            );
            assert_eq!(
                year[at],
                upto(month / 12 * 12, month / 12 * 12 + 11),
                "YEARVALUE {product} {month}"
            );
            assert_eq!(
                window[at],
                upto(month.saturating_sub(2), month + 1),
                "MOVINGSUM {product} {month}"
            );
        }
    }
}

#[test]
fn yearvalue_fiscal_april_start() {
    let mut book = Book::with_calendar(calendar(4, 2027, 2));
    book.series("Rev", &sequence());
    assert_eq!(book.cal.label(TimeLevel::Month, 11), "Mar 27");
    assert_eq!(book.cal.label(TimeLevel::Month, 12), "Apr 27");

    let year = book.numbers("YEARVALUE(Rev)", 24);

    // FY27 is Apr 26 to Mar 27 and FY28 is Apr 27 to Mar 28.
    assert!(year[..12].iter().all(|&total| total == 78.0));
    assert!(year[12..].iter().all(|&total| total == 222.0));
    assert_eq!(year[11], 78.0);
    assert_eq!(year[12], 222.0);

    let quarters = book.numbers("QUARTERVALUE(Rev)", 24);
    let expected: Vec<f64> = [6.0, 15.0, 24.0, 33.0, 42.0, 51.0, 60.0, 69.0]
        .iter()
        .flat_map(|&total| [total; 3])
        .collect();
    assert_eq!(quarters, expected);

    let halves = book.numbers("HALFYEARVALUE(Rev)", 24);
    let expected: Vec<f64> = [21.0, 57.0, 93.0, 129.0]
        .iter()
        .flat_map(|&total| [total; 6])
        .collect();
    assert_eq!(halves, expected);

    assert_eq!(book.numbers("MONTHVALUE(Rev)", 24), sequence());
}

#[test]
fn yearvalue_follows_the_time_summary_of_the_line_item() {
    let mut book = Book::new();
    let values: Vec<Value> = (1..=12)
        .map(|i| Value::Number(f64::from(i) * 10.0))
        .collect();
    for (name, method) in [
        ("Total", SummaryMethod::Sum),
        ("Mean", SummaryMethod::Average),
        ("Closing Balance", SummaryMethod::Closing),
        ("Opening Balance", SummaryMethod::Opening),
        ("Highest", SummaryMethod::Max),
        ("Nothing", SummaryMethod::None),
    ] {
        let mut li = line_item(book.sheet, name, Format::number(), None);
        li.time_summary = Some(method);
        let id = book.add(li);
        let cells = values
            .iter()
            .enumerate()
            .map(|(i, value)| (vec![book.month(i)], value.clone()))
            .collect();
        book.set_all(id, cells);
    }

    assert_eq!(book.numbers("YEARVALUE(Total)", 2), [780.0, 780.0]);
    assert_eq!(book.numbers("YEARVALUE(Mean)", 2), [65.0, 65.0]);
    assert_eq!(
        book.numbers("YEARVALUE(Closing Balance)", 2),
        [120.0, 120.0]
    );
    assert_eq!(book.numbers("YEARVALUE(Opening Balance)", 2), [10.0, 10.0]);
    assert_eq!(book.numbers("YEARVALUE(Highest)", 2), [120.0, 120.0]);
    assert_eq!(
        book.numbers("QUARTERVALUE(Mean)", 6),
        [20.0, 20.0, 20.0, 50.0, 50.0, 50.0]
    );
    assert_eq!(book.numbers("YEARVALUE(Nothing)", 2), [0.0, 0.0]);
    // The second year has no values, and an average of nothing is nothing.
    assert_eq!(book.numbers("YEARVALUE(Mean)", 24)[12], 0.0);
}

#[test]
fn yearvalue_of_a_formula_is_the_formula_at_the_level_of_the_year() {
    let mut book = Book::new();
    book.series("Rev", &sequence());

    // The line items of the argument are read at the year, as `Rev * 2` is when the line item is
    // by year.
    assert_eq!(book.numbers("YEARVALUE(Rev * 2)", 2), [156.0, 156.0]);
    assert_eq!(book.numbers("YEARVALUE(CUMULATE(Rev))", 24)[0], 78.0);
    assert_eq!(book.numbers("YEARVALUE(PREVIOUS(Rev))", 24)[12], 78.0);
    assert_eq!(book.numbers("YEARVALUE(PREVIOUS(Rev))", 24)[0], 0.0);
    assert_eq!(
        book.flags("YEARVALUE(Rev) > 100", 24)[11..13],
        [false, true]
    );
}

#[test]
fn ytd_resets_each_fiscal_year() {
    let mut book = Book::with_calendar(calendar(4, 2027, 2));
    book.series("Rev", &sequence());

    assert_eq!(
        book.numbers("YEARTODATE(Rev)", 24),
        [
            1.0, 3.0, 6.0, 10.0, 15.0, 21.0, 28.0, 36.0, 45.0, 55.0, 66.0, 78.0, // FY27
            13.0, 27.0, 42.0, 58.0, 75.0, 93.0, 112.0, 132.0, 153.0, 175.0, 198.0,
            222.0, // FY28
        ]
    );
    assert_eq!(
        book.numbers("QUARTERTODATE(Rev)", 12),
        [
            1.0, 3.0, 6.0, 4.0, 9.0, 15.0, 7.0, 15.0, 24.0, 10.0, 21.0, 33.0
        ]
    );
    assert_eq!(
        book.numbers("HALFYEARTODATE(Rev)", 14),
        [
            1.0, 3.0, 6.0, 10.0, 15.0, 21.0, 7.0, 15.0, 24.0, 34.0, 45.0, 57.0, 13.0, 27.0
        ]
    );
}

#[test]
fn ytd_of_a_january_year_matches_the_calendar_year() {
    let mut book = Book::new();
    book.series("Rev", &sequence());

    let ytd = book.numbers("YEARTODATE(Rev)", 24);
    assert_eq!(ytd[11], 78.0);
    assert_eq!(ytd[12], 13.0);
    assert_eq!(ytd[23], 222.0);
}

#[test]
fn level_functions_follow_the_time_scale_of_the_line_item() {
    let mut book = Book::new();
    book.series("Rev", &sequence());
    let quarterly = book.module("Quarterly", vec![time_axis(TimeLevel::Quarter)]);
    let yearly = book.module("Yearly", vec![time_axis(TimeLevel::Year)]);
    let q: Vec<Vec<CoordToken>> = (0..8)
        .map(|i| vec![book.level(TimeLevel::Quarter, i)])
        .collect();
    let y: Vec<Vec<CoordToken>> = (0..2)
        .map(|i| vec![book.level(TimeLevel::Year, i)])
        .collect();
    let quarters = |book: &mut Book, formula: &str| {
        let li = book.calc_in(quarterly, Format::number(), formula);
        book.numbers_at(li, q.clone())
    };

    // `Rev` is read by quarter: 6, 15, 24, 33, 42, 51, 60, 69.
    assert_eq!(
        quarters(&mut book, "Rev"),
        [6.0, 15.0, 24.0, 33.0, 42.0, 51.0, 60.0, 69.0]
    );
    assert_eq!(
        quarters(&mut book, "PREVIOUS(Rev)"),
        [0.0, 6.0, 15.0, 24.0, 33.0, 42.0, 51.0, 60.0]
    );
    assert_eq!(
        quarters(&mut book, "CUMULATE(Rev)"),
        [6.0, 21.0, 45.0, 78.0, 120.0, 171.0, 231.0, 300.0]
    );
    assert_eq!(
        quarters(&mut book, "LAG(Rev, 4, -1)"),
        [-1.0, -1.0, -1.0, -1.0, 6.0, 15.0, 24.0, 33.0]
    );
    assert_eq!(
        quarters(&mut book, "YEARTODATE(Rev)"),
        [6.0, 21.0, 45.0, 78.0, 42.0, 93.0, 153.0, 222.0]
    );
    assert_eq!(
        quarters(&mut book, "HALFYEARTODATE(Rev)"),
        [6.0, 21.0, 24.0, 57.0, 42.0, 93.0, 60.0, 129.0]
    );
    assert_eq!(
        quarters(&mut book, "QUARTERTODATE(Rev)"),
        [6.0, 15.0, 24.0, 33.0, 42.0, 51.0, 60.0, 69.0]
    );
    assert_eq!(
        quarters(&mut book, "YEARVALUE(Rev)"),
        [78.0, 78.0, 78.0, 78.0, 222.0, 222.0, 222.0, 222.0]
    );
    assert_eq!(
        quarters(&mut book, "HALFYEARVALUE(Rev)"),
        [21.0, 21.0, 57.0, 57.0, 93.0, 93.0, 129.0, 129.0]
    );
    assert_eq!(
        quarters(&mut book, "QUARTERVALUE(Rev)"),
        [6.0, 15.0, 24.0, 33.0, 42.0, 51.0, 60.0, 69.0]
    );
    assert_eq!(quarters(&mut book, "TIMESUM(Rev)"), [300.0; 8]);
    assert_eq!(
        quarters(&mut book, "MOVINGSUM(Rev, -1, 0)"),
        [6.0, 21.0, 39.0, 57.0, 75.0, 93.0, 111.0, 129.0]
    );
    assert_eq!(
        quarters(&mut book, "TIMESUM(Rev, Time.'Q2 FY26', Time.'Q3 FY26')"),
        [39.0; 8]
    );
    // A quarter counts when all of it lies in the range: Q1 FY26 starts before Feb 26.
    assert_eq!(
        quarters(&mut book, "TIMESUM(Rev, Time.'Feb 26', Time.'Dec 27')"),
        [294.0; 8]
    );

    let li = book.calc_in(yearly, Format::number(), "YEARVALUE(Rev)");
    assert_eq!(book.numbers_at(li, y.clone()), [78.0, 222.0]);
    let li = book.calc_in(yearly, Format::number(), "CUMULATE(Rev)");
    assert_eq!(book.numbers_at(li, y.clone()), [78.0, 300.0]);
    let li = book.calc_in(yearly, Format::number(), "YEARTODATE(Rev)");
    assert_eq!(book.numbers_at(li, y.clone()), [78.0, 222.0]);
    let li = book.calc_in(yearly, Format::number(), "PREVIOUS(Rev)");
    assert_eq!(book.numbers_at(li, y.clone()), [0.0, 78.0]);
}

#[test]
fn a_line_item_may_have_a_time_scale_of_its_own() {
    let mut book = Book::new();
    book.series("Rev", &sequence());
    let mut by_year = line_item(
        book.sheet,
        "By Year",
        Format::number(),
        Some("CUMULATE(Rev)"),
    );
    by_year.time_scale = TimeScale::Level(TimeLevel::Year);
    let by_year = book.add(by_year);
    let mut by_half = line_item(
        book.sheet,
        "By Half",
        Format::number(),
        Some("HALFYEARTODATE(Rev) + YEARVALUE(Rev)"),
    );
    by_half.time_scale = TimeScale::Level(TimeLevel::HalfYear);
    let by_half = book.add(by_half);
    book.recalc();

    let year = |i| vec![book.level(TimeLevel::Year, i)];
    let half = |i| vec![book.level(TimeLevel::HalfYear, i)];
    assert_eq!(
        book.numbers_at(by_year, vec![year(0), year(1)]),
        [78.0, 300.0]
    );
    assert_eq!(
        book.numbers_at(by_half, (0..4).map(half).collect()),
        [21.0 + 78.0, 57.0 + 78.0, 93.0 + 222.0, 129.0 + 222.0]
    );
}

#[test]
fn a_level_function_needs_a_time_scale_no_coarser_than_its_level() {
    let mut book = Book::new();
    book.series("Rev", &sequence());
    let yearly = book.module("Yearly", vec![time_axis(TimeLevel::Year)]);
    let quarterly = book.module("Quarterly", vec![time_axis(TimeLevel::Quarter)]);

    for (module, call, wanted, found) in [
        (yearly, "QUARTERVALUE(Rev)", "month or quarter", "year"),
        (
            yearly,
            "HALFYEARVALUE(Rev)",
            "month, quarter or half-year",
            "year",
        ),
        (yearly, "MONTHVALUE(Rev)", "month", "year"),
        (yearly, "QUARTERTODATE(Rev)", "month or quarter", "year"),
        (quarterly, "MONTHVALUE(Rev)", "month", "quarter"),
    ] {
        let errors = book.errors_in(module, Format::number(), call);
        assert_eq!(errors.len(), 1, "{call}");
        assert_eq!(errors[0].code, "formula.dimension", "{call}");
        let name = call.split('(').next().unwrap();
        assert_eq!(
            errors[0].message,
            format!("{name} needs a line item by {wanted}, but this one is by {found}."),
            "{call}"
        );
        assert_eq!((errors[0].start, errors[0].end), (0, call.len()), "{call}");
    }
}

#[test]
fn timesum_range() {
    let mut book = Book::new();
    book.series("Rev", &sequence());

    let all = book.numbers("TIMESUM(Rev)", 24);
    assert!(all.iter().all(|&total| total == 300.0));

    // Jan 26 to Jun 26 are the months 1 to 6.
    let first_half = book.numbers("TIMESUM(Rev, Time.'Jan 26', Time.'Jun 26')", 24);
    assert!(first_half.iter().all(|&total| total == 21.0));
    // A period of any level starts at its first month and ends at its last.
    assert_eq!(
        book.numbers("TIMESUM(Rev, Time.'Q2 FY26', Time.'Q3 FY26')", 1),
        [4.0 + 5.0 + 6.0 + 7.0 + 8.0 + 9.0]
    );
    assert_eq!(
        book.numbers("TIMESUM(Rev, Time.FY27, Time.FY27)", 1),
        [222.0]
    );
    assert_eq!(
        book.numbers("TIMESUM(Rev, Time.'Mar 26', Time.'Dec 27')", 1),
        [300.0 - 3.0]
    );
    // One month, and a range that ends before it starts.
    assert_eq!(
        book.numbers("TIMESUM(Rev, Time.'Feb 27', Time.'Feb 27')", 1),
        [14.0]
    );
    assert_eq!(
        book.numbers("TIMESUM(Rev, Time.'Jun 26', Time.'Jan 26')", 1),
        [0.0]
    );
    assert_eq!(
        book.numbers("TIMESUM(Rev + 1, Time.'Jan 26', Time.'Jan 26')", 1),
        [2.0]
    );
}

#[test]
fn timesum_ranges_may_come_from_the_cells() {
    let mut book = Book::new();
    book.series("Rev", &sequence());
    book.input_series(
        "From",
        Format::TimePeriod {
            level: TimeLevel::Month,
        },
        vec![
            Value::Period(Some((TimeLevel::Month, 0))),
            Value::Period(Some((TimeLevel::Month, 2))),
            Value::Period(Some((TimeLevel::Month, 5))),
            Value::Period(None),
        ],
    );
    book.input_series(
        "To",
        Format::TimePeriod {
            level: TimeLevel::Month,
        },
        vec![
            Value::Period(Some((TimeLevel::Month, 1))),
            Value::Period(Some((TimeLevel::Month, 4))),
            Value::Period(Some((TimeLevel::Month, 3))),
            Value::Period(Some((TimeLevel::Month, 3))),
            Value::Period(None),
        ],
    );

    // A period that is not set is no range at all.
    assert_eq!(
        book.numbers("TIMESUM(Rev, From, To)", 6),
        [3.0, 3.0 + 4.0 + 5.0, 0.0, 0.0, 0.0, 0.0]
    );
    assert_eq!(
        book.numbers("TIMESUM(Rev, From, Time.'Dec 27')", 4),
        [300.0, 300.0 - 3.0, 300.0 - 15.0, 0.0]
    );
}

#[test]
fn time_functions_follow_a_time_range() {
    let mut book = Book::with_calendar(calendar(1, 2026, 3));
    let range = TimeRangeId::new();
    book.model
        .apply(Command::CreateTimeRange {
            id: range,
            name: "Second year".to_string(),
            first_year: 2027,
            years: 1,
        })
        .unwrap();
    let plan = book.module(
        "Plan",
        vec![AxisSpec::Time {
            level: TimeLevel::Month,
            range: Some(range),
        }],
    );
    let rev = book.input(plan, "Rev", Format::number());
    // The range starts in Jan 27, the thirteenth month of the model calendar.
    let months: Vec<Vec<CoordToken>> = (0..12).map(|i| vec![book.month(12 + i)]).collect();
    let cells = months
        .iter()
        .enumerate()
        .map(|(i, month)| (month.clone(), Value::Number((i + 1) as f64)))
        .collect();
    book.set_all(rev, cells);
    let in_range = |book: &mut Book, format: Format, formula: &str| -> Vec<Value> {
        let li = book.calc_in(plan, format, formula);
        book.read(li, months.clone())
    };
    let numbers = |values: Vec<Value>| -> Vec<f64> {
        values
            .into_iter()
            .map(|value| match value {
                Value::Number(number) => number,
                other => panic!("expected a number, found {other:?}"),
            })
            .collect()
    };

    // The timeline is that of the range, so nothing comes before Jan 27.
    assert_eq!(
        numbers(in_range(&mut book, Format::number(), "PREVIOUS(Rev)"))[..3],
        [0.0, 1.0, 2.0]
    );
    assert_eq!(
        numbers(in_range(&mut book, Format::number(), "CUMULATE(Rev)"))[..4],
        [1.0, 3.0, 6.0, 10.0]
    );
    assert_eq!(
        numbers(in_range(&mut book, Format::number(), "YEARVALUE(Rev)")),
        [78.0; 12]
    );
    assert_eq!(
        numbers(in_range(&mut book, Format::number(), "QUARTERTODATE(Rev)"))[..6],
        [1.0, 3.0, 6.0, 4.0, 9.0, 15.0]
    );
    // The periods of a range are given by the model calendar.
    assert_eq!(
        numbers(in_range(
            &mut book,
            Format::number(),
            "TIMESUM(Rev, Time.'Mar 27', Time.'Jun 27')"
        ))[0],
        3.0 + 4.0 + 5.0 + 6.0
    );
    assert_eq!(
        numbers(in_range(
            &mut book,
            Format::number(),
            "TIMESUM(Rev, Time.'Nov 26', Time.'Feb 27')"
        ))[0],
        3.0
    );
    // And the dates are those of the range.
    let starts = in_range(&mut book, Format::Date, "START()");
    assert_eq!(starts[0], Value::Date(date(2027, 1, 1)));
    assert_eq!(starts[11], Value::Date(date(2027, 12, 1)));
    let ends = in_range(&mut book, Format::Date, "END()");
    assert_eq!(ends[1], Value::Date(date(2027, 2, 28)));
    assert_eq!(ends[11], Value::Date(date(2027, 12, 31)));
}

#[test]
fn time_range_of_a_fiscal_year_that_starts_in_april() {
    // FY26 is Apr 25 to Mar 26, so FY27, the range, is Apr 26 to Mar 27: months 12 to 23 of the
    // model calendar.
    let mut book = Book::with_calendar(calendar(4, 2026, 3));
    assert_eq!(book.cal.label(TimeLevel::Month, 12), "Apr 26");
    let range = TimeRangeId::new();
    book.model
        .apply(Command::CreateTimeRange {
            id: range,
            name: "FY27".to_string(),
            first_year: 2027,
            years: 1,
        })
        .unwrap();
    let plan = book.module(
        "Plan",
        vec![AxisSpec::Time {
            level: TimeLevel::Month,
            range: Some(range),
        }],
    );
    let rev = book.input(plan, "Rev", Format::number());
    let months: Vec<Vec<CoordToken>> = (0..12).map(|i| vec![book.month(12 + i)]).collect();
    let cells = months
        .iter()
        .enumerate()
        .map(|(i, month)| (month.clone(), Value::Number((i + 1) as f64)))
        .collect();
    book.set_all(rev, cells);

    // The dates of the range run from Apr 26 to Mar 27.
    let starts = book.calc_in(plan, Format::Date, "START()");
    let starts = book.read(starts, months.clone());
    assert_eq!(starts[0], Value::Date(date(2026, 4, 1)));
    assert_eq!(starts[11], Value::Date(date(2027, 3, 1)));
    let ends = book.calc_in(plan, Format::Date, "END()");
    let ends = book.read(ends, months.clone());
    assert_eq!(ends[0], Value::Date(date(2026, 4, 30)));
    assert_eq!(ends[11], Value::Date(date(2027, 3, 31)));

    // YEARVALUE is the total of FY27, 1 + ... + 12, in every month.
    let year = book.calc_in(plan, Format::number(), "YEARVALUE(Rev)");
    assert_eq!(book.numbers_at(year, months.clone()), [78.0; 12]);
    // YEARTODATE starts again at the first month of FY27, which is the first month of the range.
    let to_date = book.calc_in(plan, Format::number(), "YEARTODATE(Rev)");
    assert_eq!(
        book.numbers_at(to_date, months.clone()),
        [
            1.0, 3.0, 6.0, 10.0, 15.0, 21.0, 28.0, 36.0, 45.0, 55.0, 66.0, 78.0
        ]
    );
    // Jul 26 to Sep 26 are months 15 to 17 of the model calendar, which are months 3 to 5 of the
    // range: 4 + 5 + 6.
    let between = book.calc_in(
        plan,
        Format::number(),
        "TIMESUM(Rev, Time.'Jul 26', Time.'Sep 26')",
    );
    assert_eq!(book.numbers_at(between, months.clone()), [15.0; 12]);
}

#[test]
fn inperiod_and_period() {
    let mut book = Book::new();
    book.input_series(
        "Invoice Date",
        Format::Date,
        vec![
            Value::Date(date(2026, 1, 15)),
            Value::Date(date(2026, 2, 1)),
            Value::Date(date(2026, 3, 31)),
            Value::Date(date(2027, 12, 31)),
            Value::Date(date(2028, 1, 1)),
            Value::Date(date(2025, 12, 31)),
            Value::Date(None),
        ],
    );
    book.input_series(
        "When",
        Format::TimePeriod {
            level: TimeLevel::Month,
        },
        vec![
            Value::Period(Some((TimeLevel::Month, 0))),
            Value::Period(Some((TimeLevel::Month, 0))),
            Value::Period(Some((TimeLevel::Month, 2))),
            Value::Period(Some((TimeLevel::Month, 23))),
            Value::Period(Some((TimeLevel::Month, 23))),
            Value::Period(None),
            Value::Period(Some((TimeLevel::Month, 0))),
        ],
    );

    assert_eq!(
        book.flags("INPERIOD(Invoice Date, Time.'Jan 26')", 7),
        [true, false, false, false, false, false, false]
    );
    assert_eq!(
        book.flags("INPERIOD(Invoice Date, Time.'Q1 FY26')", 7),
        [true, true, true, false, false, false, false]
    );
    assert_eq!(
        book.flags("INPERIOD(Invoice Date, Time.'H1 FY26')", 7),
        [true, true, true, false, false, false, false]
    );
    assert_eq!(
        book.flags("INPERIOD(Invoice Date, Time.FY27)", 7),
        [false, false, false, true, false, false, false]
    );
    assert_eq!(
        book.flags("INPERIOD(Invoice Date, Time.Total)", 7),
        [true, true, true, true, false, false, false]
    );
    // The period may be a value of the cell; one that is not set contains no date.
    assert_eq!(
        book.flags("INPERIOD(Invoice Date, When)", 7),
        [true, false, true, true, false, false, false]
    );

    let periods = book.calc(
        Format::TimePeriod {
            level: TimeLevel::Month,
        },
        "PERIOD(Invoice Date)",
        7,
    );
    let month = |i| Value::Period(Some((TimeLevel::Month, i)));
    assert_eq!(
        periods,
        [
            month(0),
            month(1),
            month(2),
            month(23),
            Value::Period(None),
            Value::Period(None),
            Value::Period(None)
        ]
    );
    assert_eq!(
        book.flags("PERIOD(Invoice Date) = Time.'Feb 26'", 3),
        [false, true, false]
    );
}

#[test]
fn period_counts_months_from_the_start_of_a_fiscal_year() {
    let mut book = Book::with_calendar(calendar(4, 2027, 2));
    book.input_series(
        "Invoice Date",
        Format::Date,
        vec![
            Value::Date(date(2026, 4, 10)),
            Value::Date(date(2027, 3, 31)),
            Value::Date(date(2026, 3, 31)),
        ],
    );

    let periods = book.calc(
        Format::TimePeriod {
            level: TimeLevel::Month,
        },
        "PERIOD(Invoice Date)",
        3,
    );
    assert_eq!(
        periods,
        [
            Value::Period(Some((TimeLevel::Month, 0))),
            Value::Period(Some((TimeLevel::Month, 11))),
            Value::Period(None)
        ]
    );
    assert_eq!(
        book.flags("INPERIOD(Invoice Date, Time.FY27)", 3),
        [true, true, false]
    );
}

#[test]
fn start_end_dates() {
    // 2028 is a leap year.
    let mut book = Book::with_calendar(calendar(1, 2028, 1));

    let starts = book.dates("START()", 12);
    assert_eq!(starts[0], date(2028, 1, 1));
    assert_eq!(starts[1], date(2028, 2, 1));
    assert_eq!(starts[11], date(2028, 12, 1));
    let ends = book.dates("END()", 12);
    assert_eq!(ends[0], date(2028, 1, 31));
    assert_eq!(ends[1], date(2028, 2, 29));
    assert_eq!(ends[3], date(2028, 4, 30));
    assert_eq!(ends[11], date(2028, 12, 31));
    assert_eq!(
        book.numbers("DAYS(START(), END()) + 1", 3),
        [31.0, 29.0, 31.0]
    );
}

#[test]
fn start_and_end_of_coarser_periods() {
    let mut book = Book::with_calendar(calendar(4, 2027, 2));
    let quarterly = book.module("Quarterly", vec![time_axis(TimeLevel::Quarter)]);
    let yearly = book.module("Yearly", vec![time_axis(TimeLevel::Year)]);
    let cal = book.cal;
    let quarter = |i: u32| vec![CoordToken::Period(cal.label(TimeLevel::Quarter, i))];
    let year = |i: u32| vec![CoordToken::Period(cal.label(TimeLevel::Year, i))];

    let li = book.calc_in(quarterly, Format::Date, "START()");
    assert_eq!(
        book.read(li, vec![quarter(0), quarter(1), quarter(7)]),
        [
            Value::Date(date(2026, 4, 1)),
            Value::Date(date(2026, 7, 1)),
            Value::Date(date(2028, 1, 1))
        ]
    );
    let li = book.calc_in(quarterly, Format::Date, "END()");
    assert_eq!(
        book.read(li, vec![quarter(0), quarter(3), quarter(7)]),
        [
            Value::Date(date(2026, 6, 30)),
            Value::Date(date(2027, 3, 31)),
            Value::Date(date(2028, 3, 31))
        ]
    );
    let li = book.calc_in(yearly, Format::Date, "START()");
    assert_eq!(
        book.read(li, vec![year(0), year(1)]),
        [Value::Date(date(2026, 4, 1)), Value::Date(date(2027, 4, 1))]
    );
    let li = book.calc_in(yearly, Format::Date, "END()");
    assert_eq!(
        book.read(li, vec![year(0), year(1)]),
        [
            Value::Date(date(2027, 3, 31)),
            Value::Date(date(2028, 3, 31))
        ]
    );
}

#[test]
fn current_period_dates() {
    let mut book = Book::new();

    // Without a current month there is no current period.
    assert_eq!(book.dates("CURRENTPERIODSTART()", 2), [None, None]);
    assert_eq!(book.dates("CURRENTPERIODEND()", 2), [None, None]);

    // Month 14 of the calendar is Mar 27.
    book.model
        .apply(Command::SetCalendar {
            calendar: Calendar {
                current_month: Some(14),
                ..book.cal
            },
        })
        .unwrap();
    book.recalc();
    let starts = book.dates("CURRENTPERIODSTART()", 2);
    assert_eq!(starts, [date(2027, 3, 1), date(2027, 3, 1)]);
    let ends = book.dates("CURRENTPERIODEND()", 2);
    assert_eq!(ends, [date(2027, 3, 31), date(2027, 3, 31)]);
    assert_eq!(
        book.flags("INPERIOD(CURRENTPERIODSTART(), Time.'Mar 27')", 1),
        [true]
    );

    // A module without a Time dimension has them too.
    let (regions, ids) = book.list("Regions", &["East"]);
    let plain = book.module("Plain", vec![list_axis(regions)]);
    let li = book.calc_in(plain, Format::Date, "CURRENTPERIODEND()");
    assert_eq!(
        book.value_at(li, vec![item(ids[0])]),
        Value::Date(date(2027, 3, 31))
    );
}

#[test]
fn currentversion() {
    let mut book = Book::new();
    let finance = book.module("Finance", vec![month_axis(), AxisSpec::Versions]);
    let amount = book.input(finance, "Amount", Format::number());
    let note = book.input(finance, "Note", Format::Text);
    let (actual, budget, forecast) = (
        book.version("Actual"),
        book.version("Budget"),
        book.version("Forecast"),
    );
    let (jan, feb) = (book.month(0), book.month(1));
    for (month, version, value) in [
        (&jan, &actual, 1.0),
        (&jan, &budget, 2.0),
        (&jan, &forecast, 3.0),
        (&feb, &actual, 10.0),
        (&feb, &budget, 20.0),
        (&feb, &forecast, 30.0),
    ] {
        book.set_number(amount, vec![month.clone(), version.clone()], value);
    }
    book.set(note, vec![jan.clone(), budget.clone()], text("b"));
    book.set(note, vec![jan.clone(), forecast.clone()], text("f"));
    let current = book.calc_in(finance, Format::number(), "CURRENTVERSION(Amount)");
    let previous = book.calc_in(finance, Format::number(), "PREVIOUSVERSION(Amount)");
    let next = book.calc_in(finance, Format::number(), "NEXTVERSION(Amount)");
    let next_note = book.calc_in(finance, Format::Text, "NEXTVERSION(Note)");

    // Budget is the current version of a new model, and the versions are in the order Actual,
    // Budget, Forecast.
    let at = |book: &Book, li, month: &CoordToken, version: &CoordToken| {
        book.number_at(li, vec![month.clone(), version.clone()])
    };
    for version in [&actual, &budget, &forecast] {
        assert_eq!(at(&book, current, &jan, version), 2.0);
        assert_eq!(at(&book, current, &feb, version), 20.0);
    }
    assert_eq!(at(&book, previous, &jan, &actual), 0.0);
    assert_eq!(at(&book, previous, &jan, &budget), 1.0);
    assert_eq!(at(&book, previous, &jan, &forecast), 2.0);
    assert_eq!(at(&book, previous, &feb, &forecast), 20.0);
    assert_eq!(at(&book, next, &jan, &actual), 2.0);
    assert_eq!(at(&book, next, &jan, &budget), 3.0);
    assert_eq!(at(&book, next, &jan, &forecast), 0.0);
    assert_eq!(at(&book, next, &feb, &budget), 30.0);
    assert_eq!(
        book.value_at(next_note, vec![jan.clone(), actual.clone()]),
        text("b")
    );
    assert_eq!(
        book.value_at(next_note, vec![jan.clone(), budget.clone()]),
        text("f")
    );
    assert_eq!(
        book.value_at(next_note, vec![jan.clone(), forecast.clone()]),
        text("")
    );

    // Flagging another version as current moves CURRENTVERSION to it.
    let forecast_id = book
        .model
        .structure()
        .version_by_name("Forecast")
        .unwrap()
        .id;
    book.model
        .apply(Command::UpsertVersion {
            id: forecast_id,
            name: "Forecast".to_string(),
            is_actual: false,
            is_current: true,
            switchover: None,
        })
        .unwrap();
    book.recalc();
    for version in [&actual, &budget, &forecast] {
        assert_eq!(at(&book, current, &jan, version), 3.0);
        assert_eq!(at(&book, current, &feb, version), 30.0);
    }
}

#[test]
fn version_functions_read_the_switchover_too() {
    let mut book = Book::new();
    let finance = book.module("Finance", vec![month_axis(), AxisSpec::Versions]);
    let amount = book.input(finance, "Amount", Format::number());
    let budget_id = book.model.structure().version_by_name("Budget").unwrap().id;
    book.model
        .apply(Command::UpsertVersion {
            id: budget_id,
            name: "Budget".to_string(),
            is_actual: false,
            is_current: true,
            switchover: Some(1),
        })
        .unwrap();
    let (actual, budget, forecast) = (
        book.version("Actual"),
        book.version("Budget"),
        book.version("Forecast"),
    );
    let (jan, feb) = (book.month(0), book.month(1));
    for (month, version, value) in [
        (&jan, &actual, 1.0),
        (&feb, &budget, 20.0),
        (&jan, &forecast, 3.0),
    ] {
        book.set_number(amount, vec![month.clone(), version.clone()], value);
    }
    let current = book.calc_in(finance, Format::number(), "CURRENTVERSION(Amount)");
    let previous = book.calc_in(finance, Format::number(), "PREVIOUSVERSION(Amount)");

    // In Jan, before the switchover, the budget shows the actual values.
    assert_eq!(
        book.number_at(current, vec![jan.clone(), forecast.clone()]),
        1.0
    );
    assert_eq!(
        book.number_at(current, vec![feb.clone(), forecast.clone()]),
        20.0
    );
    assert_eq!(
        book.number_at(previous, vec![jan.clone(), forecast.clone()]),
        1.0
    );
    assert_eq!(book.number_at(previous, vec![feb, forecast]), 20.0);
}

#[test]
fn version_functions_follow_a_restricted_versions_axis() {
    let mut book = Book::new();
    let finance = book.module("Finance", vec![month_axis(), AxisSpec::Versions]);
    let amount = book.input(finance, "Amount", Format::number());
    let id = |name: &str| book.model.structure().version_by_name(name).unwrap().id;
    let (actual_id, forecast_id) = (id("Actual"), id("Forecast"));
    let (actual, budget, forecast) = (
        book.version("Actual"),
        book.version("Budget"),
        book.version("Forecast"),
    );
    let jan = book.month(0);
    for (version, value) in [(&actual, 1.0), (&budget, 2.0), (&forecast, 3.0)] {
        book.set_number(amount, vec![jan.clone(), version.clone()], value);
    }
    let narrow = |book: &mut Book, name: &str, formula: &str| {
        let mut li = line_item(finance, name, Format::number(), Some(formula));
        li.versions = VersionsScope::Only(vec![actual_id, forecast_id]);
        let li = book.add(li);
        book.recalc();
        li
    };
    let current = narrow(&mut book, "Current", "CURRENTVERSION(Amount)");
    let previous = narrow(&mut book, "Previous", "PREVIOUSVERSION(Amount)");
    let next = narrow(&mut book, "Next", "NEXTVERSION(Amount)");

    // The current version, Budget, is not one of the two versions, so there is no current value;
    // the version before Forecast is the one before it on the axis of the line item.
    assert_eq!(
        book.number_at(current, vec![jan.clone(), actual.clone()]),
        0.0
    );
    assert_eq!(
        book.number_at(current, vec![jan.clone(), forecast.clone()]),
        0.0
    );
    assert_eq!(
        book.number_at(previous, vec![jan.clone(), forecast.clone()]),
        1.0
    );
    assert_eq!(
        book.number_at(previous, vec![jan.clone(), actual.clone()]),
        0.0
    );
    assert_eq!(book.number_at(next, vec![jan.clone(), actual]), 3.0);
    assert_eq!(book.number_at(next, vec![jan, forecast]), 0.0);
}

/// A list of five products with their sales in a module `Sales` by month.
struct Ranking {
    book: Book,
    products: ListId,
    ids: Vec<ItemId>,
    sales: ModuleId,
    units: LineItemId,
}

fn ranking() -> Ranking {
    let mut book = Book::new();
    let (products, ids) = book.list("Products", &["A", "B", "C", "D", "E"]);
    let sales = book.module("Sales", vec![list_axis(products), month_axis()]);
    let units = book.input(sales, "Units", Format::number());
    Ranking {
        book,
        products,
        ids,
        sales,
        units,
    }
}

impl Ranking {
    fn set_month(&mut self, month: usize, values: [f64; 5]) {
        for (id, value) in self.ids.clone().into_iter().zip(values) {
            let coords = vec![item(id), self.book.month(month)];
            self.book.set_number(self.units, coords, value);
        }
    }

    fn ranks(&mut self, formula: &str, month: usize) -> Vec<f64> {
        let li = self.book.calc_in(self.sales, Format::number(), formula);
        let coords = self
            .ids
            .iter()
            .map(|&id| vec![item(id), self.book.month(month)])
            .collect();
        self.book.numbers_at(li, coords)
    }
}

#[test]
fn rank_ties_and_slices() {
    let mut r = ranking();
    r.set_month(0, [50.0, 70.0, 70.0, 10.0, 90.0]);
    r.set_month(1, [1.0, 2.0, 3.0, 4.0, 5.0]);

    // Descending is the default; ties share the lowest rank and the next rank is skipped.
    assert_eq!(r.ranks("RANK(Units)", 0), [4.0, 2.0, 2.0, 5.0, 1.0]);
    assert_eq!(
        r.ranks("RANK(Units, DESCENDING)", 0),
        [4.0, 2.0, 2.0, 5.0, 1.0]
    );
    assert_eq!(
        r.ranks("RANK(Units, ASCENDING)", 0),
        [2.0, 3.0, 3.0, 1.0, 5.0]
    );
    // Every month is a slice of its own.
    assert_eq!(r.ranks("RANK(Units)", 1), [5.0, 4.0, 3.0, 2.0, 1.0]);
    assert_eq!(
        r.ranks("RANK(Units, ASCENDING)", 1),
        [1.0, 2.0, 3.0, 4.0, 5.0]
    );
    // Months without values are all tied.
    assert_eq!(r.ranks("RANK(Units)", 2), [1.0; 5]);
    assert_eq!(r.ranks("RANK(Units, ASCENDING)", 2), [1.0; 5]);
}

#[test]
fn rank_of_any_number_and_with_negative_values() {
    let mut r = ranking();
    r.set_month(0, [-5.0, 0.0, 5.0, -5.0, 0.5]);

    assert_eq!(r.ranks("RANK(Units)", 0), [4.0, 3.0, 1.0, 4.0, 2.0]);
    assert_eq!(
        r.ranks("RANK(Units, ASCENDING)", 0),
        [1.0, 3.0, 5.0, 1.0, 4.0]
    );
    assert_eq!(r.ranks("RANK(Units * -1)", 0), [1.0, 3.0, 5.0, 1.0, 4.0]);
    assert_eq!(r.ranks("RANK(ABS(Units))", 0), [1.0, 5.0, 1.0, 1.0, 4.0]);
    // A value that does not vary by item is a tie of all.
    assert_eq!(r.ranks("RANK(7)", 0), [1.0; 5]);
}

#[test]
fn rank_is_per_version() {
    let mut book = Book::new();
    let (products, ids) = book.list("Products", &["A", "B", "C"]);
    let sales = book.module(
        "Sales",
        vec![list_axis(products), month_axis(), AxisSpec::Versions],
    );
    let units = book.input(sales, "Units", Format::number());
    let (actual, budget) = (book.version("Actual"), book.version("Budget"));
    for (product, version, value) in [
        (0, &actual, 1.0),
        (1, &actual, 2.0),
        (2, &actual, 3.0),
        (0, &budget, 30.0),
        (1, &budget, 20.0),
        (2, &budget, 10.0),
    ] {
        let coords = vec![item(ids[product]), book.month(0), version.clone()];
        book.set_number(units, coords, value);
    }
    let rank = book.calc_in(sales, Format::number(), "RANK(Units)");

    let coords = |version: &CoordToken| -> Vec<Vec<CoordToken>> {
        ids.iter()
            .map(|&id| vec![item(id), book.month(0), version.clone()])
            .collect()
    };
    assert_eq!(book.numbers_at(rank, coords(&actual)), [3.0, 2.0, 1.0]);
    assert_eq!(book.numbers_at(rank, coords(&budget)), [1.0, 2.0, 3.0]);
}

#[test]
fn rank_goes_across_all_the_list_dimensions() {
    let mut book = Book::new();
    let (products, product_ids) = book.list("Products", &["A", "B"]);
    let (regions, region_ids) = book.list("Regions", &["East", "West"]);
    let sales = book.module(
        "Sales",
        vec![list_axis(products), list_axis(regions), month_axis()],
    );
    let units = book.input(sales, "Units", Format::number());
    let month = book.month(0);
    let mut cells = Vec::new();
    for (product, row) in product_ids.iter().zip([[4.0, 8.0], [6.0, 8.0]]) {
        for (region, value) in region_ids.iter().zip(row) {
            let coords = vec![item(*product), item(*region), month.clone()];
            cells.push((coords, Value::Number(value)));
        }
    }
    book.set_all(units, cells);
    let rank = book.calc_in(sales, Format::number(), "RANK(Units)");

    let coords = product_ids
        .iter()
        .flat_map(|product| {
            region_ids
                .iter()
                .map(|region| vec![item(*product), item(*region), month.clone()])
        })
        .collect();
    let ranks = book.numbers_at(rank, coords);
    // 8 and 8 are first; then 6, then 4.
    assert_eq!(ranks, [4.0, 1.0, 3.0, 1.0]);
}

#[test]
fn rank_skips_deleted_items_and_follows_subsets() {
    let mut r = ranking();
    r.set_month(0, [50.0, 70.0, 20.0, 10.0, 90.0]);
    let subset = SubsetId::new();
    r.book
        .model
        .apply(Command::CreateSubset {
            id: subset,
            list: r.products,
            name: "Some".to_string(),
            items: vec![r.ids[0], r.ids[2], r.ids[4]],
        })
        .unwrap();
    let picked = r
        .book
        .module("Picked", vec![AxisSpec::Subset { subset }, month_axis()]);
    let picked_rank = r.book.calc_in(picked, Format::number(), "RANK(Units)");
    let jan = r.book.month(0);
    let coords = |ids: &[ItemId]| -> Vec<Vec<CoordToken>> {
        ids.iter().map(|&id| vec![item(id), jan.clone()]).collect()
    };

    // Among A, C and E alone the ranks are 2, 3 and 1.
    assert_eq!(
        r.book
            .numbers_at(picked_rank, coords(&[r.ids[0], r.ids[2], r.ids[4]])),
        [2.0, 3.0, 1.0]
    );

    let rank = r.book.calc_in(r.sales, Format::number(), "RANK(Units)");
    r.book
        .model
        .apply(Command::DeleteListItems {
            list: r.products,
            ids: vec![r.ids[4]],
        })
        .unwrap();
    r.book.recalc();
    // Without E, B is first.
    assert_eq!(
        r.book
            .numbers_at(rank, coords(&[r.ids[0], r.ids[1], r.ids[2], r.ids[3]])),
        [2.0, 1.0, 3.0, 4.0]
    );
}

#[test]
fn rank_works_over_more_than_one_chunk() {
    const PRODUCTS: usize = 700;
    let mut book = Book::new();
    let names: Vec<String> = (0..PRODUCTS).map(|i| format!("P{i}")).collect();
    let names: Vec<&str> = names.iter().map(String::as_str).collect();
    let (products, ids) = book.list("Products", &names);
    let sales = book.module("Sales", vec![list_axis(products), month_axis()]);
    let units = book.input(sales, "Units", Format::number());
    // Product p sells (p * 7) % 701 in Jan, which are all different, and p % 10 in Feb.
    let mut cells = Vec::new();
    for (product, id) in ids.iter().enumerate() {
        cells.push((
            vec![item(*id), book.month(0)],
            Value::Number(((product * 7) % 701) as f64),
        ));
        cells.push((
            vec![item(*id), book.month(1)],
            Value::Number((product % 10) as f64),
        ));
    }
    book.set_all(units, cells);
    let rank = book.calc_in(sales, Format::number(), "RANK(Units)");

    let jan: Vec<f64> = book.numbers_at(
        rank,
        ids.iter()
            .map(|&id| vec![item(id), book.month(0)])
            .collect(),
    );
    let feb: Vec<f64> = book.numbers_at(
        rank,
        ids.iter()
            .map(|&id| vec![item(id), book.month(1)])
            .collect(),
    );
    for product in 0..PRODUCTS {
        let sold = (product * 7) % 701;
        let better = (0..PRODUCTS)
            .filter(|&other| (other * 7) % 701 > sold)
            .count();
        assert_eq!(jan[product], (better + 1) as f64, "Jan {product}");
        let sold = product % 10;
        let better = (0..PRODUCTS).filter(|&other| other % 10 > sold).count();
        assert_eq!(feb[product], (better + 1) as f64, "Feb {product}");
    }
}

#[test]
fn npv_irr_match_excel() {
    let mut book = Book::new();
    book.series("Flows", &[100.0, 100.0, 100.0]);
    book.series("Investment", &[-1000.0, 300.0, 400.0, 500.0]);

    // The first period is discounted by one period, and the value is the same in every month.
    for value in book.numbers("NPV(0.1, Flows)", 24) {
        assert_close(value, 248.685_199_098_422_2);
    }
    assert_all_close(
        &book.numbers("NPV(0.1, Investment)", 2),
        &[-1000.0 / 1.1 + 300.0 / 1.21 + 400.0 / 1.331 + 500.0 / 1.4641; 2],
    );
    assert_all_close(&book.numbers("NPV(0, Flows)", 2), &[300.0; 2]);

    // The first flow of an IRR is not discounted at all.
    for value in book.numbers("IRR(Investment)", 24) {
        assert_close(value, 0.088_963_394_693_349_85);
    }
    // At the rate of return the value of the flows is nothing.
    let nothing = book.numbers("NPV(IRR(Investment), Investment)", 1)[0];
    assert!(nothing.abs() < 1e-6, "{nothing}");

    // A series that has no rate of return, and one that has no flows at all.
    book.series("Gains", &[100.0, 200.0]);
    book.series("Nothing", &[]);
    assert_eq!(book.numbers("IRR(Gains)", 3), [0.0; 3]);
    assert_eq!(book.numbers("IRR(Nothing)", 3), [0.0; 3]);
}

#[test]
fn npv_takes_the_rate_of_the_cell() {
    let mut book = Book::new();
    book.series("Flows", &[100.0, 100.0, 100.0]);
    book.series("Rate", &[0.1, 0.2, 0.2]);

    let npv = book.numbers("NPV(Rate, Flows)", 5);
    assert_close(npv[0], 248.685_199_098_422_2);
    assert_close(npv[1], 100.0 / 1.2 + 100.0 / 1.44 + 100.0 / 1.728);
    assert_close(npv[2], npv[1]);
    // The months without a rate use a rate of 0.
    assert_close(npv[3], 300.0);
    // Nothing can be discounted at a rate of -1.
    assert_eq!(book.numbers("NPV(-1, Flows)", 2), [0.0, 0.0]);
}

#[test]
fn npv_and_irr_are_per_line_of_the_other_axes() {
    let mut book = Book::new();
    let (products, ids) = book.list("Products", &["A", "B"]);
    let sales = book.module("Sales", vec![list_axis(products), month_axis()]);
    let flows = book.input(sales, "Flows", Format::number());
    for (product, values) in [
        (0, vec![-100.0, 110.0]),
        (1, vec![-500.0, 100.0, 200.0, 300.0, 400.0]),
    ] {
        for (month, value) in values.into_iter().enumerate() {
            book.set_number(flows, vec![item(ids[product]), book.month(month)], value);
        }
    }
    let irr = book.calc_in(sales, Format::number(), "IRR(Flows)");
    let npv = book.calc_in(sales, Format::number(), "NPV(0.1, Flows)");

    let at = |book: &Book, li, product: usize, month: usize| {
        book.number_at(li, vec![item(ids[product]), book.month(month)])
    };
    assert_close(at(&book, irr, 0, 0), 0.1);
    assert_close(at(&book, irr, 0, 7), 0.1);
    assert_close(at(&book, irr, 1, 0), 0.272_732_102_758_182_7);
    assert_close(at(&book, npv, 0, 5), -100.0 / 1.1 + 110.0 / 1.21);
    assert_close(at(&book, npv, 1, 5), 231.634_699_567_217_7);
}

#[test]
fn irr_brackets_a_root_that_newton_steps_past() {
    let mut book = Book::new();
    // Newton's method from 10 % steps past -100 %, and the root is at -80 %.
    book.series("Two Flows", &[-500.0, 100.0]);
    let rate = book.numbers("IRR(Two Flows)", 1)[0];
    assert!((rate + 0.8).abs() < 1e-9, "{rate}");

    // The root is at (1 + rate)^5 = 0.05.
    book.series("Five Years", &[-1000.0, 0.0, 0.0, 0.0, 0.0, 50.0]);
    let rate = book.numbers("IRR(Five Years)", 1)[0];
    let expected = 0.05_f64.powf(0.2) - 1.0;
    assert!((rate - expected).abs() < 1e-9, "{rate}");
    assert!((rate + 0.4507).abs() < 1e-4, "{rate}");
    let nothing = book.numbers("NPV(IRR(Five Years), Five Years)", 1)[0];
    assert!(nothing.abs() < 1e-6, "{nothing}");
}

#[test]
fn irr_is_zero_when_the_values_never_change_sign() {
    let mut book = Book::new();
    book.series("Gains", &[100.0, 200.0]);
    book.series("Losses", &[-100.0, -200.0]);
    assert_eq!(book.numbers("IRR(Gains)", 1), [0.0]);
    assert_eq!(book.numbers("IRR(Losses)", 1), [0.0]);
}

#[test]
fn irr_over_a_long_timeline_ignores_flows_too_small_to_see() {
    // Over 240 months the present value at the lowest rates of the search is too small to tell
    // from 0, and must not make a rate of its own out of that.
    let mut book = Book::with_calendar(calendar(1, 2026, 20));
    book.series("Two Flows", &[-500.0, 100.0]);
    let rate = book.numbers("IRR(Two Flows)", 1)[0];
    assert!((rate + 0.8).abs() < 1e-9, "{rate}");
}

#[test]
fn irr_over_a_long_timeline_never_uses_subnormal_weights() {
    // Over 240 flows the weights of the first flows at the lowest rates of the search go
    // subnormal and give the wrong sign. The only root is at -97 %, below the lowest rate that
    // the search scans for 240 flows, so the answer is 0 or that root.
    let mut book = Book::with_calendar(calendar(1, 2026, 20));
    let mut flows = vec![-1000.0, 30.0];
    flows.resize(240, 0.0);
    book.series("Thirty", &flows);
    let rate = book.numbers("IRR(Thirty)", 1)[0];
    assert!(rate == 0.0 || (rate + 0.97).abs() < 1e-6, "{rate}");
}

#[test]
fn irr_over_a_long_timeline_never_reports_a_non_root() {
    // The only root of these 240 flows is at growth 1e170^(1/100), about 50.1, which is above the
    // highest growth the search scans for 240 flows. Above about 40 the weight of the late flow
    // underflows, and the sign change that gave was no root (a rate of 40.5).
    let mut book = Book::with_calendar(calendar(1, 2026, 20));
    let mut flows = vec![0.0; 240];
    flows[100] = -1.0;
    flows[200] = 1e170;
    book.series("Late", &flows);
    let root = 10f64.powf(1.7) - 1.0;
    let rate = book.numbers("IRR(Late)", 1)[0];
    assert!(rate == 0.0 || (rate - root).abs() < 1e-6, "{rate}");
}

#[test]
fn pmt_pv_fv_match_excel() {
    let mut book = Book::new();

    // A loan of 200,000 over 30 years at 5 %.
    let pmt = book.numbers("PMT(0.05 / 12, 360, 200000)", 1)[0];
    assert_close(pmt, -1_073.643_246_024_279_5);
    assert_close(book.numbers("PMT(0, 12, 1200)", 1)[0], -100.0);
    assert_close(
        book.numbers("PMT(0.01, 12, -1000)", 1)[0],
        88.848_788_678_341_68,
    );
    assert_eq!(book.numbers("PMT(0.01, 0, 1000)", 1), [0.0]);

    assert_close(
        book.numbers("PV(0.05 / 12, 360, -1073.643246024279)", 1)[0],
        200_000.0,
    );
    assert_close(book.numbers("PV(0, 12, -100)", 1)[0], 1200.0);
    assert_close(
        book.numbers("PV(0.08 / 12, 240, 500)", 1)[0],
        -59_777.145_851_187_77,
    );

    // The example of the Excel documentation, without the payment at the start of the period.
    assert_close(
        book.numbers("FV(0.06 / 12, 10, -200, -500)", 1)[0],
        2_571.175_347_651_979,
    );
    assert_close(book.numbers("FV(0, 12, -100, 0)", 1)[0], 1200.0);
    assert_close(book.numbers("FV(0, 12, -100, -1000)", 1)[0], 2200.0);
    assert_close(
        book.numbers("FV(0.05 / 12, 12, -100, 0)", 1)[0],
        1_227.885_549_161_591_4,
    );

    // Paying the loan back leaves nothing owed.
    let owed = book.numbers("FV(0.05 / 12, 360, PMT(0.05 / 12, 360, 200000), 200000)", 1)[0];
    assert!(owed.abs() < 1e-6, "{owed}");
    // A rate too small to tell from 0 is 0.
    assert_close(book.numbers("PMT(1e-20, 12, 1200)", 1)[0], -100.0);
}

#[test]
fn finance_functions_take_cells_and_never_overflow() {
    let mut book = Book::new();
    book.series("Rate", &[0.01, 0.02]);
    book.series("Term", &[12.0, 24.0]);

    assert_all_close(
        &book.numbers("PMT(Rate, Term, 1000)", 2),
        &[-88.848_788_678_341_68, -52.871_097_253_249_85],
    );
    // Over a term that never ends the payment is the interest and the present value is the
    // interest capitalised; a future value that is out of range is like any other overflow.
    assert_close(book.numbers("PMT(0.5, 1e300, 1)", 1)[0], -0.5);
    assert_close(book.numbers("PV(0.5, 1e300, 1)", 1)[0], -2.0);
    assert_eq!(book.numbers("FV(0.5, 1e300, 1, 1)", 1), [0.0]);
}

#[test]
fn time_function_without_time_axis_errors() {
    let mut book = Book::new();
    let (regions, _) = book.list("Regions", &["East", "West"]);
    let plain = book.module("Plain", vec![list_axis(regions)]);
    book.input(plain, "Units", Format::number());

    let calls = [
        "PREVIOUS(Units)",
        "NEXT(Units)",
        "OFFSET(Units, 1, 0)",
        "LAG(Units, 1, 0)",
        "LEAD(Units, 1, 0)",
        "CUMULATE(Units)",
        "MOVINGSUM(Units, -1, 0)",
        "YEARVALUE(Units)",
        "QUARTERVALUE(Units)",
        "HALFYEARVALUE(Units)",
        "MONTHVALUE(Units)",
        "TIMESUM(Units)",
        "TIMESUM(Units, Time.'Jan 26', Time.'Jun 26')",
        "YEARTODATE(Units)",
        "QUARTERTODATE(Units)",
        "HALFYEARTODATE(Units)",
        "NPV(0.1, Units)",
        "IRR(Units)",
    ];
    for call in calls {
        let formula = format!("1 + {call}");
        let errors = book.errors_in(plain, Format::number(), &formula);
        assert_eq!(errors.len(), 1, "{call}: {errors:?}");
        assert_eq!(errors[0].code, "formula.dimension", "{call}");
        assert_eq!(
            errors[0].message, "This function needs a Time dimension.",
            "{call}"
        );
        assert_eq!(
            (errors[0].start, errors[0].end),
            (4, formula.len()),
            "{call}"
        );
    }
    for call in ["START()", "END()"] {
        let errors = book.errors_in(plain, Format::Date, call);
        assert_eq!(errors.len(), 1, "{call}: {errors:?}");
        assert_eq!(errors[0].code, "formula.dimension", "{call}");
        assert_eq!(
            errors[0].message, "This function needs a Time dimension.",
            "{call}"
        );
        assert_eq!((errors[0].start, errors[0].end), (0, call.len()), "{call}");
    }
}

#[test]
fn a_time_function_needs_the_time_dimension_of_the_line_item_not_the_module() {
    let mut book = Book::new();
    let rev = book.series("Rev", &[1.0]);
    let mut yearless = line_item(
        book.sheet,
        "Total Rev",
        Format::number(),
        Some("PREVIOUS(Rev)"),
    );
    yearless.time_scale = TimeScale::None;

    let errors = match book.model.apply(Command::CreateLineItem(yearless)) {
        Err(EngineError::Formula(errors)) => errors,
        other => panic!("the formula should be rejected, found {other:?}"),
    };

    assert_eq!(errors[0].code, "formula.dimension");
    assert_eq!(errors[0].message, "This function needs a Time dimension.");
    assert!(book.model.line_item_errors(rev).is_none());
}

#[test]
fn a_missing_dimension_is_an_error_even_in_a_branch_that_is_skipped() {
    let mut book = Book::new();
    let (regions, _) = book.list("Regions", &["East"]);
    let plain = book.module("Plain", vec![list_axis(regions)]);
    book.input(plain, "Units", Format::number());

    for formula in [
        "IF FALSE THEN CUMULATE(Units) ELSE 0",
        "IF TRUE THEN 0 ELSE PREVIOUS(Units)",
        "IF TRUE THEN 0 ELSE YEARVALUE(Units)",
        "IF TRUE THEN 0 ELSE NPV(0.1, Units)",
    ] {
        let errors = book.errors_in(plain, Format::number(), formula);
        assert_eq!(
            errors[0].message, "This function needs a Time dimension.",
            "{formula}"
        );
    }
    let errors = book.errors_in(
        plain,
        Format::number(),
        "IF TRUE THEN 0 ELSE CURRENTVERSION(Units)",
    );
    assert_eq!(
        errors[0].message,
        "This function needs a Versions dimension."
    );
}

#[test]
fn version_and_rank_functions_need_their_dimensions() {
    let mut book = Book::new();
    let rev = book.series("Rev", &[1.0]);
    let (regions, _) = book.list("Regions", &["East", "West"]);
    let sales = book.module("Sales", vec![list_axis(regions), AxisSpec::Versions]);
    book.input(sales, "Units", Format::number());

    for call in ["CURRENTVERSION", "PREVIOUSVERSION", "NEXTVERSION"] {
        let formula = format!("2 * {call}(Rev)");
        let errors = book.errors_in(book.sheet, Format::number(), &formula);
        assert_eq!(errors.len(), 1, "{call}: {errors:?}");
        assert_eq!(errors[0].code, "formula.dimension", "{call}");
        assert_eq!(
            errors[0].message, "This function needs a Versions dimension.",
            "{call}"
        );
        assert_eq!(
            (errors[0].start, errors[0].end),
            (4, formula.len()),
            "{call}"
        );
    }
    let errors = book.errors_in(book.sheet, Format::number(), "RANK(Rev)");
    assert_eq!(errors[0].code, "formula.dimension");
    assert_eq!(errors[0].message, "This function needs a list dimension.");
    assert_eq!((errors[0].start, errors[0].end), (0, 9));
    let errors = book.errors_in(book.sheet, Format::number(), "RANK(Rev, ASCENDING)");
    assert_eq!(errors[0].message, "This function needs a list dimension.");
    assert!(book.model.line_item_errors(rev).is_none());

    // A line item with a list, however, ranks.
    book.calc_in(sales, Format::number(), "RANK(Units)");
}

#[test]
fn functions_over_a_list_without_items_have_nothing_to_calculate() {
    let mut book = Book::new();
    let (products, _) = book.list("Products", &[]);
    let sales = book.module("Sales", vec![list_axis(products), month_axis()]);
    book.input(sales, "Units", Format::number());

    for formula in [
        "CUMULATE(Units)",
        "PREVIOUS(Units)",
        "YEARVALUE(Units)",
        "YEARTODATE(Units)",
        "TIMESUM(Units)",
        "MOVINGSUM(Units, -1, 0)",
        "NPV(0.1, Units)",
        "IRR(Units)",
        "RANK(Units)",
    ] {
        book.calc_in(sales, Format::number(), formula);
    }
    book.calc_in(sales, Format::Boolean, "ISFIRSTOCCURRENCE(Units, Products)");
}

#[test]
fn time_functions_nest_and_combine() {
    let mut book = Book::new();
    book.series("Rev", &[10.0, 20.0, 30.0, 40.0]);

    assert_eq!(
        book.numbers("CUMULATE(PREVIOUS(Rev))", 6),
        [0.0, 10.0, 30.0, 60.0, 100.0, 100.0]
    );
    assert_eq!(
        book.numbers("PREVIOUS(CUMULATE(Rev))", 6),
        [0.0, 10.0, 30.0, 60.0, 100.0, 100.0]
    );
    assert_eq!(
        book.numbers("MOVINGSUM(CUMULATE(Rev), -1, 0)", 5),
        [10.0, 40.0, 90.0, 160.0, 200.0]
    );
    assert_eq!(book.numbers("CUMULATE(Rev) - YEARTODATE(Rev)", 4), [0.0; 4]);
    assert_eq!(
        book.numbers("CUMULATE(IF Rev > 15 THEN Rev ELSE 0)", 5),
        [0.0, 20.0, 50.0, 90.0, 90.0]
    );
    assert_eq!(
        book.numbers("DIVIDE(Rev, TIMESUM(Rev))", 4),
        [0.1, 0.2, 0.3, 0.4]
    );
    assert_eq!(
        book.numbers("OFFSET(CUMULATE(Rev), -1, 0) + Rev", 4),
        [10.0, 30.0, 60.0, 100.0]
    );
}

#[test]
fn every_function_evaluates() {
    // One formula per function of the table, in a module with every dimension a function can
    // need. A function nobody implemented would come back as a problem of its call.
    let mut book = Book::new();
    let (regions, regions_ids) = book.list("Regions", &["East", "West"]);
    let countries = ListId::new();
    book.model
        .apply(Command::CreateList {
            id: countries,
            name: "Countries".to_string(),
            parent: Some(regions),
            top_level_name: None,
            numbered: false,
            production_data: false,
        })
        .unwrap();
    let country_specs = [("US", 0), ("CA", 0), ("DE", 1)].map(|(name, parent)| ItemSpec {
        id: ItemId::new(),
        code: Some(format!("C-{name}")),
        name: name.to_string(),
        parent: Some(regions_ids[parent]),
    });
    book.model
        .apply(Command::UpsertListItems {
            list: countries,
            items: country_specs.to_vec(),
        })
        .unwrap();
    let grid = book.module(
        "Grid",
        vec![list_axis(countries), month_axis(), AxisSpec::Versions],
    );
    book.input(grid, "Amount", Format::number());
    book.input(grid, "Label", Format::Text);
    book.input(grid, "Invoice Date", Format::Date);

    #[derive(Clone, Copy)]
    enum Kind {
        Number,
        Boolean,
        Text,
        Date,
        Country,
        Region,
        Month,
    }
    use Kind::*;
    let table: &[(&str, Kind, &str)] = &[
        ("ABS", Number, "ABS(Amount)"),
        ("ROUND", Number, "ROUND(Amount, 1, UP)"),
        ("MIN", Number, "MIN(Amount, 1, 2)"),
        ("MAX", Number, "MAX(Amount, 1, 2)"),
        ("POWER", Number, "POWER(Amount, 2)"),
        ("SQRT", Number, "SQRT(Amount)"),
        ("EXP", Number, "EXP(Amount)"),
        ("LN", Number, "LN(Amount)"),
        ("LOG", Number, "LOG(Amount, 2)"),
        ("MOD", Number, "MOD(Amount, 3)"),
        ("DIVIDE", Number, "DIVIDE(Amount, 3)"),
        ("SIGN", Number, "SIGN(Amount)"),
        ("ISBLANK", Boolean, "ISBLANK(Label)"),
        ("ISNOTBLANK", Boolean, "ISNOTBLANK(Label)"),
        (
            "ISANCESTOR",
            Boolean,
            "ISANCESTOR(Regions.East, ITEM(Countries))",
        ),
        (
            "ISFIRSTOCCURRENCE",
            Boolean,
            "ISFIRSTOCCURRENCE(Label, Countries)",
        ),
        ("LEFT", Text, "LEFT(Label, 2)"),
        ("RIGHT", Text, "RIGHT(Label, 2)"),
        ("MID", Text, "MID(Label, 2, 2)"),
        ("LEN", Number, "LEN(Label)"),
        ("FIND", Number, "FIND(\"a\", Label)"),
        ("UPPER", Text, "UPPER(Label)"),
        ("LOWER", Text, "LOWER(Label)"),
        ("TRIM", Text, "TRIM(Label)"),
        ("SUBSTITUTE", Text, "SUBSTITUTE(Label, \"a\", \"b\")"),
        ("TEXT", Text, "TEXT(Amount)"),
        ("VALUE", Number, "VALUE(Label)"),
        ("ITEM", Country, "ITEM(Countries)"),
        ("PARENT", Region, "PARENT(ITEM(Countries))"),
        ("NAME", Text, "NAME(ITEM(Countries))"),
        ("CODE", Text, "CODE(ITEM(Countries))"),
        ("FINDITEM", Country, "FINDITEM(Countries, Label)"),
        ("PREVIOUS", Number, "PREVIOUS(Amount)"),
        ("NEXT", Number, "NEXT(Amount)"),
        ("OFFSET", Number, "OFFSET(Amount, 1, 0)"),
        ("LAG", Number, "LAG(Amount, 1, 0)"),
        ("LEAD", Number, "LEAD(Amount, 1, 0)"),
        ("CUMULATE", Number, "CUMULATE(Amount)"),
        ("MOVINGSUM", Number, "MOVINGSUM(Amount, -1, 0)"),
        ("YEARVALUE", Number, "YEARVALUE(Amount)"),
        ("QUARTERVALUE", Number, "QUARTERVALUE(Amount)"),
        ("HALFYEARVALUE", Number, "HALFYEARVALUE(Amount)"),
        ("MONTHVALUE", Number, "MONTHVALUE(Amount)"),
        (
            "TIMESUM",
            Number,
            "TIMESUM(Amount, Time.'Jan 26', Time.'Jun 26')",
        ),
        ("YEARTODATE", Number, "YEARTODATE(Amount)"),
        ("QUARTERTODATE", Number, "QUARTERTODATE(Amount)"),
        ("HALFYEARTODATE", Number, "HALFYEARTODATE(Amount)"),
        ("START", Date, "START()"),
        ("END", Date, "END()"),
        ("INPERIOD", Boolean, "INPERIOD(Invoice Date, Time.'Jan 26')"),
        ("PERIOD", Month, "PERIOD(Invoice Date)"),
        ("CURRENTPERIODSTART", Date, "CURRENTPERIODSTART()"),
        ("CURRENTPERIODEND", Date, "CURRENTPERIODEND()"),
        ("DATE", Date, "DATE(2026, 1, 31)"),
        ("DAY", Number, "DAY(Invoice Date)"),
        ("MONTH", Number, "MONTH(Invoice Date)"),
        ("YEAR", Number, "YEAR(Invoice Date)"),
        ("WEEKDAY", Number, "WEEKDAY(Invoice Date)"),
        ("ADDMONTHS", Date, "ADDMONTHS(Invoice Date, 1)"),
        ("ADDYEARS", Date, "ADDYEARS(Invoice Date, 1)"),
        ("DAYS", Number, "DAYS(Invoice Date, START())"),
        ("CURRENTVERSION", Number, "CURRENTVERSION(Amount)"),
        ("PREVIOUSVERSION", Number, "PREVIOUSVERSION(Amount)"),
        ("NEXTVERSION", Number, "NEXTVERSION(Amount)"),
        ("RANK", Number, "RANK(Amount, ASCENDING)"),
        ("NPV", Number, "NPV(0.1, Amount)"),
        ("IRR", Number, "IRR(Amount)"),
        ("PMT", Number, "PMT(0.01, 12, Amount)"),
        ("PV", Number, "PV(0.01, 12, Amount)"),
        ("FV", Number, "FV(0.01, 12, Amount, 1)"),
    ];
    let defined: Vec<&str> = functions::all().iter().map(|def| def.name).collect();
    let covered: Vec<&str> = table.iter().map(|(name, ..)| *name).collect();
    for name in &defined {
        assert!(covered.contains(name), "{name} has no formula in the table");
    }
    for name in &covered {
        assert!(defined.contains(name), "{name} is not a function");
    }

    let mut calculated = Vec::new();
    for (name, kind, formula) in table {
        let format = match kind {
            Number => Format::number(),
            Boolean => Format::Boolean,
            Text => Format::Text,
            Date => Format::Date,
            Country => Format::List { list: countries },
            Region => Format::List { list: regions },
            Month => Format::TimePeriod {
                level: TimeLevel::Month,
            },
        };
        calculated.push((*name, book.errors_in_id(grid, format, formula)));
    }
    for (name, id) in calculated {
        if let Some(errors) = book.model.line_item_errors(id) {
            panic!("{name} should evaluate: {errors:?}");
        }
    }
}

#[test]
fn cumulate_and_rank_over_a_large_target() {
    const ITEMS: usize = 20_000;
    // Twenty years of months.
    let mut book = Book::with_calendar(calendar(1, 2026, 20));
    let names: Vec<String> = (0..ITEMS).map(|i| format!("P{i}")).collect();
    let names: Vec<&str> = names.iter().map(String::as_str).collect();
    let (products, ids) = book.list("Products", &names);
    let info = book.module("Info", vec![list_axis(products)]);
    let seed = book.input(info, "Seed", Format::number());
    let cells = ids
        .iter()
        .enumerate()
        .map(|(i, id)| (vec![item(*id)], Value::Number(i as f64)))
        .collect();
    book.set_all(seed, cells);
    let sales_module = book.module("Sales", vec![list_axis(products), month_axis()]);

    // Distinct per item, the same for every year, and growing with the calendar month.
    let sales = book.add(line_item(
        sales_module,
        "Sales",
        Format::number(),
        Some("Seed * 10 + MOD(Seed, 7) + MONTH(START()) * 3"),
    ));
    book.recalc();

    let mut add = |name: &str, format: Format, formula: &str| {
        book.add(line_item(sales_module, name, format, Some(formula)))
    };
    let cumulative = add("Cumulative", Format::number(), "CUMULATE(Sales)");
    let rank = add("Rank", Format::number(), "RANK(Sales)");
    let previous = add("Previous", Format::number(), "PREVIOUS(Sales)");
    let year = add("Year", Format::number(), "YEARVALUE(Sales)");
    let ytd = add("YTD", Format::number(), "YEARTODATE(Sales)");
    // Many items share the value of their sales in hundreds.
    let first = add(
        "First",
        Format::Boolean,
        "ISFIRSTOCCURRENCE(MOD(Sales, 100), Products)",
    );
    book.recalc();
    for line_item in [sales, cumulative, rank, previous, year, ytd, first] {
        assert!(book.model.line_item_errors(line_item).is_none());
    }

    for month in [0, 7, 239] {
        let mut seen = HashSet::new();
        let expected: Vec<Value> = (0..ITEMS)
            .map(|p| {
                let sold = 10 * p + p % 7 + 3 * (month % 12 + 1);
                Value::Boolean(seen.insert(sold % 100))
            })
            .collect();
        let coords = ids
            .iter()
            .map(|&id| vec![item(id), book.month(month)])
            .collect();
        assert_eq!(book.read(first, coords), expected, "month {month}");
    }

    let last = book.month(239);
    for product in [0, 1, 6, 7, 4095, 4096, 9_999, 19_998, 19_999] {
        let id = ids[product];
        let base = (product * 10 + product % 7) as f64;
        let cell = |month: usize| vec![item(id), book.month(month)];
        // Months 0, 1, ... are Jan, Feb, ...; the sum of the months of the year is 78.
        assert_eq!(book.number_at(sales, cell(0)), base + 3.0);
        assert_eq!(
            book.number_at(cumulative, vec![item(id), last.clone()]),
            240.0 * base + 3.0 * 78.0 * 20.0,
            "CUMULATE of {product}"
        );
        assert_eq!(book.number_at(cumulative, cell(1)), 2.0 * base + 9.0);
        assert_eq!(book.number_at(previous, cell(5)), base + 15.0);
        assert_eq!(book.number_at(year, cell(100)), 12.0 * base + 3.0 * 78.0);
        assert_eq!(book.number_at(ytd, cell(14)), 3.0 * base + 3.0 * 6.0);
        for month in [0, 7, 239] {
            assert_eq!(
                book.number_at(rank, cell(month)),
                (ITEMS - product) as f64,
                "RANK of {product} in month {month}"
            );
        }
    }
}
