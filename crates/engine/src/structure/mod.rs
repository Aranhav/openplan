use std::collections::{BTreeMap, HashMap};
use std::sync::OnceLock;

use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::calendar::{Calendar, TimeLevel, TimeRange};
use crate::command::Command;
use crate::error::EngineError;
use crate::ids::{ItemId, LineItemId, ListId, ModuleId, SubsetId, TimeRangeId, VersionId};
use crate::value::ValueType;

mod layout;
mod list;
mod module;

pub(crate) use layout::Layout;
pub use layout::MAX_LINE_ITEM_CELLS;
pub use list::{Item, List, Lookup};
pub use module::{
    AxisSpec, LineItem, MAX_MODULE_DIMENSIONS, Module, SummaryMethod, TimeScale, VersionsScope,
};

const MAX_NAME_CHARS: usize = 80;

/// A scenario of the model. Exactly one version is the actual one and exactly one the
/// current one.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Version {
    pub id: VersionId,
    pub name: String,
    pub is_actual: bool,
    pub is_current: bool,
    /// Month index before which this version shows the actual version's values.
    pub switchover: Option<u32>,
}

/// A named selection of items of one list that can serve as a module dimension.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Subset {
    pub id: SubsetId,
    pub list: ListId,
    pub name: String,
    pub items: Vec<ItemId>,
}

/// Everything a model is made of apart from cell values: calendar, lists, subsets, versions,
/// time ranges, modules and line items.
#[derive(Clone, Debug)]
pub struct Structure {
    pub calendar: Calendar,
    lists: BTreeMap<ListId, List>,
    subsets: BTreeMap<SubsetId, Subset>,
    versions: Vec<Version>,
    time_ranges: BTreeMap<TimeRangeId, TimeRange>,
    modules: BTreeMap<ModuleId, Module>,
    line_items: BTreeMap<LineItemId, LineItem>,
    /// Lists, modules and line items by name, built when a name is first looked up and
    /// dropped by every command that is applied.
    names: OnceLock<NameIndex>,
}

/// The ids of lists, modules and line items by name, ignoring case: the key is the name in
/// lower case. Line items of one name are in id order, which is the order a search of all of
/// them finds them in.
#[derive(Clone, Debug)]
struct NameIndex {
    lists: HashMap<String, ListId>,
    modules: HashMap<String, ModuleId>,
    line_items: HashMap<String, Vec<LineItemId>>,
}

impl NameIndex {
    fn of(structure: &Structure) -> NameIndex {
        let mut lists = HashMap::new();
        for list in structure.lists.values() {
            lists.entry(fold(&list.name)).or_insert(list.id);
        }
        let mut modules = HashMap::new();
        for module in structure.modules.values() {
            modules.entry(fold(&module.name)).or_insert(module.id);
        }
        let mut line_items: HashMap<String, Vec<LineItemId>> = HashMap::new();
        for line_item in structure.line_items.values() {
            line_items
                .entry(fold(&line_item.name))
                .or_default()
                .push(line_item.id);
        }
        NameIndex {
            lists,
            modules,
            line_items,
        }
    }
}

impl Structure {
    /// An empty structure with the default versions Actual, Budget (current) and Forecast.
    pub(crate) fn new(calendar: Calendar) -> Structure {
        let version = |name: &str, is_actual, is_current| Version {
            id: VersionId::new(),
            name: name.to_string(),
            is_actual,
            is_current,
            switchover: None,
        };
        Structure {
            calendar,
            lists: BTreeMap::new(),
            subsets: BTreeMap::new(),
            versions: vec![
                version("Actual", true, false),
                version("Budget", false, true),
                version("Forecast", false, false),
            ],
            time_ranges: BTreeMap::new(),
            modules: BTreeMap::new(),
            line_items: BTreeMap::new(),
            names: OnceLock::new(),
        }
    }

    fn names(&self) -> &NameIndex {
        self.names.get_or_init(|| NameIndex::of(self))
    }

    pub fn lists(&self) -> impl Iterator<Item = &List> {
        self.lists.values()
    }

    pub fn list(&self, id: ListId) -> Option<&List> {
        self.lists.get(&id)
    }

    /// The list with this name, ignoring case and surrounding spaces.
    pub fn list_by_name(&self, name: &str) -> Option<&List> {
        let id = self.names().lists.get(&fold(name.trim()))?;
        self.lists.get(id)
    }

    pub fn subsets(&self) -> impl Iterator<Item = &Subset> {
        self.subsets.values()
    }

    pub fn subset(&self, id: SubsetId) -> Option<&Subset> {
        self.subsets.get(&id)
    }

    pub fn versions(&self) -> &[Version] {
        &self.versions
    }

    pub fn version(&self, id: VersionId) -> Option<&Version> {
        self.versions.iter().find(|version| version.id == id)
    }

    pub fn version_by_name(&self, name: &str) -> Option<&Version> {
        self.versions
            .iter()
            .find(|version| same_name(&version.name, name.trim()))
    }

    pub fn time_ranges(&self) -> impl Iterator<Item = &TimeRange> {
        self.time_ranges.values()
    }

    pub fn time_range(&self, id: TimeRangeId) -> Option<&TimeRange> {
        self.time_ranges.get(&id)
    }

    pub fn modules(&self) -> impl Iterator<Item = &Module> {
        self.modules.values()
    }

    pub fn module(&self, id: ModuleId) -> Option<&Module> {
        self.modules.get(&id)
    }

    pub fn module_by_name(&self, name: &str) -> Option<&Module> {
        let id = self.names().modules.get(&fold(name.trim()))?;
        self.modules.get(id)
    }

    pub fn line_items(&self) -> impl Iterator<Item = &LineItem> {
        self.line_items.values()
    }

    pub fn line_item(&self, id: LineItemId) -> Option<&LineItem> {
        self.line_items.get(&id)
    }

    /// The line item with this name, ignoring case and surrounding spaces. With `None` every
    /// module is searched and the first match in id order wins.
    pub fn line_item_by_name(&self, module: Option<ModuleId>, name: &str) -> Option<&LineItem> {
        self.line_items_named(name)
            .find(|li| module.is_none_or(|module| li.module == module))
    }

    /// The line items of every module with this name, ignoring case and surrounding spaces,
    /// in id order.
    pub(crate) fn line_items_named(&self, name: &str) -> impl Iterator<Item = &LineItem> {
        self.names()
            .line_items
            .get(&fold(name.trim()))
            .into_iter()
            .flatten()
            .filter_map(|id| self.line_items.get(id))
    }

    pub fn line_items_in(&self, module: ModuleId) -> impl Iterator<Item = &LineItem> {
        self.line_items
            .values()
            .filter(move |li| li.module == module)
    }

    /// Applies a structural command; `Model` applies `SetCells` itself and never passes it on.
    ///
    /// Rejected commands leave the structure unchanged.
    pub(crate) fn apply(&mut self, command: Command) -> Result<(), EngineError> {
        let applied = self.apply_command(command);
        self.names.take();
        applied
    }

    fn apply_command(&mut self, command: Command) -> Result<(), EngineError> {
        match command {
            Command::SetCalendar { calendar } => self.set_calendar(calendar),
            Command::CreateList {
                id,
                name,
                parent,
                top_level_name,
                numbered,
                production_data,
            } => self.create_list(id, name, parent, top_level_name, numbered, production_data),
            Command::UpdateList {
                id,
                name,
                top_level_name,
                production_data,
                selective_access,
            } => self.update_list(id, name, top_level_name, production_data, selective_access),
            Command::DeleteList { id } => self.delete_list(id),
            Command::UpsertListItems { list, items } => self.upsert_items(list, items),
            Command::DeleteListItems { list, ids } => self.delete_items(list, ids),
            Command::CreateSubset {
                id,
                list,
                name,
                items,
            } => self.create_subset(id, list, name, items),
            Command::UpdateSubset { id, name, items } => self.update_subset(id, name, items),
            Command::DeleteSubset { id } => self.delete_subset(id),
            Command::UpsertVersion {
                id,
                name,
                is_actual,
                is_current,
                switchover,
            } => self.upsert_version(id, name, is_actual, is_current, switchover),
            Command::DeleteVersion { id } => self.delete_version(id),
            Command::CreateTimeRange {
                id,
                name,
                first_year,
                years,
            } => self.create_time_range(id, name, first_year, years),
            Command::DeleteTimeRange { id } => self.delete_time_range(id),
            Command::CreateModule {
                id,
                name,
                axes,
                functional_area,
            } => self.create_module(id, name, axes, functional_area),
            Command::UpdateModule {
                id,
                name,
                axes,
                functional_area,
            } => self.update_module(id, name, axes, functional_area),
            Command::DeleteModule { id } => self.delete_module(id),
            Command::CreateLineItem(line_item) => self.create_line_item(line_item),
            Command::UpdateLineItem { id, patch } => self.update_line_item(id, patch),
            Command::DeleteLineItem { id } => self.delete_line_item(id),
            Command::SetCells { .. } => unreachable!("SetCells is handled by Model"),
        }
    }

    fn set_calendar(&mut self, calendar: Calendar) -> Result<(), EngineError> {
        calendar.validate()?;
        if calendar
            .current_month
            .is_some_and(|month| month >= calendar.months())
        {
            return Err(EngineError::invalid(
                "The current month must lie inside the calendar.",
            ));
        }
        // A switchover is a month of the calendar: it stays on the same month when the calendar
        // moves, and is cleared when that month is no longer on the timeline.
        let previous = self.calendar;
        for version in &mut self.versions {
            version.switchover = version
                .switchover
                .and_then(|month| calendar.month_of_date(previous.month_start_date(month)));
        }
        self.calendar = calendar;
        Ok(())
    }

    fn upsert_version(
        &mut self,
        id: VersionId,
        name: String,
        is_actual: bool,
        is_current: bool,
        switchover: Option<u32>,
    ) -> Result<(), EngineError> {
        let name = check_name(
            "version",
            &name,
            self.versions
                .iter()
                .filter(|version| version.id != id)
                .map(|version| version.name.as_str()),
        )?;
        if let Some(month) = switchover {
            if month >= self.calendar.months() {
                return Err(EngineError::invalid(
                    "The switchover month must lie inside the calendar.",
                ));
            }
            if is_actual {
                return Err(EngineError::invalid(
                    "The actual version cannot have a switchover month.",
                ));
            }
        }
        let others = || self.versions.iter().filter(|version| version.id != id);
        if !is_actual && others().all(|version| !version.is_actual) {
            return Err(EngineError::invalid(
                "Exactly one version must be the actual version.",
            ));
        }
        if !is_current && others().all(|version| !version.is_current) {
            return Err(EngineError::invalid(
                "Exactly one version must be the current version.",
            ));
        }
        for other in self.versions.iter_mut().filter(|version| version.id != id) {
            other.is_actual &= !is_actual;
            other.is_current &= !is_current;
        }
        let version = Version {
            id,
            name,
            is_actual,
            is_current,
            switchover,
        };
        match self.versions.iter_mut().find(|existing| existing.id == id) {
            Some(slot) => *slot = version,
            None => self.versions.push(version),
        }
        Ok(())
    }

    fn delete_version(&mut self, id: VersionId) -> Result<(), EngineError> {
        let version = self
            .version(id)
            .ok_or_else(|| EngineError::not_found("version", id.0))?;
        if version.is_actual || version.is_current {
            return Err(EngineError::invalid(
                "The actual and current versions cannot be deleted.",
            ));
        }
        let users = self
            .line_items
            .values()
            .filter(|li| matches!(&li.versions, VersionsScope::Only(only) if only.contains(&id)))
            .map(|li| format!("line item '{}'", self.qualified_name(li)))
            .collect();
        in_use("Version", &version.name, users)?;
        self.versions.retain(|version| version.id != id);
        Ok(())
    }

    /// Replaces the versions of a structure that nothing uses yet with `versions`, which are
    /// held to the rules `UpsertVersion` keeps: distinct names, switchover months inside the
    /// calendar and none for the actual version, and exactly one actual and one current version.
    pub(crate) fn restore_versions(&mut self, versions: Vec<Version>) -> Result<(), EngineError> {
        let mut restored: Vec<Version> = Vec::with_capacity(versions.len());
        for version in versions {
            let name = check_name(
                "version",
                &version.name,
                restored.iter().map(|other| other.name.as_str()),
            )?;
            if restored.iter().any(|other| other.id == version.id) {
                return Err(already_exists("version", version.id.0));
            }
            match version.switchover {
                Some(month) if month >= self.calendar.months() => {
                    return Err(EngineError::invalid(
                        "The switchover month must lie inside the calendar.",
                    ));
                }
                Some(_) if version.is_actual => {
                    return Err(EngineError::invalid(
                        "The actual version cannot have a switchover month.",
                    ));
                }
                _ => {}
            }
            restored.push(Version { name, ..version });
        }
        if restored.iter().filter(|version| version.is_actual).count() != 1 {
            return Err(EngineError::invalid(
                "Exactly one version must be the actual version.",
            ));
        }
        if restored.iter().filter(|version| version.is_current).count() != 1 {
            return Err(EngineError::invalid(
                "Exactly one version must be the current version.",
            ));
        }
        self.versions = restored;
        Ok(())
    }

    fn create_time_range(
        &mut self,
        id: TimeRangeId,
        name: String,
        first_year: i32,
        years: u8,
    ) -> Result<(), EngineError> {
        if self.time_ranges.contains_key(&id) {
            return Err(already_exists("time range", id.0));
        }
        let name = check_name(
            "time range",
            &name,
            self.time_ranges.values().map(|range| range.name.as_str()),
        )?;
        if !(1..=20).contains(&years) {
            return Err(EngineError::invalid("years must be between 1 and 20"));
        }
        if !(1..=9999).contains(&first_year) {
            return Err(EngineError::invalid(
                "first_year must be between 1 and 9999",
            ));
        }
        self.time_ranges.insert(
            id,
            TimeRange {
                id,
                name,
                first_year,
                years,
            },
        );
        Ok(())
    }

    fn delete_time_range(&mut self, id: TimeRangeId) -> Result<(), EngineError> {
        let range = self
            .time_ranges
            .get(&id)
            .ok_or_else(|| EngineError::not_found("time range", id.0))?;
        let users = self
            .modules
            .values()
            .filter(|module| {
                module.axes.iter().any(
                    |axis| matches!(axis, AxisSpec::Time { range: Some(used), .. } if *used == id),
                )
            })
            .map(|module| format!("module '{}'", module.name))
            .collect();
        in_use("Time range", &range.name, users)?;
        self.time_ranges.remove(&id);
        Ok(())
    }

    /// The calendar a time axis counts its periods in: the model calendar, or the calendar
    /// of the range that starts at the range's first fiscal year.
    pub(crate) fn time_calendar(
        &self,
        range: Option<TimeRangeId>,
    ) -> Result<Calendar, EngineError> {
        let Some(id) = range else {
            return Ok(self.calendar);
        };
        let range = self
            .time_ranges
            .get(&id)
            .ok_or_else(|| EngineError::not_found("time range", id.0))?;
        Ok(Calendar {
            first_year: range.first_year,
            years: range.years,
            current_month: None,
            ..self.calendar
        })
    }

    /// Months from the start of the model calendar to the start of a time range; 0 for the
    /// model calendar itself.
    pub(crate) fn time_offset(&self, range: Option<TimeRangeId>) -> i64 {
        range
            .and_then(|id| self.time_ranges.get(&id))
            .map_or(0, |range| self.calendar.range_month_offset(range))
    }

    fn require_list(&self, id: ListId) -> Result<&List, EngineError> {
        self.lists
            .get(&id)
            .ok_or_else(|| EngineError::not_found("list", id.0))
    }

    fn require_subset(&self, id: SubsetId) -> Result<&Subset, EngineError> {
        self.subsets
            .get(&id)
            .ok_or_else(|| EngineError::not_found("subset", id.0))
    }

    /// `Module.Line item`, for messages.
    fn qualified_name(&self, line_item: &LineItem) -> String {
        let module = self
            .modules
            .get(&line_item.module)
            .map_or("?", |module| module.name.as_str());
        format!("{module}.{}", line_item.name)
    }
}

impl Structure {
    /// A type as it reads in a message about a formula.
    pub(crate) fn type_name(&self, ty: ValueType) -> String {
        match ty {
            ValueType::Number => "Number".to_string(),
            ValueType::Boolean => "Boolean".to_string(),
            ValueType::Text => "Text".to_string(),
            ValueType::Date => "Date".to_string(),
            ValueType::Item(ListId::VERSIONS) => "Version".to_string(),
            ValueType::Item(list) => format!("List '{}'", self.list_name(list)),
            ValueType::Period(level) => format!("Time period ({})", level_name(level)),
        }
    }

    /// The name of a list in a message: `Versions` for the built-in dimension and `?` for a
    /// list that does not exist.
    pub(crate) fn list_name(&self, list: ListId) -> &str {
        if list == ListId::VERSIONS {
            return "Versions";
        }
        self.lists.get(&list).map_or("?", |list| list.name.as_str())
    }
}

pub(crate) fn level_name(level: TimeLevel) -> &'static str {
    match level {
        TimeLevel::Month => "month",
        TimeLevel::Quarter => "quarter",
        TimeLevel::HalfYear => "half-year",
        TimeLevel::Year => "year",
        TimeLevel::All => "all-periods",
    }
}

fn already_exists(what: &'static str, id: Uuid) -> EngineError {
    EngineError::invalid(format!("A {what} with id {id} already exists."))
}

/// Case-insensitive name comparison.
pub(crate) fn same_name(a: &str, b: &str) -> bool {
    a.chars()
        .flat_map(char::to_lowercase)
        .eq(b.chars().flat_map(char::to_lowercase))
}

/// The text in lower case, the form names are compared in.
pub(crate) fn fold(text: &str) -> String {
    text.chars().flat_map(char::to_lowercase).collect()
}

/// Trims a name and checks its length and that it has no NUL character, which the database
/// cannot store.
fn clean_name(what: &str, raw: &str) -> Result<String, EngineError> {
    let name = raw.trim();
    let length = name.chars().count();
    if length == 0 || length > MAX_NAME_CHARS {
        return Err(EngineError::invalid(format!(
            "The {what} name must be between 1 and {MAX_NAME_CHARS} characters."
        )));
    }
    if name.contains('\0') {
        return Err(EngineError::invalid(format!(
            "The {what} name can't contain the NUL character."
        )));
    }
    Ok(name.to_string())
}

/// The built-in dimensions are named in formulas as `Versions` and `Time`, which a list or a
/// module of that name would make ambiguous.
fn check_not_reserved(name: &str) -> Result<(), EngineError> {
    for reserved in ["Versions", "Time"] {
        if same_name(name, reserved) {
            return Err(EngineError::invalid(format!(
                "'{reserved}' is a reserved name."
            )));
        }
    }
    Ok(())
}

/// Fails with `NameTaken` when `name` equals one of `others`, ignoring case.
fn ensure_unique<'a>(
    what: &'static str,
    name: &str,
    mut others: impl Iterator<Item = &'a str>,
) -> Result<(), EngineError> {
    if others.any(|other| same_name(other, name)) {
        return Err(EngineError::NameTaken {
            what,
            name: name.to_string(),
        });
    }
    Ok(())
}

/// A trimmed, length-checked name that none of `others` has.
fn check_name<'a>(
    what: &'static str,
    raw: &str,
    others: impl Iterator<Item = &'a str>,
) -> Result<String, EngineError> {
    let name = clean_name(what, raw)?;
    ensure_unique(what, &name, others)?;
    Ok(name)
}

/// Fails with `InUse` naming up to five of the things that still use `name`.
fn in_use(what: &str, name: &str, users: Vec<String>) -> Result<(), EngineError> {
    if users.is_empty() {
        return Ok(());
    }
    let shown = users.iter().take(5).cloned().collect::<Vec<_>>().join(", ");
    let more = match users.len() {
        0..=5 => String::new(),
        count => format!(" and {} more", count - 5),
    };
    Err(EngineError::InUse {
        message: format!("{what} '{name}' is in use by {shown}{more}."),
    })
}
