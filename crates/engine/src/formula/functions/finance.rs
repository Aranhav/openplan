//! `NPV`, `IRR`, `PMT`, `PV` and `FV`, with the results of the functions of the same names in
//! a spreadsheet: payments are negative, what is received is positive, and a payment is made at
//! the end of its period.
//!
//! A result that overflowed or has no value is 0 at once, as it is in arithmetic.

use crate::error::EngineError;
use crate::shape::Shape;
use crate::value::{Column, sanitize_number};

use crate::formula::{EvalCtx, TExpr};

use super::axis::Lines;
use super::time::time_axis;
use super::{mismatch, shared, whole_numbers};

/// `NPV(rate, x)`: the present value of the values of `x` over all periods of the line item
/// at the rate of the cell, the first period being discounted by one period. Every period has
/// the same value, unless the rate varies by period.
pub(super) fn eval_npv(
    ctx: &EvalCtx,
    target: &Shape,
    args: &[TExpr],
    idx: &[usize],
) -> Result<Column, EngineError> {
    shared(ctx, target, args, idx, || {
        let lines = Lines::new(target, time_axis(target)?);
        let (rates, flows) = (
            whole_numbers(ctx, target, &args[0])?,
            whole_numbers(ctx, target, &args[1])?,
        );
        let mut out = vec![0.0; flows.len()];
        let mut series = Vec::with_capacity(lines.len);
        for origin in lines.origins() {
            series.clear();
            series.extend((0..lines.len).map(|at| flows[lines.cell(origin, at)]));
            let mut last: Option<(f64, f64)> = None;
            for at in 0..lines.len {
                let cell = lines.cell(origin, at);
                out[cell] = match last {
                    Some((rate, value)) if rate == rates[cell] => value,
                    _ => {
                        let value = npv(rates[cell], &series);
                        last = Some((rates[cell], value));
                        value
                    }
                };
            }
        }
        Ok(Column::Number(out))
    })
}

fn npv(rate: f64, series: &[f64]) -> f64 {
    let discount = 1.0 / (1.0 + rate);
    let mut factor = 1.0;
    let mut total = 0.0;
    for &flow in series {
        factor *= discount;
        total += flow * factor;
    }
    sanitize_number(total)
}

/// `IRR(x)`: the rate at which the values of `x` over all periods of the line item have a
/// present value of 0, the first period not being discounted. The same in every period. It is
/// 0 when no rate is found.
pub(super) fn eval_irr(
    ctx: &EvalCtx,
    target: &Shape,
    args: &[TExpr],
    idx: &[usize],
) -> Result<Column, EngineError> {
    shared(ctx, target, args, idx, || {
        let lines = Lines::new(target, time_axis(target)?);
        let flows = whole_numbers(ctx, target, &args[0])?;
        let mut out = vec![0.0; flows.len()];
        let mut series = Vec::with_capacity(lines.len);
        for origin in lines.origins() {
            series.clear();
            series.extend((0..lines.len).map(|at| flows[lines.cell(origin, at)]));
            let rate = irr(&series);
            for at in 0..lines.len {
                out[lines.cell(origin, at)] = rate;
            }
        }
        Ok(Column::Number(out))
    })
}

/// The most steps of Newton's method `IRR` takes, and how close two steps, or two rates in the
/// bisection, must be.
const IRR_STEPS: usize = 100;
const IRR_TOLERANCE: f64 = 1e-10;
/// The sign-change search scans the growth factors `1 + rate`, log-spaced from `IRR_LOW` to
/// `IRR_HIGH`: the rates from -99.999 % to 1000 %, in `IRR_GRID` points.
const IRR_LOW: f64 = 1e-5;
const IRR_HIGH: f64 = 1001.0;
const IRR_GRID: usize = 1000;

/// The rate at which the values of `series` have a present value of 0: where Newton's method
/// from a guess of 10 % settles, or else the first sign change of the present value over the
/// grid of rates, bisected. 0 when there is no such rate.
fn irr(series: &[f64]) -> f64 {
    newton(series)
        .or_else(|| first_sign_change(series))
        .unwrap_or(0.0)
}

/// The rate Newton's method settles on from a guess of 10 %, or `None` if the steps do not
/// settle on a rate above -100 % within [`IRR_STEPS`].
fn newton(series: &[f64]) -> Option<f64> {
    let mut rate = 0.1;
    for _ in 0..IRR_STEPS {
        let discount = 1.0 / (1.0 + rate);
        let (mut factor, mut value, mut slope) = (1.0, 0.0, 0.0);
        for (at, &flow) in series.iter().enumerate() {
            value += flow * factor;
            slope -= at as f64 * flow * factor * discount;
            factor *= discount;
        }
        let next = rate - value / slope;
        if !next.is_finite() || next <= -1.0 {
            return None;
        }
        if (next - rate).abs() < IRR_TOLERANCE {
            return Some(next);
        }
        rate = next;
    }
    None
}

/// The rate where the present value of `series` first changes sign over the grid, found by
/// bisection between the two grid points either side of the change. Grid points where it is 0
/// are skipped. A series whose flows are not of both signs keeps one sign at every rate, so it
/// has no such rate, and `None` comes without a scan.
fn first_sign_change(series: &[f64]) -> Option<f64> {
    let positive = series.iter().any(|&flow| flow > 0.0);
    let negative = series.iter().any(|&flow| flow < 0.0);
    if !positive || !negative {
        return None;
    }
    let ratio = (IRR_HIGH / IRR_LOW).powf(1.0 / (IRR_GRID - 1) as f64);
    let mut previous: Option<(f64, f64)> = None;
    for step in 0..IRR_GRID {
        let rate = IRR_LOW * ratio.powi(step as i32) - 1.0;
        let value = scaled_value(series, rate);
        if value == 0.0 {
            continue;
        }
        if let Some((low, at_low)) = previous
            && (at_low < 0.0) != (value < 0.0)
        {
            return Some(bisect(series, low, rate, at_low < 0.0));
        }
        previous = Some((rate, value));
    }
    None
}

/// The rate between `low` and `high`, where the present value of `series` changes sign, to
/// within [`IRR_TOLERANCE`]. The present value is negative at `low` when `negative_low` is set,
/// and positive at `high`, or the other way round.
fn bisect(series: &[f64], mut low: f64, mut high: f64, negative_low: bool) -> f64 {
    while high - low > IRR_TOLERANCE {
        let middle = (low + high) / 2.0;
        let value = scaled_value(series, middle);
        if value == 0.0 {
            return middle;
        }
        if (value < 0.0) == negative_low {
            low = middle;
        } else {
            high = middle;
        }
    }
    (low + high) / 2.0
}

/// The present value of `series` at `rate`, with its first flow not discounted, multiplied by a
/// positive factor so that it does not overflow at the lowest rates of the search. It has the
/// sign of the present value, and is 0 where that is too small to tell from 0.
fn scaled_value(series: &[f64], rate: f64) -> f64 {
    let growth = 1.0 + rate;
    let mut factor = 1.0;
    let mut total = 0.0;
    if growth < 1.0 {
        // The present value times growth^(n - 1) is the sum of flow * growth^(n - 1 - at), with
        // no power of growth above 1.
        for &flow in series.iter().rev() {
            total += flow * factor;
            factor *= growth;
        }
    } else {
        let discount = 1.0 / growth;
        for &flow in series {
            total += flow * factor;
            factor *= discount;
        }
    }
    total
}

fn map3(args: &[Column], f: impl Fn(f64, f64, f64) -> f64) -> Result<Column, EngineError> {
    let [Column::Number(a), Column::Number(b), Column::Number(c)] = args else {
        return Err(mismatch());
    };
    Ok(Column::Number(
        a.iter()
            .zip(b)
            .zip(c)
            .map(|((&a, &b), &c)| sanitize_number(f(a, b, c)))
            .collect(),
    ))
}

fn map4(args: &[Column], f: impl Fn(f64, f64, f64, f64) -> f64) -> Result<Column, EngineError> {
    let [
        Column::Number(a),
        Column::Number(b),
        Column::Number(c),
        Column::Number(d),
    ] = args
    else {
        return Err(mismatch());
    };
    Ok(Column::Number(
        a.iter()
            .zip(b)
            .zip(c)
            .zip(d)
            .map(|(((&a, &b), &c), &d)| sanitize_number(f(a, b, c, d)))
            .collect(),
    ))
}

/// `(1 + rate)^periods - 1`, exact for a rate near 0.
fn growth(rate: f64, periods: f64) -> f64 {
    (periods * rate.ln_1p()).exp_m1()
}

/// `PMT(rate, nper, pv)`: the payment per period that pays off the loan `pv` in `nper`
/// periods at `rate` per period; 0 for no periods.
pub(super) fn eval_pmt(args: &[Column]) -> Result<Column, EngineError> {
    map3(args, |rate, periods, loan| {
        if rate == 0.0 {
            return if periods == 0.0 { 0.0 } else { -loan / periods };
        }
        let paid_off = growth(rate, -periods);
        if paid_off == 0.0 {
            0.0
        } else {
            loan * rate / paid_off
        }
    })
}

/// `PV(rate, nper, pmt)`: the present value of `nper` payments of `pmt`.
pub(super) fn eval_pv(args: &[Column]) -> Result<Column, EngineError> {
    map3(args, |rate, periods, payment| {
        if rate == 0.0 {
            -payment * periods
        } else {
            payment * growth(rate, -periods) / rate
        }
    })
}

/// `FV(rate, nper, pmt, pv)`: the future value of the present value `pv` and `nper` payments
/// of `pmt`.
pub(super) fn eval_fv(args: &[Column]) -> Result<Column, EngineError> {
    map4(args, |rate, periods, payment, present| {
        if rate == 0.0 {
            -(present + payment * periods)
        } else {
            let grown = growth(rate, periods);
            -(present * (grown + 1.0) + payment * grown / rate)
        }
    })
}
