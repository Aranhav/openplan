//! `LEFT`, `RIGHT`, `MID`, `LEN`, `FIND`, `UPPER`, `LOWER`, `TRIM`, `SUBSTITUTE`, `TEXT` and
//! `VALUE`. Positions and lengths count characters, not bytes, and positions count from 1.

use std::sync::Arc;

use crate::error::EngineError;
use crate::shape::Shape;
use crate::value::{Column, sanitize_number};

use crate::formula::eval::{eval, ops};
use crate::formula::{EvalCtx, TExpr};

use super::mismatch;

/// A count of characters as a whole number: 0 for a count below 1.
fn whole(count: f64) -> usize {
    if count >= 1.0 { count as usize } else { 0 }
}

/// The byte offset of the character `n` places from the start of the text, or the length of the
/// text if it has no such character.
fn offset(text: &str, n: usize) -> usize {
    text.char_indices()
        .nth(n)
        .map_or(text.len(), |(offset, _)| offset)
}

/// The bytes `from..to` of a text as a text of their own, which is the text itself when they are
/// all of it.
fn slice(text: &Arc<str>, from: usize, to: usize) -> Arc<str> {
    if (from, to) == (0, text.len()) {
        Arc::clone(text)
    } else {
        Arc::from(&text[from..to])
    }
}

fn map_text(args: &[Column], f: impl Fn(&Arc<str>) -> Arc<str>) -> Result<Column, EngineError> {
    let [Column::Text(texts)] = args else {
        return Err(mismatch());
    };
    Ok(Column::Text(texts.iter().map(f).collect()))
}

fn text_and_number(
    args: &[Column],
    f: impl Fn(&Arc<str>, f64) -> Arc<str>,
) -> Result<Column, EngineError> {
    let [Column::Text(texts), Column::Number(numbers)] = args else {
        return Err(mismatch());
    };
    Ok(Column::Text(
        texts
            .iter()
            .zip(numbers)
            .map(|(text, &number)| f(text, number))
            .collect(),
    ))
}

pub(super) fn eval_left(args: &[Column]) -> Result<Column, EngineError> {
    text_and_number(args, |text, count| {
        slice(text, 0, offset(text, whole(count)))
    })
}

pub(super) fn eval_right(args: &[Column]) -> Result<Column, EngineError> {
    text_and_number(args, |text, count| {
        let from = match whole(count) {
            0 => text.len(),
            n => text
                .char_indices()
                .rev()
                .nth(n - 1)
                .map_or(0, |(offset, _)| offset),
        };
        slice(text, from, text.len())
    })
}

/// `MID(text, start, length)`: `length` characters from the one at position `start`. Positions
/// before the first character hold no character, so they use up some of the length.
pub(super) fn eval_mid(args: &[Column]) -> Result<Column, EngineError> {
    let [
        Column::Text(texts),
        Column::Number(starts),
        Column::Number(lengths),
    ] = args
    else {
        return Err(mismatch());
    };
    let cells = texts
        .iter()
        .zip(starts)
        .zip(lengths)
        .map(|((text, &start), &length)| {
            let (start, length) = (start.trunc(), length.trunc());
            let from = offset(text, whole(start - 1.0));
            let taken = whole(length - (1.0 - start).max(0.0));
            slice(text, from, from + offset(&text[from..], taken))
        })
        .collect();
    Ok(Column::Text(cells))
}

pub(super) fn eval_len(args: &[Column]) -> Result<Column, EngineError> {
    let [Column::Text(texts)] = args else {
        return Err(mismatch());
    };
    Ok(Column::Number(
        texts
            .iter()
            .map(|text| text.chars().count() as f64)
            .collect(),
    ))
}

/// `FIND(needle, text[, start])`: the position of the first `needle` in `text` at or after the
/// position `start` (1 unless given), or 0 if there is none. Case matters.
pub(super) fn eval_find(args: &[Column]) -> Result<Column, EngineError> {
    let cells = match args {
        [Column::Text(needles), Column::Text(texts)] => needles
            .iter()
            .zip(texts)
            .map(|(needle, text)| find(needle, text, 1.0))
            .collect(),
        [
            Column::Text(needles),
            Column::Text(texts),
            Column::Number(starts),
        ] => needles
            .iter()
            .zip(texts)
            .zip(starts)
            .map(|((needle, text), &start)| find(needle, text, start))
            .collect(),
        _ => return Err(mismatch()),
    };
    Ok(Column::Number(cells))
}

fn find(needle: &str, text: &str, start: f64) -> f64 {
    let skipped = whole(start - 1.0);
    let from = if skipped == 0 {
        0
    } else {
        match text.char_indices().nth(skipped) {
            Some((offset, _)) => offset,
            None => return 0.0,
        }
    };
    text[from..].find(needle).map_or(0.0, |found| {
        (text[..from + found].chars().count() + 1) as f64
    })
}

pub(super) fn eval_upper(args: &[Column]) -> Result<Column, EngineError> {
    map_text(args, |text| Arc::from(text.to_uppercase()))
}

pub(super) fn eval_lower(args: &[Column]) -> Result<Column, EngineError> {
    map_text(args, |text| Arc::from(text.to_lowercase()))
}

pub(super) fn eval_trim(args: &[Column]) -> Result<Column, EngineError> {
    map_text(args, |text| {
        let end = text.trim_end().len();
        let start = end - text[..end].trim_start().len();
        slice(text, start, end)
    })
}

pub(super) fn eval_substitute(args: &[Column]) -> Result<Column, EngineError> {
    let [Column::Text(texts), Column::Text(olds), Column::Text(news)] = args else {
        return Err(mismatch());
    };
    let cells = texts
        .iter()
        .zip(olds)
        .zip(news)
        .map(|((text, old), new)| {
            if old.is_empty() || !text.contains(&**old) {
                Arc::clone(text)
            } else {
                Arc::from(text.replace(&**old, new))
            }
        })
        .collect();
    Ok(Column::Text(cells))
}

/// `TEXT(x)`: a number, date or list item as text, the way `&` writes it.
pub(super) fn eval_text(
    ctx: &EvalCtx,
    target: &Shape,
    args: &[TExpr],
    idx: &[usize],
) -> Result<Column, EngineError> {
    let [arg] = args else {
        return Err(mismatch());
    };
    let Some(ty) = arg.ty() else {
        return Err(mismatch());
    };
    let column = eval(ctx, target, arg, idx)?;
    ops::to_text(ctx.structure, &column, ty)
}

/// `VALUE(text)`: the number a text reads as, with spaces around it ignored, or 0.
pub(super) fn eval_value(args: &[Column]) -> Result<Column, EngineError> {
    let [Column::Text(texts)] = args else {
        return Err(mismatch());
    };
    let cells = texts
        .iter()
        .map(|text| text.trim().parse::<f64>().map_or(0.0, sanitize_number))
        .collect();
    Ok(Column::Number(cells))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn value_of_negative_zero_is_positive_zero() {
        let texts = Column::Text(vec![Arc::from("-0"), Arc::from("-0.0e3")]);
        let Ok(Column::Number(cells)) = eval_value(&[texts]) else {
            panic!("VALUE should give numbers");
        };
        assert!(
            cells
                .iter()
                .all(|cell| *cell == 0.0 && cell.is_sign_positive())
        );
    }
}
