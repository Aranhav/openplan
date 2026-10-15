//! `ISBLANK`, `ISNOTBLANK`, `ISANCESTOR` and `ISFIRSTOCCURRENCE`.

use std::collections::HashSet;
use std::hash::Hash;

use crate::error::EngineError;
use crate::shape::{Axis, Shape};
use crate::value::{BLANK_DATE, BLANK_ITEM, BLANK_PERIOD, Column, ValueType};

use crate::formula::align::take;
use crate::formula::eval::{eval, eval_whole};
use crate::formula::{EvalCtx, TExpr};

use super::axis::Lines;
use super::dimension::list_axis;
use super::list::ancestor_in;
use super::{items_of, mismatch, shared};

/// Whether each cell is blank: empty text, a date, list item or period that is not set, or a
/// Boolean that is `FALSE`. A number is never blank, not even 0.
fn blanks(column: &Column) -> Vec<bool> {
    match column {
        Column::Number(cells) => vec![false; cells.len()],
        Column::Boolean(cells) => cells.iter().map(|&flag| !flag).collect(),
        Column::Text(cells) => cells.iter().map(|text| text.is_empty()).collect(),
        Column::Date(cells) => cells.iter().map(|&date| date == BLANK_DATE).collect(),
        Column::Item(cells) => cells.iter().map(|&item| item == BLANK_ITEM).collect(),
        Column::Period(cells) => cells.iter().map(|&period| period == BLANK_PERIOD).collect(),
    }
}

pub(super) fn eval_is_blank(args: &[Column]) -> Result<Column, EngineError> {
    let [column] = args else {
        return Err(mismatch());
    };
    Ok(Column::Boolean(blanks(column)))
}

pub(super) fn eval_is_not_blank(args: &[Column]) -> Result<Column, EngineError> {
    let [column] = args else {
        return Err(mismatch());
    };
    let mut flags = blanks(column);
    for flag in &mut flags {
        *flag = !*flag;
    }
    Ok(Column::Boolean(flags))
}

/// `ISANCESTOR(a, b)`: whether the item `a` is above the item `b` in the hierarchy of lists, or
/// is `b` itself. A blank item is no one's ancestor and has none.
pub(super) fn eval_is_ancestor(
    ctx: &EvalCtx,
    target: &Shape,
    args: &[TExpr],
    idx: &[usize],
) -> Result<Column, EngineError> {
    let [ancestor, descendant] = args else {
        return Err(mismatch());
    };
    let (Some(ValueType::Item(ancestors)), Some(ValueType::Item(descendants))) =
        (ancestor.ty(), descendant.ty())
    else {
        return Err(mismatch());
    };
    let above = items_of(eval(ctx, target, ancestor, idx)?)?;
    let below = items_of(eval(ctx, target, descendant, idx)?)?;
    let flags = above
        .iter()
        .zip(&below)
        .map(|(&above, &below)| {
            above != BLANK_ITEM
                && ancestor_in(ctx.structure, descendants, below, ancestors) == Some(above)
        })
        .collect();
    Ok(Column::Boolean(flags))
}

/// Checks that the line item has the list `ISFIRSTOCCURRENCE` goes through as a dimension.
pub(super) fn check_is_first_occurrence(
    ctx: &EvalCtx,
    target: &Shape,
    args: &[TExpr],
) -> Result<(), EngineError> {
    occurrence_axis(ctx, target, args).map(|_| ())
}

/// The position on `target` of the axis `ISFIRSTOCCURRENCE(x, List)` goes through. Which axes a
/// line item has depends on the structure only, so this is checked before any cell is
/// evaluated.
fn occurrence_axis(ctx: &EvalCtx, target: &Shape, args: &[TExpr]) -> Result<usize, EngineError> {
    match args {
        [_, TExpr::ListRef { list, span }] => list_axis(ctx.structure, target, *list, *span),
        _ => Err(mismatch()),
    }
}

/// `ISFIRSTOCCURRENCE(x, List)`: whether no item before this one on the `List` axis, other
/// coordinates being the same, has the same value of `x`. A blank is a value like any other, and
/// a deleted item is no occurrence.
///
/// A cell depends on the cells before it on the axis, which are not in the batch. The flags of
/// the whole target are worked out once, from `x` evaluated over all of it, and shared by the
/// chunks.
pub(super) fn eval_is_first_occurrence(
    ctx: &EvalCtx,
    target: &Shape,
    args: &[TExpr],
    idx: &[usize],
) -> Result<Column, EngineError> {
    let axis = occurrence_axis(ctx, target, args)?;
    shared(ctx, target, args, idx, || {
        let values = eval_whole(ctx, target, &args[0])?;
        let lines = Lines::new(target, axis);
        let deleted = deleted_positions(ctx, target, axis);
        let mut flags = vec![false; values.len()];
        for origin in lines.origins() {
            let cells: Vec<usize> = (0..lines.len)
                .map(|position| lines.cell(origin, position))
                .collect();
            let first = first_flags(&take(&values, &cells), &deleted);
            for (&cell, flag) in cells.iter().zip(first) {
                flags[cell] = flag;
            }
        }
        Ok(Column::Boolean(flags))
    })
}

/// Which positions of the axis are deleted items of the list.
fn deleted_positions(ctx: &EvalCtx, target: &Shape, axis: usize) -> Vec<bool> {
    let len = target.lens[axis];
    match &target.axes[axis] {
        Axis::List(list) => {
            let list = ctx.structure.list(*list);
            (0..len)
                .map(|position| list.is_some_and(|list| list.item(position).deleted))
                .collect()
        }
        _ => vec![false; len as usize],
    }
}

/// For the cells of a line along the axis, from its start, whether each is the first live one
/// with its value.
fn first_flags(values: &Column, deleted: &[bool]) -> Vec<bool> {
    match values {
        // Zero is zero whichever sign it has.
        Column::Number(cells) => first_of(cells, deleted, |&number| {
            if number == 0.0 { 0 } else { number.to_bits() }
        }),
        Column::Boolean(cells) => first_of(cells, deleted, |&flag| flag),
        Column::Text(cells) => first_of(cells, deleted, |text| &**text),
        Column::Date(cells) => first_of(cells, deleted, |&date| date),
        Column::Item(cells) | Column::Period(cells) => first_of(cells, deleted, |&cell| cell),
    }
}

fn first_of<'a, T, K: Hash + Eq>(
    cells: &'a [T],
    deleted: &[bool],
    key: impl Fn(&'a T) -> K,
) -> Vec<bool> {
    let mut seen = HashSet::new();
    cells
        .iter()
        .zip(deleted)
        .map(|(cell, &gone)| !gone && seen.insert(key(cell)))
        .collect()
}
