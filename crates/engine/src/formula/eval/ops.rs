//! The operators of the formula language over columns: loops over whole vectors, one per
//! operator, with the language's rules for blanks and division by zero. A result that
//! overflowed or has no value is 0 at once, so it never reaches a comparison or a text.

use std::fmt::Write;
use std::sync::Arc;

use chrono::NaiveDate;

use crate::error::EngineError;
use crate::formula::BinOp;
use crate::ids::ListId;
use crate::model::EPOCH_DAYS_FROM_CE;
use crate::structure::Structure;
use crate::value::{BLANK_DATE, Column, ValueType, sanitize_number};

fn mismatch() -> EngineError {
    EngineError::Invalid {
        message: "The operands of an operator do not have matching types.".to_string(),
    }
}

pub(super) fn negate(operand: Column) -> Result<Column, EngineError> {
    let Column::Number(mut numbers) = operand else {
        return Err(mismatch());
    };
    for number in &mut numbers {
        *number = sanitize_number(-*number);
    }
    Ok(Column::Number(numbers))
}

pub(super) fn not(operand: Column) -> Result<Column, EngineError> {
    let Column::Boolean(mut flags) = operand else {
        return Err(mismatch());
    };
    for flag in &mut flags {
        *flag = !*flag;
    }
    Ok(Column::Boolean(flags))
}

/// Applies the infix operator `op`. Each operand comes with its type, which tells apart
/// the columns that hold list items of different lists when they become text.
pub(super) fn binary(
    structure: &Structure,
    op: BinOp,
    left: (Column, ValueType),
    right: (Column, ValueType),
) -> Result<Column, EngineError> {
    match op {
        BinOp::Add | BinOp::Sub | BinOp::Mul | BinOp::Div => arithmetic(op, left.0, right.0),
        BinOp::And | BinOp::Or => logic(op, left.0, right.0),
        BinOp::Concat => concat(structure, &left, &right),
        BinOp::Eq | BinOp::Ne | BinOp::Lt | BinOp::Le | BinOp::Gt | BinOp::Ge => {
            compare(op, &left.0, &right.0)
        }
    }
}

fn arithmetic(op: BinOp, left: Column, right: Column) -> Result<Column, EngineError> {
    let (Column::Number(mut left), Column::Number(right)) = (left, right) else {
        return Err(mismatch());
    };
    fn apply(left: &mut [f64], right: &[f64], f: impl Fn(f64, f64) -> f64) {
        for (left, &right) in left.iter_mut().zip(right) {
            *left = f(*left, right);
        }
    }
    match op {
        BinOp::Add => apply(&mut left, &right, |a, b| sanitize_number(a + b)),
        BinOp::Sub => apply(&mut left, &right, |a, b| sanitize_number(a - b)),
        BinOp::Mul => apply(&mut left, &right, |a, b| sanitize_number(a * b)),
        BinOp::Div => apply(&mut left, &right, |a, b| {
            if b == 0.0 {
                0.0
            } else {
                sanitize_number(a / b)
            }
        }),
        _ => return Err(mismatch()),
    }
    Ok(Column::Number(left))
}

fn logic(op: BinOp, left: Column, right: Column) -> Result<Column, EngineError> {
    let (Column::Boolean(mut left), Column::Boolean(right)) = (left, right) else {
        return Err(mismatch());
    };
    for (left, &right) in left.iter_mut().zip(&right) {
        *left = if op == BinOp::And {
            *left && right
        } else {
            *left || right
        };
    }
    Ok(Column::Boolean(left))
}

fn compare(op: BinOp, left: &Column, right: &Column) -> Result<Column, EngineError> {
    let flags = match (left, right) {
        (Column::Number(a), Column::Number(b)) => relate(op, a, b),
        (Column::Boolean(a), Column::Boolean(b)) => relate(op, a, b),
        (Column::Text(a), Column::Text(b)) => relate(op, a, b),
        (Column::Date(a), Column::Date(b)) => relate(op, a, b),
        (Column::Item(a), Column::Item(b)) | (Column::Period(a), Column::Period(b)) => {
            relate(op, a, b)
        }
        _ => None,
    };
    flags.map(Column::Boolean).ok_or_else(mismatch)
}

/// `None` unless `op` is a comparison.
fn relate<T: PartialOrd>(op: BinOp, left: &[T], right: &[T]) -> Option<Vec<bool>> {
    let pairs = left.iter().zip(right);
    Some(match op {
        BinOp::Eq => pairs.map(|(a, b)| a == b).collect(),
        BinOp::Ne => pairs.map(|(a, b)| a != b).collect(),
        BinOp::Lt => pairs.map(|(a, b)| a < b).collect(),
        BinOp::Le => pairs.map(|(a, b)| a <= b).collect(),
        BinOp::Gt => pairs.map(|(a, b)| a > b).collect(),
        BinOp::Ge => pairs.map(|(a, b)| a >= b).collect(),
        _ => return None,
    })
}

/// An operand of `&` or `TEXT`, read cell by cell as text.
enum Part<'a> {
    Text(&'a [Arc<str>]),
    Number(&'a [f64]),
    Date(&'a [i32]),
    Item(&'a [u32], ListId),
}

impl<'a> Part<'a> {
    fn of(column: &'a Column, ty: ValueType) -> Result<Part<'a>, EngineError> {
        match (column, ty) {
            (Column::Text(cells), _) => Ok(Part::Text(cells)),
            (Column::Number(cells), _) => Ok(Part::Number(cells)),
            (Column::Date(cells), _) => Ok(Part::Date(cells)),
            (Column::Item(cells), ValueType::Item(list)) => Ok(Part::Item(cells, list)),
            _ => Err(mismatch()),
        }
    }

    fn len(&self) -> usize {
        match self {
            Part::Text(cells) => cells.len(),
            Part::Number(cells) => cells.len(),
            Part::Date(cells) => cells.len(),
            Part::Item(cells, _) => cells.len(),
        }
    }

    /// Writes cell `i` as text: numbers as the shortest text that reads back as the same
    /// number, dates as `YYYY-MM-DD`, items by name; a blank date or item as nothing.
    fn write(&self, structure: &Structure, i: usize, out: &mut String) {
        match self {
            Part::Text(cells) => out.push_str(&cells[i]),
            Part::Number(cells) => {
                let number = if cells[i] == 0.0 { 0.0 } else { cells[i] };
                let _ = write!(out, "{number}");
            }
            Part::Date(cells) => {
                if cells[i] != BLANK_DATE
                    && let Some(date) =
                        NaiveDate::from_num_days_from_ce_opt(cells[i] + EPOCH_DAYS_FROM_CE)
                {
                    let _ = write!(out, "{date}");
                }
            }
            Part::Item(cells, list) => out.push_str(item_name(structure, *list, cells[i])),
        }
    }
}

/// The name of the item at a dense index of a list, or of the version at a position; empty for
/// a blank or deleted one.
fn item_name(structure: &Structure, list: ListId, idx: u32) -> &str {
    if list == ListId::VERSIONS {
        return structure
            .versions()
            .get(idx as usize)
            .map_or("", |version| version.name.as_str());
    }
    match structure.list(list) {
        Some(list) if idx < list.len_dense() && !list.item(idx).deleted => {
            list.item(idx).name.as_str()
        }
        _ => "",
    }
}

fn concat(
    structure: &Structure,
    left: &(Column, ValueType),
    right: &(Column, ValueType),
) -> Result<Column, EngineError> {
    let left = Part::of(&left.0, left.1)?;
    let right = Part::of(&right.0, right.1)?;
    Ok(text_cells(left.len(), |i, out| {
        left.write(structure, i, out);
        right.write(structure, i, out);
    }))
}

/// A column of `column` as text, the way `&` writes its operands: numbers as the shortest text
/// that reads back as the same number, dates as `YYYY-MM-DD`, items by name; a blank date or
/// item as nothing. `ty` tells apart the columns that hold items of different lists.
pub(crate) fn to_text(
    structure: &Structure,
    column: &Column,
    ty: ValueType,
) -> Result<Column, EngineError> {
    let part = Part::of(column, ty)?;
    Ok(text_cells(part.len(), |i, out| {
        part.write(structure, i, out);
    }))
}

/// A column of `len` texts, the `i`th of which `write` writes into the empty buffer it is given.
fn text_cells(len: usize, mut write: impl FnMut(usize, &mut String)) -> Column {
    let mut buffer = String::new();
    Column::Text(
        (0..len)
            .map(|i| {
                buffer.clear();
                write(i, &mut buffer);
                Arc::from(buffer.as_str())
            })
            .collect(),
    )
}

/// The cells of `then` where `mask` is true and those of `els` elsewhere.
pub(crate) fn select(mask: &[bool], then: Column, els: Column) -> Result<Column, EngineError> {
    fn pick<T: Clone>(mut then: Vec<T>, els: &[T], mask: &[bool]) -> Vec<T> {
        for ((chosen, other), &flag) in then.iter_mut().zip(els).zip(mask) {
            if !flag {
                *chosen = other.clone();
            }
        }
        then
    }
    Ok(match (then, els) {
        (Column::Number(a), Column::Number(b)) => Column::Number(pick(a, &b, mask)),
        (Column::Boolean(a), Column::Boolean(b)) => Column::Boolean(pick(a, &b, mask)),
        (Column::Text(a), Column::Text(b)) => Column::Text(pick(a, &b, mask)),
        (Column::Date(a), Column::Date(b)) => Column::Date(pick(a, &b, mask)),
        (Column::Item(a), Column::Item(b)) => Column::Item(pick(a, &b, mask)),
        (Column::Period(a), Column::Period(b)) => Column::Period(pick(a, &b, mask)),
        _ => return Err(mismatch()),
    })
}

/// Appends the cells of `tail` to `column`, which holds cells of the same kind.
pub(super) fn append(column: &mut Column, tail: Column) -> Result<(), EngineError> {
    match (column, tail) {
        (Column::Number(a), Column::Number(b)) => a.extend(b),
        (Column::Boolean(a), Column::Boolean(b)) => a.extend(b),
        (Column::Text(a), Column::Text(b)) => a.extend(b),
        (Column::Date(a), Column::Date(b)) => a.extend(b),
        (Column::Item(a), Column::Item(b)) => a.extend(b),
        (Column::Period(a), Column::Period(b)) => a.extend(b),
        _ => return Err(mismatch()),
    }
    Ok(())
}
