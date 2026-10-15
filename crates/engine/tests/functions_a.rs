//! The math, logic, text, date and list functions (spec §4.5), evaluated through the model.

use std::sync::Arc;

use chrono::NaiveDate;
use openplan_engine::{
    AxisSpec, Calendar, CellEdit, Command, CoordToken, EngineError, Format, FormulaError, ItemId,
    ItemSpec, LineItem, LineItemId, ListId, Model, ModuleId, SubsetId, SummaryMethod, TimeLevel,
    TimeScale, Value, VersionsScope,
};

const MONTHS: [&str; 12] = [
    "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

fn new_line_item(module: ModuleId, name: &str, format: Format, formula: Option<&str>) -> LineItem {
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

/// The coordinate of the `i`th month of the two-year calendar.
fn month(i: usize) -> CoordToken {
    CoordToken::Period(format!("{} {}", MONTHS[i % 12], 26 + i / 12))
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

fn numbers(values: &[f64]) -> Vec<Value> {
    values.iter().map(|&number| Value::Number(number)).collect()
}

fn texts(values: &[&str]) -> Vec<Value> {
    values.iter().map(|&value| text(value)).collect()
}

fn dates(values: &[Option<NaiveDate>]) -> Vec<Value> {
    values.iter().map(|&value| Value::Date(value)).collect()
}

/// Lists Regions > Countries > Cities and a module `Sheet` on a monthly Time axis, which is
/// where inputs are set in the first months and formulas are read back.
struct Book {
    model: Model,
    sheet: ModuleId,
    outputs: usize,
    regions: ListId,
    countries: ListId,
    cities: ListId,
    na: ItemId,
    eu: ItemId,
    us: ItemId,
    ca: ItemId,
    de: ItemId,
    new_york: ItemId,
    boston: ItemId,
    berlin: ItemId,
}

impl Book {
    fn new() -> Book {
        let mut model = Model::new(Calendar {
            fiscal_year_start_month: 1,
            first_year: 2026,
            years: 2,
            current_month: None,
        });
        let mut list = |name: &str, parent: Option<ListId>| {
            let id = ListId::new();
            model
                .apply(Command::CreateList {
                    id,
                    name: name.to_string(),
                    parent,
                    top_level_name: None,
                    numbered: false,
                    production_data: false,
                })
                .unwrap();
            id
        };
        let regions = list("Regions", None);
        let countries = list("Countries", Some(regions));
        let cities = list("Cities", Some(countries));
        let mut book = Book {
            model,
            sheet: ModuleId::new(),
            outputs: 0,
            regions,
            countries,
            cities,
            na: ItemId::new(),
            eu: ItemId::new(),
            us: ItemId::new(),
            ca: ItemId::new(),
            de: ItemId::new(),
            new_york: ItemId::new(),
            boston: ItemId::new(),
            berlin: ItemId::new(),
        };
        let spec = |id, name: &str, code: Option<&str>, parent| ItemSpec {
            id,
            code: code.map(str::to_string),
            name: name.to_string(),
            parent,
        };
        let items = [
            (
                regions,
                vec![
                    spec(book.na, "North America", Some("NA"), None),
                    spec(book.eu, "Europe", Some("EU"), None),
                ],
            ),
            (
                countries,
                vec![
                    spec(book.us, "US", Some("C-US"), Some(book.na)),
                    spec(book.ca, "CA", Some("C-CA"), Some(book.na)),
                    spec(book.de, "DE", Some("C-DE"), Some(book.eu)),
                ],
            ),
            (
                cities,
                vec![
                    spec(book.new_york, "New York", None, Some(book.us)),
                    spec(book.boston, "Boston", None, Some(book.us)),
                    spec(book.berlin, "Berlin", None, Some(book.de)),
                ],
            ),
        ];
        for (list, items) in items {
            book.model
                .apply(Command::UpsertListItems { list, items })
                .unwrap();
        }
        book.sheet = book.module("Sheet", vec![book.time()]);
        book
    }

    fn time(&self) -> AxisSpec {
        AxisSpec::Time {
            level: TimeLevel::Month,
            range: None,
        }
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

    fn line_item(
        &mut self,
        module: ModuleId,
        name: &str,
        format: Format,
        formula: Option<&str>,
    ) -> LineItemId {
        let line_item = new_line_item(module, name, format, formula);
        let id = line_item.id;
        self.model
            .apply(Command::CreateLineItem(line_item))
            .unwrap();
        id
    }

    /// What is wrong with a formula, which the model refuses for a new line item.
    fn rejected(
        &mut self,
        module: ModuleId,
        name: &str,
        format: Format,
        formula: &str,
    ) -> Vec<FormulaError> {
        let line_item = new_line_item(module, name, format, Some(formula));
        match self.model.apply(Command::CreateLineItem(line_item)) {
            Err(EngineError::Formula(errors)) => errors,
            other => panic!("{formula} should be rejected, found {other:?}"),
        }
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

    fn get(&self, line_item: LineItemId, coords: Vec<CoordToken>) -> Value {
        self.model
            .read_cells(line_item, &[coords])
            .unwrap()
            .pop()
            .unwrap()
    }

    /// An input of `Sheet` holding `values` in its first months.
    fn input(&mut self, name: &str, format: Format, values: Vec<Value>) {
        let id = self.line_item(self.sheet, name, format, None);
        let cells = values
            .into_iter()
            .enumerate()
            .map(|(i, value)| (vec![month(i)], value))
            .collect();
        self.set_all(id, cells);
    }

    fn numbers_in(&mut self, name: &str, values: &[f64]) {
        self.input(name, Format::number(), numbers(values));
    }

    fn texts_in(&mut self, name: &str, values: &[&str]) {
        self.input(name, Format::Text, texts(values));
    }

    fn dates_in(&mut self, name: &str, values: &[Option<NaiveDate>]) {
        self.input(name, Format::Date, dates(values));
    }

    /// The first `count` months of a formula on `Sheet`, which must be valid.
    fn calc(&mut self, format: Format, formula: &str, count: usize) -> Vec<Value> {
        self.outputs += 1;
        let name = format!("Out {}", self.outputs);
        let id = self.line_item(self.sheet, &name, format, Some(formula));
        self.model.recalc_all().unwrap();
        if let Some(errors) = self.model.line_item_errors(id) {
            panic!("{formula} should be valid: {errors:?}");
        }
        let coords: Vec<_> = (0..count).map(|i| vec![month(i)]).collect();
        self.model.read_cells(id, &coords).unwrap()
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

    fn items(&mut self, list: ListId, formula: &str, count: usize) -> Vec<Option<ItemId>> {
        self.calc(Format::List { list }, formula, count)
            .into_iter()
            .map(|value| match value {
                Value::Item(item) => item,
                other => panic!("expected an item, found {other:?}"),
            })
            .collect()
    }
}

fn assert_close(actual: &[f64], expected: &[f64]) {
    assert_eq!(actual.len(), expected.len());
    for (actual, expected) in actual.iter().zip(expected) {
        assert!(
            (actual - expected).abs() < 1e-12,
            "expected {expected:?}, found {actual:?}"
        );
    }
}

#[test]
fn round_modes() {
    let mut book = Book::new();
    book.numbers_in("Half", &[2.5, -2.5, 2.4, -2.6, 0.5, -0.5]);
    let nearest = [3.0, -3.0, 2.0, -3.0, 1.0, -1.0];
    assert_eq!(book.numbers("ROUND(Half, 0)", 6), nearest);
    assert_eq!(book.numbers("ROUND(Half, 0, NEAREST)", 6), nearest);

    book.numbers_in("Frac", &[2.1, -2.1, 2.0, 2.9, -2.9, 0.0]);
    assert_eq!(
        book.numbers("ROUND(Frac, 0, UP)", 6),
        [3.0, -3.0, 2.0, 3.0, -3.0, 0.0]
    );
    assert_eq!(
        book.numbers("ROUND(Frac, 0, DOWN)", 6),
        [2.0, -2.0, 2.0, 2.0, -2.0, 0.0]
    );

    book.numbers_in("Fine", &[1.25, -1.25, 1.24, 1.26]);
    assert_eq!(book.numbers("ROUND(Fine, 1)", 4), [1.3, -1.3, 1.2, 1.3]);
}

#[test]
fn round_to_negative_places() {
    let mut book = Book::new();
    book.numbers_in("Big", &[1250.0, -1250.0, 1249.0, 1201.0, 1299.0]);
    assert_eq!(
        book.numbers("ROUND(Big, -2)", 5),
        [1300.0, -1300.0, 1200.0, 1200.0, 1300.0]
    );
    assert_eq!(
        book.numbers("ROUND(Big, -2, UP)", 5),
        [1300.0, -1300.0, 1300.0, 1300.0, 1300.0]
    );
    assert_eq!(
        book.numbers("ROUND(Big, -2, DOWN)", 5),
        [1200.0, -1200.0, 1200.0, 1200.0, 1200.0]
    );
    assert_eq!(
        book.numbers("ROUND(Big, -1)", 5),
        [1250.0, -1250.0, 1250.0, 1200.0, 1300.0]
    );
}

#[test]
fn round_places_come_from_the_cell() {
    let mut book = Book::new();
    book.numbers_in("Pi", &[1.2345, 1.2345, 1.2345, 1.2345]);
    book.numbers_in("Places", &[0.0, 1.0, 2.0, 2.9]);
    assert_eq!(book.numbers("ROUND(Pi, Places)", 4), [1.0, 1.2, 1.23, 1.23]);
}

#[test]
fn round_ignores_the_representation_error_of_scaling() {
    let mut book = Book::new();
    // 12.35 * 100 is 1235.0000000000002 and 1.005 * 100 is 100.49999999999999, but these
    // are the numbers the user typed, so they round as such.
    book.numbers_in("Typed", &[12.35, 1.005, 1.1, 0.1 + 0.2, 2.675]);
    assert_eq!(
        book.numbers("ROUND(Typed, 2, UP)", 5),
        [12.35, 1.01, 1.1, 0.3, 2.68]
    );
    assert_eq!(
        book.numbers("ROUND(Typed, 2, DOWN)", 5),
        [12.35, 1.0, 1.1, 0.3, 2.67]
    );
    assert_eq!(
        book.numbers("ROUND(Typed, 2)", 5),
        [12.35, 1.01, 1.1, 0.3, 2.68]
    );
}

#[test]
fn round_survives_extreme_places_and_never_gives_negative_zero() {
    let mut book = Book::new();
    book.numbers_in("X", &[1.5, -0.4, 1.0e-20, 0.0]);
    assert_eq!(book.numbers("ROUND(X, 400)", 4), [1.5, -0.4, 1.0e-20, 0.0]);
    assert_eq!(book.numbers("ROUND(X, -400)", 4), [0.0; 4]);
    assert_eq!(book.numbers("ROUND(1.2345e-20, 22)", 1), [1.23e-20]);
    let rounded = book.numbers("ROUND(X, 0)", 4);
    assert_eq!(rounded, [2.0, 0.0, 0.0, 0.0]);
    assert!(rounded.iter().all(|number| number.is_sign_positive()));
}

#[test]
fn round_of_large_numbers_is_exact() {
    let mut book = Book::new();
    // Above 2^50 the spacing of numbers is a quarter, so a fraction is rounded as it is.
    assert_eq!(
        book.numbers("ROUND(1125899906842624.25, 0)", 1),
        [1125899906842624.0]
    );
    assert_eq!(
        book.numbers("ROUND(1125899906842624.75, 0, DOWN)", 1),
        [1125899906842624.0]
    );
    // Below 2^50 a scaled number is snapped to a half only within four units in the last place
    // of it. The typed number is 0.3125 above a whole one, which is outside that.
    assert_eq!(
        book.numbers("ROUND(250000000000000.3, 0)", 1),
        [250000000000000.0]
    );
    // Scaled by 10^5 this is past 2^52, where a number has no fraction, so it is left alone.
    assert_eq!(book.numbers("ROUND(1e300, 5)", 1), [1e300]);
}

#[test]
fn round_of_large_numbers_is_the_nearest_double_of_the_decimal() {
    let mut book = Book::new();
    // Scaled by 10^6 this is past 2^52, but the fraction is still there to round.
    assert_eq!(
        book.numbers("ROUND(5728547987.8965435, 6)", 1),
        [5728547987.896544]
    );
    assert_eq!(
        book.numbers("ROUND(450359962737049.75, 1)", 1),
        [450359962737049.8]
    );
    assert_eq!(
        book.numbers("ROUND(450359962737049.75, 1, DOWN)", 1),
        [450359962737049.7]
    );
    // 450359962737051136 is 450359962737051100 to the hundred, and the nearest double to that is
    // 450359962737051072.
    assert_eq!(
        book.numbers("ROUND(450359962737051136, -2)", 1),
        [450359962737051072.0]
    );
}

#[test]
fn round_takes_the_number_as_written() {
    let mut book = Book::new();
    assert_eq!(book.numbers("ROUND(12.35, 2, UP)", 1), [12.35]);
    assert_eq!(book.numbers("ROUND(12.35, 1)", 1), [12.4]);
    assert_eq!(book.numbers("ROUND(2.5, 0)", 1), [3.0]);
    assert_eq!(book.numbers("ROUND(-2.5, 0)", 1), [-3.0]);
    assert_eq!(book.numbers("ROUND(1.005, 2)", 1), [1.01]);
    assert_eq!(book.numbers("ROUND(1234.5678, -2)", 1), [1200.0]);
    assert_eq!(book.numbers("ROUND(-1234.5678, -2, UP)", 1), [-1300.0]);
    assert_eq!(book.numbers("ROUND(0.000123456, 4, DOWN)", 1), [0.0001]);
    // Any amount above zero is away from zero at UP, even when it is far below the unit.
    assert_eq!(book.numbers("ROUND(0.0001, -2, UP)", 1), [100.0]);
}

#[test]
fn round_of_large_numbers_takes_the_digits_written() {
    let mut book = Book::new();
    // 281474976710656.3 is 281474976710656.3125 as a double, and the digits written leave a
    // fraction below a half.
    assert_eq!(
        book.numbers("ROUND(281474976710656.3, 0)", 1),
        [281474976710656.0]
    );
    // Rounded to the nearest 10^308 this is 2e308, which is out of range, so the result is 0.
    assert_eq!(
        book.numbers("ROUND(1.7976931348623157e308, -308)", 1),
        [0.0]
    );
}

#[test]
fn round_of_a_blank_or_a_zero_is_zero() {
    let mut book = Book::new();
    book.line_item(book.sheet, "Blank", Format::number(), None);
    assert_eq!(book.numbers("ROUND(Blank, 2, UP)", 1), [0.0]);
    assert_eq!(book.numbers("ROUND(Blank / 0, -2, UP)", 1), [0.0]);
    assert_eq!(book.numbers("ROUND(0, 2, UP)", 1), [0.0]);
}

#[test]
fn round_takes_fifteen_digits_when_they_read_back_to_the_number() {
    let mut book = Book::new();
    // 1.005 and 2.675 read back from their 15-digit decimals, so they round as written.
    assert_eq!(book.numbers("ROUND(1.005, 2)", 1), [1.01]);
    assert_eq!(book.numbers("ROUND(2.675, 2)", 1), [2.68]);
    assert_eq!(book.numbers("ROUND(0.1 + 0.2, 2, UP)", 1), [0.3]);
}

#[test]
fn round_takes_the_shortest_decimal_when_fifteen_digits_are_too_far() {
    let mut book = Book::new();
    // The 15-digit decimal of 5728547987.8965435 is 5728547987.89654, more than two units in the
    // last place from it, so the shortest decimal is rounded.
    assert_eq!(
        book.numbers("ROUND(5728547987.8965435, 6)", 1),
        [5728547987.896544]
    );
}

#[test]
fn mod_takes_the_sign_of_the_divisor() {
    let mut book = Book::new();
    book.numbers_in("A", &[7.0, -7.0, 7.0, -7.0, 5.5, 5.0, 0.0]);
    book.numbers_in("B", &[3.0, 3.0, -3.0, -3.0, 2.0, 0.0, 4.0]);
    assert_eq!(
        book.numbers("MOD(A, B)", 7),
        [1.0, 2.0, -2.0, -1.0, 1.5, 0.0, 0.0]
    );
}

#[test]
fn divide_by_zero_is_zero() {
    let mut book = Book::new();
    book.numbers_in("A", &[6.0, 1.0, 0.0, -9.0]);
    book.numbers_in("B", &[3.0, 0.0, 5.0, 3.0]);
    assert_eq!(book.numbers("DIVIDE(A, B)", 4), [2.0, 0.0, 0.0, -3.0]);
    assert_eq!(book.numbers("DIVIDE(A, 0)", 2), [0.0, 0.0]);
}

#[test]
fn power_roots_logs_and_exponentials() {
    let mut book = Book::new();
    book.numbers_in("X", &[9.0, -4.0, 0.0, 2.0]);
    assert_eq!(book.numbers("SQRT(X)", 4), [3.0, 0.0, 0.0, 2.0f64.sqrt()]);
    assert_eq!(book.numbers("POWER(X, 2)", 4), [81.0, 16.0, 0.0, 4.0]);
    // Powers that are not numbers, or do not fit one, are 0 like every such result.
    assert_eq!(
        book.numbers("POWER(X, 0.5)", 4),
        [3.0, 0.0, 0.0, 2.0f64.sqrt()]
    );
    assert_eq!(book.numbers("POWER(0, -1)", 1), [0.0]);
    assert_eq!(book.numbers("POWER(10, 400)", 1), [0.0]);
    assert_eq!(book.numbers("POWER(2, 10)", 1), [1024.0]);

    book.numbers_in("Y", &[1.0, std::f64::consts::E, 0.0, -3.0]);
    assert_close(&book.numbers("LN(Y)", 4), &[0.0, 1.0, 0.0, 0.0]);
    assert_close(
        &book.numbers("EXP(LN(Y))", 4),
        &[1.0, std::f64::consts::E, 1.0, 1.0],
    );
    assert_eq!(book.numbers("EXP(1000)", 1), [0.0]);
    assert_eq!(book.numbers("EXP(0)", 1), [1.0]);
}

#[test]
fn log_takes_a_base_and_defaults_to_ten() {
    let mut book = Book::new();
    book.numbers_in("X", &[1000.0, 100.0, 1.0, 0.0, -5.0]);
    assert_eq!(book.numbers("LOG(X)", 5), [3.0, 2.0, 0.0, 0.0, 0.0]);
    assert_eq!(book.numbers("LOG(X, 10)", 5), [3.0, 2.0, 0.0, 0.0, 0.0]);
    assert_eq!(book.numbers("LOG(8, 2)", 1), [3.0]);
    assert_close(&book.numbers("LOG(125, 5)", 1), &[3.0]);
    // A base that has no logarithms is not a number.
    assert_eq!(book.numbers("LOG(5, 1)", 1), [0.0]);
    assert_eq!(book.numbers("LOG(5, 0)", 1), [0.0]);
    assert_eq!(book.numbers("LOG(5, -2)", 1), [0.0]);
}

#[test]
fn abs_and_sign() {
    let mut book = Book::new();
    book.numbers_in("X", &[-2.5, 0.0, 7.0]);
    assert_eq!(book.numbers("ABS(X)", 3), [2.5, 0.0, 7.0]);
    assert_eq!(book.numbers("SIGN(X)", 3), [-1.0, 0.0, 1.0]);
}

#[test]
fn min_and_max_take_two_or_more_numbers() {
    let mut book = Book::new();
    book.numbers_in("A", &[1.0, 5.0, -3.0]);
    book.numbers_in("B", &[2.0, 4.0, -3.0]);
    book.numbers_in("C", &[0.0, 9.0, -8.0]);
    assert_eq!(book.numbers("MIN(A, B)", 3), [1.0, 4.0, -3.0]);
    assert_eq!(book.numbers("MAX(A, B)", 3), [2.0, 5.0, -3.0]);
    assert_eq!(book.numbers("MIN(A, B, C, 3)", 3), [0.0, 3.0, -8.0]);
    assert_eq!(book.numbers("MAX(A, B, C, 3)", 3), [3.0, 9.0, 3.0]);
}

#[test]
fn functions_take_part_in_conditions_and_operators() {
    let mut book = Book::new();
    book.texts_in("T", &["abc", "", "xyz"]);
    book.numbers_in("N", &[2.0, 5.0, 8.0]);
    assert_eq!(
        book.texts("IF ISBLANK(T) THEN \"none\" ELSE UPPER(T) & TEXT(N)", 3),
        ["ABC2", "none", "XYZ8"]
    );
    assert_eq!(
        book.numbers("IF MOD(N, 2) = 0 THEN LEN(T) ELSE -1", 3),
        [3.0, -1.0, 3.0]
    );
    assert_eq!(
        book.flags("LEFT(T, 1) = \"a\" OR FIND(\"z\", T) > 0", 3),
        [true, false, true]
    );
}

#[test]
fn math_composes_with_operators() {
    let mut book = Book::new();
    book.numbers_in("A", &[4.0, 9.0]);
    assert_eq!(
        book.numbers("SQRT(A) * 2 + ABS(-1) - MAX(A, 5)", 2),
        [0.0, -2.0]
    );
}

#[test]
fn isblank_follows_the_blank_rules() {
    let mut book = Book::new();
    book.numbers_in("Num", &[0.0, 3.0]);
    book.texts_in("Txt", &["", "x"]);
    book.dates_in("Day", &[None, date(2026, 1, 1)]);
    book.input(
        "Owner",
        Format::List { list: book.regions },
        vec![Value::Item(None), Value::Item(Some(book.eu))],
    );
    book.input(
        "Flag",
        Format::Boolean,
        vec![Value::Boolean(false), Value::Boolean(true)],
    );
    // A number is never blank, not even 0.
    assert_eq!(book.flags("ISBLANK(Num)", 3), [false, false, false]);
    assert_eq!(book.flags("ISNOTBLANK(Num)", 3), [true, true, true]);
    // Unset cells are blank too: the third month has no value at all.
    assert_eq!(book.flags("ISBLANK(Txt)", 3), [true, false, true]);
    assert_eq!(book.flags("ISNOTBLANK(Txt)", 3), [false, true, false]);
    assert_eq!(book.flags("ISBLANK(Day)", 3), [true, false, true]);
    assert_eq!(book.flags("ISBLANK(Owner)", 3), [true, false, true]);
    assert_eq!(book.flags("ISNOTBLANK(Owner)", 3), [false, true, false]);
    // A blank Boolean is FALSE.
    assert_eq!(book.flags("ISBLANK(Flag)", 3), [true, false, true]);
    book.input(
        "Due",
        Format::TimePeriod {
            level: TimeLevel::Month,
        },
        vec![
            Value::Period(None),
            Value::Period(Some((TimeLevel::Month, 2))),
        ],
    );
    assert_eq!(book.flags("ISBLANK(Due)", 3), [true, false, true]);
    assert_eq!(book.flags("ISBLANK(Time.'Mar 26')", 1), [false]);
    assert_eq!(
        book.flags("ISBLANK(\"\") AND NOT ISBLANK(\"a\")", 1),
        [true]
    );
}

#[test]
fn parent_and_isancestor() {
    let mut book = Book::new();
    let (regions, countries, cities) = (book.regions, book.countries, book.cities);
    let detail = book.module("Detail", vec![AxisSpec::List { list: countries }]);
    let places = book.module("Places", vec![AxisSpec::List { list: cities }]);
    let parent = book.line_item(
        detail,
        "Region",
        Format::List { list: regions },
        Some("PARENT(ITEM(Countries))"),
    );
    let in_na = book.line_item(
        detail,
        "In NA",
        Format::Boolean,
        Some("ISANCESTOR(Regions.'North America', ITEM(Countries))"),
    );
    let own_parent = book.line_item(
        detail,
        "Own Parent",
        Format::Boolean,
        Some("ISANCESTOR(PARENT(ITEM(Countries)), ITEM(Countries))"),
    );
    let same = book.line_item(
        detail,
        "Same",
        Format::Boolean,
        Some("ISANCESTOR(ITEM(Countries), Countries.US)"),
    );
    let city_region = book.line_item(
        places,
        "City Region",
        Format::List { list: regions },
        Some("PARENT(PARENT(ITEM(Cities)))"),
    );
    let city_in_europe = book.line_item(
        places,
        "In Europe",
        Format::Boolean,
        Some("ISANCESTOR(Regions.Europe, ITEM(Cities))"),
    );
    let city_in_us = book.line_item(
        places,
        "In US",
        Format::Boolean,
        Some("ISANCESTOR(Countries.US, ITEM(Cities))"),
    );
    book.model.recalc_all().unwrap();

    let region = |book: &Book, country| book.get(parent, vec![item(country)]);
    assert_eq!(region(&book, book.us), Value::Item(Some(book.na)));
    assert_eq!(region(&book, book.ca), Value::Item(Some(book.na)));
    assert_eq!(region(&book, book.de), Value::Item(Some(book.eu)));
    for (country, expected) in [(book.us, true), (book.ca, true), (book.de, false)] {
        assert_eq!(
            book.get(in_na, vec![item(country)]),
            Value::Boolean(expected)
        );
        assert_eq!(
            book.get(own_parent, vec![item(country)]),
            Value::Boolean(true)
        );
    }
    // In one list an item is only its own ancestor.
    assert_eq!(book.get(same, vec![item(book.us)]), Value::Boolean(true));
    assert_eq!(book.get(same, vec![item(book.ca)]), Value::Boolean(false));
    // Across two levels of the hierarchy.
    assert_eq!(
        book.get(city_region, vec![item(book.new_york)]),
        Value::Item(Some(book.na))
    );
    assert_eq!(
        book.get(city_region, vec![item(book.berlin)]),
        Value::Item(Some(book.eu))
    );
    for (city, in_europe, in_us) in [
        (book.new_york, false, true),
        (book.boston, false, true),
        (book.berlin, true, false),
    ] {
        assert_eq!(
            book.get(city_in_europe, vec![item(city)]),
            Value::Boolean(in_europe)
        );
        assert_eq!(
            book.get(city_in_us, vec![item(city)]),
            Value::Boolean(in_us)
        );
    }
}

#[test]
fn parent_and_isancestor_of_blank_items_are_blank_and_false() {
    let mut book = Book::new();
    let countries = book.countries;
    book.input(
        "Home",
        Format::List { list: countries },
        vec![Value::Item(Some(book.de))],
    );
    let regions = book.regions;
    assert_eq!(
        book.items(regions, "PARENT(Home)", 2),
        [Some(book.eu), None]
    );
    assert_eq!(
        book.flags("ISANCESTOR(Regions.Europe, Home)", 2),
        [true, false]
    );
    // Two blanks are not the same item.
    assert_eq!(book.flags("ISANCESTOR(Home, Home)", 2), [true, false]);
}

#[test]
fn parent_skips_deleted_items() {
    let mut book = Book::new();
    let countries = book.countries;
    let detail = book.module("Detail", vec![AxisSpec::List { list: countries }]);
    let region = book.line_item(
        detail,
        "Region",
        Format::List { list: book.regions },
        Some("PARENT(ITEM(Countries))"),
    );
    book.model
        .apply(Command::DeleteListItems {
            list: countries,
            ids: vec![book.ca],
        })
        .unwrap();
    book.model.recalc_all().unwrap();
    assert_eq!(
        book.get(region, vec![item(book.us)]),
        Value::Item(Some(book.na))
    );
    assert_eq!(
        book.get(region, vec![item(book.de)]),
        Value::Item(Some(book.eu))
    );
}

/// A list Customers of `count` items named "Customer 0", "Customer 1", ..., in a module
/// Segments with the text input Segment, which holds `segment(i)` for customer `i`.
struct Customers {
    list: ListId,
    ids: Vec<ItemId>,
    module: ModuleId,
}

impl Customers {
    fn new(book: &mut Book, count: usize, segment: impl Fn(usize) -> String) -> Customers {
        let list = ListId::new();
        book.model
            .apply(Command::CreateList {
                id: list,
                name: "Customers".to_string(),
                parent: None,
                top_level_name: None,
                numbered: false,
                production_data: false,
            })
            .unwrap();
        let ids: Vec<ItemId> = (0..count).map(|_| ItemId::new()).collect();
        let items = ids
            .iter()
            .enumerate()
            .map(|(i, &id)| ItemSpec {
                id,
                code: None,
                name: format!("Customer {i}"),
                parent: None,
            })
            .collect();
        book.model
            .apply(Command::UpsertListItems { list, items })
            .unwrap();
        let module = book.module("Segments", vec![AxisSpec::List { list }]);
        let input = book.line_item(module, "Segment", Format::Text, None);
        let cells = ids
            .iter()
            .enumerate()
            .map(|(i, &id)| (vec![item(id)], text(&segment(i))))
            .collect();
        book.set_all(input, cells);
        Customers { list, ids, module }
    }

    fn flags(&self, book: &Book, line_item: LineItemId) -> Vec<bool> {
        self.ids
            .iter()
            .map(|&id| match book.get(line_item, vec![item(id)]) {
                Value::Boolean(flag) => flag,
                other => panic!("expected a boolean, found {other:?}"),
            })
            .collect()
    }
}

/// Whether each customer is the first with its value of the input `name` of `format`, which
/// holds `values` for the customers in order.
fn first_occurrences(
    book: &mut Book,
    customers: &Customers,
    name: &str,
    format: Format,
    values: Vec<Value>,
) -> Vec<bool> {
    let input = book.line_item(customers.module, name, format, None);
    let cells = customers
        .ids
        .iter()
        .zip(values)
        .map(|(&id, value)| (vec![item(id)], value))
        .collect();
    book.set_all(input, cells);
    let first = book.line_item(
        customers.module,
        &format!("First {name}"),
        Format::Boolean,
        Some(&format!("ISFIRSTOCCURRENCE({name}, Customers)")),
    );
    book.model.recalc_all().unwrap();
    customers.flags(book, first)
}

#[test]
fn isfirstoccurrence() {
    let mut book = Book::new();
    let segments = ["gold", "silver", "gold", "bronze", "silver", "gold"];
    let customers = Customers::new(&mut book, 6, |i| segments[i].to_string());
    let first = book.line_item(
        customers.module,
        "First",
        Format::Boolean,
        Some("ISFIRSTOCCURRENCE(Segment, Customers)"),
    );
    book.model.recalc_all().unwrap();
    assert_eq!(
        customers.flags(&book, first),
        [true, true, false, true, false, false]
    );
}

#[test]
fn isfirstoccurrence_works_per_line_of_the_other_axes() {
    let mut book = Book::new();
    let customers = Customers::new(&mut book, 4, |_| String::new());
    let grid = book.module(
        "Grid",
        vec![
            AxisSpec::List {
                list: customers.list,
            },
            book.time(),
        ],
    );
    let tier = book.line_item(grid, "Tier", Format::number(), None);
    // January: tiers 1, 2, 1, 2. February: 5, 5, 6, 5. Each month is a line of its own.
    let tiers = [[1.0, 2.0, 1.0, 2.0], [5.0, 5.0, 6.0, 5.0]];
    let cells = (0..2)
        .flat_map(|m| (0..4).map(move |c| (m, c)))
        .map(|(m, c)| {
            (
                vec![item(customers.ids[c]), month(m)],
                Value::Number(tiers[m][c]),
            )
        })
        .collect();
    book.set_all(tier, cells);
    let first = book.line_item(
        grid,
        "First Tier",
        Format::Boolean,
        Some("ISFIRSTOCCURRENCE(Tier, Customers)"),
    );
    book.model.recalc_all().unwrap();
    let expected = [[true, true, false, false], [true, false, true, false]];
    for (m, expected) in expected.into_iter().enumerate() {
        for (c, expected) in expected.into_iter().enumerate() {
            assert_eq!(
                book.get(first, vec![item(customers.ids[c]), month(m)]),
                Value::Boolean(expected),
                "month {m}, customer {c}"
            );
        }
    }
}

#[test]
fn isfirstoccurrence_looks_back_past_the_start_of_a_chunk() {
    let mut book = Book::new();
    // 5000 customers run over the 4096 cells of a chunk; segment k first occurs at 1000 * k.
    let customers = Customers::new(&mut book, 5000, |i| format!("segment {}", i / 1000));
    let first = book.line_item(
        customers.module,
        "First",
        Format::Boolean,
        Some("ISFIRSTOCCURRENCE(Segment, Customers)"),
    );
    book.model.recalc_all().unwrap();
    let expected: Vec<bool> = (0..5000).map(|i| i % 1000 == 0).collect();
    assert_eq!(customers.flags(&book, first), expected);
}

#[test]
fn isfirstoccurrence_compares_booleans_dates_items_periods_and_numbers() {
    let mut book = Book::new();
    let customers = Customers::new(&mut book, 6, |_| String::new());
    let (us, de, countries) = (book.us, book.de, book.countries);
    let flags = first_occurrences(
        &mut book,
        &customers,
        "Flag Key",
        Format::Boolean,
        [true, false, true, false, false, true]
            .map(Value::Boolean)
            .to_vec(),
    );
    assert_eq!(flags, [true, true, false, false, false, false]);
    let days = first_occurrences(
        &mut book,
        &customers,
        "Date Key",
        Format::Date,
        dates(&[
            date(2026, 1, 1),
            None,
            date(2026, 1, 1),
            date(2026, 2, 1),
            None,
            date(2026, 2, 1),
        ]),
    );
    assert_eq!(days, [true, true, false, true, false, false]);
    let home = first_occurrences(
        &mut book,
        &customers,
        "Country Key",
        Format::List { list: countries },
        [Some(us), None, Some(us), None, Some(de), Some(de)]
            .map(Value::Item)
            .to_vec(),
    );
    assert_eq!(home, [true, true, false, false, true, false]);
    let quarters = first_occurrences(
        &mut book,
        &customers,
        "Quarter Key",
        Format::TimePeriod {
            level: TimeLevel::Quarter,
        },
        [Some(1), None, Some(1), Some(2), None, Some(2)]
            .map(|index| Value::Period(index.map(|index| (TimeLevel::Quarter, index))))
            .to_vec(),
    );
    assert_eq!(quarters, [true, true, false, true, false, false]);
    // Zero is zero whichever sign it has.
    let scores = first_occurrences(
        &mut book,
        &customers,
        "Score Key",
        Format::number(),
        numbers(&[0.0, -0.0, 1.5, -0.0, 0.0, -1.5]),
    );
    assert_eq!(scores, [true, false, true, false, false, true]);
}

#[test]
fn isfirstoccurrence_over_several_lines_and_chunks() {
    let mut book = Book::new();
    let customers = Customers::new(&mut book, 5000, |_| String::new());
    let grid = book.module(
        "Grid",
        vec![
            AxisSpec::List {
                list: customers.list,
            },
            book.time(),
        ],
    );
    let tier = book.line_item(grid, "Tier", Format::number(), None);
    // Each month is a line of its own, and the tier of a customer differs from month to month.
    let tier_of = |customer: usize, m: usize| ((customer * customer + m * 7) % 151) as f64;
    let cells = (0..3)
        .flat_map(|m| (0..5000).map(move |c| (m, c)))
        .map(|(m, c)| {
            (
                vec![item(customers.ids[c]), month(m)],
                Value::Number(tier_of(c, m)),
            )
        })
        .collect();
    book.set_all(tier, cells);
    let first = book.line_item(
        grid,
        "First Tier",
        Format::Boolean,
        Some("ISFIRSTOCCURRENCE(Tier, Customers)"),
    );
    book.model.recalc_all().unwrap();
    for m in 0..3 {
        for c in 0..5000 {
            let expected = !(0..c).any(|earlier| tier_of(earlier, m) == tier_of(c, m));
            assert_eq!(
                book.get(first, vec![item(customers.ids[c]), month(m)]),
                Value::Boolean(expected),
                "customer {c}, month {m}"
            );
        }
    }
}

#[test]
fn isfirstoccurrence_follows_the_order_of_a_subset() {
    let mut book = Book::new();
    let customers = Customers::new(&mut book, 4, |i| ["a", "a", "b", "b"][i].to_string());
    let ids = &customers.ids;
    let subset = SubsetId::new();
    book.model
        .apply(Command::CreateSubset {
            id: subset,
            list: customers.list,
            name: "Reordered".to_string(),
            items: vec![ids[3], ids[1], ids[2], ids[0]],
        })
        .unwrap();
    let view = book.module("Reordered View", vec![AxisSpec::Subset { subset }]);
    let copy = book.line_item(view, "Segment Copy", Format::Text, Some("Segment"));
    let first = book.line_item(
        view,
        "First In Subset",
        Format::Boolean,
        Some("ISFIRSTOCCURRENCE(Segment Copy, Customers)"),
    );
    book.model.recalc_all().unwrap();
    assert_eq!(book.get(copy, vec![item(ids[3])]), text("b"));
    // In the order of the subset (customers 4, 2, 3, 1) the first "b" is customer 4 and the
    // first "a" customer 2.
    for (customer, expected) in [(3, true), (1, true), (2, false), (0, false)] {
        assert_eq!(
            book.get(first, vec![item(ids[customer])]),
            Value::Boolean(expected),
            "customer {customer}"
        );
    }
}

#[test]
fn isfirstoccurrence_skips_deleted_items() {
    let mut book = Book::new();
    let customers = Customers::new(&mut book, 4, |i| ["a", "a", "b", "b"][i].to_string());
    let first = book.line_item(
        customers.module,
        "First",
        Format::Boolean,
        Some("ISFIRSTOCCURRENCE(Segment, Customers)"),
    );
    book.model
        .apply(Command::DeleteListItems {
            list: customers.list,
            ids: vec![customers.ids[0]],
        })
        .unwrap();
    book.model.recalc_all().unwrap();
    // The first live "a" is customer 2.
    for (customer, expected) in [(1, true), (2, true), (3, false)] {
        assert_eq!(
            book.get(first, vec![item(customers.ids[customer])]),
            Value::Boolean(expected),
            "customer {customer}"
        );
    }
}

#[test]
fn isfirstoccurrence_needs_the_list_as_a_dimension_of_the_line_item() {
    let mut book = Book::new();
    Customers::new(&mut book, 2, |_| "x".to_string());
    let grid = book.module(
        "Grid",
        vec![AxisSpec::List {
            list: book.countries,
        }],
    );
    let plain = "ISFIRSTOCCURRENCE(ITEM(Countries), Customers)";
    let guarded = "IF TRUE THEN TRUE ELSE ISFIRSTOCCURRENCE(ITEM(Countries), Customers)";
    // The problem is the same whichever branch the cells take.
    for formula in [plain, guarded] {
        let name = format!("Check {}", formula.len());
        let errors = book.rejected(grid, &name, Format::Boolean, formula);
        assert_eq!(errors.len(), 1, "{errors:?}");
        assert_eq!(errors[0].code, "formula.dimension");
        assert_eq!(
            errors[0].message,
            "This formula's line item has no 'Customers' dimension."
        );
        let start = formula.rfind("Customers").unwrap();
        assert_eq!((errors[0].start, errors[0].end), (start, start + 9));
    }
}

#[test]
fn left_right_and_mid_count_characters_from_one() {
    let mut book = Book::new();
    book.texts_in("T", &["hello", "héllo", "", "ab"]);
    assert_eq!(book.texts("LEFT(T, 2)", 4), ["he", "hé", "", "ab"]);
    assert_eq!(book.texts("LEFT(T, 0)", 4), ["", "", "", ""]);
    assert_eq!(book.texts("LEFT(T, -1)", 4), ["", "", "", ""]);
    assert_eq!(book.texts("LEFT(T, 10)", 4), ["hello", "héllo", "", "ab"]);
    assert_eq!(book.texts("LEFT(T, 2.9)", 4), ["he", "hé", "", "ab"]);
    assert_eq!(book.texts("RIGHT(T, 2)", 4), ["lo", "lo", "", "ab"]);
    assert_eq!(book.texts("RIGHT(T, 0)", 4), ["", "", "", ""]);
    assert_eq!(book.texts("RIGHT(T, 10)", 4), ["hello", "héllo", "", "ab"]);
    assert_eq!(book.texts("MID(T, 2, 3)", 4), ["ell", "éll", "", "b"]);
    assert_eq!(book.texts("MID(T, 1, 2)", 4), ["he", "hé", "", "ab"]);
    assert_eq!(book.texts("MID(T, 5, 10)", 4), ["o", "o", "", ""]);
    assert_eq!(book.texts("MID(T, 6, 2)", 4), ["", "", "", ""]);
    assert_eq!(book.texts("MID(T, 2, 0)", 4), ["", "", "", ""]);
    // Positions before the first character hold no character.
    assert_eq!(book.texts("MID(T, 0, 3)", 4), ["he", "hé", "", "ab"]);
    assert_eq!(book.texts("MID(T, -5, 3)", 4), ["", "", "", ""]);
}

#[test]
fn mid_start_before_one_uses_up_part_of_the_length() {
    let mut book = Book::new();
    assert_eq!(book.texts("MID(\"hello\", 0, 3)", 1), ["he"]);
    assert_eq!(book.texts("MID(\"hello\", -1, 4)", 1), ["he"]);
    assert_eq!(book.texts("MID(\"hello\", 0, 1)", 1), [""]);
    assert_eq!(book.texts("MID(\"hello\", 1, 3)", 1), ["hel"]);
}

#[test]
fn len_counts_characters() {
    let mut book = Book::new();
    book.texts_in("T", &["hello", "héllo", "", "日本語"]);
    assert_eq!(book.numbers("LEN(T)", 4), [5.0, 5.0, 0.0, 3.0]);
}

#[test]
fn find_is_one_based() {
    let mut book = Book::new();
    book.texts_in("Hay", &["a-b-c", "abc", "héllo wörld", ""]);
    assert_eq!(book.numbers("FIND(\"-\", Hay)", 4), [2.0, 0.0, 0.0, 0.0]);
    assert_eq!(book.numbers("FIND(\"a\", Hay)", 4), [1.0, 1.0, 0.0, 0.0]);
    assert_eq!(book.numbers("FIND(\"-\", Hay, 3)", 4), [4.0, 0.0, 0.0, 0.0]);
    assert_eq!(book.numbers("FIND(\"-\", Hay, 5)", 4), [0.0; 4]);
    assert_eq!(book.numbers("FIND(\"l\", Hay)", 4), [0.0, 0.0, 3.0, 0.0]);
    assert_eq!(book.numbers("FIND(\"l\", Hay, 4)", 4), [0.0, 0.0, 4.0, 0.0]);
    assert_eq!(
        book.numbers("FIND(\"l\", Hay, 5)", 4),
        [0.0, 0.0, 10.0, 0.0]
    );
    // A start before the text is the start of the text; past its end nothing is found.
    assert_eq!(book.numbers("FIND(\"a\", Hay, 0)", 4), [1.0, 1.0, 0.0, 0.0]);
    assert_eq!(book.numbers("FIND(\"a\", Hay, 99)", 4), [0.0; 4]);
    // The text looked for is compared exactly, and may be longer than one character.
    assert_eq!(book.numbers("FIND(\"B\", Hay)", 4), [0.0; 4]);
    assert_eq!(book.numbers("FIND(\"b-c\", Hay)", 4), [3.0, 0.0, 0.0, 0.0]);
    book.texts_in("Needle", &["-", "c", "wör", "x"]);
    assert_eq!(book.numbers("FIND(Needle, Hay)", 4), [2.0, 3.0, 7.0, 0.0]);
}

#[test]
fn find_of_an_empty_text_is_the_start() {
    let mut book = Book::new();
    book.texts_in("Hay", &["a-b-c", "abc"]);
    assert_eq!(book.numbers("FIND(\"\", Hay)", 2), [1.0, 1.0]);
    assert_eq!(book.numbers("FIND(\"\", Hay, 3)", 2), [3.0, 3.0]);
}

#[test]
fn case_and_spacing() {
    let mut book = Book::new();
    book.texts_in("T", &["  a b  ", "Héllo", "   ", ""]);
    assert_eq!(book.texts("TRIM(T)", 4), ["a b", "Héllo", "", ""]);
    assert_eq!(book.texts("UPPER(T)", 4), ["  A B  ", "HÉLLO", "   ", ""]);
    assert_eq!(book.texts("LOWER(T)", 4), ["  a b  ", "héllo", "   ", ""]);
}

#[test]
fn trim_removes_whitespace_of_every_kind() {
    let mut book = Book::new();
    book.texts_in("T", &["\t a b \n", "\u{a0}x\u{3000}", "\r\n", "a\tb"]);
    assert_eq!(book.texts("TRIM(T)", 4), ["a b", "x", "", "a\tb"]);
}

#[test]
fn substitute_replaces_every_occurrence() {
    let mut book = Book::new();
    book.texts_in("T", &["a-b-c", "none", "aaa", ""]);
    assert_eq!(
        book.texts("SUBSTITUTE(T, \"-\", \"+\")", 4),
        ["a+b+c", "none", "aaa", ""]
    );
    assert_eq!(
        book.texts("SUBSTITUTE(T, \"aa\", \"b\")", 4),
        ["a-b-c", "none", "ba", ""]
    );
    assert_eq!(
        book.texts("SUBSTITUTE(T, \"-\", \"\")", 4),
        ["abc", "none", "aaa", ""]
    );
    // There is nothing to replace in an empty text, so the text stays.
    assert_eq!(
        book.texts("SUBSTITUTE(T, \"\", \"x\")", 4),
        ["a-b-c", "none", "aaa", ""]
    );
}

#[test]
fn text_of_numbers_dates_and_items() {
    let mut book = Book::new();
    book.numbers_in("N", &[1.5, 100.0, 0.1 + 0.2, -2.0]);
    assert_eq!(
        book.texts("TEXT(N)", 5),
        ["1.5", "100", "0.30000000000000004", "-2", "0"]
    );
    book.dates_in("D", &[date(2026, 4, 1), None, date(2028, 2, 29)]);
    assert_eq!(book.texts("TEXT(D)", 3), ["2026-04-01", "", "2028-02-29"]);
    let countries = book.countries;
    book.input(
        "Home",
        Format::List { list: countries },
        vec![Value::Item(Some(book.de)), Value::Item(None)],
    );
    assert_eq!(book.texts("TEXT(Home)", 3), ["DE", "", ""]);
    assert_eq!(book.texts("TEXT(Countries.US) & TEXT(7)", 1), ["US7"]);
}

#[test]
fn value_parses_numbers_and_gives_zero_otherwise() {
    let mut book = Book::new();
    let inputs = [
        "12", " 3.5 ", "-4e2", "abc", "", "1,000", "inf", "NaN", "+7", ".5", "1e999", "12abc",
    ];
    book.texts_in("T", &inputs);
    assert_eq!(
        book.numbers("VALUE(T)", inputs.len()),
        [
            12.0, 3.5, -400.0, 0.0, 0.0, 0.0, 0.0, 0.0, 7.0, 0.5, 0.0, 0.0
        ]
    );
    assert_eq!(book.numbers("VALUE(TEXT(2.25)) * 2", 1), [4.5]);
}

#[test]
fn value_of_negative_zero_is_positive_zero() {
    let mut book = Book::new();
    book.texts_in("T", &["-0", " -0.0 ", "-0e5"]);
    let values = book.numbers("VALUE(T)", 3);
    assert_eq!(values, [0.0; 3]);
    assert!(values.iter().all(|value| value.is_sign_positive()));
    // The sign of the zero is also what TEXT of it writes, before the cells are sanitized.
    assert_eq!(book.texts("TEXT(VALUE(T))", 3), ["0", "0", "0"]);
}

#[test]
fn date_builds_a_date_or_is_blank() {
    let mut book = Book::new();
    book.numbers_in(
        "Y",
        &[2026.0, 2026.0, 2028.0, 2026.0, 2026.0, 2026.0, 2026.0],
    );
    book.numbers_in("M", &[4.0, 2.0, 2.0, 13.0, 0.0, 4.0, 4.0]);
    book.numbers_in("D", &[1.0, 29.0, 29.0, 1.0, 1.0, 31.0, 0.0]);
    assert_eq!(
        book.dates("DATE(Y, M, D)", 7),
        [
            date(2026, 4, 1),
            None,
            date(2028, 2, 29),
            None,
            None,
            None,
            None
        ]
    );
    assert_eq!(book.dates("DATE(2026, 12, 31)", 1), [date(2026, 12, 31)]);
    assert_eq!(book.dates("DATE(1970, 1, 1)", 1), [date(1970, 1, 1)]);
    assert_eq!(book.dates("DATE(1969, 12, 31)", 1), [date(1969, 12, 31)]);
    assert_eq!(book.dates("DATE(999999999, 1, 1)", 1), [None]);
    // Fractions are dropped.
    assert_eq!(book.dates("DATE(2026.9, 4.9, 1.9)", 1), [date(2026, 4, 1)]);
}

#[test]
fn day_month_year_and_weekday() {
    let mut book = Book::new();
    book.dates_in(
        "Day",
        &[
            date(2026, 4, 1),
            date(2026, 4, 5),
            date(2026, 4, 6),
            None,
            date(1969, 12, 31),
        ],
    );
    assert_eq!(book.numbers("DAY(Day)", 5), [1.0, 5.0, 6.0, 0.0, 31.0]);
    assert_eq!(book.numbers("MONTH(Day)", 5), [4.0, 4.0, 4.0, 0.0, 12.0]);
    assert_eq!(
        book.numbers("YEAR(Day)", 5),
        [2026.0, 2026.0, 2026.0, 0.0, 1969.0]
    );
    // Monday is 1 and Sunday is 7.
    assert_eq!(book.numbers("WEEKDAY(Day)", 5), [3.0, 7.0, 1.0, 0.0, 3.0]);
}

#[test]
fn addmonths_clamps() {
    let mut book = Book::new();
    book.dates_in(
        "Day",
        &[
            date(2026, 1, 31),
            date(2028, 1, 31),
            date(2026, 3, 31),
            date(2026, 12, 15),
            None,
        ],
    );
    assert_eq!(
        book.dates("ADDMONTHS(Day, 1)", 5),
        [
            date(2026, 2, 28),
            date(2028, 2, 29),
            date(2026, 4, 30),
            date(2027, 1, 15),
            None
        ]
    );
    assert_eq!(
        book.dates("ADDMONTHS(Day, -1)", 5),
        [
            date(2025, 12, 31),
            date(2027, 12, 31),
            date(2026, 2, 28),
            date(2026, 11, 15),
            None
        ]
    );
    assert_eq!(
        book.dates("ADDMONTHS(Day, 13)", 2),
        [date(2027, 2, 28), date(2029, 2, 28)]
    );
    assert_eq!(book.dates("ADDMONTHS(Day, 0)", 1), [date(2026, 1, 31)]);
    assert_eq!(book.dates("ADDMONTHS(Day, 1.9)", 1), [date(2026, 2, 28)]);
    assert_eq!(book.dates("ADDMONTHS(Day, 100000000)", 1), [None]);
}

#[test]
fn addyears_clamps_leap_days() {
    let mut book = Book::new();
    book.dates_in(
        "Day",
        &[
            date(2028, 2, 29),
            date(2026, 6, 15),
            date(2028, 2, 29),
            None,
        ],
    );
    assert_eq!(
        book.dates("ADDYEARS(Day, 1)", 4),
        [
            date(2029, 2, 28),
            date(2027, 6, 15),
            date(2029, 2, 28),
            None
        ]
    );
    assert_eq!(
        book.dates("ADDYEARS(Day, 4)", 3),
        [date(2032, 2, 29), date(2030, 6, 15), date(2032, 2, 29)]
    );
    assert_eq!(
        book.dates("ADDYEARS(Day, -1)", 2),
        [date(2027, 2, 28), date(2025, 6, 15)]
    );
    assert_eq!(
        book.dates("ADDYEARS(Day, 1.9)", 2),
        [date(2029, 2, 28), date(2027, 6, 15)]
    );
}

#[test]
fn days_counts_from_the_first_date_to_the_second() {
    let mut book = Book::new();
    book.dates_in(
        "From",
        &[date(2026, 1, 1), date(2026, 3, 1), date(2026, 1, 1), None],
    );
    book.dates_in(
        "To",
        &[
            date(2026, 3, 1),
            date(2026, 1, 1),
            date(2026, 1, 1),
            date(2026, 1, 1),
        ],
    );
    assert_eq!(book.numbers("DAYS(From, To)", 4), [59.0, -59.0, 0.0, 0.0]);
    assert_eq!(book.numbers("DAYS(To, From)", 4), [-59.0, 59.0, 0.0, 0.0]);
    assert_eq!(
        book.numbers(
            "DAYS(DATE(2026, 12, 31), ADDYEARS(DATE(2026, 12, 31), 1))",
            1
        ),
        [365.0]
    );
}

#[test]
fn name_and_code_of_items() {
    let mut book = Book::new();
    let by_country = book.module(
        "By Country",
        vec![AxisSpec::List {
            list: book.countries,
        }],
    );
    let name = book.line_item(
        by_country,
        "Name",
        Format::Text,
        Some("NAME(ITEM(Countries))"),
    );
    let code = book.line_item(
        by_country,
        "Code",
        Format::Text,
        Some("CODE(ITEM(Countries))"),
    );
    let region = book.line_item(
        by_country,
        "Region",
        Format::Text,
        Some("NAME(PARENT(ITEM(Countries))) & \" \" & CODE(PARENT(ITEM(Countries)))"),
    );
    let constant = book.line_item(
        by_country,
        "Constant",
        Format::Text,
        Some("NAME(Countries.DE)"),
    );
    book.model.recalc_all().unwrap();
    assert_eq!(book.get(name, vec![item(book.us)]), text("US"));
    assert_eq!(book.get(code, vec![item(book.us)]), text("C-US"));
    assert_eq!(book.get(code, vec![item(book.de)]), text("C-DE"));
    assert_eq!(
        book.get(region, vec![item(book.ca)]),
        text("North America NA")
    );
    assert_eq!(book.get(constant, vec![item(book.us)]), text("DE"));
}

#[test]
fn name_and_code_of_versions() {
    let mut book = Book::new();
    let versions = book.module("By Version", vec![AxisSpec::Versions]);
    let name = book.line_item(
        versions,
        "Version Name",
        Format::Text,
        Some("NAME(ITEM(Versions))"),
    );
    let code = book.line_item(
        versions,
        "Version Code",
        Format::Text,
        Some("CODE(ITEM(Versions))"),
    );
    let shown = book.line_item(
        versions,
        "Version Text",
        Format::Text,
        Some("TEXT(ITEM(Versions)) & \"|\" & NAME(Versions.Budget)"),
    );
    let is_budget = book.line_item(
        versions,
        "Is Budget",
        Format::Boolean,
        Some("ISANCESTOR(Versions.Budget, ITEM(Versions))"),
    );
    book.model.recalc_all().unwrap();
    for version in ["Actual", "Budget", "Forecast"] {
        let id = book.model.structure().version_by_name(version).unwrap().id;
        let coord = vec![item(ItemId(id.0))];
        assert_eq!(book.get(name, coord.clone()), text(version));
        assert_eq!(book.get(code, coord.clone()), text(""));
        assert_eq!(
            book.get(shown, coord.clone()),
            text(&format!("{version}|Budget"))
        );
        // A version is only its own ancestor.
        assert_eq!(
            book.get(is_budget, coord),
            Value::Boolean(version == "Budget")
        );
    }
}

#[test]
fn blank_items_and_items_without_a_code_have_empty_names_and_codes() {
    let mut book = Book::new();
    book.input(
        "Home",
        Format::List {
            list: book.countries,
        },
        vec![Value::Item(Some(book.ca))],
    );
    book.input(
        "Place",
        Format::List { list: book.cities },
        vec![Value::Item(Some(book.boston))],
    );
    assert_eq!(book.texts("NAME(Home)", 2), ["CA", ""]);
    assert_eq!(book.texts("CODE(Home)", 2), ["C-CA", ""]);
    assert_eq!(book.texts("NAME(Place)", 2), ["Boston", ""]);
    assert_eq!(book.texts("CODE(Place)", 2), ["", ""]);
}

#[test]
fn finditem_matches_names_then_codes() {
    let mut book = Book::new();
    let customers = Customers::new(&mut book, 3, |_| String::new());
    let ids = &customers.ids;
    // Item 0 has the code "Customer 1", which is also the name of item 1.
    book.model
        .apply(Command::UpsertListItems {
            list: customers.list,
            items: vec![
                ItemSpec {
                    id: ids[0],
                    code: Some("Customer 1".to_string()),
                    name: "Customer 0".to_string(),
                    parent: None,
                },
                ItemSpec {
                    id: ids[2],
                    code: Some("K2".to_string()),
                    name: "Customer 2".to_string(),
                    parent: None,
                },
            ],
        })
        .unwrap();
    book.texts_in(
        "Key",
        &[
            "Customer 1",
            "customer 2",
            "K2",
            "k2",
            "  Customer 0 ",
            "Nobody",
            "",
        ],
    );
    // The name decides before the code, names ignore case and surrounding spaces, and codes
    // must match exactly.
    assert_eq!(
        book.items(customers.list, "FINDITEM(Customers, Key)", 7),
        [
            Some(ids[1]),
            Some(ids[2]),
            Some(ids[2]),
            None,
            Some(ids[0]),
            None,
            None
        ]
    );
    assert_eq!(
        book.items(customers.list, "FINDITEM(Customers, \"Customer 2\")", 1),
        [Some(ids[2])]
    );
}

#[test]
fn finditem_does_not_need_the_list_as_a_dimension() {
    let mut book = Book::new();
    assert_eq!(
        book.items(book.regions, "FINDITEM(Regions, \"Europe\")", 1),
        [Some(book.eu)]
    );
    assert_eq!(
        book.items(book.countries, "FINDITEM(Countries, \"C-DE\")", 1),
        [Some(book.de)]
    );
}

#[test]
fn finditem_finds_every_item_by_its_name_over_more_than_one_chunk() {
    let mut book = Book::new();
    let customers = Customers::new(&mut book, 5000, |_| String::new());
    let round_trip = book.line_item(
        customers.module,
        "Round Trip",
        Format::List {
            list: customers.list,
        },
        Some("FINDITEM(Customers, NAME(ITEM(Customers)))"),
    );
    book.model.recalc_all().unwrap();
    for (i, &id) in customers.ids.iter().enumerate() {
        assert_eq!(
            book.get(round_trip, vec![item(id)]),
            Value::Item(Some(id)),
            "customer {i}"
        );
    }
}

#[test]
fn finditem_agrees_with_list_find_over_more_than_one_chunk() {
    let mut book = Book::new();
    let customers = Customers::new(&mut book, 5000, |_| String::new());
    // Even customers have the code "Customer" followed by the number of the next customer; odd
    // customers have codes of their own, which keeps the codes exact and unique.
    let items = (0..5000)
        .map(|i| ItemSpec {
            id: customers.ids[i],
            code: Some(if i % 2 == 0 {
                format!("Customer {}", (i + 1) % 5000)
            } else {
                format!("K{i}")
            }),
            name: format!("Customer {i}"),
            parent: None,
        })
        .collect();
    book.model
        .apply(Command::UpsertListItems {
            list: customers.list,
            items,
        })
        .unwrap();
    // Each sampled customer contributes a name, a code, a name in other case and spacing, the
    // name of the next customer, and two keys that are none of them. The cells cycle through
    // these keys, so that every chunk sees all kinds.
    let keys: Vec<String> = [0, 1, 2, 3, 4, 5, 6, 7, 2500, 2501, 4998, 4999]
        .iter()
        .flat_map(|&i| {
            [
                format!("Customer {i}"),
                format!("K{i}"),
                format!("  customer {i}  "),
                format!("Customer {}", i + 1),
                format!("Customer {}", i + 5000),
                format!("k{i}"),
                String::new(),
            ]
        })
        .collect();
    let lookups = book.line_item(customers.module, "Lookup Key", Format::Text, None);
    let cells = customers
        .ids
        .iter()
        .enumerate()
        .map(|(i, &id)| (vec![item(id)], text(&keys[i % keys.len()])))
        .collect();
    book.set_all(lookups, cells);
    let found = book.line_item(
        customers.module,
        "Found",
        Format::List {
            list: customers.list,
        },
        Some("FINDITEM(Customers, Lookup Key)"),
    );
    book.model.recalc_all().unwrap();
    let coords: Vec<Vec<CoordToken>> = customers.ids.iter().map(|&id| vec![item(id)]).collect();
    let actual = book.model.read_cells(found, &coords).unwrap();
    let list = book.model.structure().list(customers.list).unwrap();
    let found_by_key: Vec<Value> = keys
        .iter()
        .map(|key| Value::Item(list.find(key).map(|idx| list.item(idx).id)))
        .collect();
    let expected: Vec<Value> = (0..5000)
        .map(|i| found_by_key[i % keys.len()].clone())
        .collect();
    assert_eq!(actual, expected);
    assert!(expected.contains(&Value::Item(None)));
    assert!(expected.contains(&Value::Item(Some(customers.ids[1]))));
}

#[test]
fn text_functions_work_over_more_than_one_chunk() {
    let mut book = Book::new();
    let customers = Customers::new(&mut book, 5000, |i| format!("  Seg{}  ", i % 10));
    let label = book.line_item(
        customers.module,
        "Label",
        Format::Text,
        Some("UPPER(TRIM(Segment)) & \"-\" & TEXT(LEN(Segment) * 2)"),
    );
    let digit = book.line_item(
        customers.module,
        "Digit",
        Format::number(),
        Some("VALUE(MID(TRIM(Segment), 4, 1)) + MOD(LEN(Segment), 7)"),
    );
    book.model.recalc_all().unwrap();
    for i in [0, 1, 4095, 4096, 4999] {
        let id = customers.ids[i];
        assert_eq!(
            book.get(label, vec![item(id)]),
            text(&format!("SEG{}-16", i % 10))
        );
        assert_eq!(
            book.get(digit, vec![item(id)]),
            Value::Number((i % 10) as f64 + 1.0)
        );
    }
}
