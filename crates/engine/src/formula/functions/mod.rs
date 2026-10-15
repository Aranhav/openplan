//! The built-in functions of the formula language (spec §4.5): names, arities, argument and
//! result types, and the one-line documentation the editor shows, and the evaluation of calls.

use crate::calendar::TimeLevel;
use crate::error::EngineError;
use crate::shape::Shape;
use crate::structure::same_name;
use crate::value::Column;

use super::align::take;
use super::eval::{eval, eval_whole};
use super::{EvalCtx, TExpr};

mod axis;
mod date;
mod dimension;
mod finance;
mod list;
mod logic;
mod math;
mod period;
mod rank;
mod rules;
mod text;
mod time;
mod version;

pub use rules::Word;
pub(crate) use rules::{ArgType, check};
pub(super) use rules::{Param, arity_message, keyword_choice, params};
use rules::{Ret, Signature, max_arity, min_arity};

/// One entry of the function table, as shown to users in the editor.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct FunctionDef {
    pub name: &'static str,
    /// The fewest arguments a call takes.
    pub min_args: usize,
    /// The most arguments a call takes; `usize::MAX` when there is no limit.
    pub max_args: usize,
    /// One sentence saying what the function does.
    pub doc: &'static str,
    /// A formula that uses the function.
    pub example: &'static str,
    pub category: &'static str,
}

/// Defines `FuncId`, the table of definitions and the table of signatures from one list, so
/// that the three always agree.
macro_rules! functions {
    (@rest) => { None };
    (@rest $rest:ident) => { Some(Param::$rest) };
    ($(
        $variant:ident {
            name: $name:literal,
            category: $category:literal,
            signature: $([$($param:ident),*])|+ $(+ $rest:ident)? => $ret:expr,
            doc: $doc:literal,
            example: $example:literal,
        }
    )*) => {
        /// A built-in function.
        #[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
        pub enum FuncId {
            $($variant),*
        }

        impl FuncId {
            const ALL: &'static [FuncId] = &[$(FuncId::$variant),*];
        }

        const SIGNATURES: &[Signature] = &[$(
            Signature {
                forms: &[$(&[$(Param::$param),*]),+],
                rest: functions!(@rest $($rest)?),
                ret: $ret,
            }
        ),*];

        static DEFS: &[FunctionDef] = &[$(
            FunctionDef {
                name: $name,
                min_args: min_arity(&SIGNATURES[FuncId::$variant as usize]),
                max_args: max_arity(&SIGNATURES[FuncId::$variant as usize]),
                doc: $doc,
                example: $example,
                category: $category,
            }
        ),*];
    };
}

functions! {
    // Math
    Abs {
        name: "ABS",
        category: "Math",
        signature: [Number] => Ret::Number,
        doc: "Returns the absolute value of a number.",
        example: "ABS(Variance)",
    }
    Round {
        name: "ROUND",
        category: "Math",
        signature: [Number, Number] | [Number, Number, RoundMode] => Ret::Number,
        doc: "Rounds the number to the given places, on its 15 significant digits when they read back less than two units in its last place away, and otherwise on its shortest decimal form.",
        example: "ROUND(Price * Volume, 2, UP)",
    }
    Min {
        name: "MIN",
        category: "Math",
        signature: [Number, Number] + Number => Ret::Number,
        doc: "Returns the smallest of two or more numbers.",
        example: "MIN(Revenue, Target)",
    }
    Max {
        name: "MAX",
        category: "Math",
        signature: [Number, Number] + Number => Ret::Number,
        doc: "Returns the largest of two or more numbers.",
        example: "MAX(Revenue, 0)",
    }
    Power {
        name: "POWER",
        category: "Math",
        signature: [Number, Number] => Ret::Number,
        doc: "Raises a number to a power.",
        example: "POWER(Growth, 2)",
    }
    Sqrt {
        name: "SQRT",
        category: "Math",
        signature: [Number] => Ret::Number,
        doc: "Returns the square root of a number, or 0 if the number is negative.",
        example: "SQRT(Variance)",
    }
    Exp {
        name: "EXP",
        category: "Math",
        signature: [Number] => Ret::Number,
        doc: "Returns e raised to the power of a number.",
        example: "EXP(Rate)",
    }
    Ln {
        name: "LN",
        category: "Math",
        signature: [Number] => Ret::Number,
        doc: "Returns the natural logarithm of a number, or 0 if the number is not positive.",
        example: "LN(Revenue)",
    }
    Log {
        name: "LOG",
        category: "Math",
        signature: [Number] | [Number, Number] => Ret::Number,
        doc: "Returns the logarithm of a number to a base that is 10 unless given, or 0 if the number is not positive.",
        example: "LOG(Revenue, 2)",
    }
    Mod {
        name: "MOD",
        category: "Math",
        signature: [Number, Number] => Ret::Number,
        doc: "Returns the remainder of dividing one number by another, or 0 when the divisor is 0.",
        example: "MOD(Month Number, 3)",
    }
    Divide {
        name: "DIVIDE",
        category: "Math",
        signature: [Number, Number] => Ret::Number,
        doc: "Divides one number by another and returns 0 when the divisor is 0.",
        example: "DIVIDE(Profit, Revenue)",
    }
    Sign {
        name: "SIGN",
        category: "Math",
        signature: [Number] => Ret::Number,
        doc: "Returns 1 for a positive number, -1 for a negative number and 0 for zero.",
        example: "SIGN(Variance)",
    }

    // Logic
    IsBlank {
        name: "ISBLANK",
        category: "Logic",
        signature: [Any] => Ret::Boolean,
        doc: "Returns TRUE if a value is blank, such as empty text or a date, list item or time period that is not set.",
        example: "ISBLANK(Start Date)",
    }
    IsNotBlank {
        name: "ISNOTBLANK",
        category: "Logic",
        signature: [Any] => Ret::Boolean,
        doc: "Returns TRUE if a value is not blank.",
        example: "ISNOTBLANK(Owner)",
    }
    IsAncestor {
        name: "ISANCESTOR",
        category: "Logic",
        signature: [Item, Item] => Ret::Boolean,
        doc: "Returns TRUE if the first item is an ancestor of the second in the list hierarchy, or is the second item itself.",
        example: "ISANCESTOR(Regions.EMEA, ITEM(Countries))",
    }
    IsFirstOccurrence {
        name: "ISFIRSTOCCURRENCE",
        category: "Logic",
        signature: [Any, List] => Ret::Boolean,
        doc: "Returns TRUE for the first item of a list where a value occurs.",
        example: "ISFIRSTOCCURRENCE(Segment, Customers)",
    }

    // Text
    Left {
        name: "LEFT",
        category: "Text",
        signature: [Text, Number] => Ret::Text,
        doc: "Returns the first characters of a text.",
        example: "LEFT(Product Code, 3)",
    }
    Right {
        name: "RIGHT",
        category: "Text",
        signature: [Text, Number] => Ret::Text,
        doc: "Returns the last characters of a text.",
        example: "RIGHT(Product Code, 2)",
    }
    Mid {
        name: "MID",
        category: "Text",
        signature: [Text, Number, Number] => Ret::Text,
        doc: "Returns a number of characters from a text, starting at a position counted from 1; a start before 1 uses up part of the length.",
        example: "MID(Product Code, 2, 3)",
    }
    Len {
        name: "LEN",
        category: "Text",
        signature: [Text] => Ret::Number,
        doc: "Returns the number of characters in a text.",
        example: "LEN(Description)",
    }
    Find {
        name: "FIND",
        category: "Text",
        signature: [Text, Text] | [Text, Text, Number] => Ret::Number,
        doc: "Returns the position, counted from 1, at which a text first occurs inside another, or 0 if it does not; an empty search text returns 1 unless a start is given.",
        example: "FIND(\"-\", Product Code)",
    }
    Upper {
        name: "UPPER",
        category: "Text",
        signature: [Text] => Ret::Text,
        doc: "Converts a text to upper case.",
        example: "UPPER(Product Code)",
    }
    Lower {
        name: "LOWER",
        category: "Text",
        signature: [Text] => Ret::Text,
        doc: "Converts a text to lower case.",
        example: "LOWER(Product Code)",
    }
    Trim {
        name: "TRIM",
        category: "Text",
        signature: [Text] => Ret::Text,
        doc: "Removes whitespace of any kind, such as spaces, tabs and line breaks, from both ends of a text.",
        example: "TRIM(Description)",
    }
    Substitute {
        name: "SUBSTITUTE",
        category: "Text",
        signature: [Text, Text, Text] => Ret::Text,
        doc: "Replaces every occurrence of one text inside another with a new text.",
        example: "SUBSTITUTE(Product Code, \"-\", \"\")",
    }
    Text {
        name: "TEXT",
        category: "Text",
        signature: [Printable] => Ret::Text,
        doc: "Converts a number, date or list item to text.",
        example: "TEXT(Revenue)",
    }
    Value {
        name: "VALUE",
        category: "Text",
        signature: [Text] => Ret::Number,
        doc: "Converts a text to a number, or 0 if the text is not a number.",
        example: "VALUE(Quantity Text)",
    }

    // List
    Item {
        name: "ITEM",
        category: "List",
        signature: [Dimension] => Ret::ItemOf(0),
        doc: "Returns the item of a list, the version or the time period at the cell being calculated.",
        example: "ITEM(Products)",
    }
    Parent {
        name: "PARENT",
        category: "List",
        signature: [Item] => Ret::ParentOf(0),
        doc: "Returns the parent of a list item, which is an item of the list above in the hierarchy.",
        example: "PARENT(ITEM(Countries))",
    }
    Name {
        name: "NAME",
        category: "List",
        signature: [Item] => Ret::Text,
        doc: "Returns the name of a list item or version.",
        example: "NAME(ITEM(Products))",
    }
    Code {
        name: "CODE",
        category: "List",
        signature: [Item] => Ret::Text,
        doc: "Returns the code of a list item, which is blank for a version.",
        example: "CODE(ITEM(Products))",
    }
    FindItem {
        name: "FINDITEM",
        category: "List",
        signature: [List, Text] => Ret::ItemOf(0),
        doc: "Returns the item of a list with the given name or code, or blank if there is none.",
        example: "FINDITEM(Products, Product Name)",
    }

    // Time
    Previous {
        name: "PREVIOUS",
        category: "Time",
        signature: [Any] => Ret::SameAs(0),
        doc: "Returns the value from the previous period.",
        example: "PREVIOUS(Closing Balance)",
    }
    Next {
        name: "NEXT",
        category: "Time",
        signature: [Any] => Ret::SameAs(0),
        doc: "Returns the value from the next period.",
        example: "NEXT(Opening Balance)",
    }
    Offset {
        name: "OFFSET",
        category: "Time",
        signature: [Any, Number, SameAsFirst] => Ret::SameAs(0),
        doc: "Returns the value from a number of periods ahead, or behind when negative, and the default beyond the timeline.",
        example: "OFFSET(Revenue, -3, 0)",
    }
    Lag {
        name: "LAG",
        category: "Time",
        signature: [Any, Number, SameAsFirst] => Ret::SameAs(0),
        doc: "Returns the value from a number of periods back, and the default before the start of the timeline.",
        example: "LAG(Revenue, 12, 0)",
    }
    Lead {
        name: "LEAD",
        category: "Time",
        signature: [Any, Number, SameAsFirst] => Ret::SameAs(0),
        doc: "Returns the value from a number of periods ahead, and the default after the end of the timeline.",
        example: "LEAD(Revenue, 1, 0)",
    }
    Cumulate {
        name: "CUMULATE",
        category: "Time",
        signature: [Number] => Ret::Number,
        doc: "Returns the running total from the first period up to the current one.",
        example: "CUMULATE(Revenue)",
    }
    MovingSum {
        name: "MOVINGSUM",
        category: "Time",
        signature: [Number, Number, Number] => Ret::Number,
        doc: "Adds up the values from one offset to another, counted in periods from the current period.",
        example: "MOVINGSUM(Revenue, -2, 0)",
    }
    YearValue {
        name: "YEARVALUE",
        category: "Time",
        signature: [Any] => Ret::SameAs(0),
        doc: "Returns the summary value of the fiscal year that contains the current period.",
        example: "YEARVALUE(Revenue)",
    }
    QuarterValue {
        name: "QUARTERVALUE",
        category: "Time",
        signature: [Any] => Ret::SameAs(0),
        doc: "Returns the summary value of the quarter that contains the current period.",
        example: "QUARTERVALUE(Revenue)",
    }
    HalfYearValue {
        name: "HALFYEARVALUE",
        category: "Time",
        signature: [Any] => Ret::SameAs(0),
        doc: "Returns the summary value of the half-year that contains the current period.",
        example: "HALFYEARVALUE(Revenue)",
    }
    MonthValue {
        name: "MONTHVALUE",
        category: "Time",
        signature: [Any] => Ret::SameAs(0),
        doc: "Returns the summary value of the month that contains the current period.",
        example: "MONTHVALUE(Revenue)",
    }
    TimeSum {
        name: "TIMESUM",
        category: "Time",
        signature: [Number] | [Number, Period, Period] => Ret::Number,
        doc: "Adds up a line item over all periods, or over the periods from one period to another.",
        example: "TIMESUM(Revenue, Time.'Jan 26', Time.'Jun 26')",
    }
    YearToDate {
        name: "YEARTODATE",
        category: "Time",
        signature: [Number] => Ret::Number,
        doc: "Adds up the values from the start of the fiscal year to the current period.",
        example: "YEARTODATE(Revenue)",
    }
    QuarterToDate {
        name: "QUARTERTODATE",
        category: "Time",
        signature: [Number] => Ret::Number,
        doc: "Adds up the values from the start of the quarter to the current period.",
        example: "QUARTERTODATE(Revenue)",
    }
    HalfYearToDate {
        name: "HALFYEARTODATE",
        category: "Time",
        signature: [Number] => Ret::Number,
        doc: "Adds up the values from the start of the half-year to the current period.",
        example: "HALFYEARTODATE(Revenue)",
    }
    Start {
        name: "START",
        category: "Time",
        signature: [] => Ret::Date,
        doc: "Returns the first date of the period being calculated.",
        example: "START()",
    }
    End {
        name: "END",
        category: "Time",
        signature: [] => Ret::Date,
        doc: "Returns the last date of the period being calculated.",
        example: "DAYS(START(), END()) + 1",
    }
    InPeriod {
        name: "INPERIOD",
        category: "Time",
        signature: [Date, Period] => Ret::Boolean,
        doc: "Returns TRUE if a date falls inside a time period.",
        example: "INPERIOD(Invoice Date, Time.'Jan 26')",
    }
    Period {
        name: "PERIOD",
        category: "Time",
        signature: [Date] => Ret::Month,
        doc: "Returns the month in which a date falls.",
        example: "PERIOD(Invoice Date)",
    }
    CurrentPeriodStart {
        name: "CURRENTPERIODSTART",
        category: "Time",
        signature: [] => Ret::Date,
        doc: "Returns the first date of the current period of the model.",
        example: "CURRENTPERIODSTART()",
    }
    CurrentPeriodEnd {
        name: "CURRENTPERIODEND",
        category: "Time",
        signature: [] => Ret::Date,
        doc: "Returns the last date of the current period of the model.",
        example: "CURRENTPERIODEND()",
    }

    // Date
    Date {
        name: "DATE",
        category: "Date",
        signature: [Number, Number, Number] => Ret::Date,
        doc: "Builds a date from a year, a month and a day, or a blank date if they do not make one.",
        example: "DATE(2026, 4, 1)",
    }
    Day {
        name: "DAY",
        category: "Date",
        signature: [Date] => Ret::Number,
        doc: "Returns the day of the month of a date.",
        example: "DAY(Invoice Date)",
    }
    Month {
        name: "MONTH",
        category: "Date",
        signature: [Date] => Ret::Number,
        doc: "Returns the month of a date as a number from 1 to 12.",
        example: "MONTH(Invoice Date)",
    }
    Year {
        name: "YEAR",
        category: "Date",
        signature: [Date] => Ret::Number,
        doc: "Returns the calendar year of a date.",
        example: "YEAR(Invoice Date)",
    }
    Weekday {
        name: "WEEKDAY",
        category: "Date",
        signature: [Date] => Ret::Number,
        doc: "Returns the day of the week of a date, from 1 for Monday to 7 for Sunday.",
        example: "WEEKDAY(Invoice Date)",
    }
    AddMonths {
        name: "ADDMONTHS",
        category: "Date",
        signature: [Date, Number] => Ret::Date,
        doc: "Adds a number of months to a date, keeping the day or moving it back to the end of a shorter month.",
        example: "ADDMONTHS(Invoice Date, 3)",
    }
    AddYears {
        name: "ADDYEARS",
        category: "Date",
        signature: [Date, Number] => Ret::Date,
        doc: "Adds a number of years to a date, keeping the day or moving it back to the end of a shorter month.",
        example: "ADDYEARS(Invoice Date, 1)",
    }
    Days {
        name: "DAYS",
        category: "Date",
        signature: [Date, Date] => Ret::Number,
        doc: "Returns the number of days from one date to another.",
        example: "DAYS(Start Date, End Date)",
    }

    // Version
    CurrentVersion {
        name: "CURRENTVERSION",
        category: "Version",
        signature: [Any] => Ret::SameAs(0),
        doc: "Returns the value from the version flagged as current.",
        example: "CURRENTVERSION(Revenue)",
    }
    PreviousVersion {
        name: "PREVIOUSVERSION",
        category: "Version",
        signature: [Any] => Ret::SameAs(0),
        doc: "Returns the value from the version before the one being calculated in the version order.",
        example: "PREVIOUSVERSION(Revenue)",
    }
    NextVersion {
        name: "NEXTVERSION",
        category: "Version",
        signature: [Any] => Ret::SameAs(0),
        doc: "Returns the value from the version after the one being calculated in the version order.",
        example: "NEXTVERSION(Revenue)",
    }

    // Rank
    Rank {
        name: "RANK",
        category: "Rank",
        signature: [Number] | [Number, RankOrder] => Ret::Number,
        doc: "Ranks a value among the items of the list dimensions, with 1 for the highest value unless ASCENDING is given.",
        example: "RANK(Revenue, DESCENDING)",
    }

    // Finance
    Npv {
        name: "NPV",
        category: "Finance",
        signature: [Number, Number] => Ret::Number,
        doc: "Returns the net present value of a series of values over time at a discount rate.",
        example: "NPV(0.1, Cash Flow)",
    }
    Irr {
        name: "IRR",
        category: "Finance",
        signature: [Number] => Ret::Number,
        doc: "Returns the internal rate of return of a series of values over time.",
        example: "IRR(Cash Flow)",
    }
    Pmt {
        name: "PMT",
        category: "Finance",
        signature: [Number, Number, Number] => Ret::Number,
        doc: "Returns the payment per period of a loan with a constant rate and number of periods.",
        example: "PMT(Rate / 12, Term, Loan Amount)",
    }
    Pv {
        name: "PV",
        category: "Finance",
        signature: [Number, Number, Number] => Ret::Number,
        doc: "Returns the present value of a series of equal payments.",
        example: "PV(Rate / 12, Term, Payment)",
    }
    Fv {
        name: "FV",
        category: "Finance",
        signature: [Number, Number, Number, Number] => Ret::Number,
        doc: "Returns the future value of an investment of equal payments at a constant rate.",
        example: "FV(Rate / 12, Term, Payment, Opening Value)",
    }
}

impl FuncId {
    /// The table entry of this function.
    pub fn def(self) -> &'static FunctionDef {
        &DEFS[self as usize]
    }

    fn signature(self) -> &'static Signature {
        &SIGNATURES[self as usize]
    }
}

/// Every built-in function, grouped by category in the order of the spec.
pub fn all() -> &'static [FunctionDef] {
    DEFS
}

/// The function called `name`, ignoring case and surrounding spaces.
pub fn lookup(name: &str) -> Option<FuncId> {
    let name = name.trim();
    DEFS.iter()
        .position(|def| same_name(def.name, name))
        .map(|position| FuncId::ALL[position])
}

/// Checks a call of `func` against the line item it is evaluated for, before any cell is.
///
/// Whatever depends on the structure only, such as which dimensions the line item has, is
/// checked here and not while evaluating, so that a formula is valid or not whatever the
/// data, whichever branch of an `IF` its cells take.
pub(crate) fn check_fn(
    func: FuncId,
    ctx: &EvalCtx,
    target: &Shape,
    args: &[TExpr],
) -> Result<(), EngineError> {
    match func {
        FuncId::Item => dimension::check_item(ctx, target, args),
        FuncId::IsFirstOccurrence => logic::check_is_first_occurrence(ctx, target, args),
        FuncId::Previous
        | FuncId::Next
        | FuncId::Offset
        | FuncId::Lag
        | FuncId::Lead
        | FuncId::Cumulate
        | FuncId::MovingSum
        | FuncId::YearValue
        | FuncId::QuarterValue
        | FuncId::HalfYearValue
        | FuncId::MonthValue
        | FuncId::TimeSum
        | FuncId::YearToDate
        | FuncId::QuarterToDate
        | FuncId::HalfYearToDate
        | FuncId::Start
        | FuncId::End
        | FuncId::Npv
        | FuncId::Irr => time::check(func, target),
        FuncId::CurrentVersion | FuncId::PreviousVersion | FuncId::NextVersion => {
            version::check(target)
        }
        FuncId::Rank => rank::check(target),
        _ => Ok(()),
    }
}

/// The shape over which the arguments of a call to `func` are evaluated, when it is not the
/// target's own: `YEARVALUE(x)` and its kin evaluate `x` as the line item would be by year,
/// quarter or month.
pub(crate) fn arg_target(func: FuncId, ctx: &EvalCtx, target: &Shape) -> Option<Shape> {
    time::arg_target(func, ctx, target)
}

/// Whether a call of `func` shares a column over the whole target between its chunks (see
/// [`EvalCtx::memoized`]): the calls whose result at a cell depends on cells in other chunks,
/// which evaluate through [`shared`] or keep a column of their own. Keep this in step with those
/// calls. A call missing here still gives the right values, but each chunk works it out.
pub(crate) fn shares(func: FuncId) -> bool {
    matches!(
        func,
        FuncId::IsFirstOccurrence
            | FuncId::FindItem
            | FuncId::Cumulate
            | FuncId::MovingSum
            | FuncId::YearValue
            | FuncId::QuarterValue
            | FuncId::HalfYearValue
            | FuncId::MonthValue
            | FuncId::TimeSum
            | FuncId::YearToDate
            | FuncId::QuarterToDate
            | FuncId::HalfYearToDate
            | FuncId::Rank
            | FuncId::Npv
            | FuncId::Irr
    )
}

/// Works out ahead of the chunks what a call that [`shares`] shares between them, so that the
/// chunks, which run in parallel, each take their cells from it.
pub(crate) fn warm_fn(
    func: FuncId,
    ctx: &EvalCtx,
    target: &Shape,
    args: &[TExpr],
) -> Result<(), EngineError> {
    if !shares(func) {
        return Ok(());
    }
    eval_fn(func, ctx, target, args, &[]).map(|_| ())
}

/// Evaluates a call of `func` with the argument expressions `args` for the target cells at the
/// linear indices `idx` of `target`.
///
/// Most functions work on their arguments cell by cell: the arguments are evaluated first and the
/// function maps over the columns. Those that need more than the values, such as the list an
/// item belongs to or the cells around the one being calculated, get the expressions. Those
/// that need cells of other chunks, such as a running total or a rank, work out their result for
/// the whole target once and the chunks take their cells from it.
pub(crate) fn eval_fn(
    func: FuncId,
    ctx: &EvalCtx,
    target: &Shape,
    args: &[TExpr],
    idx: &[usize],
) -> Result<Column, EngineError> {
    let cellwise =
        |f: fn(&[Column]) -> Result<Column, EngineError>| f(&eval_args(ctx, target, args, idx)?);
    match func {
        FuncId::Abs => cellwise(math::eval_abs),
        FuncId::Round => math::eval_round(ctx, target, args, idx),
        FuncId::Min => cellwise(math::eval_min),
        FuncId::Max => cellwise(math::eval_max),
        FuncId::Power => cellwise(math::eval_power),
        FuncId::Sqrt => cellwise(math::eval_sqrt),
        FuncId::Exp => cellwise(math::eval_exp),
        FuncId::Ln => cellwise(math::eval_ln),
        FuncId::Log => cellwise(math::eval_log),
        FuncId::Mod => cellwise(math::eval_mod),
        FuncId::Divide => cellwise(math::eval_divide),
        FuncId::Sign => cellwise(math::eval_sign),

        FuncId::IsBlank => cellwise(logic::eval_is_blank),
        FuncId::IsNotBlank => cellwise(logic::eval_is_not_blank),
        FuncId::IsAncestor => logic::eval_is_ancestor(ctx, target, args, idx),
        FuncId::IsFirstOccurrence => logic::eval_is_first_occurrence(ctx, target, args, idx),

        FuncId::Left => cellwise(text::eval_left),
        FuncId::Right => cellwise(text::eval_right),
        FuncId::Mid => cellwise(text::eval_mid),
        FuncId::Len => cellwise(text::eval_len),
        FuncId::Find => cellwise(text::eval_find),
        FuncId::Upper => cellwise(text::eval_upper),
        FuncId::Lower => cellwise(text::eval_lower),
        FuncId::Trim => cellwise(text::eval_trim),
        FuncId::Substitute => cellwise(text::eval_substitute),
        FuncId::Text => text::eval_text(ctx, target, args, idx),
        FuncId::Value => cellwise(text::eval_value),

        FuncId::Item => dimension::eval_item(ctx, target, args, idx),
        FuncId::Parent => list::eval_parent(ctx, target, args, idx),
        FuncId::Name => list::eval_name(ctx, target, args, idx),
        FuncId::Code => list::eval_code(ctx, target, args, idx),
        FuncId::FindItem => list::eval_find_item(ctx, target, args, idx),

        FuncId::Date => cellwise(date::eval_date),
        FuncId::Day => cellwise(date::eval_day),
        FuncId::Month => cellwise(date::eval_month),
        FuncId::Year => cellwise(date::eval_year),
        FuncId::Weekday => cellwise(date::eval_weekday),
        FuncId::AddMonths => cellwise(date::eval_add_months),
        FuncId::AddYears => cellwise(date::eval_add_years),
        FuncId::Days => cellwise(date::eval_days),

        FuncId::Previous => time::eval_previous(ctx, target, args, idx),
        FuncId::Next => time::eval_next(ctx, target, args, idx),
        FuncId::Offset | FuncId::Lead => time::eval_shift(1, ctx, target, args, idx),
        FuncId::Lag => time::eval_shift(-1, ctx, target, args, idx),
        FuncId::Cumulate => time::eval_cumulate(ctx, target, args, idx),
        FuncId::MovingSum => time::eval_moving_sum(ctx, target, args, idx),
        FuncId::YearValue => time::eval_value(TimeLevel::Year, ctx, target, args, idx),
        FuncId::QuarterValue => time::eval_value(TimeLevel::Quarter, ctx, target, args, idx),
        FuncId::HalfYearValue => time::eval_value(TimeLevel::HalfYear, ctx, target, args, idx),
        FuncId::MonthValue => time::eval_value(TimeLevel::Month, ctx, target, args, idx),
        FuncId::TimeSum => time::eval_time_sum(ctx, target, args, idx),
        FuncId::YearToDate => time::eval_to_date(TimeLevel::Year, ctx, target, args, idx),
        FuncId::QuarterToDate => time::eval_to_date(TimeLevel::Quarter, ctx, target, args, idx),
        FuncId::HalfYearToDate => time::eval_to_date(TimeLevel::HalfYear, ctx, target, args, idx),
        FuncId::Start => period::eval_bound(ctx, target, idx, false),
        FuncId::End => period::eval_bound(ctx, target, idx, true),
        FuncId::InPeriod => period::eval_in_period(ctx, target, args, idx),
        FuncId::Period => period::eval_period(ctx, target, args, idx),
        FuncId::CurrentPeriodStart => Ok(period::eval_current(ctx, idx.len(), false)),
        FuncId::CurrentPeriodEnd => Ok(period::eval_current(ctx, idx.len(), true)),

        FuncId::CurrentVersion => version::eval_current(ctx, target, args, idx),
        FuncId::PreviousVersion => version::eval_adjacent(-1, ctx, target, args, idx),
        FuncId::NextVersion => version::eval_adjacent(1, ctx, target, args, idx),

        FuncId::Rank => rank::eval_rank(ctx, target, args, idx),

        FuncId::Npv => finance::eval_npv(ctx, target, args, idx),
        FuncId::Irr => finance::eval_irr(ctx, target, args, idx),
        FuncId::Pmt => cellwise(finance::eval_pmt),
        FuncId::Pv => cellwise(finance::eval_pv),
        FuncId::Fv => cellwise(finance::eval_fv),
    }
}

/// The values of the arguments `args` for the target cells at `idx`, one column each.
fn eval_args<'a>(
    ctx: &EvalCtx,
    target: &Shape,
    args: impl IntoIterator<Item = &'a TExpr>,
    idx: &[usize],
) -> Result<Vec<Column>, EngineError> {
    args.into_iter()
        .map(|arg| eval(ctx, target, arg, idx))
        .collect()
}

/// What identifies a call among the columns a context keeps for the whole target: where its
/// arguments are. Every call with an argument has its own, and it does not change while a
/// formula is evaluated.
fn call_key(args: &[TExpr]) -> usize {
    args.as_ptr() as usize
}

/// The cells `idx` of the column that `compute` works out for the whole of `target`, which it
/// does once for all the chunks of an evaluation and not once per chunk. This is for the
/// calls whose result at a cell depends on cells in other chunks.
fn shared(
    ctx: &EvalCtx,
    target: &Shape,
    args: &[TExpr],
    idx: &[usize],
    compute: impl FnOnce() -> Result<Column, EngineError>,
) -> Result<Column, EngineError> {
    let whole = ctx.memoized(call_key(args), target, compute)?;
    Ok(take(&whole, idx))
}

/// The numbers of the expression `expr` for every cell of `target`.
fn whole_numbers(ctx: &EvalCtx, target: &Shape, expr: &TExpr) -> Result<Vec<f64>, EngineError> {
    match eval_whole(ctx, target, expr)? {
        Column::Number(numbers) => Ok(numbers),
        _ => Err(mismatch()),
    }
}

/// The error for a column that is not of the type its function takes, which the type check of
/// the formula rules out.
fn mismatch() -> EngineError {
    EngineError::Invalid {
        message: "A function was given a value of a type it does not take.".to_string(),
    }
}

/// The dense item indices of a column of list items.
fn items_of(column: Column) -> Result<Vec<u32>, EngineError> {
    match column {
        Column::Item(items) => Ok(items),
        _ => Err(mismatch()),
    }
}
