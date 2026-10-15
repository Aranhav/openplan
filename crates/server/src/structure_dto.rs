//! The structure of a model as the API documents it: mirrors of the engine's structure types that
//! carry the OpenAPI schemas, so that the engine itself needs no web dependencies.
//!
//! Every mirror serializes to exactly the JSON the engine's own serde implementation writes, so
//! that the structure document, which the engine stores and the API serves, has one shape. The
//! mirrors that requests also use (axes, formats, summary methods, time scales and versions
//! scopes) read that JSON back as well.

use openplan_engine::{
    AxisSpec, Calendar, Format, ItemDoc, LineItem, LineItemId, ListDoc, ListId, Module,
    NegativeStyle, NumberUnit, StructureDoc, Subset, SubsetId, SummaryMethod, TimeLevel, TimeRange,
    TimeRangeId, TimeScale, ValueType, Version, VersionId, VersionsScope,
};
use serde::{Deserialize, Serialize};
use utoipa::ToSchema;
use uuid::Uuid;

/// The structure document of a model: calendar, lists with their items, subsets, versions, time
/// ranges, modules and line items. Months and periods are indices from the start of the calendar.
#[derive(Serialize, ToSchema)]
pub struct StructureDto {
    /// The version of the document format; 1.
    format_version: u32,
    calendar: StructureCalendarDto,
    lists: Vec<StructureListDto>,
    subsets: Vec<StructureSubsetDto>,
    versions: Vec<StructureVersionDto>,
    time_ranges: Vec<StructureTimeRangeDto>,
    modules: Vec<ModuleDto>,
    line_items: Vec<LineItemDto>,
}

/// The timeline of the model: whole fiscal years of months.
#[derive(Serialize, ToSchema)]
pub struct StructureCalendarDto {
    /// The month a fiscal year starts in, 1 to 12.
    fiscal_year_start_month: u8,
    /// The label year of the first fiscal year, which is the calendar year it ends in.
    first_year: i32,
    years: u8,
    /// The index of the current month from the start of the calendar.
    current_month: Option<u32>,
}

/// A list with its items, in order.
#[derive(Serialize, ToSchema)]
pub struct StructureListDto {
    id: Uuid,
    name: String,
    /// The list one level up: every item of this list has a parent item in it.
    parent: Option<Uuid>,
    /// The name of the single total item above all items, if the list has one.
    top_level_name: Option<String>,
    numbered: bool,
    production_data: bool,
    selective_access: bool,
    items: Vec<StructureItemDto>,
}

/// An item of a list.
#[derive(Serialize, ToSchema)]
pub struct StructureItemDto {
    id: Uuid,
    code: Option<String>,
    name: String,
    /// The item of the parent list this item belongs to.
    parent: Option<Uuid>,
}

/// A named selection of the items of one list.
#[derive(Serialize, ToSchema)]
pub struct StructureSubsetDto {
    id: Uuid,
    list: Uuid,
    name: String,
    items: Vec<Uuid>,
}

/// A scenario of the model.
#[derive(Serialize, ToSchema)]
pub struct StructureVersionDto {
    id: Uuid,
    name: String,
    is_actual: bool,
    is_current: bool,
    /// The index of the month before which this version shows the actual version's values.
    switchover: Option<u32>,
}

/// A named run of whole fiscal years.
#[derive(Serialize, ToSchema)]
pub struct StructureTimeRangeDto {
    id: Uuid,
    name: String,
    first_year: i32,
    years: u8,
}

/// A grid of line items over shared dimensions.
#[derive(Serialize, ToSchema)]
pub struct ModuleDto {
    id: Uuid,
    name: String,
    axes: Vec<AxisDto>,
    /// The folder label used for navigation; empty when the module is in none.
    functional_area: String,
}

/// A dimension of a module. Whatever their order, cells are laid out with the list and subset
/// dimensions first, then Time, then Versions.
#[derive(Serialize, Deserialize, ToSchema)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum AxisDto {
    List {
        list: Uuid,
    },
    Subset {
        subset: Uuid,
    },
    Time {
        level: TimeLevelDto,
        /// The named time range to use instead of the model calendar.
        range: Option<Uuid>,
    },
    Versions,
}

/// The granularity of a time axis, finest first.
#[derive(Clone, Copy, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum TimeLevelDto {
    Month,
    Quarter,
    HalfYear,
    Year,
    All,
}

/// A row of a module. Without a formula it is an input line item that stores typed cells; with
/// one it is calculated.
#[derive(Serialize, ToSchema)]
pub struct LineItemDto {
    id: Uuid,
    module: Uuid,
    name: String,
    /// The position among the line items of the module.
    ordinal: i32,
    format: FormatDto,
    formula: Option<String>,
    /// How cells roll up along a hierarchy.
    summary: SummaryMethodDto,
    /// How cells roll up through time, when that differs from `summary`.
    time_summary: Option<SummaryMethodDto>,
    /// The list and subset dimensions that replace the module's for this line item.
    applies_to: Option<Vec<AxisDto>>,
    time_scale: TimeScaleDto,
    versions: VersionsScopeDto,
    notes: String,
    code: Option<String>,
    read_access_driver: Option<Uuid>,
    write_access_driver: Option<Uuid>,
}

/// How a line item's values are typed and displayed.
#[derive(Serialize, Deserialize, ToSchema)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum FormatDto {
    Number {
        /// How many decimals are shown, 0 to 10. Wider than the engine's, so that a request with
        /// too many is refused with a message about the decimals.
        decimals: u32,
        thousands_sep: bool,
        unit: NumberUnitDto,
        negative: NegativeStyleDto,
    },
    Boolean,
    Text,
    Date,
    List {
        list: Uuid,
    },
    TimePeriod {
        level: TimeLevelDto,
    },
}

/// The unit a number is shown in.
#[derive(Serialize, Deserialize, ToSchema)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum NumberUnitDto {
    None,
    Currency {
        /// The ISO 4217 code: three uppercase letters, such as `USD`.
        code: String,
    },
    Percent,
}

/// How a negative number is shown.
#[derive(Clone, Copy, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum NegativeStyleDto {
    Minus,
    Parens,
}

/// How cells roll up along a hierarchy or through time.
#[derive(Serialize, Deserialize, ToSchema)]
#[serde(tag = "method", rename_all = "snake_case")]
pub enum SummaryMethodDto {
    Sum,
    Average,
    Min,
    Max,
    None,
    Formula,
    Ratio { numerator: Uuid, denominator: Uuid },
    First,
    Last,
    Opening,
    Closing,
    Any,
    All,
}

/// The time axis of a line item relative to its module's: the module's, none, or a coarser level.
#[derive(Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum TimeScaleDto {
    Module,
    None,
    Level(TimeLevelDto),
}

/// The versions axis of a line item relative to its module's: the module's, none, or only some
/// versions, in this order.
#[derive(Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum VersionsScopeDto {
    Module,
    None,
    Only(Vec<Uuid>),
}

/// The type a formula evaluates to.
#[derive(Serialize, ToSchema)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ValueTypeDto {
    Number,
    Boolean,
    Text,
    Date,
    /// An item of a list.
    Item {
        list: Uuid,
    },
    /// A period of the calendar at a level.
    Period {
        level: TimeLevelDto,
    },
}

impl From<TimeLevel> for TimeLevelDto {
    fn from(level: TimeLevel) -> Self {
        match level {
            TimeLevel::Month => TimeLevelDto::Month,
            TimeLevel::Quarter => TimeLevelDto::Quarter,
            TimeLevel::HalfYear => TimeLevelDto::HalfYear,
            TimeLevel::Year => TimeLevelDto::Year,
            TimeLevel::All => TimeLevelDto::All,
        }
    }
}

impl From<TimeLevelDto> for TimeLevel {
    fn from(level: TimeLevelDto) -> Self {
        match level {
            TimeLevelDto::Month => TimeLevel::Month,
            TimeLevelDto::Quarter => TimeLevel::Quarter,
            TimeLevelDto::HalfYear => TimeLevel::HalfYear,
            TimeLevelDto::Year => TimeLevel::Year,
            TimeLevelDto::All => TimeLevel::All,
        }
    }
}

impl From<&AxisSpec> for AxisDto {
    fn from(axis: &AxisSpec) -> Self {
        match axis {
            AxisSpec::List { list } => AxisDto::List { list: list.0 },
            AxisSpec::Subset { subset } => AxisDto::Subset { subset: subset.0 },
            AxisSpec::Time { level, range } => AxisDto::Time {
                level: (*level).into(),
                range: range.map(|range| range.0),
            },
            AxisSpec::Versions => AxisDto::Versions,
        }
    }
}

impl From<AxisDto> for AxisSpec {
    fn from(axis: AxisDto) -> Self {
        match axis {
            AxisDto::List { list } => AxisSpec::List { list: ListId(list) },
            AxisDto::Subset { subset } => AxisSpec::Subset {
                subset: SubsetId(subset),
            },
            AxisDto::Time { level, range } => AxisSpec::Time {
                level: level.into(),
                range: range.map(TimeRangeId),
            },
            AxisDto::Versions => AxisSpec::Versions,
        }
    }
}

impl From<NegativeStyle> for NegativeStyleDto {
    fn from(style: NegativeStyle) -> Self {
        match style {
            NegativeStyle::Minus => NegativeStyleDto::Minus,
            NegativeStyle::Parens => NegativeStyleDto::Parens,
        }
    }
}

impl From<NegativeStyleDto> for NegativeStyle {
    fn from(style: NegativeStyleDto) -> Self {
        match style {
            NegativeStyleDto::Minus => NegativeStyle::Minus,
            NegativeStyleDto::Parens => NegativeStyle::Parens,
        }
    }
}

impl From<&NumberUnit> for NumberUnitDto {
    fn from(unit: &NumberUnit) -> Self {
        match unit {
            NumberUnit::None => NumberUnitDto::None,
            NumberUnit::Currency { code } => NumberUnitDto::Currency { code: code.clone() },
            NumberUnit::Percent => NumberUnitDto::Percent,
        }
    }
}

impl From<NumberUnitDto> for NumberUnit {
    fn from(unit: NumberUnitDto) -> Self {
        match unit {
            NumberUnitDto::None => NumberUnit::None,
            NumberUnitDto::Currency { code } => NumberUnit::Currency { code },
            NumberUnitDto::Percent => NumberUnit::Percent,
        }
    }
}

impl From<&Format> for FormatDto {
    fn from(format: &Format) -> Self {
        match format {
            Format::Number {
                decimals,
                thousands_sep,
                unit,
                negative,
            } => FormatDto::Number {
                decimals: u32::from(*decimals),
                thousands_sep: *thousands_sep,
                unit: unit.into(),
                negative: (*negative).into(),
            },
            Format::Boolean => FormatDto::Boolean,
            Format::Text => FormatDto::Text,
            Format::Date => FormatDto::Date,
            Format::List { list } => FormatDto::List { list: list.0 },
            Format::TimePeriod { level } => FormatDto::TimePeriod {
                level: (*level).into(),
            },
        }
    }
}

impl From<FormatDto> for Format {
    fn from(format: FormatDto) -> Self {
        match format {
            FormatDto::Number {
                decimals,
                thousands_sep,
                unit,
                negative,
            } => Format::Number {
                decimals: u8::try_from(decimals).unwrap_or(u8::MAX),
                thousands_sep,
                unit: unit.into(),
                negative: negative.into(),
            },
            FormatDto::Boolean => Format::Boolean,
            FormatDto::Text => Format::Text,
            FormatDto::Date => Format::Date,
            FormatDto::List { list } => Format::List { list: ListId(list) },
            FormatDto::TimePeriod { level } => Format::TimePeriod {
                level: level.into(),
            },
        }
    }
}

impl From<&SummaryMethod> for SummaryMethodDto {
    fn from(method: &SummaryMethod) -> Self {
        match method {
            SummaryMethod::Sum => SummaryMethodDto::Sum,
            SummaryMethod::Average => SummaryMethodDto::Average,
            SummaryMethod::Min => SummaryMethodDto::Min,
            SummaryMethod::Max => SummaryMethodDto::Max,
            SummaryMethod::None => SummaryMethodDto::None,
            SummaryMethod::Formula => SummaryMethodDto::Formula,
            SummaryMethod::Ratio {
                numerator,
                denominator,
            } => SummaryMethodDto::Ratio {
                numerator: numerator.0,
                denominator: denominator.0,
            },
            SummaryMethod::First => SummaryMethodDto::First,
            SummaryMethod::Last => SummaryMethodDto::Last,
            SummaryMethod::Opening => SummaryMethodDto::Opening,
            SummaryMethod::Closing => SummaryMethodDto::Closing,
            SummaryMethod::Any => SummaryMethodDto::Any,
            SummaryMethod::All => SummaryMethodDto::All,
        }
    }
}

impl From<SummaryMethodDto> for SummaryMethod {
    fn from(method: SummaryMethodDto) -> Self {
        match method {
            SummaryMethodDto::Sum => SummaryMethod::Sum,
            SummaryMethodDto::Average => SummaryMethod::Average,
            SummaryMethodDto::Min => SummaryMethod::Min,
            SummaryMethodDto::Max => SummaryMethod::Max,
            SummaryMethodDto::None => SummaryMethod::None,
            SummaryMethodDto::Formula => SummaryMethod::Formula,
            SummaryMethodDto::Ratio {
                numerator,
                denominator,
            } => SummaryMethod::Ratio {
                numerator: LineItemId(numerator),
                denominator: LineItemId(denominator),
            },
            SummaryMethodDto::First => SummaryMethod::First,
            SummaryMethodDto::Last => SummaryMethod::Last,
            SummaryMethodDto::Opening => SummaryMethod::Opening,
            SummaryMethodDto::Closing => SummaryMethod::Closing,
            SummaryMethodDto::Any => SummaryMethod::Any,
            SummaryMethodDto::All => SummaryMethod::All,
        }
    }
}

impl From<&TimeScale> for TimeScaleDto {
    fn from(scale: &TimeScale) -> Self {
        match scale {
            TimeScale::Module => TimeScaleDto::Module,
            TimeScale::None => TimeScaleDto::None,
            TimeScale::Level(level) => TimeScaleDto::Level((*level).into()),
        }
    }
}

impl From<TimeScaleDto> for TimeScale {
    fn from(scale: TimeScaleDto) -> Self {
        match scale {
            TimeScaleDto::Module => TimeScale::Module,
            TimeScaleDto::None => TimeScale::None,
            TimeScaleDto::Level(level) => TimeScale::Level(level.into()),
        }
    }
}

impl From<&VersionsScope> for VersionsScopeDto {
    fn from(scope: &VersionsScope) -> Self {
        match scope {
            VersionsScope::Module => VersionsScopeDto::Module,
            VersionsScope::None => VersionsScopeDto::None,
            VersionsScope::Only(versions) => {
                VersionsScopeDto::Only(versions.iter().map(|version| version.0).collect())
            }
        }
    }
}

impl From<VersionsScopeDto> for VersionsScope {
    fn from(scope: VersionsScopeDto) -> Self {
        match scope {
            VersionsScopeDto::Module => VersionsScope::Module,
            VersionsScopeDto::None => VersionsScope::None,
            VersionsScopeDto::Only(versions) => {
                VersionsScope::Only(versions.into_iter().map(VersionId).collect())
            }
        }
    }
}

impl From<ValueType> for ValueTypeDto {
    fn from(ty: ValueType) -> Self {
        match ty {
            ValueType::Number => ValueTypeDto::Number,
            ValueType::Boolean => ValueTypeDto::Boolean,
            ValueType::Text => ValueTypeDto::Text,
            ValueType::Date => ValueTypeDto::Date,
            ValueType::Item(list) => ValueTypeDto::Item { list: list.0 },
            ValueType::Period(level) => ValueTypeDto::Period {
                level: level.into(),
            },
        }
    }
}

impl From<&Module> for ModuleDto {
    fn from(module: &Module) -> Self {
        ModuleDto {
            id: module.id.0,
            name: module.name.clone(),
            axes: module.axes.iter().map(AxisDto::from).collect(),
            functional_area: module.functional_area.clone(),
        }
    }
}

impl From<&LineItem> for LineItemDto {
    fn from(line_item: &LineItem) -> Self {
        LineItemDto {
            id: line_item.id.0,
            module: line_item.module.0,
            name: line_item.name.clone(),
            ordinal: line_item.ordinal,
            format: (&line_item.format).into(),
            formula: line_item.formula.clone(),
            summary: (&line_item.summary).into(),
            time_summary: line_item.time_summary.as_ref().map(SummaryMethodDto::from),
            applies_to: line_item
                .applies_to
                .as_ref()
                .map(|axes| axes.iter().map(AxisDto::from).collect()),
            time_scale: (&line_item.time_scale).into(),
            versions: (&line_item.versions).into(),
            notes: line_item.notes.clone(),
            code: line_item.code.clone(),
            read_access_driver: line_item.read_access_driver.map(|driver| driver.0),
            write_access_driver: line_item.write_access_driver.map(|driver| driver.0),
        }
    }
}

impl From<Calendar> for StructureCalendarDto {
    fn from(calendar: Calendar) -> Self {
        StructureCalendarDto {
            fiscal_year_start_month: calendar.fiscal_year_start_month,
            first_year: calendar.first_year,
            years: calendar.years,
            current_month: calendar.current_month,
        }
    }
}

impl From<ItemDoc> for StructureItemDto {
    fn from(item: ItemDoc) -> Self {
        StructureItemDto {
            id: item.id.0,
            code: item.code,
            name: item.name,
            parent: item.parent.map(|parent| parent.0),
        }
    }
}

impl From<ListDoc> for StructureListDto {
    fn from(list: ListDoc) -> Self {
        StructureListDto {
            id: list.id.0,
            name: list.name,
            parent: list.parent.map(|parent| parent.0),
            top_level_name: list.top_level_name,
            numbered: list.numbered,
            production_data: list.production_data,
            selective_access: list.selective_access,
            items: list.items.into_iter().map(Into::into).collect(),
        }
    }
}

impl From<Subset> for StructureSubsetDto {
    fn from(subset: Subset) -> Self {
        StructureSubsetDto {
            id: subset.id.0,
            list: subset.list.0,
            name: subset.name,
            items: subset.items.into_iter().map(|item| item.0).collect(),
        }
    }
}

impl From<&Version> for StructureVersionDto {
    fn from(version: &Version) -> Self {
        StructureVersionDto {
            id: version.id.0,
            name: version.name.clone(),
            is_actual: version.is_actual,
            is_current: version.is_current,
            switchover: version.switchover,
        }
    }
}

impl From<&TimeRange> for StructureTimeRangeDto {
    fn from(range: &TimeRange) -> Self {
        StructureTimeRangeDto {
            id: range.id.0,
            name: range.name.clone(),
            first_year: range.first_year,
            years: range.years,
        }
    }
}

impl From<StructureDoc> for StructureDto {
    fn from(doc: StructureDoc) -> Self {
        StructureDto {
            format_version: doc.format_version,
            calendar: doc.calendar.into(),
            lists: doc.lists.into_iter().map(Into::into).collect(),
            subsets: doc.subsets.into_iter().map(Into::into).collect(),
            versions: doc.versions.iter().map(Into::into).collect(),
            time_ranges: doc.time_ranges.iter().map(Into::into).collect(),
            modules: doc.modules.iter().map(Into::into).collect(),
            line_items: doc.line_items.iter().map(Into::into).collect(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use openplan_engine::{Command, Item, ItemId, ItemSpec, LineItemPatch, Model, ModuleId};
    use serde_json::{Value, json};

    fn line_item(module: ModuleId, name: &str, ordinal: i32, format: Format) -> LineItem {
        LineItem {
            id: LineItemId::new(),
            module,
            name: name.to_string(),
            ordinal,
            format,
            formula: None,
            summary: SummaryMethod::Sum,
            time_summary: None,
            applies_to: None,
            time_scale: TimeScale::Module,
            versions: VersionsScope::Module,
            notes: String::new(),
            code: None,
            read_access_driver: None,
            write_access_driver: None,
        }
    }

    /// A model that uses every kind of axis, format, summary method, time scale and versions
    /// scope there is.
    fn rich_model() -> Model {
        let mut model = Model::new(Calendar {
            fiscal_year_start_month: 4,
            first_year: 2026,
            years: 3,
            current_month: Some(5),
        });
        let regions = ListId::new();
        let countries = ListId::new();
        let (emea, france) = (ItemId::new(), ItemId::new());
        let range = TimeRangeId::new();
        let subset = SubsetId::new();
        let (plan, summary) = (ModuleId::new(), ModuleId::new());
        let version = VersionId::new();
        let budget = model
            .structure()
            .versions()
            .iter()
            .find(|version| version.is_current)
            .unwrap()
            .id;

        let mut commands = vec![
            Command::CreateList {
                id: regions,
                name: "Regions".to_string(),
                parent: None,
                top_level_name: Some("All Regions".to_string()),
                numbered: false,
                production_data: true,
            },
            Command::CreateList {
                id: countries,
                name: "Countries".to_string(),
                parent: Some(regions),
                top_level_name: None,
                numbered: true,
                production_data: false,
            },
            Command::UpsertListItems {
                list: regions,
                items: vec![ItemSpec {
                    id: emea,
                    code: Some("EU".to_string()),
                    name: "EMEA".to_string(),
                    parent: None,
                }],
            },
            Command::UpsertListItems {
                list: countries,
                items: vec![ItemSpec {
                    id: france,
                    code: None,
                    name: "France".to_string(),
                    parent: Some(emea),
                }],
            },
            Command::UpdateList {
                id: countries,
                name: None,
                top_level_name: None,
                production_data: None,
                selective_access: Some(true),
            },
            Command::CreateSubset {
                id: subset,
                list: regions,
                name: "Core".to_string(),
                items: vec![emea],
            },
            Command::UpsertVersion {
                id: version,
                name: "Stretch".to_string(),
                is_actual: false,
                is_current: false,
                switchover: Some(3),
            },
            Command::CreateTimeRange {
                id: range,
                name: "Short".to_string(),
                first_year: 2026,
                years: 2,
            },
            Command::CreateModule {
                id: plan,
                name: "Plan".to_string(),
                axes: vec![
                    AxisSpec::List { list: countries },
                    AxisSpec::Subset { subset },
                    AxisSpec::Time {
                        level: TimeLevel::Month,
                        range: Some(range),
                    },
                    AxisSpec::Versions,
                ],
                functional_area: "Finance".to_string(),
            },
            Command::CreateModule {
                id: summary,
                name: "Summary".to_string(),
                axes: vec![AxisSpec::Time {
                    level: TimeLevel::Quarter,
                    range: None,
                }],
                functional_area: String::new(),
            },
        ];
        let units = line_item(plan, "Units", 0, Format::number());
        let price = line_item(
            plan,
            "Price",
            1,
            Format::Number {
                decimals: 2,
                thousands_sep: false,
                unit: NumberUnit::Currency {
                    code: "EUR".to_string(),
                },
                negative: NegativeStyle::Parens,
            },
        );
        let (units_id, price_id) = (units.id, price.id);
        commands.extend([
            Command::CreateLineItem(units),
            Command::CreateLineItem(price),
        ]);
        let methods = [
            SummaryMethod::Sum,
            SummaryMethod::Average,
            SummaryMethod::Min,
            SummaryMethod::Max,
            SummaryMethod::None,
            SummaryMethod::Formula,
            SummaryMethod::Ratio {
                numerator: units_id,
                denominator: price_id,
            },
            SummaryMethod::First,
            SummaryMethod::Last,
            SummaryMethod::Opening,
            SummaryMethod::Closing,
            SummaryMethod::Any,
            SummaryMethod::All,
        ];
        let formats = [
            Format::Boolean,
            Format::Text,
            Format::Date,
            Format::List { list: countries },
            Format::TimePeriod {
                level: TimeLevel::HalfYear,
            },
            Format::Number {
                decimals: 1,
                thousands_sep: true,
                unit: NumberUnit::Percent,
                negative: NegativeStyle::Minus,
            },
        ];
        for (index, method) in methods.into_iter().enumerate() {
            let mut line_item = line_item(
                plan,
                &format!("Summary {index}"),
                10 + index as i32,
                Format::number(),
            );
            line_item.summary = method;
            commands.push(Command::CreateLineItem(line_item));
        }
        for (index, format) in formats.into_iter().enumerate() {
            commands.push(Command::CreateLineItem(line_item(
                plan,
                &format!("Format {index}"),
                30 + index as i32,
                format,
            )));
        }
        let mut scaled = line_item(plan, "Scaled", 40, Format::number());
        scaled.time_scale = TimeScale::Level(TimeLevel::Year);
        scaled.versions = VersionsScope::Only(vec![budget, version]);
        scaled.time_summary = Some(SummaryMethod::Last);
        scaled.applies_to = Some(vec![AxisSpec::List { list: regions }]);
        scaled.notes = "Per region".to_string();
        scaled.code = Some("SCL".to_string());
        scaled.read_access_driver = Some(units_id);
        scaled.write_access_driver = Some(price_id);
        let scaled_id = scaled.id;
        commands.push(Command::CreateLineItem(scaled));
        let mut unscaled = line_item(summary, "Unscaled", 0, Format::number());
        unscaled.time_scale = TimeScale::None;
        unscaled.versions = VersionsScope::None;
        let unscaled_id = unscaled.id;
        commands.push(Command::CreateLineItem(unscaled));
        commands.push(Command::UpdateLineItem {
            id: unscaled_id,
            patch: LineItemPatch {
                formula: Some(Some("1".to_string())),
                ..LineItemPatch::default()
            },
        });
        model.apply_batch(commands).unwrap();
        assert!(model.structure().line_item(scaled_id).is_some());
        model
    }

    #[test]
    fn the_typed_structure_serializes_exactly_as_the_engine_document_does() {
        let model = rich_model();
        let doc = model.export_structure();
        let engine = serde_json::to_value(&doc).unwrap();

        let typed = serde_json::to_value(StructureDto::from(doc)).unwrap();

        assert_eq!(typed, engine);
        assert!(engine["lists"][1]["items"][0]["parent"].is_string());
        assert!(engine["line_items"].as_array().unwrap().len() > 20);
    }

    #[test]
    fn mirrors_read_what_the_engine_writes_and_write_it_back() {
        let model = rich_model();
        let doc = model.export_structure();

        for module in &doc.modules {
            let json = serde_json::to_value(&module.axes).unwrap();
            let axes: Vec<AxisDto> = serde_json::from_value(json.clone()).unwrap();
            let back: Vec<AxisSpec> = axes.into_iter().map(Into::into).collect();
            assert_eq!(back, module.axes);
            assert_eq!(serde_json::to_value(&back).unwrap(), json);
        }
        for line_item in &doc.line_items {
            let format: FormatDto =
                serde_json::from_value(serde_json::to_value(&line_item.format).unwrap()).unwrap();
            assert_eq!(Format::from(format), line_item.format);
            let summary: SummaryMethodDto =
                serde_json::from_value(serde_json::to_value(&line_item.summary).unwrap()).unwrap();
            assert_eq!(SummaryMethod::from(summary), line_item.summary);
            let scale: TimeScaleDto =
                serde_json::from_value(serde_json::to_value(&line_item.time_scale).unwrap())
                    .unwrap();
            assert_eq!(TimeScale::from(scale), line_item.time_scale);
            let versions: VersionsScopeDto =
                serde_json::from_value(serde_json::to_value(&line_item.versions).unwrap()).unwrap();
            assert_eq!(VersionsScope::from(versions), line_item.versions);
        }
    }

    #[test]
    fn value_types_are_tagged() {
        let list = ListId::new();
        let cases: [(ValueType, Value); 6] = [
            (ValueType::Number, json!({ "type": "number" })),
            (ValueType::Boolean, json!({ "type": "boolean" })),
            (ValueType::Text, json!({ "type": "text" })),
            (ValueType::Date, json!({ "type": "date" })),
            (
                ValueType::Item(list),
                json!({ "type": "item", "list": list.0 }),
            ),
            (
                ValueType::Period(TimeLevel::Quarter),
                json!({ "type": "period", "level": "quarter" }),
            ),
        ];
        for (ty, expected) in cases {
            assert_eq!(
                serde_json::to_value(ValueTypeDto::from(ty)).unwrap(),
                expected
            );
        }
    }

    #[test]
    fn items_keep_their_order_and_parents() {
        let model = rich_model();
        let list = model.structure().list_by_name("Countries").unwrap();
        let first: &Item = list.items().next().map(|(_, item)| item).unwrap();

        let typed = serde_json::to_value(StructureDto::from(model.export_structure())).unwrap();

        let countries = typed["lists"]
            .as_array()
            .unwrap()
            .iter()
            .find(|candidate| candidate["name"] == "Countries")
            .unwrap();
        assert_eq!(countries["items"][0]["id"], json!(first.id.0));
        assert_eq!(
            countries["items"][0]["parent"],
            json!(first.parent.unwrap().0)
        );
    }
}
