use std::collections::HashSet;

use serde::{Deserialize, Serialize};

use crate::calendar::TimeLevel;
use crate::command::{CoordToken, LineItemPatch};
use crate::error::EngineError;
use crate::ids::{LineItemId, ListId, ModuleId, SubsetId, TimeRangeId, VersionId};
use crate::shape::{Axis, Shape};
use crate::value::Format;

use super::{
    Structure, already_exists, check_name, clean_name, ensure_unique, in_use, invalid, level_name,
    not_found,
};

const SYSTEM_AREA: &str = "System";

/// A grid of line items over shared dimensions.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Module {
    pub id: ModuleId,
    pub name: String,
    pub axes: Vec<AxisSpec>,
    /// Folder label used for navigation.
    pub functional_area: String,
}

/// A dimension of a module.
///
/// Whatever their order in a module's axes, cells are laid out with the list and subset axes
/// first, then Time, then Versions.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum AxisSpec {
    List {
        list: ListId,
    },
    Subset {
        subset: SubsetId,
    },
    Time {
        level: TimeLevel,
        range: Option<TimeRangeId>,
    },
    Versions,
}

/// A row of a module. Without a formula it is an input line item that stores typed cells;
/// with one it is calculated.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct LineItem {
    pub id: LineItemId,
    pub module: ModuleId,
    pub name: String,
    pub ordinal: i32,
    pub format: Format,
    pub formula: Option<String>,
    pub summary: SummaryMethod,
    pub time_summary: Option<SummaryMethod>,
    /// Replaces the module's list and subset axes for this line item.
    pub applies_to: Option<Vec<AxisSpec>>,
    pub time_scale: TimeScale,
    pub versions: VersionsScope,
    pub notes: String,
    pub code: Option<String>,
    pub read_access_driver: Option<LineItemId>,
    pub write_access_driver: Option<LineItemId>,
}

/// How cells roll up along a hierarchy or through time.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "method", rename_all = "snake_case")]
pub enum SummaryMethod {
    Sum,
    Average,
    Min,
    Max,
    None,
    Formula,
    Ratio {
        numerator: LineItemId,
        denominator: LineItemId,
    },
    First,
    Last,
    Opening,
    Closing,
    Any,
    All,
}

/// The time axis of a line item relative to its module's.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TimeScale {
    Module,
    None,
    Level(TimeLevel),
}

/// The versions axis of a line item relative to its module's.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum VersionsScope {
    Module,
    None,
    /// Only these versions, in this order.
    Only(Vec<VersionId>),
}

impl ModuleId {
    /// The id of the system module holding the properties of `list`.
    ///
    /// The module does not exist until the first property is created in it, by a
    /// `CreateLineItem` whose module is this id.
    pub fn for_list_properties(list: ListId) -> ModuleId {
        ModuleId(list.0)
    }
}

pub(super) fn properties_name(list_name: &str) -> String {
    format!("{list_name} Properties")
}

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

    /// The system module holding the properties of a list, once it has any.
    pub fn properties_module(&self, list: ListId) -> Option<&Module> {
        self.modules.get(&ModuleId::for_list_properties(list))
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
        let module_time = module.axes.iter().find_map(|spec| match spec {
            AxisSpec::Time { level, range } => Some((*level, *range)),
            _ => None,
        });
        if let Some((module_level, range)) = module_time {
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

    pub(super) fn create_module(
        &mut self,
        id: ModuleId,
        name: String,
        axes: Vec<AxisSpec>,
        functional_area: String,
    ) -> Result<(), EngineError> {
        if self.modules.contains_key(&id) {
            return Err(already_exists("module", id.0));
        }
        let name = check_name(
            "module",
            &name,
            self.modules.values().map(|module| module.name.as_str()),
        )?;
        self.check_axes(&axes, true)?;
        let functional_area = clean_area(&functional_area)?;
        self.modules.insert(
            id,
            Module {
                id,
                name,
                axes,
                functional_area,
            },
        );
        Ok(())
    }

    pub(super) fn update_module(
        &mut self,
        id: ModuleId,
        name: Option<String>,
        axes: Option<Vec<AxisSpec>>,
        functional_area: Option<String>,
    ) -> Result<(), EngineError> {
        let module = self
            .modules
            .get(&id)
            .ok_or_else(|| not_found("module", id.0))?;
        if self.lists.contains_key(&ListId(id.0))
            && (name
                .as_deref()
                .is_some_and(|name| name.trim() != module.name)
                || axes.as_ref().is_some_and(|axes| *axes != module.axes))
        {
            return Err(invalid(
                "The name and dimensions of a list's properties module follow the list.",
            ));
        }
        let name = name
            .map(|name| {
                check_name(
                    "module",
                    &name,
                    self.modules
                        .values()
                        .filter(|other| other.id != id)
                        .map(|other| other.name.as_str()),
                )
            })
            .transpose()?;
        if let Some(axes) = &axes {
            self.check_axes(axes, true)?;
        }
        let functional_area = functional_area.map(|area| clean_area(&area)).transpose()?;

        let module = self
            .modules
            .get_mut(&id)
            .ok_or_else(|| not_found("module", id.0))?;
        if let Some(name) = name {
            module.name = name;
        }
        if let Some(axes) = axes {
            module.axes = axes;
        }
        if let Some(area) = functional_area {
            module.functional_area = area;
        }
        Ok(())
    }

    pub(super) fn delete_module(&mut self, id: ModuleId) -> Result<(), EngineError> {
        let module = self
            .modules
            .get(&id)
            .ok_or_else(|| not_found("module", id.0))?;
        self.ensure_line_items_free("Module", &module.name, &self.line_item_ids_of(id))?;
        self.drop_module(id);
        Ok(())
    }

    pub(super) fn create_line_item(&mut self, mut line_item: LineItem) -> Result<(), EngineError> {
        if self.line_items.contains_key(&line_item.id) {
            return Err(already_exists("line item", line_item.id.0));
        }
        let system_module = if self.modules.contains_key(&line_item.module) {
            None
        } else {
            Some(self.new_properties_module(line_item.module)?)
        };
        line_item.name = self.check_line_item(&line_item)?;
        if let Some(module) = system_module {
            self.modules.insert(module.id, module);
        }
        self.line_items.insert(line_item.id, line_item);
        Ok(())
    }

    pub(super) fn update_line_item(
        &mut self,
        id: LineItemId,
        patch: LineItemPatch,
    ) -> Result<(), EngineError> {
        let mut line_item = self
            .line_items
            .get(&id)
            .ok_or_else(|| not_found("line item", id.0))?
            .clone();
        let LineItemPatch {
            name,
            ordinal,
            format,
            formula,
            summary,
            time_summary,
            applies_to,
            time_scale,
            versions,
            notes,
            code,
            read_access_driver,
            write_access_driver,
        } = patch;
        if let Some(name) = name {
            line_item.name = name;
        }
        if let Some(ordinal) = ordinal {
            line_item.ordinal = ordinal;
        }
        if let Some(format) = format {
            line_item.format = format;
        }
        if let Some(formula) = formula {
            line_item.formula = formula;
        }
        if let Some(summary) = summary {
            line_item.summary = summary;
        }
        if let Some(time_summary) = time_summary {
            line_item.time_summary = time_summary;
        }
        if let Some(applies_to) = applies_to {
            line_item.applies_to = applies_to;
        }
        if let Some(time_scale) = time_scale {
            line_item.time_scale = time_scale;
        }
        if let Some(versions) = versions {
            line_item.versions = versions;
        }
        if let Some(notes) = notes {
            line_item.notes = notes;
        }
        if let Some(code) = code {
            line_item.code = code;
        }
        if let Some(driver) = read_access_driver {
            line_item.read_access_driver = driver;
        }
        if let Some(driver) = write_access_driver {
            line_item.write_access_driver = driver;
        }
        line_item.name = self.check_line_item(&line_item)?;
        self.line_items.insert(id, line_item);
        Ok(())
    }

    pub(super) fn delete_line_item(&mut self, id: LineItemId) -> Result<(), EngineError> {
        let line_item = self
            .line_items
            .get(&id)
            .ok_or_else(|| not_found("line item", id.0))?;
        self.ensure_line_items_free(
            "Line item",
            &self.qualified_name(line_item),
            &HashSet::from([id]),
        )?;
        self.line_items.remove(&id);
        Ok(())
    }

    /// Removes a module and its line items.
    pub(super) fn drop_module(&mut self, id: ModuleId) {
        self.line_items
            .retain(|_, line_item| line_item.module != id);
        self.modules.remove(&id);
    }

    pub(super) fn line_item_ids_of(&self, module: ModuleId) -> HashSet<LineItemId> {
        self.line_items_in(module).map(|li| li.id).collect()
    }

    /// Fails with `InUse` when a line item outside `doomed` refers to one inside it as a
    /// ratio part or an access driver. `what` and `name` describe what is being deleted.
    pub(super) fn ensure_line_items_free(
        &self,
        what: &str,
        name: &str,
        doomed: &HashSet<LineItemId>,
    ) -> Result<(), EngineError> {
        let users = self
            .line_items
            .values()
            .filter(|li| !doomed.contains(&li.id))
            .filter(|li| references(li).any(|target| doomed.contains(&target)))
            .map(|li| format!("line item '{}'", self.qualified_name(li)))
            .collect();
        in_use(what, name, users)
    }

    fn require_list(&self, id: ListId) -> Result<&super::List, EngineError> {
        self.lists.get(&id).ok_or_else(|| not_found("list", id.0))
    }

    fn require_subset(&self, id: SubsetId) -> Result<&super::Subset, EngineError> {
        self.subsets
            .get(&id)
            .ok_or_else(|| not_found("subset", id.0))
    }

    /// The system module for a list's properties, ready to insert.
    fn new_properties_module(&self, id: ModuleId) -> Result<Module, EngineError> {
        let list_id = ListId(id.0);
        let list = self
            .lists
            .get(&list_id)
            .ok_or_else(|| not_found("module", id.0))?;
        let name = properties_name(&list.name);
        ensure_unique(
            "module",
            &name,
            self.modules.values().map(|module| module.name.as_str()),
        )?;
        Ok(Module {
            id,
            name,
            axes: vec![AxisSpec::List { list: list_id }],
            functional_area: SYSTEM_AREA.to_string(),
        })
    }

    /// Checks everything about a line item except whether its module exists and returns its
    /// trimmed name.
    fn check_line_item(&self, line_item: &LineItem) -> Result<String, EngineError> {
        let name = check_name(
            "line item",
            &line_item.name,
            self.line_items
                .values()
                .filter(|other| other.module == line_item.module && other.id != line_item.id)
                .map(|other| other.name.as_str()),
        )?;
        if let Some(axes) = &line_item.applies_to {
            self.check_axes(axes, false)?;
        }
        if let VersionsScope::Only(only) = &line_item.versions {
            if only.is_empty() {
                return Err(invalid(
                    "A line item restricted to versions needs at least one.",
                ));
            }
            let mut seen = HashSet::new();
            for id in only {
                if self.version(*id).is_none() {
                    return Err(not_found("version", id.0));
                }
                if !seen.insert(*id) {
                    return Err(invalid(format!("Version {} is listed twice.", id.0)));
                }
            }
        }
        if let Format::List { list } = &line_item.format {
            self.require_list(*list)?;
        }
        for target in references(line_item) {
            if !self.line_items.contains_key(&target) {
                return Err(not_found("line item", target.0));
            }
        }
        Ok(name)
    }

    /// Checks that axes exist and are distinct. `allow_time_versions` is false for a line
    /// item's `applies_to`, which only replaces list and subset axes.
    fn check_axes(&self, axes: &[AxisSpec], allow_time_versions: bool) -> Result<(), EngineError> {
        let mut lists = HashSet::new();
        let mut has_time = false;
        let mut has_versions = false;
        for axis in axes {
            let list = match axis {
                AxisSpec::List { list } => Some(self.require_list(*list)?.id),
                AxisSpec::Subset { subset } => Some(self.require_subset(*subset)?.list),
                AxisSpec::Time { range, .. } => {
                    if !allow_time_versions {
                        return Err(invalid("Only lists and subsets can be applied to."));
                    }
                    if let Some(range) = range
                        && !self.time_ranges.contains_key(range)
                    {
                        return Err(not_found("time range", range.0));
                    }
                    if std::mem::replace(&mut has_time, true) {
                        return Err(invalid("A module can have only one Time dimension."));
                    }
                    None
                }
                AxisSpec::Versions => {
                    if !allow_time_versions {
                        return Err(invalid("Only lists and subsets can be applied to."));
                    }
                    if std::mem::replace(&mut has_versions, true) {
                        return Err(invalid("A module can have only one Versions dimension."));
                    }
                    None
                }
            };
            if let Some(list) = list
                && !lists.insert(list)
            {
                let name = &self.require_list(list)?.name;
                return Err(invalid(format!(
                    "List '{name}' can be used only once among the dimensions."
                )));
            }
        }
        Ok(())
    }
}

fn clean_area(raw: &str) -> Result<String, EngineError> {
    let area = raw.trim();
    if area.is_empty() {
        return Ok(String::new());
    }
    clean_name("functional area", area)
}

fn describe(axis: &Axis) -> &'static str {
    match axis {
        Axis::List(_) | Axis::ListTop(_) | Axis::Subset(_) => "an item id",
        Axis::Time { .. } => "a period label",
        Axis::Versions => "a version id",
    }
}

/// The line items a line item depends on through its summaries and access drivers.
fn references(line_item: &LineItem) -> impl Iterator<Item = LineItemId> {
    let parts = |method: &SummaryMethod| match method {
        SummaryMethod::Ratio {
            numerator,
            denominator,
        } => [Some(*numerator), Some(*denominator)],
        _ => [None, None],
    };
    parts(&line_item.summary)
        .into_iter()
        .chain(line_item.time_summary.as_ref().map_or([None, None], parts))
        .flatten()
        .chain(line_item.read_access_driver)
        .chain(line_item.write_access_driver)
}
