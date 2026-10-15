//! Moving along one axis of the target: the lines of cells that differ only in their coordinate
//! on it, and reading the cell some steps further along it. Time functions move along the Time
//! axis, version functions along Versions.

use crate::error::{EngineError, FormulaError};
use crate::shape::Shape;
use crate::value::Column;

use crate::formula::eval::{eval, ops};
use crate::formula::{DIMENSION, EvalCtx, TExpr};

/// The lines of cells along one axis of a shape.
#[derive(Clone, Copy)]
pub(super) struct Lines {
    /// How far apart neighbours on a line are, in cells.
    stride: usize,
    /// The number of cells on a line.
    pub(super) len: usize,
    count: usize,
}

impl Lines {
    pub(super) fn new(shape: &Shape, axis: usize) -> Lines {
        let len = shape.lens[axis] as usize;
        Lines {
            stride: shape.strides[axis],
            len,
            count: shape.size().checked_div(len).unwrap_or(0),
        }
    }

    /// The first cell of every line.
    pub(super) fn origins(&self) -> impl Iterator<Item = usize> + use<> {
        let (stride, len) = (self.stride, self.len);
        (0..self.count).map(move |line| line / stride * stride * len + line % stride)
    }

    /// The cell `position` steps along the line that starts at `origin`.
    pub(super) fn cell(&self, origin: usize, position: usize) -> usize {
        origin + position * self.stride
    }
}

/// The coordinate of `cell` on `axis`.
pub(super) fn position(shape: &Shape, axis: usize, cell: usize) -> usize {
    cell / shape.strides[axis] % shape.lens[axis] as usize
}

/// A problem with the dimensions of the line item a call is evaluated for. It has no position,
/// so it is located at the call.
pub(super) fn dimension_problem(message: impl Into<String>) -> EngineError {
    EngineError::Formula(vec![FormulaError {
        code: DIMENSION,
        message: message.into(),
        start: 0,
        end: 0,
        suggestion: None,
    }])
}

/// The problem of a line item that lacks a dimension its function goes along. `what` is `Time`,
/// `Versions` or `list`.
pub(super) fn needs_dimension(what: &str) -> EngineError {
    dimension_problem(format!("This function needs a {what} dimension."))
}

/// The whole steps that a column of numbers counts, towards the end of the axis for a positive
/// `sign` and towards its start for a negative one. A fraction is dropped towards zero.
pub(super) fn count_steps(counts: &Column, sign: i64) -> Result<Vec<i64>, EngineError> {
    let Column::Number(counts) = counts else {
        return Err(super::mismatch());
    };
    Ok(counts
        .iter()
        .map(|&count| (count as i64).saturating_mul(sign))
        .collect())
}

/// `x` for the cells `idx` of `target`, each read `steps` positions further along `axis`. A cell
/// whose source lies beyond the axis gets the `default` at the cell itself, or the blank of the
/// type of `x` without one.
///
/// `x` is evaluated at the cells it is read from and nowhere else, so every chunk of the target
/// evaluates its own share of the source cells and no more.
pub(super) fn read_shifted(
    ctx: &EvalCtx,
    target: &Shape,
    axis: usize,
    (x, default): (&TExpr, Option<&TExpr>),
    steps: &[i64],
    idx: &[usize],
) -> Result<Column, EngineError> {
    let (stride, len) = (target.strides[axis] as i64, i64::from(target.lens[axis]));
    let mut sources = Vec::with_capacity(idx.len());
    let mut inside = Vec::with_capacity(idx.len());
    for (&cell, &step) in idx.iter().zip(steps) {
        let at = position(target, axis, cell) as i64;
        let moved = at.saturating_add(step);
        let within = (0..len).contains(&moved);
        inside.push(within);
        // A cell with nothing to read is read as itself, and its value is not used.
        sources.push(if within {
            (cell as i64 + (moved - at) * stride) as usize
        } else {
            cell
        });
    }
    let read = eval(ctx, target, x, &sources)?;
    if inside.iter().all(|&within| within) {
        return Ok(read);
    }
    let fallback = match default {
        Some(default) => eval(ctx, target, default, idx)?,
        None => read.blank_like(idx.len()),
    };
    ops::select(&inside, read, fallback)
}
