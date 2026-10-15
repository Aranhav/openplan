//! `ABS`, `ROUND`, `MIN`, `MAX`, `POWER`, `SQRT`, `EXP`, `LN`, `LOG`, `MOD`, `DIVIDE` and
//! `SIGN`.
//!
//! A result that overflowed or has no value, such as a negative number raised to a fraction, is
//! 0 at once, as it is in arithmetic, so that nothing after it sees it.

use crate::error::EngineError;
use crate::shape::Shape;
use crate::value::{Column, sanitize_number};

use crate::formula::{EvalCtx, TExpr};

use super::{Word, eval_args, mismatch};

fn map1(args: &[Column], f: impl Fn(f64) -> f64) -> Result<Column, EngineError> {
    let [Column::Number(x)] = args else {
        return Err(mismatch());
    };
    Ok(Column::Number(
        x.iter().map(|&x| sanitize_number(f(x))).collect(),
    ))
}

fn map2(args: &[Column], f: impl Fn(f64, f64) -> f64) -> Result<Column, EngineError> {
    let [Column::Number(x), Column::Number(y)] = args else {
        return Err(mismatch());
    };
    Ok(Column::Number(
        x.iter()
            .zip(y)
            .map(|(&x, &y)| sanitize_number(f(x, y)))
            .collect(),
    ))
}

pub(super) fn eval_abs(args: &[Column]) -> Result<Column, EngineError> {
    map1(args, f64::abs)
}

pub(super) fn eval_sqrt(args: &[Column]) -> Result<Column, EngineError> {
    map1(args, |x| if x < 0.0 { 0.0 } else { x.sqrt() })
}

pub(super) fn eval_exp(args: &[Column]) -> Result<Column, EngineError> {
    map1(args, f64::exp)
}

pub(super) fn eval_ln(args: &[Column]) -> Result<Column, EngineError> {
    map1(args, |x| if x <= 0.0 { 0.0 } else { x.ln() })
}

/// `LOG(x)` is the logarithm to base 10, `LOG(x, base)` the one to `base`. It is 0 for a number
/// that is not positive and for a base that is not positive or is 1.
pub(super) fn eval_log(args: &[Column]) -> Result<Column, EngineError> {
    match args {
        [Column::Number(_)] => map1(args, |x| log(x, 10.0)),
        _ => map2(args, log),
    }
}

fn log(x: f64, base: f64) -> f64 {
    if x <= 0.0 || base <= 0.0 || base == 1.0 {
        0.0
    } else if base == 10.0 {
        x.log10()
    } else if base == 2.0 {
        x.log2()
    } else {
        x.ln() / base.ln()
    }
}

pub(super) fn eval_sign(args: &[Column]) -> Result<Column, EngineError> {
    map1(args, |x| {
        if x > 0.0 {
            1.0
        } else if x < 0.0 {
            -1.0
        } else {
            0.0
        }
    })
}

pub(super) fn eval_power(args: &[Column]) -> Result<Column, EngineError> {
    map2(args, f64::powf)
}

/// `MOD(a, b)` is `a - b * floor(a / b)`, which takes the sign of `b`; it is 0 when `b` is 0.
pub(super) fn eval_mod(args: &[Column]) -> Result<Column, EngineError> {
    map2(args, |a, b| {
        if b == 0.0 {
            0.0
        } else {
            a - b * (a / b).floor()
        }
    })
}

pub(super) fn eval_divide(args: &[Column]) -> Result<Column, EngineError> {
    map2(args, |a, b| if b == 0.0 { 0.0 } else { a / b })
}

pub(super) fn eval_min(args: &[Column]) -> Result<Column, EngineError> {
    fold(args, f64::min)
}

pub(super) fn eval_max(args: &[Column]) -> Result<Column, EngineError> {
    fold(args, f64::max)
}

fn fold(args: &[Column], pick: fn(f64, f64) -> f64) -> Result<Column, EngineError> {
    let Some((Column::Number(first), rest)) = args.split_first() else {
        return Err(mismatch());
    };
    let mut cells = first.clone();
    for column in rest {
        let Column::Number(next) = column else {
            return Err(mismatch());
        };
        for (cell, &other) in cells.iter_mut().zip(next) {
            *cell = pick(*cell, other);
        }
    }
    Ok(Column::Number(cells))
}

/// `ROUND(x, places[, mode])`: `x` to a number of decimal places, which may be negative to
/// round to tens, hundreds and so on. `NEAREST`, the default, takes a half away from zero,
/// `UP` goes away from zero and `DOWN` toward zero.
pub(super) fn eval_round(
    ctx: &EvalCtx,
    target: &Shape,
    args: &[TExpr],
    idx: &[usize],
) -> Result<Column, EngineError> {
    let (x, places, mode) = match args {
        [x, places] => (x, places, Word::Nearest),
        [x, places, TExpr::Word { word, .. }] => (x, places, *word),
        _ => return Err(mismatch()),
    };
    let values = eval_args(ctx, target, [x, places], idx)?;
    match mode {
        Word::Up => map2(&values, |x, places| {
            round(x, places, |scaled| scaled.abs().ceil().copysign(scaled))
        }),
        Word::Down => map2(&values, |x, places| round(x, places, f64::trunc)),
        _ => map2(&values, |x, places| round(x, places, f64::round)),
    }
}

/// `x` rounded to `places` decimals, where `whole` rounds a scaled number to a whole one.
fn round(x: f64, places: f64, whole: impl Fn(f64) -> f64) -> f64 {
    let places = places.trunc().clamp(-400.0, 400.0) as i32;
    let factor = 10f64.powi(places.abs());
    let scaled = if places >= 0 { x * factor } else { x / factor };
    if !scaled.is_finite() {
        return x;
    }
    let rounded = whole(settle(scaled));
    if places >= 0 {
        rounded / factor
    } else {
        rounded * factor
    }
}

/// A scaled number without the representation error of scaling: one within a few units of the
/// last place of a whole or half number is that number. `1.005 * 100` is `100.49999999999999`
/// and `12.35 * 100` is `1235.0000000000002`, but they are the numbers typed, and they round
/// as such.
fn settle(scaled: f64) -> f64 {
    let half = (scaled * 2.0).round() / 2.0;
    if (scaled - half).abs() <= scaled.abs() * 4.0 * f64::EPSILON {
        half
    } else {
        scaled
    }
}
