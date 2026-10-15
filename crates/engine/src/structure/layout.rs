use crate::command::CoordToken;
use crate::error::EngineError;
use crate::ids::{LineItemId, VersionId};
use crate::shape::{Axis, Shape};

use super::module::time_axis;
use super::{AxisSpec, LineItem, Structure, TimeScale, VersionsScope, level_name, not_found};

/// The axes of a line item's stored cells: where its module's axes put them, after the
/// line item's own overrides.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct Layout {
    pub axes: Vec<Axis>,
    /// The versions a restricted Versions axis spans; `None` spans every version.
    pub restriction: Option<Vec<VersionId>>,
}

impl Structure {
    /// The shape of the cells of a line item over its effective axes.
    pub fn line_item_shape(&self, id: LineItemId) -> Result<Shape, EngineError> {
        let line_item = self
            .line_items
            .get(&id)
            .ok_or_else(|| not_found("line item", id.0))?;
        self.shape_of(&self.layout(line_item)?)
    }

    pub(crate) fn layout(&self, line_item: &LineItem) -> Result<Layout, EngineError> {
        let module = self
            .modules
            .get(&line_item.module)
            .ok_or_else(|| not_found("module", line_item.module.0))?;
        let own_axes = line_item.applies_to.as_ref().unwrap_or(&module.axes);
        let mut axes: Vec<Axis> = own_axes
            .iter()
            .filter_map(|spec| match spec {
                AxisSpec::List { list } => Some(Axis::List(*list)),
                AxisSpec::Subset { subset } => Some(Axis::Subset(*subset)),
                AxisSpec::Time { .. } | AxisSpec::Versions => None,
            })
            .collect();
        if let Some((module_level, range)) = time_axis(&module.axes) {
            match line_item.time_scale {
                TimeScale::None => {}
                TimeScale::Module => axes.push(Axis::Time {
                    level: module_level,
                    range,
                }),
                TimeScale::Level(level) => axes.push(Axis::Time { level, range }),
            }
        }
        let mut restriction = None;
        if module.axes.contains(&AxisSpec::Versions) {
            match &line_item.versions {
                VersionsScope::None => {}
                VersionsScope::Module => axes.push(Axis::Versions),
                VersionsScope::Only(only) => {
                    axes.push(Axis::Versions);
                    restriction = Some(only.clone());
                }
            }
        }
        Ok(Layout { axes, restriction })
    }

    pub(crate) fn shape_of(&self, layout: &Layout) -> Result<Shape, EngineError> {
        let lens = layout
            .axes
            .iter()
            .map(|axis| self.axis_len(axis, layout.restriction.as_deref()))
            .collect::<Result<Vec<_>, _>>()?;
        Ok(Shape::new(layout.axes.clone(), lens))
    }

    fn axis_len(&self, axis: &Axis, restriction: Option<&[VersionId]>) -> Result<u32, EngineError> {
        Ok(match axis {
            Axis::List(id) => self.require_list(*id)?.len_dense(),
            Axis::ListTop(id) => {
                self.require_list(*id)?;
                1
            }
            Axis::Subset(id) => self.require_subset(*id)?.items.len() as u32,
            Axis::Time { level, range } => self.time_calendar(*range)?.periods(*level),
            Axis::Versions => restriction.map_or(self.versions.len(), <[VersionId]>::len) as u32,
        })
    }

    /// Identity of every position along `axis`: the uuid of the item or version there, the
    /// period index on time axes, `None` for a deleted item.
    pub(crate) fn axis_keys(
        &self,
        axis: &Axis,
        restriction: Option<&[VersionId]>,
    ) -> Result<Vec<Option<u128>>, EngineError> {
        Ok(match axis {
            Axis::List(id) => {
                let list = self.require_list(*id)?;
                (0..list.len_dense())
                    .map(|idx| {
                        let item = list.item(idx);
                        (!item.deleted).then_some(item.id.0.as_u128())
                    })
                    .collect()
            }
            Axis::ListTop(id) => {
                self.require_list(*id)?;
                vec![Some(0)]
            }
            Axis::Subset(id) => self
                .require_subset(*id)?
                .items
                .iter()
                .map(|item| Some(item.0.as_u128()))
                .collect(),
            Axis::Time { level, range } => (0..self.time_calendar(*range)?.periods(*level))
                .map(|period| Some(u128::from(period)))
                .collect(),
            Axis::Versions => match restriction {
                Some(only) => only.iter().map(|id| Some(id.0.as_u128())).collect(),
                None => self
                    .versions
                    .iter()
                    .map(|version| Some(version.id.0.as_u128()))
                    .collect(),
            },
        })
    }

    /// Position of a cell along every axis of `layout`, or a description of what is wrong
    /// with the tokens.
    pub(crate) fn resolve_cell(
        &self,
        layout: &Layout,
        tokens: &[CoordToken],
    ) -> Result<Vec<u32>, String> {
        if tokens.len() != layout.axes.len() {
            return Err(format!(
                "Expected {} coordinates but got {}.",
                layout.axes.len(),
                tokens.len()
            ));
        }
        layout
            .axes
            .iter()
            .zip(tokens)
            .map(|(axis, token)| self.resolve_token(axis, layout.restriction.as_deref(), token))
            .collect()
    }

    fn resolve_token(
        &self,
        axis: &Axis,
        restriction: Option<&[VersionId]>,
        token: &CoordToken,
    ) -> Result<u32, String> {
        match (axis, token) {
            (Axis::List(id), CoordToken::Item(item)) => {
                let list = self.require_list(*id).map_err(|error| error.to_string())?;
                list.idx(*item)
                    .ok_or_else(|| format!("{} is not an item of list '{}'.", item.0, list.name))
            }
            (Axis::Subset(id), CoordToken::Item(item)) => {
                let subset = self
                    .require_subset(*id)
                    .map_err(|error| error.to_string())?;
                subset
                    .items
                    .iter()
                    .position(|member| member == item)
                    .map(|position| position as u32)
                    .ok_or_else(|| {
                        format!("{} is not an item of subset '{}'.", item.0, subset.name)
                    })
            }
            (Axis::Time { level, range }, CoordToken::Period(label)) => {
                let calendar = self
                    .time_calendar(*range)
                    .map_err(|error| error.to_string())?;
                match calendar.parse_label(label) {
                    Some((found, period)) if found == *level => Ok(period),
                    _ => Err(format!(
                        "'{label}' is not a {} period of this time axis.",
                        level_name(*level)
                    )),
                }
            }
            (Axis::Versions, CoordToken::Item(item)) => {
                let position = match restriction {
                    Some(only) => only.iter().position(|id| id.0 == item.0),
                    None => self
                        .versions
                        .iter()
                        .position(|version| version.id.0 == item.0),
                };
                position
                    .map(|position| position as u32)
                    .ok_or_else(|| format!("{} is not a version of this line item.", item.0))
            }
            (axis, _) => Err(format!("Expected {} here.", describe(axis))),
        }
    }

    /// Whether the cell at `coords` belongs to a version and a period that lies entirely
    /// before the version's switchover month, where the version shows the actual version's
    /// values instead of its own.
    pub(crate) fn is_before_switchover(&self, layout: &Layout, coords: &[u32]) -> bool {
        let versions_pos = layout.axes.iter().position(|axis| *axis == Axis::Versions);
        let time_pos = layout
            .axes
            .iter()
            .position(|axis| matches!(axis, Axis::Time { .. }));
        let (Some(versions_pos), Some(time_pos)) = (versions_pos, time_pos) else {
            return false;
        };
        let version_idx = coords[versions_pos] as usize;
        let version_id = match &layout.restriction {
            Some(only) => only.get(version_idx).copied(),
            None => self.versions.get(version_idx).map(|version| version.id),
        };
        let Some(switchover) = version_id
            .and_then(|id| self.version(id))
            .and_then(|version| version.switchover)
        else {
            return false;
        };
        let Axis::Time { level, range } = &layout.axes[time_pos] else {
            return false;
        };
        let Ok(calendar) = self.time_calendar(*range) else {
            return false;
        };
        let offset = range
            .and_then(|id| self.time_ranges.get(&id))
            .map_or(0, |range| self.calendar.range_month_offset(range));
        let last_month =
            offset + i64::from(calendar.months_in_period(*level, coords[time_pos]).end);
        last_month <= i64::from(switchover)
    }
}

fn describe(axis: &Axis) -> &'static str {
    match axis {
        Axis::List(_) | Axis::ListTop(_) | Axis::Subset(_) => "an item id",
        Axis::Time { .. } => "a period label",
        Axis::Versions => "a version id",
    }
}
