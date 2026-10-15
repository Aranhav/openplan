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

/// The most steps of Newton's method `IRR` takes, and how close two steps must be.
const IRR_STEPS: usize = 100;
const IRR_TOLERANCE: f64 = 1e-10;

/// The rate found by Newton's method from a guess of 10 %, or 0 if the steps do not settle on
/// a rate above -100 % within [`IRR_STEPS`].
fn irr(series: &[f64]) -> f64 {
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
            return 0.0;
        }
        if (next - rate).abs() < IRR_TOLERANCE {
            return next;
        }
        rate = next;
    }
    0.0
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
