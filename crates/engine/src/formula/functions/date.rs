//! `DATE`, `DAY`, `MONTH`, `YEAR`, `WEEKDAY`, `ADDMONTHS`, `ADDYEARS` and `DAYS`. A blank date
//! gives 0 where a number is due and stays blank where a date is.

use chrono::{Datelike, Months, NaiveDate};

use crate::error::EngineError;
use crate::model::EPOCH_DAYS_FROM_CE;
use crate::value::{BLANK_DATE, Column};

use super::mismatch;

/// The date of a stored day count, or `None` for a blank date.
pub(super) fn to_date(days: i32) -> Option<NaiveDate> {
    if days == BLANK_DATE {
        return None;
    }
    NaiveDate::from_num_days_from_ce_opt(days + EPOCH_DAYS_FROM_CE)
}

/// The stored day count of a date.
pub(super) fn to_days(date: NaiveDate) -> i32 {
    date.num_days_from_ce() - EPOCH_DAYS_FROM_CE
}

/// `DATE(year, month, day)`: the date, or a blank date if there is no such day. Fractions of a
/// number are dropped.
pub(super) fn eval_date(args: &[Column]) -> Result<Column, EngineError> {
    let [
        Column::Number(years),
        Column::Number(months),
        Column::Number(days),
    ] = args
    else {
        return Err(mismatch());
    };
    let cells = years
        .iter()
        .zip(months)
        .zip(days)
        .map(|((&year, &month), &day)| make_date(year.trunc(), month.trunc(), day.trunc()))
        .collect();
    Ok(Column::Date(cells))
}

fn make_date(year: f64, month: f64, day: f64) -> i32 {
    let fits = (f64::from(i32::MIN)..=f64::from(i32::MAX)).contains(&year)
        && (1.0..=12.0).contains(&month)
        && (1.0..=31.0).contains(&day);
    if !fits {
        return BLANK_DATE;
    }
    NaiveDate::from_ymd_opt(year as i32, month as u32, day as u32).map_or(BLANK_DATE, to_days)
}

fn part(args: &[Column], of: impl Fn(NaiveDate) -> f64) -> Result<Column, EngineError> {
    let [Column::Date(days)] = args else {
        return Err(mismatch());
    };
    let cells = days
        .iter()
        .map(|&days| to_date(days).map_or(0.0, &of))
        .collect();
    Ok(Column::Number(cells))
}

pub(super) fn eval_day(args: &[Column]) -> Result<Column, EngineError> {
    part(args, |date| f64::from(date.day()))
}

pub(super) fn eval_month(args: &[Column]) -> Result<Column, EngineError> {
    part(args, |date| f64::from(date.month()))
}

pub(super) fn eval_year(args: &[Column]) -> Result<Column, EngineError> {
    part(args, |date| f64::from(date.year()))
}

/// `WEEKDAY(date)`: 1 for Monday to 7 for Sunday.
pub(super) fn eval_weekday(args: &[Column]) -> Result<Column, EngineError> {
    part(args, |date| f64::from(date.weekday().number_from_monday()))
}

fn shift(args: &[Column], months_per_unit: f64) -> Result<Column, EngineError> {
    let [Column::Date(days), Column::Number(units)] = args else {
        return Err(mismatch());
    };
    let cells = days
        .iter()
        .zip(units)
        .map(|(&days, &units)| add_months(days, units.trunc() * months_per_unit))
        .collect();
    Ok(Column::Date(cells))
}

/// `ADDMONTHS(date, months)`: the date a number of months later, or earlier when negative. A day
/// that the month does not have becomes the last day of the month.
pub(super) fn eval_add_months(args: &[Column]) -> Result<Column, EngineError> {
    shift(args, 1.0)
}

/// `ADDYEARS(date, years)`: the same as twelve times as many months.
pub(super) fn eval_add_years(args: &[Column]) -> Result<Column, EngineError> {
    shift(args, 12.0)
}

/// The date `months` whole months from `days`; blank if that is outside the dates we can hold.
fn add_months(days: i32, months: f64) -> i32 {
    let Some(date) = to_date(days) else {
        return BLANK_DATE;
    };
    let count = Months::new(months.abs() as u32);
    let moved = if months < 0.0 {
        date.checked_sub_months(count)
    } else {
        date.checked_add_months(count)
    };
    moved.map_or(BLANK_DATE, to_days)
}

/// `DAYS(from, to)`: the number of days from one date to the other, negative if `to` is earlier.
pub(super) fn eval_days(args: &[Column]) -> Result<Column, EngineError> {
    let [Column::Date(from), Column::Date(to)] = args else {
        return Err(mismatch());
    };
    let cells = from
        .iter()
        .zip(to)
        .map(|(&from, &to)| {
            if from == BLANK_DATE || to == BLANK_DATE {
                0.0
            } else {
                (i64::from(to) - i64::from(from)) as f64
            }
        })
        .collect();
    Ok(Column::Number(cells))
}
