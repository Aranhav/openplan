use serde::{Deserialize, Deserializer, Serialize};

use crate::calendar::Calendar;
use crate::ids::{ItemId, LineItemId, ListId, ModuleId, SubsetId, TimeRangeId, VersionId};
use crate::structure::{AxisSpec, LineItem, SummaryMethod, TimeScale, VersionsScope};
use crate::value::{Format, Value};

/// Reads an optional field that may also be set to `null`: absent is `None`, `null` is
/// `Some(None)` and a value is `Some(Some(value))`.
fn double_option<'de, T, D>(deserializer: D) -> Result<Option<Option<T>>, D::Error>
where
    T: Deserialize<'de>,
    D: Deserializer<'de>,
{
    Option::<T>::deserialize(deserializer).map(Some)
}

/// A change to a model, applied by `Model::apply`.
///
/// In `Update*` commands an absent (`None`) field is left unchanged; fields of type
/// `Option<Option<_>>` can also be cleared with `Some(None)`.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum Command {
    SetCalendar {
        calendar: Calendar,
    },
    CreateList {
        id: ListId,
        name: String,
        parent: Option<ListId>,
        top_level_name: Option<String>,
        numbered: bool,
        production_data: bool,
    },
    UpdateList {
        id: ListId,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        name: Option<String>,
        #[serde(
            default,
            deserialize_with = "double_option",
            skip_serializing_if = "Option::is_none"
        )]
        top_level_name: Option<Option<String>>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        production_data: Option<bool>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        selective_access: Option<bool>,
    },
    DeleteList {
        id: ListId,
    },
    /// Adds the items with new ids to the end of the list, in order, and updates the others.
    UpsertListItems {
        list: ListId,
        items: Vec<ItemSpec>,
    },
    DeleteListItems {
        list: ListId,
        ids: Vec<ItemId>,
    },
    CreateSubset {
        id: SubsetId,
        list: ListId,
        name: String,
        items: Vec<ItemId>,
    },
    UpdateSubset {
        id: SubsetId,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        name: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        items: Option<Vec<ItemId>>,
    },
    DeleteSubset {
        id: SubsetId,
    },
    UpsertVersion {
        id: VersionId,
        name: String,
        is_actual: bool,
        is_current: bool,
        switchover: Option<u32>,
    },
    DeleteVersion {
        id: VersionId,
    },
    CreateTimeRange {
        id: TimeRangeId,
        name: String,
        first_year: i32,
        years: u8,
    },
    DeleteTimeRange {
        id: TimeRangeId,
    },
    CreateModule {
        id: ModuleId,
        name: String,
        axes: Vec<AxisSpec>,
        functional_area: String,
    },
    UpdateModule {
        id: ModuleId,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        name: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        axes: Option<Vec<AxisSpec>>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        functional_area: Option<String>,
    },
    DeleteModule {
        id: ModuleId,
    },
    CreateLineItem(LineItem),
    UpdateLineItem {
        id: LineItemId,
        patch: LineItemPatch,
    },
    DeleteLineItem {
        id: LineItemId,
    },
    SetCells {
        line_item: LineItemId,
        edits: Vec<CellEdit>,
    },
}

/// A list item to add or update.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ItemSpec {
    pub id: ItemId,
    pub code: Option<String>,
    pub name: String,
    pub parent: Option<ItemId>,
}

/// Changes to a line item; absent fields are left unchanged.
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct LineItemPatch {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ordinal: Option<i32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub format: Option<Format>,
    #[serde(
        deserialize_with = "double_option",
        skip_serializing_if = "Option::is_none"
    )]
    pub formula: Option<Option<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub summary: Option<SummaryMethod>,
    #[serde(
        deserialize_with = "double_option",
        skip_serializing_if = "Option::is_none"
    )]
    pub time_summary: Option<Option<SummaryMethod>>,
    #[serde(
        deserialize_with = "double_option",
        skip_serializing_if = "Option::is_none"
    )]
    pub applies_to: Option<Option<Vec<AxisSpec>>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub time_scale: Option<TimeScale>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub versions: Option<VersionsScope>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub notes: Option<String>,
    #[serde(
        deserialize_with = "double_option",
        skip_serializing_if = "Option::is_none"
    )]
    pub code: Option<Option<String>>,
    #[serde(
        deserialize_with = "double_option",
        skip_serializing_if = "Option::is_none"
    )]
    pub read_access_driver: Option<Option<LineItemId>>,
    #[serde(
        deserialize_with = "double_option",
        skip_serializing_if = "Option::is_none"
    )]
    pub write_access_driver: Option<Option<LineItemId>>,
}

/// One cell to write: its coordinates, one token per axis of the line item, and its value.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct CellEdit {
    pub coords: Vec<CoordToken>,
    pub value: Value,
}

/// A coordinate of a cell, read positionally against the axes of its line item.
///
/// A list or subset axis takes an item id, a Time axis a period label such as `"Jan 26"` and
/// a Versions axis the id of the version, which is also written as a uuid.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum CoordToken {
    Item(ItemId),
    Period(String),
}

/// What an applied command changed.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ChangeSet {
    /// The model generation after the change.
    pub generation: u64,
    /// Line items that were created or deleted, or whose stored cells were written, cleared,
    /// re-laid out or dropped.
    pub changed_line_items: Vec<LineItemId>,
    /// Whether lists, time, versions, modules or line items changed.
    pub structure_changed: bool,
}

impl ChangeSet {
    /// Records `line_item` as changed once.
    pub(crate) fn note(&mut self, line_item: LineItemId) {
        if !self.changed_line_items.contains(&line_item) {
            self.changed_line_items.push(line_item);
        }
    }
}
