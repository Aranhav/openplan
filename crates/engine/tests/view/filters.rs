use crate::common::*;
use openplan_engine::{
    AxisSpec, CellEdit, Command, CoordToken, FilterOp, Format, ItemId, LineItem, ListId, Model,
    RowFilter, SubsetId, SummaryMethod, TimeScale, Value, VersionsScope, ViewDim,
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

    // Operations that take no value ignore one.
    q.filters = vec![RowFilter {
        line_item: w.units,
        op: FilterOp::IsBlank,
        value: Some(Value::Text("ignored".into())),
    }];
    run(&w.model, &q);
}

/// A model with a flat list of `count` items named `{name} {n}`.
fn model_with_list(model: &mut Model, name: &str, count: usize) -> (ListId, Vec<ItemId>) {
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
    let (a, _) = model_with_list(&mut model, "A", 1_500);
    let (b, _) = model_with_list(&mut model, "B", 1_500);
    let module = new_module(
        &mut model,
        "Pairs",
        vec![AxisSpec::List { list: a }, AxisSpec::List { list: b }],
    );
    let count = number_item(&mut model, module, "Count", 1);
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

    // Narrowed by a page, the view can be filtered.
    let mut q = query_of(
        module,
        vec![dim_b],
        vec![ViewDim::LineItems],
        vec![page(dim_a)],
    );
    q.filters = vec![filter];
    let result = run(&model, &q);
    assert_eq!(result.total_rows, 0);
}
