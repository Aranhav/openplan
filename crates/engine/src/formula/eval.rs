//! The batch evaluator: runs a typed formula over many target cells at once.
//!
//! Every node of the tree is evaluated for a whole slice of target cells and yields a typed
//! column, so the work per cell is a tight loop over a vector and nothing walks the tree per
//! cell. Large targets are cut into chunks that run in parallel.
//!
//! Values that a column cannot name on its own follow the stored form of cells: an item of a
//! list is its dense index in the list, an item of the built-in list `ListId::VERSIONS` the
//! position of the version among all versions of the model, and a period its index at its
//! level on the model calendar.

use std::sync::{Arc, PoisonError, RwLock};

use rayon::prelude::*;

use crate::error::{EngineError, FormulaError};
use crate::ids::{ItemId, LineItemId, ListId, VersionId};
use crate::shape::Shape;
use crate::structure::{Layout, LineItem, Structure};
use crate::summary::{LevelSpec, Summary};
use crate::value::{BLANK_ITEM, Cell, Column, Value, ValueType};

use super::align::{Reader, build_reader};
use super::functions::eval_fn;
use super::{DIMENSION, Span, TExpr, TModifier, UnOp, parse, resolve};

mod ops;

/// Target cells evaluated together; also the unit of parallel work.
const CHUNK: usize = 4096;

/// Where the evaluator finds the values of the line items a formula reads.
pub(crate) trait ColumnSource: Sync {
    /// The current values of a line item, laid out over its own shape.
    fn column(&self, line_item: LineItemId) -> Result<Arc<Column>, EngineError>;

    /// The values of a line item rolled up to `levels` with its own summary methods.
    fn aggregated(
        &self,
        line_item: LineItemId,
        levels: &LevelSpec,
    ) -> Result<Arc<Summary>, EngineError>;
}

/// What evaluating the formula of one line item needs: the structure, the values of the
/// line items it reads, and the layout of the line item itself, which says which versions a
/// restricted Versions axis spans.
///
/// The readers built for the line items a formula reads are kept, so that evaluating chunk
/// after chunk of the same target builds each one once.
pub(crate) struct EvalCtx<'a> {
    pub structure: &'a Structure,
    pub columns: &'a dyn ColumnSource,
    pub layout: &'a Layout,
    readers: RwLock<Vec<CachedReader>>,
}

struct CachedReader {
    target: Shape,
    src: LineItemId,
    modifiers: Vec<TModifier>,
    reader: Arc<Reader>,
}

impl<'a> EvalCtx<'a> {
    pub(crate) fn new(
        structure: &'a Structure,
        columns: &'a dyn ColumnSource,
        layout: &'a Layout,
    ) -> EvalCtx<'a> {
        EvalCtx {
            structure,
            columns,
            layout,
            readers: RwLock::new(Vec::new()),
        }
    }

    /// The reader of `src` with `modifiers` for cells of `target`, built on first use.
    pub(crate) fn reader(
        &self,
        target: &Shape,
        src: LineItemId,
        modifiers: &[TModifier],
    ) -> Result<Arc<Reader>, EngineError> {
        let cached = |readers: &[CachedReader]| {
            readers
                .iter()
                .find(|cached| {
                    cached.src == src && cached.modifiers == modifiers && cached.target == *target
                })
                .map(|cached| Arc::clone(&cached.reader))
        };
        if let Some(reader) = cached(&self.readers.read().unwrap_or_else(PoisonError::into_inner)) {
            return Ok(reader);
        }
        let reader = Arc::new(build_reader(self, target, src, modifiers)?);
        let mut readers = self.readers.write().unwrap_or_else(PoisonError::into_inner);
        if let Some(raced) = cached(&readers) {
            return Ok(raced);
        }
        readers.push(CachedReader {
            target: target.clone(),
            src,
            modifiers: modifiers.to_vec(),
            reader: Arc::clone(&reader),
        });
        Ok(reader)
    }
}

/// Evaluates the formula of `line_item` for every cell of its `shape`, or says what is wrong
/// with the formula.
pub(crate) fn evaluate_formula(
    structure: &Structure,
    columns: &dyn ColumnSource,
    line_item: &LineItem,
    layout: &Layout,
    shape: &Shape,
) -> Result<Column, Vec<FormulaError>> {
    let expr = parse(line_item.formula.as_deref().unwrap_or_default())?;
    let typed = resolve(structure, line_item.id, &expr)?;
    let ctx = EvalCtx::new(structure, columns, layout);
    eval_all(&ctx, shape, &typed).map_err(|error| match error {
        EngineError::Formula(errors) => errors,
        other => vec![FormulaError {
            code: other.code(),
            message: other.to_string(),
            start: 0,
            end: 0,
            suggestion: None,
        }],
    })
}

/// Evaluates `expr` for every cell of `target`, in chunks that run in parallel.
pub(crate) fn eval_all(ctx: &EvalCtx, target: &Shape, expr: &TExpr) -> Result<Column, EngineError> {
    let mut problems = Vec::new();
    prepare(ctx, target, expr, &mut problems);
    if !problems.is_empty() {
        problems.sort_by_key(|problem| (problem.start, problem.end));
        return Err(EngineError::Formula(problems));
    }
    let size = target.size();
    let run = |start: usize| {
        let idx: Vec<usize> = (start..(start + CHUNK).min(size)).collect();
        eval(ctx, target, expr, &idx)
    };
    let starts: Vec<usize> = (0..size).step_by(CHUNK).collect();
    let chunks: Vec<Result<Column, EngineError>> = if starts.len() > 1 {
        starts.par_iter().map(|&start| run(start)).collect()
    } else {
        starts.iter().map(|&start| run(start)).collect()
    };
    let mut chunks = chunks.into_iter();
    let Some(first) = chunks.next() else {
        let ty = expr.ty().unwrap_or(ValueType::Number);
        return Ok(Column::new_blank(&ty, 0));
    };
    let mut column = first?;
    for chunk in chunks {
        ops::append(&mut column, chunk?)?;
    }
    Ok(column)
}

/// Builds the readers of every line item `expr` reads, before the chunks that share them run,
/// and collects what is wrong with the ones that cannot be built.
fn prepare(ctx: &EvalCtx, target: &Shape, expr: &TExpr, problems: &mut Vec<FormulaError>) {
    match expr {
        TExpr::LineItem {
            id,
            modifiers,
            span,
            ..
        } => {
            if let Err(error) = ctx.reader(target, *id, modifiers) {
                problems.extend(locate(error, *span));
            }
        }
        TExpr::Unary { expr, .. } => prepare(ctx, target, expr, problems),
        TExpr::Binary { lhs, rhs, .. } => {
            prepare(ctx, target, lhs, problems);
            prepare(ctx, target, rhs, problems);
        }
        TExpr::If {
            cond, then, els, ..
        } => {
            for part in [cond, then, els] {
                prepare(ctx, target, part, problems);
            }
        }
        TExpr::Call { args, .. } => {
            for arg in args {
                prepare(ctx, target, arg, problems);
            }
        }
        TExpr::Const { .. }
        | TExpr::ListItemConst { .. }
        | TExpr::VersionConst { .. }
        | TExpr::PeriodConst { .. }
        | TExpr::ListRef { .. }
        | TExpr::TimeRef { .. }
        | TExpr::Word { .. } => {}
    }
}

/// The problems of a failed reader as formula errors that point at `span`.
fn locate(error: EngineError, span: Span) -> Vec<FormulaError> {
    match error {
        EngineError::Formula(errors) => errors
            .into_iter()
            .map(|mut error| {
                if (error.start, error.end) == (0, 0) {
                    error.start = span.start;
                    error.end = span.end;
                }
                error
            })
            .collect(),
        other => vec![FormulaError {
            code: DIMENSION,
            message: other.to_string(),
            start: span.start,
            end: span.end,
            suggestion: None,
        }],
    }
}

/// Evaluates `expr` for the target cells at the linear indices `idx` and returns one value
/// per index, in that order.
pub(crate) fn eval(
    ctx: &EvalCtx,
    target: &Shape,
    expr: &TExpr,
    idx: &[usize],
) -> Result<Column, EngineError> {
    let len = idx.len();
    match expr {
        TExpr::Const { value, ty, .. } => constant(ctx.structure, value, ty, len),
        TExpr::LineItem {
            id,
            modifiers,
            span,
            ..
        } => {
            let reader = ctx
                .reader(target, *id, modifiers)
                .map_err(|error| EngineError::Formula(locate(error, *span)))?;
            Ok(reader.gather(idx))
        }
        TExpr::ListItemConst { list, item, .. } => {
            Ok(Column::Item(vec![
                item_index(ctx.structure, *list, *item);
                len
            ]))
        }
        TExpr::VersionConst { version, .. } => {
            Ok(Column::Item(vec![
                version_index(ctx.structure, *version);
                len
            ]))
        }
        TExpr::PeriodConst { index, .. } => Ok(Column::Period(vec![*index; len])),
        TExpr::ListRef { .. } | TExpr::TimeRef { .. } | TExpr::Word { .. } => {
            Err(EngineError::Invalid {
                message: "A list, Time or keyword is not a value.".to_string(),
            })
        }
        TExpr::Unary { op, expr, .. } => {
            let operand = eval(ctx, target, expr, idx)?;
            match op {
                UnOp::Neg => ops::negate(operand),
                UnOp::Not => ops::not(operand),
            }
        }
        TExpr::Binary { op, lhs, rhs, .. } => {
            let left = eval(ctx, target, lhs, idx)?;
            let right = eval(ctx, target, rhs, idx)?;
            ops::binary(
                ctx.structure,
                *op,
                (left, lhs.ty().unwrap_or(ValueType::Number)),
                (right, rhs.ty().unwrap_or(ValueType::Number)),
            )
        }
        TExpr::If {
            cond, then, els, ..
        } => {
            let Column::Boolean(mask) = eval(ctx, target, cond, idx)? else {
                return Err(EngineError::Invalid {
                    message: "An IF condition must be a Boolean.".to_string(),
                });
            };
            if mask.iter().all(|&flag| flag) {
                return eval(ctx, target, then, idx);
            }
            if !mask.iter().any(|&flag| flag) {
                return eval(ctx, target, els, idx);
            }
            let chosen = eval(ctx, target, then, idx)?;
            let otherwise = eval(ctx, target, els, idx)?;
            ops::select(&mask, chosen, otherwise)
        }
        TExpr::Call { func, args, .. } => eval_fn(*func, ctx, target, args, idx),
    }
}

/// A constant of type `ty`, repeated `len` times.
fn constant(
    structure: &Structure,
    value: &Value,
    ty: &ValueType,
    len: usize,
) -> Result<Column, EngineError> {
    let cell = crate::model::encode(structure, ty, value)
        .map_err(|message| EngineError::Invalid { message })?;
    Ok(match cell {
        Cell::Number(value) => Column::Number(vec![value; len]),
        Cell::Boolean(value) => Column::Boolean(vec![value; len]),
        Cell::Text(value) => Column::Text(vec![value; len]),
        Cell::Date(value) => Column::Date(vec![value; len]),
        Cell::Item(value) => Column::Item(vec![value; len]),
        Cell::Period(value) => Column::Period(vec![value; len]),
    })
}

/// The dense index of an item of a list; blank if the item is gone.
fn item_index(structure: &Structure, list: ListId, item: ItemId) -> u32 {
    structure
        .list(list)
        .and_then(|list| list.idx(item))
        .unwrap_or(BLANK_ITEM)
}

/// The position of a version among all versions of the model; blank if the version is gone.
fn version_index(structure: &Structure, version: VersionId) -> u32 {
    structure
        .versions()
        .iter()
        .position(|candidate| candidate.id == version)
        .map_or(BLANK_ITEM, |position| position as u32)
}
