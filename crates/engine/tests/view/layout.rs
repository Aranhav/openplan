use crate::common::*;
use openplan_engine::{AxisSpec, CellFlag, Command, ListId, MemberRef, ViewDim, Window};

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
