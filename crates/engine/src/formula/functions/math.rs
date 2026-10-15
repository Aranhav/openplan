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

/// `x` rounded to `places` decimals (negative to the left of the point) in `mode`. The rounding is
/// done on the shortest decimal that reads back as `x`, which is the number as it was written, and
/// the result is the double nearest to the decimal that comes out. A decimal beyond the range of a
/// double comes out infinite, which [`sanitize_number`] makes 0.
fn round(x: f64, places: f64, mode: Word) -> f64 {
    if !x.is_finite() {
        return x;
    }
    let places = places.trunc().clamp(-400.0, 400.0) as i64;
    let (mut digits, mut point) = shortest_digits(x.abs());
    // `keep` digits stay: the rounding place is `places` places from the point.
    let keep = point + places;
    if keep >= digits.len() as i64 {
        return x;
    }
    let kept = if keep < 0 {
        // Every digit lies beyond the rounding place, so zeros stand in for the digits before it.
        digits.splice(0..0, std::iter::repeat_n(0, keep.unsigned_abs() as usize));
        point -= keep;
        0
    } else {
        keep as usize
    };
    let away = rounds_away(&digits[kept..], mode);
    digits.truncate(kept);
    if away {
        point += add_one(&mut digits);
    }
    let value: f64 = format!("0.{}e{point}", digit_text(&digits))
        .parse()
        .unwrap_or(0.0);
    if x < 0.0 { -value } else { value }
}

/// The digits of `x`, which is finite and not negative, as the shortest decimal that reads back as
/// `x`, and the place of the decimal point among them: `x` is `0.d1d2... × 10^point`.
fn shortest_digits(x: f64) -> (Vec<u8>, i64) {
    let written = format!("{x:e}");
    let (mantissa, exponent) = written.split_once('e').unwrap_or((written.as_str(), "0"));
    let digits = mantissa
        .bytes()
        .filter(u8::is_ascii_digit)
        .map(|byte| byte - b'0')
        .collect();
    (digits, exponent.parse::<i64>().unwrap_or(0) + 1)
}

/// Whether the `dropped` digits take the last kept place up by one in `mode`: `UP` when any of them
/// is nonzero, `DOWN` never, and `NEAREST` when the first is 5 or more, which takes a half away
/// from zero.
fn rounds_away(dropped: &[u8], mode: Word) -> bool {
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
