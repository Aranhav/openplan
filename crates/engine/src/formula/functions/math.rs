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
    map2(&values, |x, places| round(x, places, mode))
}

/// From 2^52 up a number is whole already, since the spacing of numbers there is 1.
const WHOLE_FROM: f64 = (1u64 << 52) as f64;

/// From 2^50 up a number is not snapped by [`settle`]: there the spacing of numbers is a quarter,
/// too coarse to tell a half from the representation error of a computed number.
const SNAP_BELOW: f64 = (1u64 << 50) as f64;

/// `x` rounded to `places` decimals in `mode`. Rounding to a whole number works on `x` itself;
/// any other number is rounded on the decimal digits it is written with (see [`round_decimal`]).
fn round(x: f64, places: f64, mode: Word) -> f64 {
    let places = places.trunc().clamp(-400.0, 400.0) as i32;
    if places == 0 {
        round_whole(x, mode)
    } else {
        round_decimal(x, places, mode)
    }
}

/// `x` rounded to a whole number in `mode`.
fn round_whole(x: f64, mode: Word) -> f64 {
    if !x.is_finite() || x.abs() >= WHOLE_FROM {
        return x;
    }
    let settled = settle(x);
    match mode {
        Word::Up => settled.abs().ceil().copysign(settled),
        Word::Down => settled.trunc(),
        _ => settled.round(),
    }
}

/// A number within four units in the last place of a whole or half number is taken as that
/// number, so that a computed `2.4999999999999996` rounds to a whole number as `2.5` does. From
/// `SNAP_BELOW` up the number is kept as it is.
fn settle(x: f64) -> f64 {
    let magnitude = x.abs();
    if magnitude >= SNAP_BELOW {
        return x;
    }
    let half = (x * 2.0).round() / 2.0;
    let ulp = f64::from_bits(magnitude.to_bits() + 1) - magnitude;
    if (x - half).abs() <= 4.0 * ulp {
        half
    } else {
        x
    }
}

/// `x` rounded to `places` decimals (negative to the left of the point) in `mode`, on the decimal
/// digits that `x` is written with: the shortest decimal that reads back as `x`, which is the
/// number as it was typed. The result is the double nearest to the decimal that comes out.
fn round_decimal(x: f64, places: i32, mode: Word) -> f64 {
    if !x.is_finite() {
        return x;
    }
    let written = format!("{}", x.abs());
    let (whole, fraction) = written.split_once('.').unwrap_or((&written, ""));
    let mut digits: Vec<u8> = whole
        .bytes()
        .chain(fraction.bytes())
        .map(|byte| byte - b'0')
        .collect();
    // `point` counts the digits before the decimal point, and `kept` the digits that stay.
    let mut point = whole.len() as i64;
    let kept = point + i64::from(places);
    if kept >= digits.len() as i64 {
        return x;
    }
    let kept = if kept < 0 {
        // The rounding place is beyond every digit, so zeros stand in for the digits before it.
        digits.splice(0..0, std::iter::repeat_n(0, kept.unsigned_abs() as usize));
        point -= kept;
        0
    } else {
        kept as usize
    };
    let away = rounds_up(&digits[kept..], places, x.abs(), mode);
    digits.truncate(kept);
    if away {
        point += add_one(&mut digits);
    }
    let text = if point <= 0 {
        format!("0.{}{}", "0".repeat((-point) as usize), digit_text(&digits))
    } else if point as usize >= digits.len() {
        format!(
            "{}{}",
            digit_text(&digits),
            "0".repeat(point as usize - digits.len())
        )
    } else {
        let (integer, fraction) = digits.split_at(point as usize);
        format!("{}.{}", digit_text(integer), digit_text(fraction))
    };
    let value: f64 = text.parse().unwrap_or(0.0);
    if x < 0.0 { -value } else { value }
}

/// The shortest run of zeros or nines that marks representation error: a computed number lies
/// just above a place with a run of zeros after it, or just below one with a run of nines.
const ERROR_RUN: usize = 10;

/// Whether the `dropped` digits after the last kept place take that place up by one, in `mode`.
/// A remainder within four units in the last place of `magnitude`, with a run of at least
/// [`ERROR_RUN`] zeros or nines after the place, is representation error: no remainder, or the
/// whole place, so that a computed `0.30000000000000004` is 0.3. Otherwise the digits are rounded
/// as written. The test only applies where the place is more than eight units in the last place
/// apart.
fn rounds_up(dropped: &[u8], places: i32, magnitude: f64, mode: Word) -> bool {
    let unit = 10f64.powi(-places);
    let ulp = f64::from_bits(magnitude.to_bits() + 1) - magnitude;
    let lead = dropped.first().copied().unwrap_or(0);
    let run = dropped.iter().take_while(|&&digit| digit == lead).count();
    if unit.is_finite() && 8.0 * ulp < unit && run >= ERROR_RUN && (lead == 0 || lead == 9) {
        let remainder = format!("0.{}", digit_text(dropped))
            .parse::<f64>()
            .unwrap_or(0.0)
            * unit;
        if lead == 0 && remainder <= 4.0 * ulp {
            return false;
        }
        if lead == 9 && unit - remainder <= 4.0 * ulp {
            return true;
        }
    }
    match mode {
        Word::Up => dropped.iter().any(|&digit| digit != 0),
        Word::Down => false,
        _ => dropped.first().is_some_and(|&digit| digit >= 5),
    }
}

/// Adds one to the last of `digits`, carrying as far as needed. Returns 1 when the carry makes a
/// new digit in front, which moves the decimal point along by one.
fn add_one(digits: &mut Vec<u8>) -> i64 {
    for digit in digits.iter_mut().rev() {
        if *digit < 9 {
            *digit += 1;
            return 0;
        }
        *digit = 0;
    }
    digits.insert(0, 1);
    1
}

/// The digits as text.
fn digit_text(digits: &[u8]) -> String {
    digits
        .iter()
        .map(|&digit| char::from(b'0' + digit))
        .collect()
}
