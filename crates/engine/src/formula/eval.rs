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
use super::functions::{arg_target, check_fn, eval_fn, warm_fn};
use super::{DIMENSION, Span, TExpr, TModifier, UnOp, parse, resolve};

pub(super) mod ops;

/// Target cells evaluated together; also the unit of parallel work.
const CHUNK: usize = 4096;

/// Where the evaluator finds the values of the line items a formula reads.
pub(crate) trait ColumnSource: Sync {
    /// The values of a line item as formulas read them, laid out over its own shape: in the
    /// periods before a version's switchover, a version shows the actual version's values.
    fn column(&self, line_item: LineItemId) -> Result<Arc<Column>, EngineError>;

    /// The values of a line item rolled up to `levels` with its own summary methods, with the
    /// same switchover rule as [`ColumnSource::column`].
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
/// after chunk of the same target builds each one once. So are the columns that calls work
/// out for the whole target (see [`EvalCtx::memoized`]). Both hold the values of the line items
/// as they were when the context was made, so a context serves one evaluation and no more.
pub(crate) struct EvalCtx<'a> {
    pub structure: &'a Structure,
    pub columns: &'a dyn ColumnSource,
    pub layout: &'a Layout,
    readers: RwLock<Vec<CachedReader>>,
    memos: RwLock<Vec<Memo>>,
}

struct CachedReader {
    target: Shape,
    src: LineItemId,
    modifiers: Vec<TModifier>,
    reader: Arc<Reader>,
}

/// A column worked out once for a whole target, and the call it belongs to.
struct Memo {
    key: usize,
    target: Shape,
    column: Arc<Column>,
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
            memos: RwLock::new(Vec::new()),
        }
    }

    /// The column that `compute` works out for every cell of `target` for the call identified by
    /// `key`, worked out on first use and shared from then on.
    ///
    /// A call whose result at a cell depends on cells outside the chunk being evaluated, such as
    /// a running total or a rank, would otherwise evaluate its arguments over the whole target
    /// again for every chunk. `compute` runs without any lock held, so it may evaluate
    /// expressions that use this context in turn; [`eval_all`] runs it for every such call
    /// before the chunks start, so that they find it done.
    pub(crate) fn memoized(
        &self,
        key: usize,
        target: &Shape,
        compute: impl FnOnce() -> Result<Column, EngineError>,
    ) -> Result<Arc<Column>, EngineError> {
        let cached = |memos: &[Memo]| {
            memos
                .iter()
                .find(|memo| memo.key == key && memo.target == *target)
                .map(|memo| Arc::clone(&memo.column))
        };
        if let Some(column) = cached(&self.memos.read().unwrap_or_else(PoisonError::into_inner)) {
            return Ok(column);
        }
        let column = Arc::new(compute()?);
        let mut memos = self.memos.write().unwrap_or_else(PoisonError::into_inner);
        if let Some(raced) = cached(&memos) {
            return Ok(raced);
        }
        memos.push(Memo {
            key,
            target: target.clone(),
            column: Arc::clone(&column),
        });
        Ok(column)
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

/// Evaluates `expr` for every cell of `target`, in chunks that run in parallel. Numbers that
/// overflowed or have no value come out as 0, as does a negative zero.
pub(crate) fn eval_all(ctx: &EvalCtx, target: &Shape, expr: &TExpr) -> Result<Column, EngineError> {
    let mut problems = Vec::new();
    prepare(ctx, target, expr, &mut problems);
    if !problems.is_empty() {
        problems.sort_by_key(|problem| (problem.start, problem.end));
        return Err(EngineError::Formula(problems));
    }
    eval_whole(ctx, target, expr)
}

/// Evaluates `expr` for every cell of `target`, in chunks that run in parallel, without
/// checking it first. The result is what [`eval_all`] gives.
pub(crate) fn eval_whole(
    ctx: &EvalCtx,
    target: &Shape,
    expr: &TExpr,
) -> Result<Column, EngineError> {
    let size = target.size();
    let run = |start: usize| {
        let idx: Vec<usize> = (start..(start + CHUNK).min(size)).collect();
        let mut column = eval(ctx, target, expr, &idx)?;
        column.sanitize();
        Ok(column)
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

/// Gets everything the chunks share ready before they run: builds the readers of every line
/// item `expr` reads, checks the calls against the structure and works out what calls share
/// between chunks. Collects what is wrong with the readers that cannot be built and the calls
/// that cannot be evaluated; once something is wrong nothing more is worked out.
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
        TExpr::Call {
            func, args, span, ..
        } => {
            let inner = arg_target(*func, ctx, target);
            for arg in args {
                prepare(ctx, inner.as_ref().unwrap_or(target), arg, problems);
            }
            match check_fn(*func, ctx, target, args) {
                Err(error) => problems.extend(locate(error, *span)),
                Ok(()) if problems.is_empty() => {
                    if let Err(error) = warm_fn(*func, ctx, target, args) {
                        problems.extend(locate(error, *span));
                    }
                }
                Ok(()) => {}
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

/// The problems of a failed reader or call as formula errors that point at `span`, unless they
/// already point somewhere.
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
        TExpr::Call {
            func, args, span, ..
        } => eval_fn(*func, ctx, target, args, idx)
            .map_err(|error| EngineError::Formula(locate(error, *span))),
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

#[cfg(test)]
mod tests {
    use std::cell::Cell;

    use super::*;
    use crate::calendar::Calendar;
    use crate::shape::Axis;

    /// A context over no line items, which the memo test does not read.
    struct NoValues;

    impl ColumnSource for NoValues {
        fn column(&self, _: LineItemId) -> Result<Arc<Column>, EngineError> {
            Err(EngineError::Invalid {
                message: "no line item values".to_string(),
            })
        }

        fn aggregated(&self, _: LineItemId, _: &LevelSpec) -> Result<Arc<Summary>, EngineError> {
            Err(EngineError::Invalid {
                message: "no line item values".to_string(),
            })
        }
    }

    #[test]
    fn memoized_works_out_a_call_once_for_each_key_and_target() {
        let structure = Structure::new(Calendar {
            fiscal_year_start_month: 1,
            first_year: 2026,
            years: 1,
            current_month: None,
        });
        let layout = Layout {
            axes: Vec::new(),
            restriction: None,
        };
        let ctx = EvalCtx::new(&structure, &NoValues, &layout);
        let target = Shape::new(vec![Axis::Versions], vec![2]);
        let other = Shape::new(vec![Axis::Versions], vec![3]);
        let worked = Cell::new(0);
        let work = |len: usize| {
            worked.set(worked.get() + 1);
            Ok(Column::Number(vec![0.0; len]))
        };

        let first = ctx.memoized(1, &target, || work(2)).unwrap();
        let again = ctx.memoized(1, &target, || work(2)).unwrap();
        assert_eq!(worked.get(), 1);
        assert!(Arc::ptr_eq(&first, &again));

        ctx.memoized(1, &other, || work(3)).unwrap();
        assert_eq!(worked.get(), 2);

        ctx.memoized(2, &target, || work(2)).unwrap();
        assert_eq!(worked.get(), 3);

        ctx.memoized(1, &target, || work(2)).unwrap();
        assert_eq!(worked.get(), 3);
    }
}
