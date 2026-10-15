use openplan_engine::view::{Cell, members, query};
use openplan_engine::{
    AxisSpec, Calendar, CellEdit, CellFlag, Command, CoordToken, FilterOp, Format, Header, ItemId,
    ItemSpec, LineItem, LineItemId, LineItemPatch, ListId, Member, MemberRef, Model, ModuleId,
    PageSelection, RowFilter, SubsetId, SummaryMethod, TimeLevel, TimeScale, Value, VersionsScope,
    ViewDim, ViewQuery, ViewResult, Window,
};
use serde_json::json;

fn calendar() -> Calendar {
    Calendar {
        fiscal_year_start_month: 4,
        first_year: 2027,
        years: 1,
        current_month: None,
    }
}

fn spec(id: ItemId, name: &str, parent: Option<ItemId>) -> ItemSpec {
    ItemSpec {
        id,
        code: None,
        name: name.to_string(),
        parent,
    }
}

fn line_item(
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

fn add(model: &mut Model, line_item: LineItem) -> LineItemId {
    let id = line_item.id;
    model.apply(Command::CreateLineItem(line_item)).unwrap();
    id
}

fn number_item(model: &mut Model, module: ModuleId, name: &str, ordinal: i32) -> LineItemId {
    add(
        model,
        line_item(module, name, ordinal, Format::number(), None),
    )
}

fn formula_item(
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

fn month_axis() -> AxisSpec {
    AxisSpec::Time {
        level: TimeLevel::Month,
        range: None,
    }
}

fn new_module(model: &mut Model, name: &str, axes: Vec<AxisSpec>) -> ModuleId {
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

fn set(model: &mut Model, line_item: LineItemId, coords: Vec<CoordToken>, value: Value) {
    model
        .apply(Command::SetCells {
            line_item,
            edits: vec![CellEdit { coords, value }],
        })
        .unwrap();
}

fn num(value: f64) -> Value {
    Value::Number(value)
}

fn period(label: &str) -> CoordToken {
    CoordToken::Period(label.to_string())
}

fn version_token(model: &Model, name: &str) -> CoordToken {
    CoordToken::Item(ItemId(
        model.structure().version_by_name(name).unwrap().id.0,
    ))
}

fn version_key(model: &Model, name: &str) -> String {
    model
        .structure()
        .version_by_name(name)
        .unwrap()
        .id
        .0
        .to_string()
}

fn key(id: ItemId) -> String {
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
struct World {
    model: Model,
    regions: ListId,
    countries: ListId,
    na: ItemId,
    us: ItemId,
    de: ItemId,
    ca: ItemId,
    sales: ModuleId,
    units: LineItemId,
}

fn world() -> World {
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
    fn countries(&self) -> ViewDim {
        ViewDim::List {
            list: self.countries,
        }
    }

    /// The cell of a line item of `sales` for a country, a month and a version by name.
    fn at(&self, country: ItemId, month: &str, version: &str) -> Vec<CoordToken> {
        vec![
            CoordToken::Item(country),
            period(month),
            version_token(&self.model, version),
        ]
    }

    fn put(&mut self, country: ItemId, month: &str, version: &str, value: f64) {
        let coords = self.at(country, month, version);
        set(&mut self.model, self.units, coords, num(value));
    }

    /// The module's dimensions other than `placed`, each at its default member.
    fn pages_but(&self, placed: &[ViewDim]) -> Vec<PageSelection> {
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
    fn grid(&self, rows: Vec<ViewDim>, columns: Vec<ViewDim>) -> ViewQuery {
        let placed: Vec<ViewDim> = rows.iter().chain(&columns).cloned().collect();
        query_of(self.sales, rows, columns, self.pages_but(&placed))
    }
}

fn page(dim: ViewDim) -> PageSelection {
    PageSelection { dim, key: None }
}

fn page_at(dim: ViewDim, key: &str) -> PageSelection {
    PageSelection {
        dim,
        key: Some(key.to_string()),
    }
}

fn everything() -> Window {
    Window {
        row_offset: 0,
        row_limit: 1000,
        col_offset: 0,
        col_limit: 200,
    }
}

fn query_of(
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

fn run(model: &Model, q: &ViewQuery) -> ViewResult {
    query(model, q).unwrap()
}

fn invalid(model: &Model, q: &ViewQuery) -> String {
    let error = query(model, q).unwrap_err();
    assert_eq!(error.code(), "structure.invalid", "{error}");
    error.to_string()
}

fn labels(headers: &[Header], level: usize) -> Vec<&str> {
    headers
        .iter()
        .map(|header| header.members[level].label.as_str())
        .collect()
}

fn member_labels(members: &[Member]) -> Vec<&str> {
    members.iter().map(|member| member.label.as_str()).collect()
}

fn number(cell: &Cell) -> f64 {
    match cell.value {
        Value::Number(number) => number,
        ref other => panic!("expected a number, found {other:?}"),
    }
}

fn numbers(row: &[Cell]) -> Vec<f64> {
    row.iter().map(number).collect()
}

const MONTHS: [&str; 12] = [
    "Apr 26", "May 26", "Jun 26", "Jul 26", "Aug 26", "Sep 26", "Oct 26", "Nov 26", "Dec 26",
    "Jan 27", "Feb 27", "Mar 27",
];

#[test]
fn default_pages_and_line_items_on_rows() {
    let mut w = world();
    number_item(&mut w.model, w.sales, "Price", 0);
    let q = w.grid(vec![ViewDim::LineItems], vec![ViewDim::Time]);

    let result = run(&w.model, &q);

    assert_eq!(result.row_dims, vec![ViewDim::LineItems]);
    assert_eq!(result.column_dims, vec![ViewDim::Time]);
    assert_eq!(labels(&result.rows, 0), vec!["Price", "Units"]);
    assert_eq!(result.total_rows, 2);
    assert_eq!(result.total_columns, 20);
    assert_eq!(result.cells.len(), 2);
    assert!(result.cells.iter().all(|row| row.len() == 20));

    assert_eq!(result.pages.len(), 2);
    assert_eq!(result.pages[0].dim, w.countries());
    let top = &result.pages[0].member;
    assert_eq!(
        (top.key.as_str(), top.label.as_str(), top.depth),
        ("top", "All Countries", 0)
    );
    assert!(top.is_summary && top.has_children && !top.collapsed);
    assert_eq!(result.pages[1].dim, ViewDim::Versions);
    assert_eq!(result.pages[1].member.label, "Budget");
    assert_eq!(result.pages[1].member.key, version_key(&w.model, "Budget"));

    let info: Vec<(&str, bool)> = result
        .line_items
        .iter()
        .map(|info| (info.name.as_str(), info.is_input))
        .collect();
    assert_eq!(info, vec![("Price", true), ("Units", true)]);
    assert_eq!(result.line_items[1].id, w.units);
    assert_eq!(result.line_items[1].format, Format::number());
    assert_eq!(
        result.line_items[1].dims,
        vec![w.countries(), ViewDim::Time, ViewDim::Versions]
    );
    assert!(result.line_items[1].errors.is_empty());
}

#[test]
fn default_pages_for_time_flat_lists_and_subsets() {
    let mut w = world();
    let q = w.grid(vec![ViewDim::LineItems], vec![w.countries()]);
    let result = run(&w.model, &q);
    let months = &result.pages[0];
    assert_eq!(months.dim, ViewDim::Time);
    assert_eq!(months.member.key, "Apr 26");
    assert!(!months.member.is_summary);

    let products = ListId::new();
    let [widget, gadget] = std::array::from_fn(|_| ItemId::new());
    let top_sellers = SubsetId::new();
    w.model
        .apply_batch(vec![
            Command::CreateList {
                id: products,
                name: "Products".to_string(),
                parent: None,
                top_level_name: None,
                numbered: false,
                production_data: false,
            },
            Command::UpsertListItems {
                list: products,
                items: vec![spec(widget, "Widget", None), spec(gadget, "Gadget", None)],
            },
            Command::CreateSubset {
                id: top_sellers,
                list: products,
                name: "Top sellers".to_string(),
                items: vec![gadget, widget],
            },
        ])
        .unwrap();
    let plain = new_module(
        &mut w.model,
        "Plain",
        vec![AxisSpec::List { list: products }],
    );
    let picked = new_module(
        &mut w.model,
        "Picked",
        vec![AxisSpec::Subset {
            subset: top_sellers,
        }],
    );
    let plain_list = ViewDim::List { list: products };
    let picked_subset = ViewDim::Subset {
        subset: top_sellers,
    };

    // A list without a top level starts at its first item, a subset at its first member.
    let q = query_of(
        plain,
        vec![ViewDim::LineItems],
        Vec::new(),
        vec![page(plain_list.clone())],
    );
    assert_eq!(run(&w.model, &q).pages[0].member.label, "Widget");
    let q = query_of(
        picked,
        vec![ViewDim::LineItems],
        Vec::new(),
        vec![page(picked_subset.clone())],
    );
    assert_eq!(run(&w.model, &q).pages[0].member.label, "Gadget");
    assert_eq!(
        member_labels(&members(&w.model, picked, &picked_subset, true).unwrap()),
        vec!["Gadget", "Widget"]
    );
}

#[test]
fn list_tree_parent_first_with_top() {
    let w = world();

    let tree = members(&w.model, w.sales, &w.countries(), true).unwrap();

    assert_eq!(
        member_labels(&tree),
        vec!["All Countries", "North America", "US", "CA", "Europe", "DE"]
    );
    let shape: Vec<(u8, bool, bool)> = tree
        .iter()
        .map(|member| (member.depth, member.is_summary, member.has_children))
        .collect();
    assert_eq!(
        shape,
        vec![
            (0, true, true),
            (1, true, true),
            (2, false, false),
            (2, false, false),
            (1, true, true),
            (2, false, false),
        ]
    );
    assert_eq!(tree[0].key, "top");
    assert_eq!(tree[1].key, key(w.na));
    assert_eq!(tree[2].key, key(w.us));
    assert!(tree.iter().all(|member| !member.collapsed));

    // Without summaries the leaves come in list order, not grouped by parent.
    let leaves = members(&w.model, w.sales, &w.countries(), false).unwrap();
    assert_eq!(member_labels(&leaves), vec!["US", "DE", "CA"]);
    assert!(
        leaves
            .iter()
            .all(|member| member.depth == 0 && !member.is_summary && !member.has_children)
    );
}

#[test]
fn list_tree_without_top_starts_at_depth_zero() {
    let mut w = world();
    let regions_module = new_module(
        &mut w.model,
        "By region",
        vec![AxisSpec::List { list: w.regions }],
    );
    let regions = ViewDim::List { list: w.regions };

    let tree = members(&w.model, regions_module, &regions, true).unwrap();

    assert_eq!(member_labels(&tree), vec!["North America", "Europe"]);
    assert!(tree.iter().all(|member| member.depth == 0));
    assert!(tree.iter().all(|member| !member.is_summary));
}

#[test]
fn time_summaries_after_children_fiscal_april() {
    let w = world();

    let all = members(&w.model, w.sales, &ViewDim::Time, true).unwrap();

    let expected = [
        "Apr 26", "May 26", "Jun 26", "Q1 FY27", "Jul 26", "Aug 26", "Sep 26", "Q2 FY27",
        "H1 FY27", "Oct 26", "Nov 26", "Dec 26", "Q3 FY27", "Jan 27", "Feb 27", "Mar 27",
        "Q4 FY27", "H2 FY27", "FY27", "Total",
    ];
    assert_eq!(member_labels(&all), expected);
    let keys: Vec<&str> = all.iter().map(|member| member.key.as_str()).collect();
    assert_eq!(keys, expected);
    let depths: Vec<u8> = all.iter().map(|member| member.depth).collect();
    assert_eq!(
        depths,
        vec![0, 0, 0, 1, 0, 0, 0, 1, 2, 0, 0, 0, 1, 0, 0, 0, 1, 2, 3, 4]
    );
    for member in &all {
        let summary = !member.label.contains(' ') || member.label.contains("FY");
        assert_eq!(member.is_summary, summary, "{}", member.label);
        assert_eq!(member.has_children, summary, "{}", member.label);
    }

    let months = members(&w.model, w.sales, &ViewDim::Time, false).unwrap();
    assert_eq!(member_labels(&months), MONTHS);
    assert!(
        months
            .iter()
            .all(|member| member.depth == 0 && !member.is_summary && !member.has_children)
    );
}

#[test]
fn time_summaries_start_at_the_level_of_the_module() {
    let mut w = world();
    let quarterly = new_module(
        &mut w.model,
        "Quarterly",
        vec![AxisSpec::Time {
            level: TimeLevel::Quarter,
            range: None,
        }],
    );

    let all = members(&w.model, quarterly, &ViewDim::Time, true).unwrap();

    assert_eq!(
        member_labels(&all),
        vec![
            "Q1 FY27", "Q2 FY27", "H1 FY27", "Q3 FY27", "Q4 FY27", "H2 FY27", "FY27", "Total"
        ]
    );
    let depths: Vec<u8> = all.iter().map(|member| member.depth).collect();
    assert_eq!(depths, vec![0, 0, 1, 0, 0, 1, 2, 3]);
    let quarters = members(&w.model, quarterly, &ViewDim::Time, false).unwrap();
    assert_eq!(
        member_labels(&quarters),
        vec!["Q1 FY27", "Q2 FY27", "Q3 FY27", "Q4 FY27"]
    );
}

#[test]
fn collapse_hides_descendants_and_counts() {
    let w = world();
    let mut q = w.grid(vec![w.countries()], vec![ViewDim::Time]);
    let all = run(&w.model, &q);
    assert_eq!(all.total_rows, 6);
    assert_eq!(all.total_columns, 20);

    q.collapsed = vec![MemberRef {
        dim: w.countries(),
        key: key(w.na),
    }];
    let result = run(&w.model, &q);
    assert_eq!(
        labels(&result.rows, 0),
        vec!["All Countries", "North America", "Europe", "DE"]
    );
    assert_eq!(result.total_rows, 4);
    assert_eq!(result.cells.len(), 4);
    let na = &result.rows[1].members[0];
    assert!(na.collapsed && na.has_children);
    assert!(!result.rows[2].members[0].collapsed);

    q.collapsed = vec![MemberRef {
        dim: w.countries(),
        key: "top".to_string(),
    }];
    let result = run(&w.model, &q);
    assert_eq!(labels(&result.rows, 0), vec!["All Countries"]);
    assert_eq!(result.total_rows, 1);
    assert!(result.rows[0].members[0].collapsed);

    // A collapsed time summary hides the periods before it, the summary stays.
    q.collapsed = vec![MemberRef {
        dim: ViewDim::Time,
        key: "Q1 FY27".to_string(),
    }];
    let result = run(&w.model, &q);
    assert_eq!(result.total_columns, 17);
    assert_eq!(
        labels(&result.columns, 0)[..4],
        ["Q1 FY27", "Jul 26", "Aug 26", "Sep 26"]
    );
    assert!(result.columns[0].members[0].collapsed);

    q.collapsed = vec![MemberRef {
        dim: ViewDim::Time,
        key: "FY27".to_string(),
    }];
    let result = run(&w.model, &q);
    assert_eq!(labels(&result.columns, 0), vec!["FY27", "Total"]);

    // A member without children has nothing to collapse, and without summaries nothing hides.
    q.collapsed = vec![MemberRef {
        dim: w.countries(),
        key: key(w.us),
    }];
    let result = run(&w.model, &q);
    assert_eq!(result.total_rows, 6);
    assert!(!result.rows[2].members[0].collapsed);
    q.collapsed = vec![MemberRef {
        dim: w.countries(),
        key: key(w.na),
    }];
    q.show_summaries = false;
    let result = run(&w.model, &q);
    assert_eq!(labels(&result.rows, 0), vec!["US", "DE", "CA"]);
}

#[test]
fn hidden_members_removed() {
    let w = world();
    let mut q = w.grid(vec![w.countries()], vec![ViewDim::Time]);

    // A hidden parent leaves its children.
    q.hidden = vec![MemberRef {
        dim: w.countries(),
        key: key(w.na),
    }];
    let result = run(&w.model, &q);
    assert_eq!(
        labels(&result.rows, 0),
        vec!["All Countries", "US", "CA", "Europe", "DE"]
    );
    assert_eq!(result.total_rows, 5);

    q.hidden = vec![
        MemberRef {
            dim: w.countries(),
            key: "top".to_string(),
        },
        MemberRef {
            dim: w.countries(),
            key: key(w.us),
        },
    ];
    let result = run(&w.model, &q);
    assert_eq!(
        labels(&result.rows, 0),
        vec!["North America", "CA", "Europe", "DE"]
    );

    q.hidden = vec![MemberRef {
        dim: ViewDim::Time,
        key: "Q1 FY27".to_string(),
    }];
    let result = run(&w.model, &q);
    assert_eq!(result.total_columns, 19);
    assert!(!labels(&result.columns, 0).contains(&"Q1 FY27"));
    assert!(labels(&result.columns, 0).contains(&"Apr 26"));
}

#[test]
fn window_slices_and_past_end_is_empty() {
    let w = world();
    let mut q = w.grid(vec![w.countries()], vec![ViewDim::Time]);
    q.window = Window {
        row_offset: 2,
        row_limit: 3,
        col_offset: 3,
        col_limit: 2,
    };

    let result = run(&w.model, &q);

    assert_eq!(labels(&result.rows, 0), vec!["US", "CA", "Europe"]);
    assert_eq!(labels(&result.columns, 0), vec!["Q1 FY27", "Jul 26"]);
    assert_eq!(result.total_rows, 6);
    assert_eq!(result.total_columns, 20);
    assert_eq!(result.cells.len(), 3);
    assert!(result.cells.iter().all(|row| row.len() == 2));

    // The last window holds what is left.
    q.window.row_offset = 5;
    q.window.row_limit = 10;
    q.window.col_offset = 18;
    q.window.col_limit = 10;
    let result = run(&w.model, &q);
    assert_eq!(labels(&result.rows, 0), vec!["DE"]);
    assert_eq!(labels(&result.columns, 0), vec!["FY27", "Total"]);
    assert_eq!(result.cells.len(), 1);
    assert_eq!(result.cells[0].len(), 2);

    // Past the end there is nothing, but the totals still say how much there is.
    q.window.row_offset = 6;
    let result = run(&w.model, &q);
    assert!(result.rows.is_empty());
    assert!(result.cells.is_empty());
    assert_eq!(result.total_rows, 6);
    q.window.row_offset = 0;
    q.window.col_offset = 20;
    let result = run(&w.model, &q);
    assert!(result.columns.is_empty());
    assert_eq!(result.rows.len(), 6);
    assert!(result.cells.iter().all(Vec::is_empty));
    assert_eq!(result.total_columns, 20);

    q.window.col_offset = 0;
    q.window.row_limit = 0;
    assert!(run(&w.model, &q).rows.is_empty());
}

#[test]
fn nested_column_dims_cartesian_order() {
    let mut w = world();
    w.put(w.us, "May 26", "Budget", 7.0);
    w.put(w.us, "May 26", "Forecast", 9.0);
    let mut q = w.grid(vec![w.countries()], vec![ViewDim::Versions, ViewDim::Time]);
    q.show_summaries = false;

    let result = run(&w.model, &q);

    assert_eq!(result.column_dims, vec![ViewDim::Versions, ViewDim::Time]);
    assert_eq!(result.total_columns, 36);
    // The last dimension varies fastest: all months of Actual, then of Budget, then of Forecast.
    let pairs: Vec<(&str, &str)> = result
        .columns
        .iter()
        .map(|header| {
            assert_eq!(header.members.len(), 2);
            (
                header.members[0].label.as_str(),
                header.members[1].label.as_str(),
            )
        })
        .collect();
    assert_eq!(pairs[0], ("Actual", "Apr 26"));
    assert_eq!(pairs[11], ("Actual", "Mar 27"));
    assert_eq!(pairs[12], ("Budget", "Apr 26"));
    assert_eq!(pairs[13], ("Budget", "May 26"));
    assert_eq!(pairs[24], ("Forecast", "Apr 26"));
    // The first row is US.
    assert_eq!(labels(&result.rows, 0)[0], "US");
    assert_eq!(number(&result.cells[0][13]), 7.0);
    assert_eq!(number(&result.cells[0][25]), 9.0);
    assert_eq!(number(&result.cells[0][1]), 0.0);

    // Nested row dimensions work the same way.
    let mut q = w.grid(vec![ViewDim::Versions, w.countries()], vec![ViewDim::Time]);
    q.show_summaries = false;
    let result = run(&w.model, &q);
    assert_eq!(result.total_rows, 9);
    assert_eq!(result.rows[3].members[0].label, "Budget");
    assert_eq!(result.rows[3].members[1].label, "US");
    assert_eq!(number(&result.cells[3][1]), 7.0);
}

#[test]
fn summary_cells_read_aggregates_and_are_readonly() {
    let mut w = world();
    w.put(w.us, "Apr 26", "Budget", 10.0);
    w.put(w.us, "May 26", "Budget", 20.0);
    w.put(w.ca, "Apr 26", "Budget", 5.0);
    w.put(w.de, "Apr 26", "Budget", 1.0);
    let q = w.grid(vec![w.countries()], vec![ViewDim::Time]);

    let result = run(&w.model, &q);

    assert_eq!(
        labels(&result.rows, 0),
        vec!["All Countries", "North America", "US", "CA", "Europe", "DE"]
    );
    let cell = |row: usize, col: usize| &result.cells[row][col];
    // Leaves are inputs.
    assert_eq!(number(cell(2, 0)), 10.0);
    assert_eq!(cell(2, 0).flags, vec![CellFlag::Input]);
    assert_eq!(number(cell(5, 0)), 1.0);
    // A parent in the same month adds up its children.
    assert_eq!(number(cell(1, 0)), 15.0);
    assert_eq!(
        cell(1, 0).flags,
        vec![CellFlag::Summary, CellFlag::Readonly]
    );
    assert_eq!(number(cell(0, 0)), 16.0);
    assert_eq!(number(cell(4, 0)), 1.0);
    // A quarter adds up its months of a leaf, and the total everything.
    assert_eq!(number(cell(2, 3)), 30.0);
    assert_eq!(
        cell(2, 3).flags,
        vec![CellFlag::Summary, CellFlag::Readonly]
    );
    assert_eq!(number(cell(0, 19)), 36.0);
    assert_eq!(number(cell(0, 8)), 36.0);
    assert_eq!(numbers(&result.cells[2])[..4], [10.0, 20.0, 0.0, 30.0]);
}

#[test]
fn calculated_and_input_flags() {
    let mut w = world();
    let revenue = formula_item(&mut w.model, w.sales, "Revenue", 2, "Units * 2");
    w.put(w.us, "Apr 26", "Budget", 10.0);
    let q = w.grid(vec![ViewDim::LineItems], vec![w.countries()]);

    let result = run(&w.model, &q);

    assert_eq!(labels(&result.rows, 0), vec!["Units", "Revenue"]);
    assert_eq!(
        labels(&result.columns, 0),
        vec!["All Countries", "North America", "US", "CA", "Europe", "DE"]
    );
    let units = &result.cells[0];
    assert_eq!(units[2].flags, vec![CellFlag::Input]);
    assert_eq!(number(&units[2]), 10.0);
    assert_eq!(units[0].flags, vec![CellFlag::Summary, CellFlag::Readonly]);
    let revenue_row = &result.cells[1];
    assert_eq!(
        revenue_row[2].flags,
        vec![CellFlag::Calculated, CellFlag::Readonly]
    );
    assert_eq!(number(&revenue_row[2]), 20.0);
    assert_eq!(number(&revenue_row[0]), 20.0);
    assert_eq!(
        revenue_row[0].flags,
        vec![CellFlag::Summary, CellFlag::Readonly]
    );

    let calculated = &result.line_items[1];
    assert_eq!(calculated.id, revenue);
    assert!(!calculated.is_input);
    assert!(result.line_items[0].is_input);
}

#[test]
fn na_for_finer_time_and_version_scope() {
    let mut w = world();
    let budget = w.model.structure().version_by_name("Budget").unwrap().id;
    let quarterly = add(
        &mut w.model,
        LineItem {
            time_scale: TimeScale::Level(TimeLevel::Quarter),
            ..line_item(w.sales, "Quarterly", 2, Format::number(), None)
        },
    );
    let budget_only = add(
        &mut w.model,
        LineItem {
            versions: VersionsScope::Only(vec![budget]),
            ..line_item(w.sales, "Budget only", 3, Format::number(), None)
        },
    );
    let europe = SubsetId::new();
    w.model
        .apply(Command::CreateSubset {
            id: europe,
            list: w.countries,
            name: "European".to_string(),
            items: vec![w.de],
        })
        .unwrap();
    let in_europe = add(
        &mut w.model,
        LineItem {
            applies_to: Some(vec![AxisSpec::Subset { subset: europe }]),
            ..line_item(w.sales, "In Europe", 4, Format::number(), None)
        },
    );
    let regional = add(
        &mut w.model,
        LineItem {
            applies_to: Some(vec![AxisSpec::List { list: w.regions }]),
            ..line_item(w.sales, "Regional", 5, Format::number(), None)
        },
    );
    let at = vec![
        CoordToken::Item(w.de),
        period("Q1 FY27"),
        version_token(&w.model, "Budget"),
    ];
    set(&mut w.model, quarterly, at, num(4.0));
    let na = vec![CellFlag::Readonly, CellFlag::Na];

    // A month is finer than the quarters of a quarterly line item.
    let mut q = query_of(
        w.sales,
        vec![ViewDim::LineItems],
        vec![ViewDim::Time],
        vec![page_at(w.countries(), &key(w.de)), page(ViewDim::Versions)],
    );
    q.line_items = Some(vec![w.units, quarterly]);
    let result = run(&w.model, &q);
    let units = &result.cells[0];
    let quarters = &result.cells[1];
    assert_eq!(units[0].flags, vec![CellFlag::Input]);
    for month in [0, 1, 2] {
        assert_eq!(quarters[month].flags, na, "{}", MONTHS[month]);
        assert_eq!(quarters[month].value, num(0.0));
    }
    assert_eq!(quarters[3].flags, vec![CellFlag::Input]);
    assert_eq!(number(&quarters[3]), 4.0);
    // Halves, the year and the total add up quarters.
    assert_eq!(
        quarters[8].flags,
        vec![CellFlag::Summary, CellFlag::Readonly]
    );
    assert_eq!(number(&quarters[8]), 4.0);
    assert_eq!(number(&quarters[19]), 4.0);

    // Versions outside of a line item's scope.
    let mut q = query_of(
        w.sales,
        vec![ViewDim::LineItems],
        vec![ViewDim::Versions],
        vec![
            page_at(w.countries(), &key(w.de)),
            page_at(ViewDim::Time, "Apr 26"),
        ],
    );
    q.line_items = Some(vec![budget_only]);
    let result = run(&w.model, &q);
    assert_eq!(
        labels(&result.columns, 0),
        vec!["Actual", "Budget", "Forecast"]
    );
    let flags: Vec<Vec<CellFlag>> = result.cells[0]
        .iter()
        .map(|cell| cell.flags.clone())
        .collect();
    assert_eq!(flags, vec![na.clone(), vec![CellFlag::Input], na.clone()]);
    assert_eq!(
        result.line_items[0].dims,
        vec![w.countries(), ViewDim::Time, ViewDim::Versions]
    );

    // Countries that a subset leaves out, and a list the view does not have.
    let mut q = query_of(
        w.sales,
        vec![w.countries()],
        vec![ViewDim::LineItems],
        vec![page_at(ViewDim::Time, "Apr 26"), page(ViewDim::Versions)],
    );
    q.show_summaries = false;
    q.line_items = Some(vec![in_europe, regional]);
    let result = run(&w.model, &q);
    assert_eq!(labels(&result.rows, 0), vec!["US", "DE", "CA"]);
    let subset_column: Vec<Vec<CellFlag>> = result
        .cells
        .iter()
        .map(|row| row[0].flags.clone())
        .collect();
    assert_eq!(
        subset_column,
        vec![na.clone(), vec![CellFlag::Input], na.clone()]
    );
    assert!(result.cells.iter().all(|row| row[1].flags == na));
    assert_eq!(
        result.line_items[0].dims,
        vec![
            ViewDim::Subset { subset: europe },
            ViewDim::Time,
            ViewDim::Versions
        ]
    );
    assert_eq!(
        result.line_items[1].dims,
        vec![
            ViewDim::List { list: w.regions },
            ViewDim::Time,
            ViewDim::Versions
        ]
    );
}

#[test]
fn broadcast_when_line_item_lacks_dim() {
    let mut w = world();
    let fee = add(
        &mut w.model,
        LineItem {
            time_scale: TimeScale::None,
            ..line_item(w.sales, "Fee", 2, Format::number(), None)
        },
    );
    let rate = add(
        &mut w.model,
        LineItem {
            versions: VersionsScope::None,
            ..line_item(w.sales, "Rate", 3, Format::number(), None)
        },
    );
    let at = vec![CoordToken::Item(w.us), version_token(&w.model, "Budget")];
    set(&mut w.model, fee, at, num(12.0));
    set(
        &mut w.model,
        rate,
        vec![CoordToken::Item(w.us), period("May 26")],
        num(3.0),
    );

    // The fee has no time: every period shows it, summaries included.
    let mut q = query_of(
        w.sales,
        vec![ViewDim::Time],
        vec![ViewDim::LineItems],
        vec![page_at(w.countries(), &key(w.us)), page(ViewDim::Versions)],
    );
    q.line_items = Some(vec![fee]);
    let result = run(&w.model, &q);
    assert_eq!(result.total_rows, 20);
    assert!(result.cells.iter().all(|row| number(&row[0]) == 12.0));
    assert!(
        result
            .cells
            .iter()
            .all(|row| row[0].flags == vec![CellFlag::Input])
    );
    assert_eq!(
        result.line_items[0].dims,
        vec![w.countries(), ViewDim::Versions]
    );

    // The rate has no versions: every version shows it.
    let mut q = query_of(
        w.sales,
        vec![ViewDim::Versions],
        vec![ViewDim::LineItems],
        vec![
            page_at(w.countries(), &key(w.us)),
            page_at(ViewDim::Time, "May 26"),
        ],
    );
    q.line_items = Some(vec![rate]);
    let result = run(&w.model, &q);
    assert_eq!(result.total_rows, 3);
    assert!(result.cells.iter().all(|row| number(&row[0]) == 3.0));
}

#[test]
fn switchover_cells_show_actual_readonly() {
    let mut w = world();
    let budget = w.model.structure().version_by_name("Budget").unwrap().id;
    w.model
        .apply(Command::UpsertVersion {
            id: budget,
            name: "Budget".to_string(),
            is_actual: false,
            is_current: true,
            switchover: Some(2),
        })
        .unwrap();
    formula_item(&mut w.model, w.sales, "Doubled", 2, "Units * 2");
    w.put(w.us, "Apr 26", "Actual", 100.0);
    w.put(w.us, "May 26", "Actual", 50.0);
    w.put(w.us, "Jun 26", "Actual", 5.0);
    w.put(w.us, "Jun 26", "Budget", 1.0);
    let mut q = query_of(
        w.sales,
        vec![ViewDim::Time],
        vec![ViewDim::LineItems],
        vec![page_at(w.countries(), &key(w.us)), page(ViewDim::Versions)],
    );

    let result = run(&w.model, &q);

    // The budget switches over at June: April and May are the actual ones.
    let units = |month: usize| &result.cells[month][0];
    let doubled = |month: usize| &result.cells[month][1];
    assert_eq!(labels(&result.rows, 0)[..3], ["Apr 26", "May 26", "Jun 26"]);
    assert_eq!(number(units(0)), 100.0);
    assert_eq!(
        units(0).flags,
        vec![CellFlag::Readonly, CellFlag::Switchover]
    );
    assert_eq!(number(units(1)), 50.0);
    assert_eq!(
        units(1).flags,
        vec![CellFlag::Readonly, CellFlag::Switchover]
    );
    assert_eq!(number(doubled(0)), 200.0);
    assert_eq!(
        doubled(0).flags,
        vec![
            CellFlag::Calculated,
            CellFlag::Readonly,
            CellFlag::Switchover
        ]
    );
    assert_eq!(number(units(2)), 1.0);
    assert_eq!(units(2).flags, vec![CellFlag::Input]);
    assert_eq!(
        doubled(2).flags,
        vec![CellFlag::Calculated, CellFlag::Readonly]
    );
    // The quarter adds up what the months show; it is a summary, not a switchover cell.
    assert_eq!(labels(&result.rows, 0)[3], "Q1 FY27");
    assert_eq!(number(units(3)), 151.0);
    assert_eq!(units(3).flags, vec![CellFlag::Summary, CellFlag::Readonly]);

    // The actual version has no switchover.
    q.pages = vec![
        page_at(w.countries(), &key(w.us)),
        page_at(ViewDim::Versions, &version_key(&w.model, "Actual")),
    ];
    let result = run(&w.model, &q);
    assert_eq!(number(&result.cells[0][0]), 100.0);
    assert_eq!(result.cells[0][0].flags, vec![CellFlag::Input]);
}

#[test]
fn error_line_item_cells_blank_with_flag() {
    let mut w = world();
    let broken = formula_item(&mut w.model, w.sales, "Broken", 2, "Units + 1");
    w.put(w.us, "Apr 26", "Budget", 10.0);
    w.model
        .apply(Command::UpdateLineItem {
            id: w.units,
            patch: LineItemPatch {
                name: Some("Volume".to_string()),
                ..LineItemPatch::default()
            },
        })
        .unwrap();
    assert!(w.model.line_item_errors(broken).is_some());
    let mut q = w.grid(vec![ViewDim::LineItems], vec![w.countries()]);
    q.line_items = Some(vec![w.units, broken]);

    let result = run(&w.model, &q);

    let volume = &result.cells[0];
    assert_eq!(volume[2].flags, vec![CellFlag::Input]);
    let broken_row = &result.cells[1];
    assert_eq!(broken_row.len(), 6);
    for cell in broken_row {
        assert_eq!(cell.value, num(0.0));
        assert_eq!(cell.flags, vec![CellFlag::Readonly, CellFlag::Error]);
    }
    assert!(result.line_items[0].errors.is_empty());
    let info = &result.line_items[1];
    assert!(!info.is_input);
    assert_eq!(info.errors[0].code, "formula.unknown_name");
}

#[test]
fn filter_rows_by_number_and_boolean() {
    let mut w = world();
    let active = add(
        &mut w.model,
        LineItem {
            time_scale: TimeScale::None,
            versions: VersionsScope::None,
            summary: SummaryMethod::Any,
            ..line_item(w.sales, "Active", 3, Format::Boolean, None)
        },
    );
    let revenue = formula_item(&mut w.model, w.sales, "Revenue", 2, "Units * 2");
    w.put(w.us, "Apr 26", "Budget", 10.0);
    w.put(w.us, "May 26", "Budget", 20.0);
    w.put(w.ca, "Apr 26", "Budget", 5.0);
    w.put(w.de, "Apr 26", "Budget", 1.0);
    for (country, on) in [(w.us, true), (w.ca, false), (w.de, true)] {
        set(
            &mut w.model,
            active,
            vec![CoordToken::Item(country)],
            Value::Boolean(on),
        );
    }
    let filter = |line_item, op, value| RowFilter {
        line_item,
        op,
        value,
    };
    let mut q = query_of(
        w.sales,
        vec![w.countries()],
        vec![ViewDim::LineItems],
        vec![page(ViewDim::Time), page(ViewDim::Versions)],
    );
    q.line_items = Some(vec![w.units]);
    q.show_summaries = false;

    // April of the budget: the page members give the filter's time and version.
    q.filters = vec![filter(w.units, FilterOp::Gt, Some(num(4.0)))];
    let result = run(&w.model, &q);
    assert_eq!(labels(&result.rows, 0), vec!["US", "CA"]);
    assert_eq!(result.total_rows, 2);
    assert_eq!(numbers(&result.cells[0]), vec![10.0]);

    q.filters = vec![filter(active, FilterOp::IsTrue, None)];
    assert_eq!(labels(&run(&w.model, &q).rows, 0), vec!["US", "DE"]);
    q.filters = vec![filter(active, FilterOp::IsFalse, None)];
    assert_eq!(labels(&run(&w.model, &q).rows, 0), vec!["CA"]);

    // Every filter has to pass.
    q.filters = vec![
        filter(w.units, FilterOp::Gt, Some(num(4.0))),
        filter(active, FilterOp::IsTrue, None),
    ];
    let result = run(&w.model, &q);
    assert_eq!(labels(&result.rows, 0), vec!["US"]);
    assert_eq!(result.total_rows, 1);

    for (op, value, expected) in [
        (FilterOp::Eq, 5.0, vec!["CA"]),
        (FilterOp::Ne, 5.0, vec!["US", "DE"]),
        (FilterOp::Lt, 5.0, vec!["DE"]),
        (FilterOp::Le, 5.0, vec!["DE", "CA"]),
        (FilterOp::Ge, 5.0, vec!["US", "CA"]),
    ] {
        q.filters = vec![filter(w.units, op, Some(num(value)))];
        assert_eq!(labels(&run(&w.model, &q).rows, 0), expected, "{op:?}");
    }

    // A filter on summary rows reads their totals.
    q.show_summaries = true;
    q.filters = vec![filter(w.units, FilterOp::Gt, Some(num(9.0)))];
    let result = run(&w.model, &q);
    assert_eq!(
        labels(&result.rows, 0),
        vec!["All Countries", "North America", "US"]
    );

    // A dimension on the columns is read at its total, and the line items on rows are not filtered.
    let mut q = query_of(
        w.sales,
        vec![w.countries(), ViewDim::LineItems],
        vec![ViewDim::Time],
        vec![page(ViewDim::Versions)],
    );
    q.show_summaries = false;
    q.line_items = Some(vec![w.units, revenue]);
    q.filters = vec![filter(w.units, FilterOp::Gt, Some(num(8.0)))];
    let result = run(&w.model, &q);
    assert_eq!(result.total_rows, 2);
    assert_eq!(result.rows[0].members[0].label, "US");
    assert_eq!(result.rows[0].members[1].label, "Units");
    assert_eq!(result.rows[1].members[1].label, "Revenue");
    assert_eq!(number(&result.cells[0][1]), 20.0);
    assert_eq!(number(&result.cells[1][1]), 40.0);
}

#[test]
fn filter_on_text_and_blank_values() {
    let mut w = world();
    let note = add(
        &mut w.model,
        LineItem {
            time_scale: TimeScale::None,
            versions: VersionsScope::None,
            summary: SummaryMethod::None,
            ..line_item(w.sales, "Note", 2, Format::Text, None)
        },
    );
    set(
        &mut w.model,
        note,
        vec![CoordToken::Item(w.us)],
        Value::Text("Strategic account".into()),
    );
    set(
        &mut w.model,
        note,
        vec![CoordToken::Item(w.de)],
        Value::Text("Standard".into()),
    );
    let mut q = query_of(
        w.sales,
        vec![w.countries()],
        vec![ViewDim::LineItems],
        vec![page(ViewDim::Time), page(ViewDim::Versions)],
    );
    q.show_summaries = false;
    q.line_items = Some(vec![note]);
    let filter = |op, value: Option<&str>| RowFilter {
        line_item: note,
        op,
        value: value.map(|text| Value::Text(text.into())),
    };

    q.filters = vec![filter(FilterOp::Contains, Some("STRAT"))];
    assert_eq!(labels(&run(&w.model, &q).rows, 0), vec!["US"]);
    q.filters = vec![filter(FilterOp::Eq, Some("standard"))];
    assert_eq!(labels(&run(&w.model, &q).rows, 0), vec!["DE"]);
    q.filters = vec![filter(FilterOp::IsBlank, None)];
    assert_eq!(labels(&run(&w.model, &q).rows, 0), vec!["CA"]);
    q.filters = vec![filter(FilterOp::NotBlank, None)];
    assert_eq!(labels(&run(&w.model, &q).rows, 0), vec!["US", "DE"]);
    q.filters = vec![filter(FilterOp::Contains, None)];
    assert!(invalid(&w.model, &q).contains("needs a value"));
}

#[test]
fn filter_line_item_with_foreign_dim_rejected() {
    let mut w = world();
    let products = ListId::new();
    w.model
        .apply(Command::CreateList {
            id: products,
            name: "Products".to_string(),
            parent: None,
            top_level_name: None,
            numbered: false,
            production_data: false,
        })
        .unwrap();
    let stock_module = new_module(
        &mut w.model,
        "Stock",
        vec![AxisSpec::List { list: products }],
    );
    let stock = number_item(&mut w.model, stock_module, "Stock level", 1);
    let mut q = w.grid(vec![w.countries()], vec![ViewDim::LineItems]);
    q.filters = vec![RowFilter {
        line_item: stock,
        op: FilterOp::Gt,
        value: Some(num(1.0)),
    }];

    let message = invalid(&w.model, &q);

    assert_eq!(
        message,
        "Filter line item 'Stock level' has a dimension this view doesn't have."
    );
}

#[test]
fn every_dim_placed_once_validation() {
    let w = world();
    let countries = w.countries();
    let base = || {
        query_of(
            w.sales,
            vec![ViewDim::LineItems],
            vec![ViewDim::Time],
            vec![page(countries.clone()), page(ViewDim::Versions)],
        )
    };
    run(&w.model, &base());

    let mut q = base();
    q.pages.pop();
    let message = invalid(&w.model, &q);
    assert!(
        message.contains("Versions") && message.contains("missing"),
        "{message}"
    );

    let mut q = base();
    q.pages.push(page(ViewDim::Time));
    let message = invalid(&w.model, &q);
    assert!(
        message.contains("Time") && message.contains("more than once"),
        "{message}"
    );

    let mut q = base();
    q.rows.push(ViewDim::LineItems);
    assert!(invalid(&w.model, &q).contains("Line items"));

    let mut q = base();
    q.pages.push(page(ViewDim::List { list: w.regions }));
    let message = invalid(&w.model, &q);
    assert!(
        message.contains("Regions") && message.contains("doesn't have"),
        "{message}"
    );

    let mut q = base();
    q.pages[1] = page_at(ViewDim::Versions, "not-a-version");
    let message = invalid(&w.model, &q);
    assert!(
        message.contains("not-a-version") && message.contains("Versions"),
        "{message}"
    );
    q.pages[1] = page_at(ViewDim::Versions, &version_key(&w.model, "Forecast"));
    assert_eq!(run(&w.model, &q).pages[1].member.label, "Forecast");

    let mut q = base();
    q.pages[0] = page_at(countries.clone(), &ItemId::new().0.to_string());
    assert!(invalid(&w.model, &q).contains("Countries"));
    q.pages[0] = page_at(countries.clone(), &key(w.na));
    let result = run(&w.model, &q);
    assert_eq!(result.pages[0].member.label, "North America");
    assert!(result.pages[0].member.is_summary);
    q.pages[0] = page_at(countries.clone(), "top");
    assert_eq!(run(&w.model, &q).pages[0].member.key, "top");

    let mut q = base();
    q.collapsed = vec![MemberRef {
        dim: ViewDim::Time,
        key: "Smarch 99".to_string(),
    }];
    assert!(invalid(&w.model, &q).contains("Smarch 99"));
    let mut q = base();
    q.hidden = vec![MemberRef {
        dim: countries.clone(),
        key: "nobody".to_string(),
    }];
    assert!(invalid(&w.model, &q).contains("nobody"));
    let mut q = base();
    q.hidden = vec![MemberRef {
        dim: ViewDim::Subset {
            subset: SubsetId::new(),
        },
        key: key(w.us),
    }];
    assert!(invalid(&w.model, &q).contains("doesn't have"));

    let mut q = base();
    q.window.row_limit = 1001;
    assert!(invalid(&w.model, &q).contains("row_limit"));
    let mut q = base();
    q.window.col_limit = 201;
    assert!(invalid(&w.model, &q).contains("col_limit"));

    let mut q = base();
    q.line_items = Some(vec![LineItemId::new()]);
    assert!(invalid(&w.model, &q).contains("line item"));
    let mut q = base();
    q.line_items = Some(vec![w.units, w.units]);
    assert!(invalid(&w.model, &q).contains("more than once"));

    let mut q = base();
    q.module = ModuleId::new();
    assert_eq!(
        query(&w.model, &q).unwrap_err().code(),
        "structure.not_found"
    );
}

#[test]
fn members_endpoint_matches_query_members() {
    let mut w = world();
    number_item(&mut w.model, w.sales, "Price", 2);
    for show_summaries in [true, false] {
        for dim in [
            w.countries(),
            ViewDim::Time,
            ViewDim::Versions,
            ViewDim::LineItems,
        ] {
            let mut q = w.grid(vec![dim.clone()], Vec::new());
            q.show_summaries = show_summaries;
            let result = run(&w.model, &q);
            let from_query: Vec<Member> = result
                .rows
                .iter()
                .map(|header| header.members[0].clone())
                .collect();

            let listed = members(&w.model, w.sales, &dim, show_summaries).unwrap();

            assert_eq!(
                listed, from_query,
                "{dim:?} with summaries {show_summaries}"
            );
            assert!(!listed.is_empty());
        }
    }
    let versions = members(&w.model, w.sales, &ViewDim::Versions, true).unwrap();
    assert_eq!(
        member_labels(&versions),
        vec!["Actual", "Budget", "Forecast"]
    );
    let line_items = members(&w.model, w.sales, &ViewDim::LineItems, true).unwrap();
    assert_eq!(line_items[0].key, w.units.0.to_string());

    let error = members(&w.model, w.sales, &ViewDim::List { list: w.regions }, true).unwrap_err();
    assert_eq!(error.code(), "structure.invalid");
    let error = members(&w.model, ModuleId::new(), &ViewDim::Time, true).unwrap_err();
    assert_eq!(error.code(), "structure.not_found");
}

#[test]
fn line_items_choose_and_order_the_line_item_members() {
    let mut w = world();
    let price = number_item(&mut w.model, w.sales, "Price", 2);
    let mut q = w.grid(vec![ViewDim::LineItems], vec![ViewDim::Time]);
    q.line_items = Some(vec![price]);

    let result = run(&w.model, &q);

    assert_eq!(labels(&result.rows, 0), vec!["Price"]);
    assert_eq!(result.line_items.len(), 1);
    assert_eq!(result.line_items[0].id, price);
    q.line_items = Some(vec![price, w.units]);
    let result = run(&w.model, &q);
    assert_eq!(labels(&result.rows, 0), vec!["Price", "Units"]);

    // As a page, the first of them is the default.
    let mut q = w.grid(vec![w.countries()], vec![ViewDim::Time]);
    q.line_items = Some(vec![price, w.units]);
    assert_eq!(run(&w.model, &q).pages[0].member.label, "Price");
}

#[test]
fn item_and_period_values_carry_their_text() {
    let mut w = world();
    let main = add(
        &mut w.model,
        LineItem {
            time_scale: TimeScale::None,
            versions: VersionsScope::None,
            summary: SummaryMethod::None,
            ..line_item(
                w.sales,
                "Main market",
                2,
                Format::List { list: w.countries },
                None,
            )
        },
    );
    let peak = add(
        &mut w.model,
        LineItem {
            time_scale: TimeScale::None,
            versions: VersionsScope::None,
            summary: SummaryMethod::None,
            ..line_item(
                w.sales,
                "Peak quarter",
                3,
                Format::TimePeriod {
                    level: TimeLevel::Quarter,
                },
                None,
            )
        },
    );
    set(
        &mut w.model,
        main,
        vec![CoordToken::Item(w.us)],
        Value::Item(Some(w.de)),
    );
    set(
        &mut w.model,
        peak,
        vec![CoordToken::Item(w.us)],
        Value::Period(Some((TimeLevel::Quarter, 1))),
    );
    let mut q = query_of(
        w.sales,
        vec![w.countries()],
        vec![ViewDim::LineItems],
        vec![page(ViewDim::Time), page(ViewDim::Versions)],
    );
    q.show_summaries = false;
    q.line_items = Some(vec![main, peak]);

    let result = run(&w.model, &q);

    assert_eq!(result.cells[0][0].value, Value::Item(Some(w.de)));
    assert_eq!(result.cells[0][0].text.as_deref(), Some("DE"));
    assert_eq!(
        result.cells[0][1].value,
        Value::Period(Some((TimeLevel::Quarter, 1)))
    );
    assert_eq!(result.cells[0][1].text.as_deref(), Some("Q2 FY27"));
    // Blank values and numbers have no text.
    assert_eq!(result.cells[1][0].value, Value::Item(None));
    assert_eq!(result.cells[1][0].text, None);

    // A filter can look for the name of an item.
    q.filters = vec![RowFilter {
        line_item: main,
        op: FilterOp::Contains,
        value: Some(Value::Text("de".into())),
    }];
    assert_eq!(labels(&run(&w.model, &q).rows, 0), vec!["US"]);
}

#[test]
fn dimensions_on_pages_alone_make_a_single_cell() {
    let mut w = world();
    w.put(w.us, "Apr 26", "Budget", 10.0);
    let q = query_of(
        w.sales,
        Vec::new(),
        Vec::new(),
        vec![
            page(ViewDim::LineItems),
            page_at(w.countries(), &key(w.us)),
            page(ViewDim::Time),
            page(ViewDim::Versions),
        ],
    );

    let result = run(&w.model, &q);

    assert_eq!((result.total_rows, result.total_columns), (1, 1));
    assert!(result.rows[0].members.is_empty());
    assert!(result.columns[0].members.is_empty());
    assert_eq!(number(&result.cells[0][0]), 10.0);
    assert_eq!(result.cells[0][0].flags, vec![CellFlag::Input]);
}

#[test]
fn a_page_without_members_makes_an_empty_view() {
    let mut w = world();
    let products = ListId::new();
    w.model
        .apply(Command::CreateList {
            id: products,
            name: "Products".to_string(),
            parent: None,
            top_level_name: None,
            numbered: false,
            production_data: false,
        })
        .unwrap();
    let empty = new_module(
        &mut w.model,
        "Empty",
        vec![AxisSpec::List { list: products }],
    );
    number_item(&mut w.model, empty, "Count", 1);
    let q = query_of(
        empty,
        vec![ViewDim::LineItems],
        Vec::new(),
        vec![page(ViewDim::List { list: products })],
    );

    let result = run(&w.model, &q);

    assert!(result.pages.is_empty());
    assert!(result.rows.is_empty() && result.columns.is_empty() && result.cells.is_empty());
    assert_eq!((result.total_rows, result.total_columns), (0, 0));
    assert_eq!(result.line_items.len(), 1);
}

#[test]
fn json_is_snake_case_and_tagged_like_the_web_types() {
    let mut w = world();
    w.put(w.us, "Apr 26", "Budget", 10.0);
    let body = json!({
        "module": w.sales,
        "rows": [{"kind": "line_items"}],
        "columns": [{"kind": "time"}],
        "pages": [
            {"dim": {"kind": "list", "list": w.countries}, "key": null},
            {"dim": {"kind": "versions"}}
        ],
        "filters": [{"line_item": w.units, "op": "is_blank"}],
        "collapsed": [{"dim": {"kind": "time"}, "key": "Q1 FY27"}],
        "window": {"row_offset": 0, "row_limit": 10, "col_offset": 0, "col_limit": 4}
    });

    let mut q: ViewQuery = serde_json::from_value(body).unwrap();

    assert!(q.show_summaries);
    assert!(q.hidden.is_empty());
    assert_eq!(q.line_items, None);
    assert_eq!(q.pages[1].key, None);
    assert_eq!(q.filters[0].op, FilterOp::IsBlank);
    q.filters.clear();

    let out = serde_json::to_value(run(&w.model, &q)).unwrap();

    assert_eq!(out["row_dims"], json!([{"kind": "line_items"}]));
    assert_eq!(out["column_dims"], json!([{"kind": "time"}]));
    assert_eq!(
        out["pages"][0],
        json!({"dim": {"kind": "list", "list": w.countries}, "member": {
            "key": "top", "label": "All Countries", "depth": 0,
            "is_summary": true, "has_children": true, "collapsed": false
        }})
    );
    assert_eq!(out["rows"][0]["members"][0]["label"], "Units");
    assert_eq!(out["columns"][0]["members"][0]["collapsed"], true);
    assert_eq!(out["total_rows"], 1);
    assert_eq!(out["total_columns"], 17);
    assert_eq!(
        out["cells"][0][0],
        json!({"value": {"t": "number", "v": 10.0}, "flags": ["summary", "readonly"]})
    );
    assert_eq!(out["line_items"][0]["id"], json!(w.units));
    assert_eq!(out["line_items"][0]["is_input"], true);
    assert_eq!(out["line_items"][0]["format"]["type"], "number");
    assert_eq!(
        out["line_items"][0]["dims"],
        json!([{"kind": "list", "list": w.countries}, {"kind": "time"}, {"kind": "versions"}])
    );
    assert_eq!(out["line_items"][0]["errors"], json!([]));
}
