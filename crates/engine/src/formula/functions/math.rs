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

/// From 2^52 up a number is whole already, so ROUND to a place of 0 or more leaves it as it is.
const WHOLE_FROM: f64 = (1u64 << 52) as f64;

/// `x` rounded to `places` decimals (negative to the left of the point) in `mode`. The fast path
/// [`round_scaled`] answers where it is exact, and [`round_decimal`] everywhere else. Both round the
/// decimal that [`decimal_digits`] gives for `x`, and the result is the double nearest to the
/// decimal that comes out.
fn round(x: f64, places: f64, mode: Word) -> f64 {
    if !x.is_finite() {
        return x;
    }
    let places = places.trunc().clamp(-400.0, 400.0) as i64;
    if places >= 0 && x.abs() >= WHOLE_FROM {
        return x;
    }
    round_scaled(x, places, mode).unwrap_or_else(|| round_decimal(x, places, mode))
}

/// The fast path of [`round`] for places from 0 to 15, where `10^places` is exact. `x` is scaled
/// in floating point, rounded to a whole number and divided back. That agrees with the decimal
/// path unless the scaled number lies within eight units in its last place of a rounding boundary:
/// the half for NEAREST, and the whole numbers for UP and DOWN. The scaling and the digits that the
/// decimal path takes can each move the number that far, so such numbers, and scaled numbers of
/// 2^52 or more, return `None` and take the decimal path.
fn round_scaled(x: f64, places: i64, mode: Word) -> Option<f64> {
    if !(0..=15).contains(&places) {
        return None;
    }
    let scale = 10f64.powi(places as i32);
    let scaled = x.abs() * scale;
    if scaled >= WHOLE_FROM {
        return None;
    }
    let whole = scaled.floor();
    let fraction = scaled - whole;
    let ulp = f64::from_bits(scaled.to_bits() + 1) - scaled;
    let tolerance = (8.0 * ulp).max(1e-9);
    let near_boundary = match mode {
        Word::Up | Word::Down => fraction < tolerance || 1.0 - fraction < tolerance,
        _ => (fraction - 0.5).abs() < tolerance,
    };
    if near_boundary {
        return None;
    }
    let units = match mode {
        Word::Up => whole + 1.0,
        Word::Down => whole,
        _ if fraction > 0.5 => whole + 1.0,
        _ => whole,
    };
    let value = units / scale;
    Some(if x < 0.0 { -value } else { value })
}

/// `x` rounded to `places` decimals in `mode` on the decimal digits of `x` (see
/// [`decimal_digits`]), and the result is the double nearest to the decimal that comes out.
fn round_decimal(x: f64, places: i64, mode: Word) -> f64 {
    let (mut digits, mut point) = decimal_digits(x.abs());
    // `keep` digits stay: the rounding place is `places` places from the point.
    let keep = point + places;
    let kept = if keep < 0 {
        // Every digit lies beyond the rounding place, so zeros stand in for the digits before it.
        digits.splice(0..0, std::iter::repeat_n(0, keep.unsigned_abs() as usize));
        point -= keep;
        0
    } else {
        keep.min(digits.len() as i64) as usize
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

/// The digits of `x`, which is finite and not negative, and the place of the decimal point among
/// them: its 15 significant digits when they read back less than two units in the last place of
/// `x` away from it, and otherwise its shortest decimal that reads back as `x`.
fn decimal_digits(x: f64) -> (Vec<u8>, i64) {
    let fifteen = format!("{x:.14e}");
    let ulp = f64::from_bits(x.to_bits() + 1) - x;
    let near = fifteen
        .parse::<f64>()
        .is_ok_and(|value| value.is_finite() && (value - x).abs() < 2.0 * ulp);
    if near {
        digits_of(&fifteen)
    } else {
        digits_of(&format!("{x:e}"))
    }
}

/// The digits of a number written in exponent form, such as `1.5e-7`, and the place of its point
/// among them: the number is `0.d1d2... × 10^point`.
fn digits_of(written: &str) -> (Vec<u8>, i64) {
    let (mantissa, exponent) = written.split_once('e').unwrap_or((written, "0"));
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

#[cfg(test)]
mod tests {
    use super::{Word, round, round_decimal, round_scaled};

    /// Scaled by 100 this is 1.9e15, where a product can be off by a quarter of a unit, so the fast
    /// path leaves it to the decimal path.
    #[test]
    fn round_leaves_large_scaled_numbers_to_the_decimal_path() {
        assert!(round_scaled(-18_973_917_696_423.1, 2, Word::Nearest).is_none());
        assert_eq!(
            round(-18_973_917_696_423.1, 2.0, Word::Nearest),
            -18_973_917_696_423.1
        );
    }

    /// The fast path and the decimal path agree on 100,000 values from a seeded generator, across
    /// places 0 to 6 and all three modes. Half of the values are decimals of at most 15 digits, so
    /// they sit on rounding ties.
    #[test]
    fn round_fast_path_matches_the_decimal_path() {
        let mut state: u64 = 0x2545_F491_4F6C_DD1D;
        let mut next = move || {
            state = state
                .wrapping_mul(6_364_136_223_846_793_005)
                .wrapping_add(1_442_695_040_888_963_407);
            state >> 11
        };
        let modes = [Word::Nearest, Word::Up, Word::Down];
        let mut fast = 0;
        for i in 0..100_000 {
            let magnitude = if i % 2 == 0 {
                let digits = (next() % 1_000_000_000_000_000) as f64;
                digits / 10f64.powi((next() % 9) as i32)
            } else {
                (next() as f64 / (1u64 << 53) as f64) * 10f64.powi((next() % 21) as i32 - 6)
            };
            let x = if next() % 2 == 0 {
                magnitude
            } else {
                -magnitude
            };
            let places = (i % 7) as i64;
            let mode = modes[(next() % 3) as usize];
            if let Some(value) = round_scaled(x, places, mode) {
                fast += 1;
                assert_eq!(
                    value,
                    round_decimal(x, places, mode),
                    "{x:e} at {places} places"
                );
            }
        }
        assert!(fast > 50_000, "the fast path answered only {fast} values");
    }
}
