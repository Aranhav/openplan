use crate::common::*;
use openplan_engine::view::query_with;
use openplan_engine::{
    AxisSpec, CellEdit, Command, CoordToken, FilterOp, Format, ItemId, LineItem, LineItemId,
    ListId, Model, ModuleId, RowFilter, SubsetId, SummaryMethod, TimeScale, Value, VersionsScope,
    ViewDim, ViewQuery,
};
use std::sync::Arc;

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
fn filters_read_column_dims_at_their_totals_and_the_current_version() {
    let mut w = world();
    w.put(w.us, "Apr 26", "Budget", 10.0);
    w.put(w.ca, "Apr 26", "Budget", 5.0);
    w.put(w.de, "Apr 26", "Budget", 1.0);
    w.put(w.us, "May 26", "Budget", 20.0);
    w.put(w.us, "Jun 26", "Forecast", 100.0);
    let filter = |op, value| RowFilter {
        line_item: w.units,
        op,
        value: Some(num(value)),
    };
    // Months on rows; the countries and the versions on columns are read at the total of the
    // countries and in the current version, the budget: April adds up to 16, May to 20.
    let mut q = query_of(
        w.sales,
        vec![ViewDim::Time],
        vec![w.countries(), ViewDim::Versions],
        vec![page(ViewDim::LineItems)],
    );
    q.show_summaries = false;
    q.filters = vec![filter(FilterOp::Gt, 17.0)];
    assert_eq!(labels(&run(&w.model, &q).rows, 0), vec!["May 26"]);
    q.filters = vec![filter(FilterOp::Gt, 15.0)];
    assert_eq!(labels(&run(&w.model, &q).rows, 0), vec!["Apr 26", "May 26"]);
}

#[test]
fn filters_read_a_subset_column_at_its_total() {
    let mut model = Model::new(calendar());
    let products = ListId::new();
    let [widget, gadget] = std::array::from_fn(|_| ItemId::new());
    let picked = SubsetId::new();
    model
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
                id: picked,
                list: products,
                name: "Picked".to_string(),
                items: vec![gadget, widget],
            },
        ])
        .unwrap();
    let stock = new_module(
        &mut model,
        "Stock",
        vec![AxisSpec::Subset { subset: picked }, AxisSpec::Versions],
    );
    let count = number_item(&mut model, stock, "Count", 1);
    for (item, version, value) in [
        (gadget, "Budget", 5.0),
        (widget, "Budget", 7.0),
        (gadget, "Forecast", 1.0),
    ] {
        let at = vec![CoordToken::Item(item), version_token(&model, version)];
        set(&mut model, count, at, num(value));
    }
    let subset = ViewDim::Subset { subset: picked };
    let filter = |value| RowFilter {
        line_item: count,
        op: FilterOp::Gt,
        value: Some(num(value)),
    };

    // The versions on rows read the subset at the total of its list: 12 in the budget, 1 in the
    // forecast.
    let mut q = query_of(
        stock,
        vec![ViewDim::Versions],
        vec![subset.clone()],
        vec![page(ViewDim::LineItems)],
    );
    q.filters = vec![filter(10.0)];
    assert_eq!(labels(&run(&model, &q).rows, 0), vec!["Budget"]);

    // The subset on rows reads the current version.
    let mut q = query_of(
        stock,
        vec![subset],
        vec![ViewDim::Versions],
        vec![page(ViewDim::LineItems)],
    );
    q.filters = vec![filter(6.0)];
    assert_eq!(labels(&run(&model, &q).rows, 0), vec!["Widget"]);
}

#[test]
fn a_filter_value_must_fit_the_line_item() {
    let mut w = world();
    let own = |name: &str, format: Format, ordinal: i32| LineItem {
        time_scale: TimeScale::None,
        versions: VersionsScope::None,
        summary: SummaryMethod::None,
        ..line_item(w.sales, name, ordinal, format, None)
    };
    let note = add(&mut w.model, own("Note", Format::Text, 2));
    let active = add(&mut w.model, own("Active", Format::Boolean, 3));
    let due = add(&mut w.model, own("Due", Format::Date, 4));
    let mut q = w.grid(vec![w.countries()], vec![ViewDim::LineItems]);

    let cases = [
        (
            w.units,
            FilterOp::Gt,
            Value::Text("many".into()),
            "Filter on 'Units' needs a number.",
        ),
        (note, FilterOp::Eq, num(1.0), "Filter on 'Note' needs text."),
        (
            note,
            FilterOp::Contains,
            num(1.0),
            "Filter on 'Note' needs text.",
        ),
        (
            w.units,
            FilterOp::Contains,
            Value::Text("1".into()),
            "Contains needs a text or list line item.",
        ),
        (
            active,
            FilterOp::Contains,
            Value::Text("true".into()),
            "Contains needs a text or list line item.",
        ),
        (
            due,
            FilterOp::Contains,
            Value::Text("2026".into()),
            "Contains needs a text or list line item.",
        ),
        (
            active,
            FilterOp::Eq,
            num(1.0),
            "Filter on 'Active' needs a boolean.",
        ),
        (due, FilterOp::Lt, num(1.0), "Filter on 'Due' needs a date."),
    ];
    for (line_item, op, value, message) in cases {
        q.filters = vec![RowFilter {
            line_item,
            op,
            value: Some(value),
        }];
        assert_eq!(invalid(&w.model, &q), message);
    }

    // Operations that take no value ignore one: nothing has been entered, so every row is blank.
    let everything = run(&w.model, &q_without_filters(&q)).total_rows;
    assert!(everything > 0);
    q.filters = vec![RowFilter {
        line_item: w.units,
        op: FilterOp::IsBlank,
        value: Some(Value::Text("ignored".into())),
    }];
    assert_eq!(run(&w.model, &q).total_rows, everything);
}

fn q_without_filters(q: &ViewQuery) -> ViewQuery {
    ViewQuery {
        filters: Vec::new(),
        ..q.clone()
    }
}

#[test]
fn filters_read_the_rows_in_chunks() {
    // More rows than the 16,384 a filter reads at a time, so that rows on both sides of a
    // chunk boundary have to be told apart.
    const ITEMS: usize = 20_000;
    let mut model = Model::new(calendar());
    let (list, items) = model_with_list(&mut model, "Item", ITEMS);
    let module = new_module(&mut model, "Counts", vec![AxisSpec::List { list }]);
    let count = number_item(&mut model, module, "Count", 1);
    let edits = items
        .iter()
        .step_by(3)
        .map(|item| CellEdit {
            coords: vec![CoordToken::Item(*item)],
            value: num(1.0),
        })
        .collect();
    model
        .apply(Command::SetCells {
            line_item: count,
            edits,
        })
        .unwrap();
    let mut q = query_of(
        module,
        vec![ViewDim::List { list }],
        vec![ViewDim::LineItems],
        Vec::new(),
    );
    let filter = |op, value| RowFilter {
        line_item: count,
        op,
        value: Some(num(value)),
    };
    q.filters = vec![filter(FilterOp::Gt, 0.0), filter(FilterOp::Lt, 2.0)];
    q.window.row_offset = 5_460;
    q.window.row_limit = 4;

    let result = run(&model, &q);

    // Every third item is set; the 5,461st of them is item 16,383, the last of the first chunk.
    assert_eq!(result.total_rows, ITEMS.div_ceil(3));
    assert_eq!(
        labels(&result.rows, 0),
        vec!["Item 16380", "Item 16383", "Item 16386", "Item 16389"]
    );
    assert!(result.cells.iter().all(|row| number(&row[0]) == 1.0));
}

#[test]
fn a_filtered_view_of_too_many_rows_is_refused() {
    let mut model = Model::new(calendar());
    let (a, a_items) = model_with_list(&mut model, "A", 1_500);
    let (b, b_items) = model_with_list(&mut model, "B", 1_500);
    let module = new_module(
        &mut model,
        "Pairs",
        vec![AxisSpec::List { list: a }, AxisSpec::List { list: b }],
    );
    let count = number_item(&mut model, module, "Count", 1);
    set(
        &mut model,
        count,
        vec![CoordToken::Item(a_items[0]), CoordToken::Item(b_items[7])],
        num(3.0),
    );
    let dim_a = ViewDim::List { list: a };
    let dim_b = ViewDim::List { list: b };
    let filter = RowFilter {
        line_item: count,
        op: FilterOp::Gt,
        value: Some(num(0.0)),
    };

    // Without a filter no row is looked at but those of the window.
    let mut q = query_of(
        module,
        vec![dim_a.clone(), dim_b.clone()],
        vec![ViewDim::LineItems],
        Vec::new(),
    );
    assert_eq!(run(&model, &q).total_rows, 2_250_000);

    q.filters = vec![filter.clone()];
    assert_eq!(
        invalid(&model, &q),
        "This view has 2,250,000 rows to filter; the limit is 2,000,000. \
         Narrow it with page selections."
    );

    // Narrowed by a page, the view can be filtered: the one cell that is set is the only row left.
    let mut q = query_of(
        module,
        vec![dim_b],
        vec![ViewDim::LineItems],
        vec![page(dim_a)],
    );
    q.filters = vec![filter];
    let result = run(&model, &q);
    assert_eq!(result.total_rows, 1);
    assert_eq!(labels(&result.rows, 0), vec!["B 7"]);
    assert_eq!(number(&result.cells[0][0]), 3.0);
}

/// A line item with a single cell for the whole module, which a filter can read in a view of
/// any number of rows without the module having the cells for them.
fn single_cell_item(model: &mut Model, module: ModuleId) -> LineItemId {
    add(
        model,
        LineItem {
            applies_to: Some(Vec::new()),
            ..line_item(module, "Count", 1, Format::number(), None)
        },
    )
}

#[test]
fn the_limit_on_the_rows_of_a_filtered_view_is_exact() {
    let mut model = Model::new(calendar());
    let (a, _) = model_with_list(&mut model, "A", 3);
    let (b, _) = model_with_list(&mut model, "B", 666_667);
    let module = new_module(
        &mut model,
        "Pairs",
        vec![AxisSpec::List { list: a }, AxisSpec::List { list: b }],
    );
    let count = single_cell_item(&mut model, module);
    let mut q = query_of(
        module,
        vec![ViewDim::List { list: a }, ViewDim::List { list: b }],
        vec![ViewDim::LineItems],
        Vec::new(),
    );
    q.filters = vec![RowFilter {
        line_item: count,
        op: FilterOp::Gt,
        value: Some(num(0.0)),
    }];

    // One row more than the limit is refused, before a cell is read.
    assert_eq!(
        invalid(&model, &q),
        "This view has 2,000,001 rows to filter; the limit is 2,000,000. \
         Narrow it with page selections."
    );
}

#[test]
fn a_filtered_view_of_exactly_the_limit_is_filtered() {
    let mut model = Model::new(calendar());
    let (a, _) = model_with_list(&mut model, "A", 2_000);
    let (b, _) = model_with_list(&mut model, "B", 1_000);
    let module = new_module(
        &mut model,
        "Pairs",
        vec![AxisSpec::List { list: a }, AxisSpec::List { list: b }],
    );
    let count = single_cell_item(&mut model, module);
    set(&mut model, count, Vec::new(), num(1.0));
    let mut q = query_of(
        module,
        vec![ViewDim::List { list: a }, ViewDim::List { list: b }],
        vec![ViewDim::LineItems],
        Vec::new(),
    );
    q.filters = vec![RowFilter {
        line_item: count,
        op: FilterOp::Gt,
        value: Some(num(0.0)),
    }];

    let result = run(&model, &q);

    assert_eq!(result.total_rows, 2_000_000);
}

#[test]
fn a_view_with_more_rows_than_a_count_holds_is_refused_and_not_overflowed() {
    let mut model = Model::new(calendar());
    let lists: Vec<ListId> = (0..5)
        .map(|at| model_with_list(&mut model, &format!("List {at}"), 10_000).0)
        .collect();
    let module = new_module(
        &mut model,
        "Cube",
        lists.iter().map(|&list| AxisSpec::List { list }).collect(),
    );
    let count = single_cell_item(&mut model, module);
    let mut q = query_of(
        module,
        lists.iter().map(|&list| ViewDim::List { list }).collect(),
        vec![ViewDim::LineItems],
        Vec::new(),
    );
    q.filters = vec![RowFilter {
        line_item: count,
        op: FilterOp::Gt,
        value: Some(num(0.0)),
    }];

    // 10,000 to the fifth power is 10^20, which is more than a count holds; it saturates.
    assert_eq!(
        invalid(&model, &q),
        format!(
            "This view has {} rows to filter; the limit is 2,000,000. \
             Narrow it with page selections.",
            "18,446,744,073,709,551,615"
        )
    );
    q.filters.clear();
    assert_eq!(run(&model, &q).total_rows, usize::MAX);
}

#[test]
fn a_contains_filter_matches_the_names_of_list_items() {
    let mut w = world();
    let region = add(
        &mut w.model,
        LineItem {
            time_scale: TimeScale::None,
            versions: VersionsScope::None,
            summary: SummaryMethod::None,
            ..line_item(w.sales, "Region", 2, Format::List { list: w.regions }, None)
        },
    );
    set(
        &mut w.model,
        region,
        vec![CoordToken::Item(w.us)],
        Value::Item(Some(w.na)),
    );
    let mut q = query_of(
        w.sales,
        vec![w.countries()],
        vec![ViewDim::LineItems],
        vec![page(ViewDim::Time), page(ViewDim::Versions)],
    );
    q.show_summaries = false;
    q.line_items = Some(vec![region]);
    let contains = |text: &str| RowFilter {
        line_item: region,
        op: FilterOp::Contains,
        value: Some(Value::Text(text.into())),
    };

    q.filters = vec![contains("AMERICA")];
    assert_eq!(labels(&run(&w.model, &q).rows, 0), vec!["US"]);
    q.filters = vec![contains("europe")];
    assert_eq!(run(&w.model, &q).total_rows, 0);
}

/// A view of the countries that sell more than 4 units in April of the budget, with its window
/// on one row.
fn busy_countries() -> (World, ViewQuery) {
    let mut w = world();
    w.put(w.us, "Apr 26", "Budget", 10.0);
    w.put(w.ca, "Apr 26", "Budget", 5.0);
    w.put(w.de, "Apr 26", "Budget", 1.0);
    let mut q = w.grid(vec![w.countries()], vec![ViewDim::LineItems]);
    q.show_summaries = false;
    q.filters = vec![RowFilter {
        line_item: w.units,
        op: FilterOp::Gt,
        value: Some(num(4.0)),
    }];
    q.window.row_limit = 1;
    (w, q)
}

#[test]
fn the_rows_that_pass_are_reused_by_another_window_of_the_same_view() {
    let (w, mut q) = busy_countries();
    let (first, passing) = query_with(&w.model, &q, None).unwrap();
    let passing = passing.expect("a filtered view has rows that pass");
    assert_eq!(labels(&first.rows, 0), vec!["US"]);
    assert_eq!(first.total_rows, 2);

    q.window.row_offset = 1;
    let (second, reused) = query_with(&w.model, &q, Some(&passing)).unwrap();

    // The same set, not one worked out again, and the window it gives is the one a query gives.
    assert!(Arc::ptr_eq(&reused.unwrap(), &passing));
    assert_eq!(labels(&second.rows, 0), vec!["CA"]);
    assert_eq!(second, run(&w.model, &q));
}

#[test]
fn an_unfiltered_view_has_no_rows_that_pass() {
    let (w, mut q) = busy_countries();
    let (_, passing) = query_with(&w.model, &q, None).unwrap();
    let passing = passing.unwrap();
    q.filters.clear();

    let (without, none) = query_with(&w.model, &q, Some(&passing)).unwrap();

    assert!(none.is_none());
    assert_eq!(without, run(&w.model, &q));
    assert_eq!(without.total_rows, 3);
}

#[test]
fn rows_that_do_not_fit_the_view_are_worked_out_again() {
    let (w, q) = busy_countries();
    let wrong = Arc::new(vec![0, 1, 99_999]);

    let (result, passing) = query_with(&w.model, &q, Some(&wrong)).unwrap();

    assert_eq!(result, run(&w.model, &q));
    assert!(!Arc::ptr_eq(&passing.unwrap(), &wrong));
}

#[test]
fn the_rows_that_pass_take_no_more_room_than_they_need() {
    // 20,000 rows that all pass: pushed one at a time they would be in a room for 32,768.
    let mut model = Model::new(calendar());
    let (list, _) = model_with_list(&mut model, "Item", 20_000);
    let module = new_module(&mut model, "Counts", vec![AxisSpec::List { list }]);
    let count = single_cell_item(&mut model, module);
    set(&mut model, count, Vec::new(), num(1.0));
    let mut q = query_of(
        module,
        vec![ViewDim::List { list }],
        vec![ViewDim::LineItems],
        Vec::new(),
    );
    q.filters = vec![RowFilter {
        line_item: count,
        op: FilterOp::Gt,
        value: Some(num(0.0)),
    }];

    let (result, passing) = query_with(&model, &q, None).unwrap();

    let passing = passing.unwrap();
    assert_eq!(result.total_rows, 20_000);
    assert_eq!(passing.len(), 20_000);
    assert_eq!(passing.capacity(), passing.len());
}
