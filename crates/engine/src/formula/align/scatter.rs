//! The aggregating modifiers, `Source[SUM: Mapping]` and its kin. A mapping line item that is
//! formatted as a list or a time level says, for every cell of the source, which item or period
//! of that list or level the cell belongs to. The source's cells are combined per item or
//! period into an intermediate column, in which the mapped dimension is replaced by that list
//! or by Time, and which is then aligned to the target like any other source.

use std::sync::Arc;

use crate::error::EngineError;
use crate::formula::ModifierKind;
use crate::ids::LineItemId;
use crate::shape::{Axis, Shape};
use crate::structure::LineItem;
use crate::summary::with_actual_before_switchover;
use crate::value::{Column, ValueType};

use super::{Builder, Driver, NONE, Work, dimension, invalid, list_of, not_found};

impl Builder<'_> {
    /// Combines the cells of the source that `mapping` sends to the same item or period, as
    /// `kind` says, and makes the result the working source.
    pub(super) fn scatter(
        &self,
        line_item: &LineItem,
        work: &mut Work,
        drivers: &[Driver],
        kind: ModifierKind,
        mapping: LineItemId,
    ) -> Result<(), EngineError> {
        let structure = self.ctx.structure;
        let mapping_item = structure
            .line_item(mapping)
            .ok_or_else(|| not_found("line item", mapping.0))?;
        let ty = mapping_item.format.value_type();
        let (new_axis, new_len) = match ty {
            ValueType::Item(list) => (Axis::List(list), list_of(structure, list)?.len_dense()),
            ValueType::Period(level) => (
                Axis::Time { level, range: None },
                structure.calendar.periods(level),
            ),
            _ => {
                return Err(invalid(format!(
                    "'{}' does not map to a list or a time period.",
                    mapping_item.name
                )));
            }
        };
        let mapping_shape = structure.line_item_shape(mapping)?;
        let replaced =
            self.replaced_axis(line_item, work, drivers, mapping_item, &mapping_shape)?;
        let clashes =
            work.shape.axes.iter().enumerate().any(|(position, axis)| {
                position != replaced && self.same_dimension(axis, &new_axis)
            });
        if clashes {
            return Err(dimension(format!(
                "'{}' already has the dimension that '{}' maps to.",
                line_item.name, mapping_item.name
            )));
        }

        let keys = self.mapped_keys(work, mapping)?;
        let stride = work.shape.strides[replaced];
        let old_block = work.shape.lens[replaced] as usize * stride;
        let new_len = new_len as usize;
        let targets: Vec<usize> = keys
            .iter()
            .enumerate()
            .map(|(cell, &key)| {
                if key as usize >= new_len {
                    return NONE;
                }
                (cell / old_block) * new_len * stride + key as usize * stride + cell % stride
            })
            .collect();

        let mut axes = work.shape.axes.clone();
        axes[replaced] = new_axis;
        let mut lens = work.shape.lens.clone();
        lens[replaced] = new_len as u32;
        let shape = Shape::new(axes, lens);
        let combined = combine(kind, &work.column, &targets, shape.size())?;
        // A Time axis made by the mapping needs the switchover like any other.
        let column = with_actual_before_switchover(
            structure,
            &shape,
            work.restriction.as_deref(),
            &combined,
        )?
        .unwrap_or(combined);
        work.shape = shape;
        work.column = Arc::new(column);
        work.pristine = false;
        Ok(())
    }

    /// The axis of the source that the mapping line item maps: the only free one that the
    /// mapping line item is also dimensioned by. A time-period mapping maps the Time axis if
    /// the source has one, else a list axis.
    fn replaced_axis(
        &self,
        line_item: &LineItem,
        work: &Work,
        drivers: &[Driver],
        mapping_item: &LineItem,
        mapping_shape: &Shape,
    ) -> Result<usize, EngineError> {
        let ty = mapping_item.format.value_type();
        let has_time = work.shape.time_pos().is_some();
        let shares_list = |axis: &Axis| {
            let base = self.base_list(axis);
            mapping_shape
                .axes
                .iter()
                .any(|other| self.base_list(other) == base)
        };
        let candidates: Vec<usize> = work
            .shape
            .axes
            .iter()
            .enumerate()
            .filter(|(position, axis)| {
                if !matches!(drivers[*position], Driver::Unassigned) {
                    return false;
                }
                match (axis, ty) {
                    (Axis::Time { .. }, ValueType::Period(_)) => mapping_shape.time_pos().is_some(),
                    (Axis::List(_) | Axis::Subset(_), ValueType::Item(_)) => shares_list(axis),
                    (Axis::List(_) | Axis::Subset(_), ValueType::Period(_)) => {
                        !has_time && shares_list(axis)
                    }
                    _ => false,
                }
            })
            .map(|(position, _)| position)
            .collect();
        match candidates[..] {
            [only] => Ok(only),
            [] => Err(dimension(format!(
                "'{}' has no dimension that '{}' can map.",
                line_item.name, mapping_item.name
            ))),
            _ => Err(dimension(format!(
                "'{}' could map more than one dimension of '{}'.",
                mapping_item.name, line_item.name
            ))),
        }
    }

    /// Whether two axes would be the same dimension of a grid: lists and subsets of one list,
    /// or any two time axes.
    fn same_dimension(&self, a: &Axis, b: &Axis) -> bool {
        match (a, b) {
            (Axis::Time { .. }, Axis::Time { .. }) => true,
            _ => self.base_list(a).is_some() && self.base_list(a) == self.base_list(b),
        }
    }

    /// The item or period the mapping line item names for every cell of the working source.
    fn mapped_keys(&self, work: &Work, mapping: LineItemId) -> Result<Vec<u32>, EngineError> {
        let inner = Builder {
            ctx: self.ctx,
            target: &work.shape,
            restriction: work.restriction.as_deref(),
        };
        let reader = inner.reader(mapping, &[])?;
        let cells: Vec<usize> = (0..work.shape.size()).collect();
        match reader.gather(&cells) {
            Column::Item(keys) | Column::Period(keys) => Ok(keys),
            _ => Err(invalid("A mapping line item must hold items or periods.")),
        }
    }
}

/// The source cells that have a target, as `(source cell, target cell)` pairs in source order.
fn pairs(targets: &[usize]) -> impl Iterator<Item = (usize, usize)> + '_ {
    targets
        .iter()
        .enumerate()
        .filter(|(_, target)| **target != NONE)
        .map(|(cell, &target)| (cell, target))
}

/// Combines the cells of `column` that share a target into `size` target cells. Targets that
/// no cell reaches are blank; a blank boolean is false, so `ALL` of nothing is false too.
fn combine(
    kind: ModifierKind,
    column: &Column,
    targets: &[usize],
    size: usize,
) -> Result<Column, EngineError> {
    use ModifierKind as K;
    match (kind, column) {
        (K::Sum | K::Average | K::Min | K::Max, Column::Number(values)) => {
            Ok(Column::Number(numbers(kind, values, targets, size)))
        }
        (K::Any | K::All, Column::Boolean(values)) => {
            Ok(Column::Boolean(flags(kind, values, targets, size)))
        }
        (K::FirstNonBlank | K::LastNonBlank, _) => Ok(non_blank(kind, column, targets, size)),
        (K::TextList, Column::Text(values)) => Ok(Column::Text(text_list(values, targets, size))),
        _ => Err(invalid(format!(
            "A {kind:?} modifier cannot combine this kind of line item."
        ))),
    }
}

fn numbers(kind: ModifierKind, values: &[f64], targets: &[usize], size: usize) -> Vec<f64> {
    let mut out = vec![0.0; size];
    let mut counts = vec![0u32; size];
    for (cell, target) in pairs(targets) {
        let value = values[cell];
        match kind {
            ModifierKind::Min if counts[target] == 0 || value < out[target] => {
                out[target] = value;
            }
            ModifierKind::Max if counts[target] == 0 || value > out[target] => {
                out[target] = value;
            }
            ModifierKind::Sum | ModifierKind::Average => out[target] += value,
            _ => {}
        }
        counts[target] += 1;
    }
    if kind == ModifierKind::Average {
        for (value, &count) in out.iter_mut().zip(&counts) {
            if count > 0 {
                *value /= f64::from(count);
            }
        }
    }
    out
}

fn flags(kind: ModifierKind, values: &[bool], targets: &[usize], size: usize) -> Vec<bool> {
    let mut counts = vec![0u32; size];
    let mut trues = vec![0u32; size];
    for (cell, target) in pairs(targets) {
        counts[target] += 1;
        trues[target] += u32::from(values[cell]);
    }
    counts
        .iter()
        .zip(&trues)
        .map(|(&count, &trues)| match kind {
            ModifierKind::All => count > 0 && count == trues,
            _ => trues > 0,
        })
        .collect()
}

/// The first or last cell per target that is not blank.
fn non_blank(kind: ModifierKind, column: &Column, targets: &[usize], size: usize) -> Column {
    let mut out = column.blank_like(size);
    for (cell, target) in pairs(targets) {
        if column.is_blank_at(cell) {
            continue;
        }
        if kind == ModifierKind::LastNonBlank || out.is_blank_at(target) {
            out.set(target, column.get(cell));
        }
    }
    out
}

/// The text cells per target that are not empty, joined with commas.
fn text_list(values: &[Arc<str>], targets: &[usize], size: usize) -> Vec<Arc<str>> {
    let mut lists = vec![String::new(); size];
    for (cell, target) in pairs(targets) {
        let text = &values[cell];
        if text.is_empty() {
            continue;
        }
        if !lists[target].is_empty() {
            lists[target].push_str(", ");
        }
        lists[target].push_str(text);
    }
    lists.into_iter().map(Arc::from).collect()
}
