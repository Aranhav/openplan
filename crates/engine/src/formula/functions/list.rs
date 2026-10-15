//! `PARENT`, `NAME`, `CODE` and `FINDITEM`. (`ITEM` is in `dimension`.)

use std::sync::Arc;

use crate::error::EngineError;
use crate::ids::ListId;
use crate::shape::Shape;
use crate::structure::{List, Lookup, Structure};
use crate::value::{BLANK_ITEM, Column, ValueType};

use crate::formula::eval::{eval, eval_whole, ops};
use crate::formula::{EvalCtx, TExpr};

use super::{items_of, mismatch, shared};

/// The parent of the item at dense index `item` of `list`: the list above and the item's dense
/// index in it. There is none for a blank or deleted item.
fn parent_item<'a>(structure: &'a Structure, list: &List, item: u32) -> Option<(&'a List, u32)> {
    if item >= list.len_dense() {
        return None;
    }
    let source = list.item(item);
    if source.deleted {
        return None;
    }
    let parents = structure.list(list.parent?)?;
    Some((parents, parents.idx(source.parent?)?))
}

/// The dense index in the list `to`, which is `from` or a list above it, of the item `item` of
/// `from` or of its ancestor there.
pub(super) fn ancestor_in(
    structure: &Structure,
    from: ListId,
    item: u32,
    to: ListId,
) -> Option<u32> {
    if from == to {
        return Some(item);
    }
    let mut at = (structure.list(from)?, item);
    while at.0.id != to {
        at = parent_item(structure, at.0, at.1)?;
    }
    Some(at.1)
}

/// The list that the item given to `PARENT`, `NAME` or `CODE` belongs to.
fn item_list(args: &[TExpr]) -> Result<ListId, EngineError> {
    match args {
        [arg] => match arg.ty() {
            Some(ValueType::Item(list)) => Ok(list),
            _ => Err(mismatch()),
        },
        _ => Err(mismatch()),
    }
}

/// `PARENT(item)`: the item of the list above in the hierarchy that the item belongs to, or
/// blank for a blank item.
pub(super) fn eval_parent(
    ctx: &EvalCtx,
    target: &Shape,
    args: &[TExpr],
    idx: &[usize],
) -> Result<Column, EngineError> {
    let list = item_list(args)?;
    let structure = ctx.structure;
    let source = structure.list(list).ok_or_else(mismatch)?;
    let items = items_of(eval(ctx, target, &args[0], idx)?)?;
    Ok(Column::Item(
        items
            .iter()
            .map(|&item| {
                parent_item(structure, source, item).map_or(BLANK_ITEM, |(_, parent)| parent)
            })
            .collect(),
    ))
}

/// `NAME(item)`: the name of a list item or version; empty for a blank item.
pub(super) fn eval_name(
    ctx: &EvalCtx,
    target: &Shape,
    args: &[TExpr],
    idx: &[usize],
) -> Result<Column, EngineError> {
    let list = item_list(args)?;
    let items = eval(ctx, target, &args[0], idx)?;
    ops::to_text(ctx.structure, &items, ValueType::Item(list))
}

/// `CODE(item)`: the code of a list item; empty for a blank item, an item without a code and a
/// version.
pub(super) fn eval_code(
    ctx: &EvalCtx,
    target: &Shape,
    args: &[TExpr],
    idx: &[usize],
) -> Result<Column, EngineError> {
    let list = item_list(args)?;
    let items = items_of(eval(ctx, target, &args[0], idx)?)?;
    let source = ctx.structure.list(list);
    let empty: Arc<str> = Arc::from("");
    let codes = items
        .iter()
        .map(|&item| {
            source
                .filter(|source| item < source.len_dense())
                .map(|source| source.item(item))
                .filter(|item| !item.deleted)
                .and_then(|item| item.code.as_deref())
                .map_or_else(|| Arc::clone(&empty), Arc::from)
        })
        .collect();
    Ok(Column::Text(codes))
}

/// `FINDITEM(List, text)`: the item of the list with the name `text`, else the one with the
/// code `text`; blank if there is none. The lookups of the whole target share one index of the
/// list, which is built once rather than for every chunk.
pub(super) fn eval_find_item(
    ctx: &EvalCtx,
    target: &Shape,
    args: &[TExpr],
    idx: &[usize],
) -> Result<Column, EngineError> {
    let [TExpr::ListRef { list, .. }, key] = args else {
        return Err(mismatch());
    };
    let list = ctx.structure.list(*list).ok_or_else(mismatch)?;
    shared(ctx, target, args, idx, || {
        let Column::Text(keys) = eval_whole(ctx, target, key)? else {
            return Err(mismatch());
        };
        let lookup = Lookup::new(list);
        Ok(Column::Item(
            keys.iter()
                .map(|text| lookup.find(text).unwrap_or(BLANK_ITEM))
                .collect(),
        ))
    })
}
