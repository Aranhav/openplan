use openplan_engine::view::{Cell, query};
use openplan_engine::{
    AxisSpec, Calendar, CellEdit, Command, CoordToken, Format, Header, ItemId, ItemSpec, LineItem,
    LineItemId, ListId, Member, Model, ModuleId, PageSelection, SummaryMethod, TimeLevel,
    TimeScale, Value, VersionsScope, ViewDim, ViewQuery, ViewResult, Window,
};

pub fn calendar() -> Calendar {
    Calendar {
        fiscal_year_start_month: 4,
        first_year: 2027,
        years: 1,
        current_month: None,
    }
}

pub fn spec(id: ItemId, name: &str, parent: Option<ItemId>) -> ItemSpec {
    ItemSpec {
        id,
        code: None,
        name: name.to_string(),
        parent,
    }
}

pub fn line_item(
    module: ModuleId,
    name: &str,
    ordinal: i32,
    format: Format,
    formula: Option<&str>,
) -> LineItem {
    LineItem {
        id: LineItemId::new(),
        module,
        name: name.to_string(),
        ordinal,
        format,
        formula: formula.map(str::to_string),
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

pub fn add(model: &mut Model, line_item: LineItem) -> LineItemId {
    let id = line_item.id;
    model.apply(Command::CreateLineItem(line_item)).unwrap();
    id
}

pub fn number_item(model: &mut Model, module: ModuleId, name: &str, ordinal: i32) -> LineItemId {
    add(
        model,
        line_item(module, name, ordinal, Format::number(), None),
    )
}

pub fn formula_item(
    model: &mut Model,
    module: ModuleId,
    name: &str,
    ordinal: i32,
    formula: &str,
) -> LineItemId {
    add(
        model,
        line_item(module, name, ordinal, Format::number(), Some(formula)),
    )
}

pub fn month_axis() -> AxisSpec {
    AxisSpec::Time {
        level: TimeLevel::Month,
        range: None,
    }
}

pub fn new_module(model: &mut Model, name: &str, axes: Vec<AxisSpec>) -> ModuleId {
    let id = ModuleId::new();
    model
        .apply(Command::CreateModule {
            id,
            name: name.to_string(),
            axes,
            functional_area: String::new(),
        })
        .unwrap();
    id
}

pub fn set(model: &mut Model, line_item: LineItemId, coords: Vec<CoordToken>, value: Value) {
    model
        .apply(Command::SetCells {
            line_item,
            edits: vec![CellEdit { coords, value }],
        })
        .unwrap();
}

pub fn num(value: f64) -> Value {
    Value::Number(value)
}

pub fn period(label: &str) -> CoordToken {
    CoordToken::Period(label.to_string())
}

pub fn version_token(model: &Model, name: &str) -> CoordToken {
    CoordToken::Item(ItemId(
        model.structure().version_by_name(name).unwrap().id.0,
    ))
}

pub fn version_key(model: &Model, name: &str) -> String {
    model
        .structure()
        .version_by_name(name)
        .unwrap()
        .id
        .0
        .to_string()
}

pub fn key(id: ItemId) -> String {
    id.0.to_string()
}

/// Countries (top level "All Countries") in Regions, over months and versions:
///
/// ```text
/// All Countries
///   North America: US, CA
///   Europe: DE
/// ```
///
/// The items of Countries are added as US, DE, CA, so that the list order differs from the
/// order of the tree.
pub struct World {
    pub model: Model,
    pub regions: ListId,
    pub countries: ListId,
    pub na: ItemId,
    pub us: ItemId,
    pub de: ItemId,
    pub ca: ItemId,
    pub sales: ModuleId,
    pub units: LineItemId,
}

pub fn world() -> World {
    let mut model = Model::new(calendar());
    let (regions, countries, sales) = (ListId::new(), ListId::new(), ModuleId::new());
    let [na, eu, us, de, ca] = std::array::from_fn(|_| ItemId::new());
    model
        .apply_batch(vec![
            Command::CreateList {
                id: regions,
                name: "Regions".to_string(),
                parent: None,
                top_level_name: None,
                numbered: false,
                production_data: false,
            },
            Command::CreateList {
                id: countries,
                name: "Countries".to_string(),
                parent: Some(regions),
                top_level_name: Some("All Countries".to_string()),
                numbered: false,
                production_data: false,
            },
            Command::UpsertListItems {
                list: regions,
                items: vec![spec(na, "North America", None), spec(eu, "Europe", None)],
            },
            Command::UpsertListItems {
                list: countries,
                items: vec![
                    spec(us, "US", Some(na)),
                    spec(de, "DE", Some(eu)),
                    spec(ca, "CA", Some(na)),
                ],
            },
            Command::CreateModule {
                id: sales,
                name: "Sales".to_string(),
                axes: vec![
                    AxisSpec::List { list: countries },
                    month_axis(),
                    AxisSpec::Versions,
                ],
                functional_area: String::new(),
            },
        ])
        .unwrap();
    let units = number_item(&mut model, sales, "Units", 1);
    World {
        model,
        regions,
        countries,
        na,
        us,
        de,
        ca,
        sales,
        units,
    }
}

impl World {
    pub fn countries(&self) -> ViewDim {
        ViewDim::List {
            list: self.countries,
        }
    }

    /// The cell of a line item of `sales` for a country, a month and a version by name.
    pub fn at(&self, country: ItemId, month: &str, version: &str) -> Vec<CoordToken> {
        vec![
            CoordToken::Item(country),
            period(month),
            version_token(&self.model, version),
        ]
    }

    pub fn put(&mut self, country: ItemId, month: &str, version: &str, value: f64) {
        let coords = self.at(country, month, version);
        set(&mut self.model, self.units, coords, num(value));
    }

    /// The module's dimensions other than `placed`, each at its default member.
    pub fn pages_but(&self, placed: &[ViewDim]) -> Vec<PageSelection> {
        [
            ViewDim::LineItems,
            self.countries(),
            ViewDim::Time,
            ViewDim::Versions,
        ]
        .into_iter()
        .filter(|dim| !placed.contains(dim))
        .map(page)
        .collect()
    }

    /// A query with `rows` and `columns` and every other dimension on a page at its default.
    pub fn grid(&self, rows: Vec<ViewDim>, columns: Vec<ViewDim>) -> ViewQuery {
        let placed: Vec<ViewDim> = rows.iter().chain(&columns).cloned().collect();
        query_of(self.sales, rows, columns, self.pages_but(&placed))
    }
}

/// A model with a flat list of `count` items named `{name} {n}`.
pub fn model_with_list(model: &mut Model, name: &str, count: usize) -> (ListId, Vec<ItemId>) {
    let list = ListId::new();
    let items: Vec<_> = (0..count)
        .map(|at| spec(ItemId::new(), &format!("{name} {at}"), None))
        .collect();
    let ids = items.iter().map(|item| item.id).collect();
    model
        .apply_batch(vec![
            Command::CreateList {
                id: list,
                name: name.to_string(),
                parent: None,
                top_level_name: None,
                numbered: false,
                production_data: false,
            },
            Command::UpsertListItems { list, items },
        ])
        .unwrap();
    (list, ids)
}

pub fn page(dim: ViewDim) -> PageSelection {
    PageSelection { dim, key: None }
}

pub fn page_at(dim: ViewDim, key: &str) -> PageSelection {
    PageSelection {
        dim,
        key: Some(key.to_string()),
    }
}

pub fn everything() -> Window {
    Window {
        row_offset: 0,
        row_limit: 1000,
        col_offset: 0,
        col_limit: 200,
    }
}

pub fn query_of(
    module: ModuleId,
    rows: Vec<ViewDim>,
    columns: Vec<ViewDim>,
    pages: Vec<PageSelection>,
) -> ViewQuery {
    ViewQuery {
        module,
        line_items: None,
        rows,
        columns,
        pages,
        show_summaries: true,
        collapsed: Vec::new(),
        hidden: Vec::new(),
        filters: Vec::new(),
        window: everything(),
    }
}

pub fn run(model: &Model, q: &ViewQuery) -> ViewResult {
    query(model, q).unwrap()
}

pub fn invalid(model: &Model, q: &ViewQuery) -> String {
    let error = query(model, q).unwrap_err();
    assert_eq!(error.code(), "structure.invalid", "{error}");
    error.to_string()
}

pub fn labels(headers: &[Header], level: usize) -> Vec<&str> {
    headers
        .iter()
        .map(|header| header.members[level].label.as_str())
        .collect()
}

pub fn member_labels(members: &[Member]) -> Vec<&str> {
    members.iter().map(|member| member.label.as_str()).collect()
}

pub fn number(cell: &Cell) -> f64 {
    match cell.value {
        Value::Number(number) => number,
        ref other => panic!("expected a number, found {other:?}"),
    }
}

pub fn numbers(row: &[Cell]) -> Vec<f64> {
    row.iter().map(number).collect()
}

pub const MONTHS: [&str; 12] = [
    "Apr 26", "May 26", "Jun 26", "Jul 26", "Aug 26", "Sep 26", "Oct 26", "Nov 26", "Dec 26",
    "Jan 27", "Feb 27", "Mar 27",
];
