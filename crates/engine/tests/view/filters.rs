use crate::common::*;
use openplan_engine::{
    AxisSpec, Command, CoordToken, FilterOp, Format, LineItem, ListId, RowFilter, SummaryMethod,
    TimeScale, Value, VersionsScope, ViewDim,
};

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
