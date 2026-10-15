//! The functions that tie dates to periods of the model calendar: `START`, `END`, `INPERIOD`,
//! `PERIOD`, `CURRENTPERIODSTART` and `CURRENTPERIODEND`.

use std::ops::Range;

use chrono::{Months, NaiveDate};

use crate::calendar::{Calendar, TimeLevel};
use crate::error::EngineError;
use crate::shape::{Axis, Shape};
use crate::value::{BLANK_DATE, BLANK_PERIOD, Column, ValueType};

use crate::formula::eval::eval;
use crate::formula::{EvalCtx, TExpr};

use super::axis::position;
use super::date::{to_date, to_days};
use super::mismatch;
use super::time::time_axis;

/// The last day of the month that starts on `first`.
fn last_day(first: NaiveDate) -> Option<NaiveDate> {
    first.checked_add_months(Months::new(1))?.pred_opt()
}

/// The months of `calendar` that make up the period at `level` with the index `period`, or
/// `None` for a period that is not set or not in the calendar.
pub(super) fn span(calendar: &Calendar, level: TimeLevel, period: u32) -> Option<Range<u32>> {
    (period != BLANK_PERIOD && period < calendar.periods(level))
        .then(|| calendar.months_in_period(level, period))
}

/// The month of `calendar` that the day `days` falls in.
fn month_of(calendar: &Calendar, days: i32) -> Option<u32> {
    to_date(days).and_then(|date| calendar.month_of_date(date))
}

/// `START()` and `END()`: the first day and the last day of the period of the cell being
/// calculated. A time range has its own calendar, so a period of one has the dates of that
/// range.
pub(super) fn eval_bound(
    ctx: &EvalCtx,
    target: &Shape,
    idx: &[usize],
    last: bool,
) -> Result<Column, EngineError> {
    let axis = time_axis(target)?;
    let Axis::Time { level, range } = target.axes[axis] else {
        return Err(mismatch());
    };
    let calendar = ctx.structure.time_calendar(range)?;
    let days: Vec<i32> = (0..target.lens[axis])
        .map(|period| {
            let months = calendar.months_in_period(level, period);
            let date = if last {
                last_day(calendar.month_start_date(months.end - 1))
            } else {
                Some(calendar.month_start_date(months.start))
            };
            date.map_or(BLANK_DATE, to_days)
        })
        .collect();
    Ok(Column::Date(
        idx.iter()
            .map(|&cell| days[position(target, axis, cell)])
            .collect(),
    ))
}

/// `CURRENTPERIODSTART()` and `CURRENTPERIODEND()`: the first and the last day of the current
/// month of the model, or a blank date when it has none.
pub(super) fn eval_current(ctx: &EvalCtx, len: usize, last: bool) -> Column {
    let calendar = &ctx.structure.calendar;
    let date = calendar
        .current_month
        .filter(|&month| month < calendar.months())
        .and_then(|month| {
            let first = calendar.month_start_date(month);
            if last { last_day(first) } else { Some(first) }
        });
    Column::Date(vec![date.map_or(BLANK_DATE, to_days); len])
}

/// `INPERIOD(date, period)`: whether the date falls in the period, which is a period of the
/// model calendar. A date outside the calendar, a blank date and a period that is not set are
/// in no period.
pub(super) fn eval_in_period(
    ctx: &EvalCtx,
    target: &Shape,
    args: &[TExpr],
    idx: &[usize],
) -> Result<Column, EngineError> {
    let [day, period] = args else {
        return Err(mismatch());
    };
    let Some(ValueType::Period(level)) = period.ty() else {
        return Err(mismatch());
    };
    let (Column::Date(days), Column::Period(periods)) = (
        eval(ctx, target, day, idx)?,
        eval(ctx, target, period, idx)?,
    ) else {
        return Err(mismatch());
    };
    let calendar = &ctx.structure.calendar;
    Ok(Column::Boolean(
        days.iter()
            .zip(&periods)
            .map(|(&day, &period)| {
                month_of(calendar, day)
                    .zip(span(calendar, level, period))
                    .is_some_and(|(month, months)| months.contains(&month))
            })
            .collect(),
    ))
}

/// `PERIOD(date)`: the month of the model calendar that the date falls in; blank for a blank
/// date or one outside the calendar.
pub(super) fn eval_period(
    ctx: &EvalCtx,
    target: &Shape,
    args: &[TExpr],
    idx: &[usize],
) -> Result<Column, EngineError> {
    let [day] = args else {
        return Err(mismatch());
    };
    let Column::Date(days) = eval(ctx, target, day, idx)? else {
        return Err(mismatch());
    };
    let calendar = &ctx.structure.calendar;
    Ok(Column::Period(
        days.iter()
            .map(|&day| month_of(calendar, day).unwrap_or(BLANK_PERIOD))
            .collect(),
    ))
}
