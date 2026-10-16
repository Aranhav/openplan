use crate::common::*;
use openplan_engine::view::query;
use openplan_engine::{
    FilterOp, ItemId, LineItemId, MemberRef, ModuleId, SubsetId, ViewDim, ViewQuery,
};
use serde_json::json;

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
