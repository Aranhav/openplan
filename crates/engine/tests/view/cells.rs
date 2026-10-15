use crate::common::*;
use openplan_engine::{
    AxisSpec, CellFlag, Command, CoordToken, FilterOp, Format, LineItem, LineItemPatch, RowFilter,
    SubsetId, SummaryMethod, TimeLevel, TimeScale, Value, VersionsScope, ViewDim,
};

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
