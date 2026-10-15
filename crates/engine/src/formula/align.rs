//! Dimension alignment (spec §3.6 and §4.4): reading a source line item from a target that has
//! other dimensions.
//!
//! A [`Reader`] answers "what does the source hold for target cell `i`?" for whole batches of
//! cells. Building one does the per-axis work once: it maps every coordinate of a target axis
//! to a coordinate of the source axis it drives, rolls the source up where it is finer than the
//! target, and scatters it through mapping line items. Reading a cell is then a few integer
//! additions on tables, without allocating.

use std::sync::Arc;

use uuid::Uuid;

use crate::calendar::TimeLevel;
use crate::error::{EngineError, FormulaError};
use crate::ids::{LineItemId, ListId, TimeRangeId, VersionId};
use crate::shape::{Axis, Shape};
use crate::structure::{LineItem, Structure};
use crate::summary::{LevelSpec, Summary, aggregate, ancestors, lift};
use crate::value::{BLANK_DATE, BLANK_ITEM, BLANK_PERIOD, Column, ValueType};

use super::eval::EvalCtx;
use super::{DIMENSION, ModifierKind, SelectTarget, TModifier};

mod scatter;

/// The source index of a cell that has nothing to read, which stays that whatever is added to it.
const NONE: usize = usize::MAX;

/// Reads a source line item, aligned to the cells of a target shape.
pub(crate) struct Reader {
    data: Data,
    access: Access,
}

/// The cells a reader draws from: the source as stored, an intermediate column made by
/// scattering or rolling up, or a rolled-up column shared through the column source.
enum Data {
    Column(Arc<Column>),
    Summary(Arc<Summary>),
}

impl Data {
    fn column(&self) -> &Column {
        match self {
            Data::Column(column) => column,
            Data::Summary(summary) => &summary.1,
        }
    }
}

/// How a target cell finds its source cell.
enum Access {
    /// Source cell `i` is target cell `i`.
    Identity,
    Mapped(Mapped),
}

/// The source cell of a target cell is the sum of `base` and what each term reads off the
/// target cell's coordinates. A term that finds nothing makes the sum `NONE`.
struct Mapped {
    lens: Vec<u32>,
    strides: Vec<usize>,
    base: usize,
    terms: Vec<Term>,
    /// Whether some term reads the coordinate of the target axis.
    needed: Vec<bool>,
}

/// One source axis' contribution to a source cell index: the source position times the
/// source stride, or `NONE`.
enum Term {
    /// The source position follows the coordinate of a target axis.
    Axis { axis: usize, offsets: Vec<usize> },
    /// The source position is picked by the value of a list- or period-formatted line item
    /// at the target cell (`LOOKUP`).
    Values {
        reader: Arc<Reader>,
        offsets: Vec<usize>,
    },
    /// The source position follows the target's version, except that months before the
    /// version's switchover read the actual version: target periods below `cutoff[version]`.
    Versions {
        versions: usize,
        time: usize,
        offsets: Vec<usize>,
        actual: usize,
        cutoff: Vec<u32>,
    },
}

impl Reader {
    /// The source values for the target cells at the linear indices `idx`, in that order.
    pub(crate) fn gather(&self, idx: &[usize]) -> Column {
        let data = self.data.column();
        match &self.access {
            Access::Identity => take(data, idx),
            Access::Mapped(mapped) => take_or_blank(data, &mapped.source_cells(idx)),
        }
    }
}

impl Mapped {
    fn source_cells(&self, idx: &[usize]) -> Vec<usize> {
        let coords: Vec<Vec<u32>> = self
            .needed
            .iter()
            .enumerate()
            .map(|(axis, &needed)| {
                if needed {
                    let (stride, len) = (self.strides[axis], self.lens[axis] as usize);
                    idx.iter().map(|&i| (i / stride % len) as u32).collect()
                } else {
                    Vec::new()
                }
            })
            .collect();
        let mut cells = vec![self.base; idx.len()];
        for term in &self.terms {
            match term {
                Term::Axis { axis, offsets } => {
                    for (cell, &coord) in cells.iter_mut().zip(&coords[*axis]) {
                        *cell = cell.saturating_add(offsets[coord as usize]);
                    }
                }
                Term::Values { reader, offsets } => {
                    let (Column::Item(keys) | Column::Period(keys)) = &reader.gather(idx) else {
                        return vec![NONE; idx.len()];
                    };
                    for (cell, &key) in cells.iter_mut().zip(keys) {
                        let offset = offsets.get(key as usize).copied().unwrap_or(NONE);
                        *cell = cell.saturating_add(offset);
                    }
                }
                Term::Versions {
                    versions,
                    time,
                    offsets,
                    actual,
                    cutoff,
                } => {
                    let (versions, time) = (&coords[*versions], &coords[*time]);
                    for ((cell, &version), &period) in cells.iter_mut().zip(versions).zip(time) {
                        let before = period < cutoff[version as usize];
                        let offset = if before {
                            *actual
                        } else {
                            offsets[version as usize]
                        };
                        *cell = cell.saturating_add(offset);
                    }
                }
            }
        }
        cells
    }
}

fn take(data: &Column, idx: &[usize]) -> Column {
    fn pick<T: Clone>(cells: &[T], idx: &[usize]) -> Vec<T> {
        idx.iter().map(|&i| cells[i].clone()).collect()
    }
    match data {
        Column::Number(cells) => Column::Number(pick(cells, idx)),
        Column::Boolean(cells) => Column::Boolean(pick(cells, idx)),
        Column::Text(cells) => Column::Text(pick(cells, idx)),
        Column::Date(cells) => Column::Date(pick(cells, idx)),
        Column::Item(cells) => Column::Item(pick(cells, idx)),
        Column::Period(cells) => Column::Period(pick(cells, idx)),
    }
}

/// The cells at `sources`, where `NONE` stands for the blank of the column's type.
fn take_or_blank(data: &Column, sources: &[usize]) -> Column {
    fn pick<T: Clone>(cells: &[T], sources: &[usize], blank: T) -> Vec<T> {
        sources
            .iter()
            .map(|&source| {
                if source == NONE {
                    blank.clone()
                } else {
                    cells[source].clone()
                }
            })
            .collect()
    }
    match data {
        Column::Number(cells) => Column::Number(pick(cells, sources, 0.0)),
        Column::Boolean(cells) => Column::Boolean(pick(cells, sources, false)),
        Column::Text(cells) => Column::Text(pick(cells, sources, Arc::from(""))),
        Column::Date(cells) => Column::Date(pick(cells, sources, BLANK_DATE)),
        Column::Item(cells) => Column::Item(pick(cells, sources, BLANK_ITEM)),
        Column::Period(cells) => Column::Period(pick(cells, sources, BLANK_PERIOD)),
    }
}

/// Builds the reader of the line item `src`, with its `modifiers`, for cells of `target`.
///
/// Each axis of the source is aligned on its own (spec §3.6): a dimension of both is the same
/// item, a coarser source list is looked up through the parent mapping, a finer one is
/// aggregated with the source's summary method, a dimension of the target only is broadcast and
/// a dimension of the source only is aggregated to its top level (lists), to all periods
/// (Time) or an error (Versions, and lists without a top level). Time follows the same rules
/// by period, Versions are the same version with the switchover applied, and a subset is read
/// item by item.
pub(crate) fn build_reader(
    ctx: &EvalCtx,
    target: &Shape,
    src: LineItemId,
    modifiers: &[TModifier],
) -> Result<Reader, EngineError> {
    Builder {
        ctx,
        target,
        restriction: ctx.layout.restriction.as_deref(),
    }
    .reader(src, modifiers)
}

/// Reads sources for the cells of one target shape.
struct Builder<'a> {
    ctx: &'a EvalCtx<'a>,
    target: &'a Shape,
    /// The versions the target's Versions axis spans when it is restricted.
    restriction: Option<&'a [VersionId]>,
}

/// The source while its modifiers are applied: its cells over `shape`.
struct Work {
    shape: Shape,
    column: Arc<Column>,
    restriction: Option<Vec<VersionId>>,
    /// The cells are still those the column source holds for the line item, so it can roll
    /// them up and share the result.
    pristine: bool,
}

/// What a modifier makes of a source axis.
#[derive(Clone)]
enum Driver {
    /// The axis follows the target axis it is matched with, if any.
    Unassigned,
    /// `SELECT`: the axis is fixed to one item, version or period.
    Select(SelectTarget),
    /// `LOOKUP`: the axis is picked by the values of a line item of the given type.
    Lookup(Arc<Reader>, ValueType),
}

/// How one source axis is read.
struct AxisPlan {
    /// The axis the source is rolled up to first; the source's own when nothing is rolled up.
    to: Axis,
    /// Where each coordinate of the driver lands on `to`.
    positions: Vec<Option<u32>>,
    feed: Feed,
}

/// Where the coordinate of a source axis comes from.
enum Feed {
    /// The coordinate of a target axis.
    Axis(usize),
    /// The values of a mapping line item.
    Values(Arc<Reader>),
    /// A single fixed coordinate.
    Single,
    /// The version of the target cell, with the switchover applied on `time`.
    Versions {
        axis: usize,
        time: Option<usize>,
        actual: Option<u32>,
        cutoff: Vec<u32>,
    },
}

/// How the list of a source axis relates to the list that drives it.
#[derive(Clone, Copy, PartialEq, Eq)]
enum Relation {
    Same,
    /// The source is at a higher level of the hierarchy.
    SourceCoarser,
    /// The source is at a lower level of the hierarchy.
    SourceFiner,
    Unrelated,
}

impl Builder<'_> {
    fn reader(&self, src: LineItemId, modifiers: &[TModifier]) -> Result<Reader, EngineError> {
        let structure = self.ctx.structure;
        let line_item = structure
            .line_item(src)
            .ok_or_else(|| not_found("line item", src.0))?;
        let layout = structure.layout(line_item)?;
        let shape = structure.shape_of(&layout)?;
        let column = self.ctx.columns.column(src)?;
        if column.len() != shape.size() {
            return Err(invalid(format!(
                "The values of line item '{}' do not fit its dimensions.",
                line_item.name
            )));
        }
        let mut drivers = vec![Driver::Unassigned; shape.axes.len()];
        let mut work = Work {
            shape,
            column,
            restriction: layout.restriction,
            pristine: true,
        };
        for modifier in modifiers {
            self.modify(line_item, &mut work, &mut drivers, modifier)?;
        }
        let plans = self.plan(line_item, &work, &drivers)?;
        self.finish(line_item, work, plans)
    }

    fn modify(
        &self,
        line_item: &LineItem,
        work: &mut Work,
        drivers: &mut [Driver],
        modifier: &TModifier,
    ) -> Result<(), EngineError> {
        match modifier {
            TModifier::Select(target) => {
                let axis = self.select_axis(line_item, work, drivers, *target)?;
                drivers[axis] = Driver::Select(*target);
            }
            TModifier::Lookup(mapping) => {
                let ty = self.mapping_type(*mapping)?;
                let axis = self.lookup_axis(line_item, work, drivers, ty)?;
                let reader = self.reader(*mapping, &[])?;
                drivers[axis] = Driver::Lookup(Arc::new(reader), ty);
            }
            TModifier::Sum(mapping) => {
                self.scatter(line_item, work, drivers, ModifierKind::Sum, *mapping)?;
            }
            TModifier::Agg(kind, mapping) => {
                self.scatter(line_item, work, drivers, *kind, *mapping)?;
            }
        }
        Ok(())
    }

    /// The type of the values of a mapping line item: the list or time level it points into.
    fn mapping_type(&self, mapping: LineItemId) -> Result<ValueType, EngineError> {
        let line_item = self
            .ctx
            .structure
            .line_item(mapping)
            .ok_or_else(|| not_found("line item", mapping.0))?;
        Ok(line_item.format.value_type())
    }

    /// The unassigned axis of the source that a `SELECT` of `target` fixes.
    fn select_axis(
        &self,
        line_item: &LineItem,
        work: &Work,
        drivers: &[Driver],
        target: SelectTarget,
    ) -> Result<usize, EngineError> {
        let found = match target {
            SelectTarget::Item { list, .. } => self.list_axis(work, drivers, list)?,
            SelectTarget::Version(_) => free_axis(work, drivers, |axis| *axis == Axis::Versions),
            SelectTarget::Period { .. } => {
                free_axis(work, drivers, |axis| matches!(axis, Axis::Time { .. }))
            }
        };
        found.ok_or_else(|| {
            let what = match target {
                SelectTarget::Item { list, .. } => {
                    format!("the dimension '{}'", self.ctx.structure.list_name(list))
                }
                SelectTarget::Version(_) => "a Versions dimension".to_string(),
                SelectTarget::Period { .. } => "a Time dimension".to_string(),
            };
            dimension(format!(
                "'{}' has no {what} for SELECT to fix.",
                line_item.name
            ))
        })
    }

    /// The unassigned axis of the source that a `LOOKUP` of values of type `ty` picks.
    fn lookup_axis(
        &self,
        line_item: &LineItem,
        work: &Work,
        drivers: &[Driver],
        ty: ValueType,
    ) -> Result<usize, EngineError> {
        let found = match ty {
            ValueType::Item(list) => self.list_axis(work, drivers, list)?,
            _ => free_axis(work, drivers, |axis| matches!(axis, Axis::Time { .. })),
        };
        found.ok_or_else(|| {
            dimension(format!(
                "'{}' has no dimension that LOOKUP can pick from.",
                line_item.name
            ))
        })
    }

    /// The unassigned list or subset axis of the source whose list is `list` or, failing that,
    /// in the same hierarchy as `list`.
    fn list_axis(
        &self,
        work: &Work,
        drivers: &[Driver],
        list: ListId,
    ) -> Result<Option<usize>, EngineError> {
        let mut related = None;
        for (position, axis) in work.shape.axes.iter().enumerate() {
            let Some(base) = self.base_list(axis) else {
                continue;
            };
            if !matches!(drivers[position], Driver::Unassigned) {
                continue;
            }
            match self.relation(base, list)? {
                Relation::Same => return Ok(Some(position)),
                Relation::Unrelated => {}
                _ => related = related.or(Some(position)),
            }
        }
        Ok(related)
    }

    /// The list a list or subset axis is made of.
    fn base_list(&self, axis: &Axis) -> Option<ListId> {
        match axis {
            Axis::List(list) => Some(*list),
            Axis::Subset(subset) => self.ctx.structure.subset(*subset).map(|subset| subset.list),
            _ => None,
        }
    }

    fn relation(&self, source: ListId, driver: ListId) -> Result<Relation, EngineError> {
        let structure = self.ctx.structure;
        Ok(if source == driver {
            Relation::Same
        } else if ancestors(structure, driver)?.contains(&source) {
            Relation::SourceCoarser
        } else if ancestors(structure, source)?.contains(&driver) {
            Relation::SourceFiner
        } else {
            Relation::Unrelated
        })
    }

    /// Plans every axis of the source.
    fn plan(
        &self,
        line_item: &LineItem,
        work: &Work,
        drivers: &[Driver],
    ) -> Result<Vec<AxisPlan>, EngineError> {
        let matched = self.match_axes(&work.shape.axes, drivers)?;
        work.shape
            .axes
            .iter()
            .zip(drivers)
            .zip(matched)
            .map(|((axis, driver), target)| match axis {
                Axis::List(_) | Axis::Subset(_) => self.plan_list(axis, driver, target),
                Axis::Time { level, range } => self.plan_time((*level, *range), driver, target),
                Axis::Versions => self.plan_versions(work, driver, target),
                Axis::ListTop(_) => Err(invalid(format!(
                    "Line item '{}' cannot have a top-level axis.",
                    line_item.name
                ))),
            })
            .collect()
    }

    /// The target axis that drives each source axis without a modifier: a list axis is paired
    /// with the target axis of the same list, then with one in the same hierarchy; Time and
    /// Versions with their counterparts.
    fn match_axes(
        &self,
        axes: &[Axis],
        drivers: &[Driver],
    ) -> Result<Vec<Option<usize>>, EngineError> {
        let mut matched = vec![None; axes.len()];
        let mut taken = vec![false; self.target.axes.len()];
        let free = |position: usize| matches!(drivers[position], Driver::Unassigned);
        for (position, axis) in axes.iter().enumerate().filter(|(p, _)| free(*p)) {
            let counterpart = match axis {
                Axis::Time { .. } => self.target.time_pos(),
                Axis::Versions => self.target.axis_pos(&Axis::Versions),
                _ => continue,
            };
            matched[position] = counterpart;
            if let Some(counterpart) = counterpart {
                taken[counterpart] = true;
            }
        }
        for exact in [true, false] {
            for (position, axis) in axes.iter().enumerate() {
                let Some(source) = self.base_list(axis).filter(|_| free(position)) else {
                    continue;
                };
                if matched[position].is_some() {
                    continue;
                }
                for (candidate, wanted) in self.target.axes.iter().enumerate() {
                    let Some(list) = self.base_list(wanted).filter(|_| !taken[candidate]) else {
                        continue;
                    };
                    let relation = self.relation(source, list)?;
                    let fits = if exact {
                        relation == Relation::Same
                    } else {
                        relation != Relation::Unrelated
                    };
                    if fits {
                        matched[position] = Some(candidate);
                        taken[candidate] = true;
                        break;
                    }
                }
            }
        }
        Ok(matched)
    }

    fn plan_list(
        &self,
        axis: &Axis,
        driver: &Driver,
        matched: Option<usize>,
    ) -> Result<AxisPlan, EngineError> {
        let structure = self.ctx.structure;
        let (list, dense, feed) = match (driver, matched) {
            (Driver::Select(SelectTarget::Item { list, item }), _) => {
                let dense = structure.list(*list).and_then(|list| list.idx(*item));
                (*list, vec![dense], Feed::Single)
            }
            (Driver::Lookup(reader, ValueType::Item(list)), _) => {
                let (_, dense) = self.axis_items(&Axis::List(*list))?;
                (*list, dense, Feed::Values(Arc::clone(reader)))
            }
            (Driver::Unassigned, Some(target)) => {
                let (list, dense) = self.axis_items(&self.target.axes[target])?;
                (list, dense, Feed::Axis(target))
            }
            (Driver::Unassigned, None) => return self.top_level(axis),
            _ => return Err(mismatched_modifier()),
        };
        let (to, positions) = self.place_list(axis, list, dense)?;
        Ok(AxisPlan {
            to,
            positions,
            feed,
        })
    }

    /// A list axis that nothing drives is added up to the single top-level item.
    fn top_level(&self, axis: &Axis) -> Result<AxisPlan, EngineError> {
        let structure = self.ctx.structure;
        let list = self
            .base_list(axis)
            .ok_or_else(|| invalid("A list axis was expected."))?;
        let has_top = list_of(structure, list)?.top_level_name.is_some();
        if !has_top {
            let name = match axis {
                Axis::Subset(subset) => structure
                    .subset(*subset)
                    .map_or("?", |subset| subset.name.as_str()),
                _ => structure.list_name(list),
            };
            return Err(dimension(format!(
                "Use SUM, LOOKUP or SELECT to map dimension '{name}'."
            )));
        }
        Ok(AxisPlan {
            to: Axis::ListTop(list),
            positions: vec![Some(0)],
            feed: Feed::Single,
        })
    }

    /// The list of a list or subset axis, and the dense index of the item at each position of
    /// the axis (`None` for a deleted item).
    fn axis_items(&self, axis: &Axis) -> Result<(ListId, Vec<Option<u32>>), EngineError> {
        let structure = self.ctx.structure;
        match axis {
            Axis::List(id) => {
                let list = list_of(structure, *id)?;
                let mut dense = vec![None; list.len_dense() as usize];
                for (idx, _) in list.items() {
                    dense[idx as usize] = Some(idx);
                }
                Ok((*id, dense))
            }
            Axis::Subset(id) => {
                let subset = structure
                    .subset(*id)
                    .ok_or_else(|| not_found("subset", id.0))?;
                let list = list_of(structure, subset.list)?;
                let dense = subset.items.iter().map(|item| list.idx(*item)).collect();
                Ok((subset.list, dense))
            }
            _ => Err(invalid("A list axis was expected.")),
        }
    }

    /// Where the items of `list` at the dense indices `dense` land on a source list or subset
    /// axis, and the axis the source has to be rolled up to before they do.
    fn place_list(
        &self,
        axis: &Axis,
        list: ListId,
        dense: Vec<Option<u32>>,
    ) -> Result<(Axis, Vec<Option<u32>>), EngineError> {
        let structure = self.ctx.structure;
        let source = self
            .base_list(axis)
            .ok_or_else(|| invalid("A list axis was expected."))?;
        let dense = match self.relation(source, list)? {
            Relation::SourceFiner => return Ok((Axis::List(list), dense)),
            Relation::Unrelated => {
                return Err(dimension(format!(
                    "'{}' is not in the same hierarchy as '{}'.",
                    structure.list_name(source),
                    structure.list_name(list)
                )));
            }
            Relation::SourceCoarser => lift(structure, list, source, dense)?,
            Relation::Same => dense,
        };
        let positions = match axis {
            Axis::Subset(id) => {
                let subset = structure
                    .subset(*id)
                    .ok_or_else(|| not_found("subset", id.0))?;
                let from = list_of(structure, source)?;
                let mut member_of = vec![None; from.len_dense() as usize];
                for (position, item) in subset.items.iter().enumerate() {
                    if let Some(idx) = from.idx(*item) {
                        member_of[idx as usize] = Some(position as u32);
                    }
                }
                dense
                    .into_iter()
                    .map(|idx| idx.and_then(|idx| member_of[idx as usize]))
                    .collect()
            }
            _ => dense,
        };
        Ok((axis.clone(), positions))
    }

    fn plan_time(
        &self,
        source: (TimeLevel, Option<TimeRangeId>),
        driver: &Driver,
        matched: Option<usize>,
    ) -> Result<AxisPlan, EngineError> {
        let structure = self.ctx.structure;
        let (wanted, periods, feed) = match (driver, matched) {
            (Driver::Select(SelectTarget::Period { level, index }), _) => {
                ((*level, None), vec![*index], Feed::Single)
            }
            (Driver::Lookup(reader, ValueType::Period(level)), _) => (
                (*level, None),
                (0..structure.calendar.periods(*level)).collect(),
                Feed::Values(Arc::clone(reader)),
            ),
            (Driver::Unassigned, Some(target)) => {
                let Axis::Time { level, range } = self.target.axes[target] else {
                    return Err(mismatched_modifier());
                };
                (
                    (level, range),
                    (0..self.target.lens[target]).collect(),
                    Feed::Axis(target),
                )
            }
            (Driver::Unassigned, None) => {
                return Ok(AxisPlan {
                    to: Axis::Time {
                        level: TimeLevel::All,
                        range: source.1,
                    },
                    positions: vec![Some(0)],
                    feed: Feed::Single,
                });
            }
            _ => return Err(mismatched_modifier()),
        };
        let (to, positions) = self.place_time(source, wanted, &periods)?;
        Ok(AxisPlan {
            to,
            positions,
            feed,
        })
    }

    /// Where the periods `periods` of the time axis `driver` land on a source time axis: the
    /// source period that contains the first month of each, once the source is rolled up to the
    /// driver's level if it is finer. Periods are matched by calendar month, so axes with
    /// different time ranges line up by date.
    fn place_time(
        &self,
        source: (TimeLevel, Option<TimeRangeId>),
        driver: (TimeLevel, Option<TimeRangeId>),
        periods: &[u32],
    ) -> Result<(Axis, Vec<Option<u32>>), EngineError> {
        let structure = self.ctx.structure;
        let ((level, range), (driver_level, driver_range)) = (source, driver);
        let to_level = level.max(driver_level);
        let source_calendar = structure.time_calendar(range)?;
        let driver_calendar = structure.time_calendar(driver_range)?;
        let source_offset = month_offset(structure, range);
        let driver_offset = month_offset(structure, driver_range);
        let positions = periods
            .iter()
            .map(|&period| {
                let first = driver_calendar.months_in_period(driver_level, period).start;
                let month = driver_offset + i64::from(first) - source_offset;
                u32::try_from(month)
                    .ok()
                    .filter(|&month| month < source_calendar.months())
                    .map(|month| source_calendar.period_of_month(month, to_level))
            })
            .collect();
        Ok((
            Axis::Time {
                level: to_level,
                range,
            },
            positions,
        ))
    }

    fn plan_versions(
        &self,
        work: &Work,
        driver: &Driver,
        matched: Option<usize>,
    ) -> Result<AxisPlan, EngineError> {
        let structure = self.ctx.structure;
        let source_keys = structure.axis_keys(&Axis::Versions, work.restriction.as_deref())?;
        let position_of = |key: Option<u128>| {
            key.and_then(|key| source_keys.iter().position(|source| *source == Some(key)))
                .map(|position| position as u32)
        };
        match (driver, matched) {
            (Driver::Select(SelectTarget::Version(version)), _) => Ok(AxisPlan {
                to: Axis::Versions,
                positions: vec![position_of(Some(version.0.as_u128()))],
                feed: Feed::Single,
            }),
            (Driver::Unassigned, Some(target)) => {
                let target_keys = structure.axis_keys(&Axis::Versions, self.restriction)?;
                let (time, cutoff) = self.switchover(&target_keys)?;
                let actual = structure
                    .versions()
                    .iter()
                    .find(|version| version.is_actual)
                    .and_then(|version| position_of(Some(version.id.0.as_u128())));
                Ok(AxisPlan {
                    to: Axis::Versions,
                    positions: target_keys.iter().map(|key| position_of(*key)).collect(),
                    feed: Feed::Versions {
                        axis: target,
                        time,
                        actual,
                        cutoff,
                    },
                })
            }
            (Driver::Unassigned, None) => Err(dimension("Use SELECT to choose a version.")),
            _ => Err(mismatched_modifier()),
        }
    }

    /// The target's time axis and, for each version of its Versions axis, how many leading
    /// periods lie entirely before the version's switchover month.
    fn switchover(
        &self,
        target_keys: &[Option<u128>],
    ) -> Result<(Option<usize>, Vec<u32>), EngineError> {
        let structure = self.ctx.structure;
        let Some(time) = self.target.time_pos() else {
            return Ok((None, vec![0; target_keys.len()]));
        };
        let Axis::Time { level, range } = self.target.axes[time] else {
            return Err(mismatched_modifier());
        };
        let calendar = structure.time_calendar(range)?;
        let offset = month_offset(structure, range);
        let cutoff = target_keys
            .iter()
            .map(|key| {
                let switchover = key
                    .and_then(|key| structure.version(VersionId(Uuid::from_u128(key))))
                    .and_then(|version| version.switchover);
                switchover.map_or(0, |month| {
                    (0..calendar.periods(level))
                        .take_while(|&period| {
                            let end = calendar.months_in_period(level, period).end;
                            offset + i64::from(end) <= i64::from(month)
                        })
                        .count() as u32
                })
            })
            .collect();
        Ok((Some(time), cutoff))
    }

    /// Rolls the source up where the plans ask for it and turns the plans into a reader.
    fn finish(
        &self,
        line_item: &LineItem,
        work: Work,
        plans: Vec<AxisPlan>,
    ) -> Result<Reader, EngineError> {
        let levels: Vec<Axis> = plans.iter().map(|plan| plan.to.clone()).collect();
        let (shape, data) = if levels == work.shape.axes {
            (work.shape, Data::Column(work.column))
        } else if work.pristine {
            let rolled = self
                .ctx
                .columns
                .aggregated(line_item.id, &LevelSpec(levels))?;
            (rolled.0.clone(), Data::Summary(rolled))
        } else {
            let time_method = line_item
                .time_summary
                .as_ref()
                .unwrap_or(&line_item.summary);
            let (shape, column) = aggregate(
                self.ctx.structure,
                &work.shape,
                &work.column,
                &line_item.summary,
                time_method,
                &LevelSpec(levels),
                None,
            )?;
            (shape, Data::Column(Arc::new(column)))
        };

        let mut base = 0usize;
        let mut terms = Vec::new();
        for (position, plan) in plans.into_iter().enumerate() {
            let stride = shape.strides[position];
            let offset = |position: Option<u32>| position.map_or(NONE, |p| p as usize * stride);
            let offsets = || plan.positions.iter().map(|&p| offset(p)).collect();
            match &plan.feed {
                Feed::Single => base = base.saturating_add(offset(plan.positions[0])),
                Feed::Axis(axis) => terms.push(Term::Axis {
                    axis: *axis,
                    offsets: offsets(),
                }),
                Feed::Values(reader) => terms.push(Term::Values {
                    reader: Arc::clone(reader),
                    offsets: offsets(),
                }),
                Feed::Versions {
                    axis,
                    time,
                    actual,
                    cutoff,
                } => match time {
                    Some(time) if cutoff.iter().any(|&periods| periods > 0) => {
                        terms.push(Term::Versions {
                            versions: *axis,
                            time: *time,
                            offsets: offsets(),
                            actual: offset(*actual),
                            cutoff: cutoff.clone(),
                        });
                    }
                    _ => terms.push(Term::Axis {
                        axis: *axis,
                        offsets: offsets(),
                    }),
                },
            }
        }

        let target = self.target;
        let identity = base == 0
            && shape.lens == target.lens
            && terms.len() == shape.axes.len()
            && terms.iter().enumerate().all(|(position, term)| {
                matches!(term, Term::Axis { axis, offsets }
                    if *axis == position
                        && offsets
                            .iter()
                            .enumerate()
                            .all(|(coord, &offset)| offset == coord * shape.strides[position]))
            });
        let access = if identity {
            Access::Identity
        } else {
            let mut needed = vec![false; target.axes.len()];
            for term in &terms {
                match term {
                    Term::Axis { axis, .. } => needed[*axis] = true,
                    Term::Values { .. } => {}
                    Term::Versions { versions, time, .. } => {
                        needed[*versions] = true;
                        needed[*time] = true;
                    }
                }
            }
            Access::Mapped(Mapped {
                lens: target.lens.clone(),
                strides: target.strides.clone(),
                base,
                terms,
                needed,
            })
        };
        Ok(Reader { data, access })
    }
}

/// The first axis of the source that has no modifier yet and satisfies `wanted`.
fn free_axis(work: &Work, drivers: &[Driver], wanted: impl Fn(&Axis) -> bool) -> Option<usize> {
    work.shape
        .axes
        .iter()
        .enumerate()
        .find(|(position, axis)| matches!(drivers[*position], Driver::Unassigned) && wanted(axis))
        .map(|(position, _)| position)
}

/// Months from the start of the model calendar to the start of a time range.
fn month_offset(structure: &Structure, range: Option<TimeRangeId>) -> i64 {
    range
        .and_then(|id| structure.time_range(id))
        .map_or(0, |range| structure.calendar.range_month_offset(range))
}

fn list_of(structure: &Structure, id: ListId) -> Result<&crate::structure::List, EngineError> {
    structure.list(id).ok_or_else(|| not_found("list", id.0))
}

fn mismatched_modifier() -> EngineError {
    invalid("A modifier does not fit the dimension it was matched to.")
}

fn dimension(message: impl Into<String>) -> EngineError {
    EngineError::Formula(vec![FormulaError {
        code: DIMENSION,
        message: message.into(),
        start: 0,
        end: 0,
        suggestion: None,
    }])
}

fn invalid(message: impl Into<String>) -> EngineError {
    EngineError::Invalid {
        message: message.into(),
    }
}

fn not_found(what: &'static str, id: Uuid) -> EngineError {
    EngineError::NotFound {
        what,
        id: id.to_string(),
    }
}
