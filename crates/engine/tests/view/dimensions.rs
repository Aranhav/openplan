use crate::common::*;
use openplan_engine::view::members;
use openplan_engine::{
    AxisSpec, Command, Format, ItemId, ListId, Member, ModuleId, SubsetId, TimeLevel, ViewDim,
};

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
