//! What the formula editor asks of a model: whether a formula would be accepted, and what could
//! be typed next.

use openplan_engine::{
    AxisSpec, Calendar, Command, CompletionKind, Format, ItemId, ItemSpec, LineItem, LineItemId,
    LineItemPatch, ListId, Model, ModuleId, SummaryMethod, TimeLevel, TimeScale, ValueType,
    VersionsScope,
};

fn month_axis() -> AxisSpec {
    AxisSpec::Time {
        level: TimeLevel::Month,
        range: None,
    }
}

fn model() -> Model {
    Model::new(Calendar {
        fiscal_year_start_month: 1,
        first_year: 2026,
        years: 1,
        current_month: None,
    })
}

fn module(model: &mut Model, name: &str, axes: Vec<AxisSpec>) -> ModuleId {
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

fn line_item(
    model: &mut Model,
    module: ModuleId,
    name: &str,
    ordinal: i32,
    format: Format,
) -> LineItemId {
    let id = LineItemId::new();
    model
        .apply(Command::CreateLineItem(LineItem {
            id,
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
        }))
        .unwrap();
    id
}

fn list(model: &mut Model, name: &str, top_level: Option<&str>) -> ListId {
    let id = ListId::new();
    model
        .apply(Command::CreateList {
            id,
            name: name.to_string(),
            parent: None,
            top_level_name: top_level.map(str::to_string),
            numbered: false,
            production_data: false,
        })
        .unwrap();
    id
}

fn set_formula(model: &mut Model, id: LineItemId, formula: &str) {
    model
        .apply(Command::UpdateLineItem {
            id,
            patch: LineItemPatch {
                formula: Some(Some(formula.to_string())),
                ..LineItemPatch::default()
            },
        })
        .unwrap();
}

/// Two modules over the months: `Plan` with Units, Price and Revenue, and `Costs` with Cost and
/// a line item that is also called Units.
struct Fixture {
    model: Model,
    module: ModuleId,
    units: LineItemId,
    revenue: LineItemId,
    cost: LineItemId,
}

fn fixture() -> Fixture {
    let mut model = model();
    let plan = module(&mut model, "Plan", vec![month_axis()]);
    let costs = module(&mut model, "Costs", vec![month_axis()]);
    let units = line_item(&mut model, plan, "Units", 0, Format::number());
    line_item(&mut model, plan, "Price", 1, Format::number());
    let revenue = line_item(&mut model, plan, "Revenue", 2, Format::number());
    let cost = line_item(&mut model, costs, "Cost", 0, Format::number());
    line_item(&mut model, costs, "Units Bought", 1, Format::number());
    Fixture {
        model,
        module: plan,
        units,
        revenue,
        cost,
    }
}

#[test]
fn a_valid_formula_has_the_type_of_the_line_item_and_changes_nothing() {
    let mut fx = fixture();
    set_formula(&mut fx.model, fx.revenue, "Units * Price");
    let generation = fx.model.generation();

    let checked = fx.model.check_formula(fx.revenue, "Units * Price * 2");

    assert_eq!(checked, Ok(ValueType::Number));
    assert_eq!(fx.model.generation(), generation);
    assert_eq!(
        fx.model
            .structure()
            .line_item(fx.revenue)
            .unwrap()
            .formula
            .as_deref(),
        Some("Units * Price")
    );
}

#[test]
fn a_formula_for_a_text_line_item_has_the_text_type() {
    let mut model = model();
    let plan = module(&mut model, "Plan", vec![month_axis()]);
    let title = line_item(&mut model, plan, "Title", 0, Format::Text);

    assert_eq!(
        model.check_formula(title, "\"Plan\" & \" A\""),
        Ok(ValueType::Text)
    );
}

#[test]
fn a_blank_formula_is_an_input_line_item() {
    let fx = fixture();

    assert_eq!(fx.model.check_formula(fx.units, ""), Ok(ValueType::Number));
    assert_eq!(
        fx.model.check_formula(fx.units, "  \n "),
        Ok(ValueType::Number)
    );
}

#[test]
fn problems_are_those_that_applying_the_formula_would_report() {
    let fx = fixture();
    let formulas = [
        "Revnue * 2",
        "Units *",
        "ABS(Units, 1)",
        "Units & \"x\"",
        "NOSUCH(Units)",
    ];
    for formula in formulas {
        let errors = fx.model.check_formula(fx.revenue, formula).unwrap_err();

        let mut applied = fx.model.clone();
        let rejected = applied
            .apply(Command::UpdateLineItem {
                id: fx.revenue,
                patch: LineItemPatch {
                    formula: Some(Some(formula.to_string())),
                    ..LineItemPatch::default()
                },
            })
            .unwrap_err();
        match rejected {
            openplan_engine::EngineError::Formula(expected) => {
                assert_eq!(errors, expected, "{formula}");
            }
            other => panic!("{formula}: {other:?}"),
        }
    }
}

#[test]
fn an_unknown_name_comes_with_a_suggestion() {
    let fx = fixture();

    let errors = fx.model.check_formula(fx.cost, "Unit * 2").unwrap_err();

    assert_eq!(errors.len(), 1);
    assert_eq!(errors[0].code, "formula.unknown_name");
    assert_eq!(errors[0].suggestion.as_deref(), Some("Units"));
    assert!(errors[0].message.contains("Did you mean 'Units'?"));
    assert_eq!((errors[0].start, errors[0].end), (0, 4));
}

#[test]
fn circular_references_are_found() {
    let mut fx = fixture();
    set_formula(&mut fx.model, fx.revenue, "Units * 2");

    let errors = fx.model.check_formula(fx.units, "Revenue").unwrap_err();

    assert_eq!(errors[0].code, "formula.cycle");
}

#[test]
fn dimension_problems_are_found() {
    let mut model = model();
    let countries = list(&mut model, "Countries", None);
    let by_country = module(
        &mut model,
        "Detail",
        vec![AxisSpec::List { list: countries }],
    );
    let company = module(&mut model, "Company", Vec::new());
    let detail = line_item(&mut model, by_country, "Revenue", 0, Format::number());
    let total = line_item(&mut model, company, "Total", 0, Format::number());
    model
        .apply(Command::UpsertListItems {
            list: countries,
            items: vec![ItemSpec {
                id: ItemId::new(),
                code: None,
                name: "US".to_string(),
                parent: None,
            }],
        })
        .unwrap();

    let errors = model.check_formula(total, "Revenue").unwrap_err();

    assert_eq!(errors[0].code, "formula.dimension");
    assert_eq!(model.structure().line_item(detail).unwrap().name, "Revenue");
}

#[test]
fn a_line_item_that_does_not_exist_is_reported() {
    let fx = fixture();

    let errors = fx.model.check_formula(LineItemId::new(), "1").unwrap_err();

    assert_eq!(errors.len(), 1);
    assert_eq!(errors[0].code, "structure.not_found");
}

fn labels(completions: &[openplan_engine::Completion]) -> Vec<&str> {
    completions
        .iter()
        .map(|completion| completion.label.as_str())
        .collect()
}

#[test]
fn line_items_of_the_same_module_come_first_in_module_order() {
    let fx = fixture();

    let completions = fx.model.completions(fx.revenue, "");

    let line_items: Vec<_> = completions
        .iter()
        .filter(|completion| completion.kind == CompletionKind::LineItem)
        .collect();
    assert_eq!(
        line_items
            .iter()
            .map(|completion| completion.label.as_str())
            .collect::<Vec<_>>(),
        [
            "Units",
            "Price",
            "Revenue",
            "Costs.Cost",
            "Costs.Units Bought"
        ]
    );
    assert_eq!(completions[0].label, "Units");
    assert!(
        completions[..5]
            .iter()
            .all(|completion| completion.kind == CompletionKind::LineItem)
    );
}

#[test]
fn the_prefix_is_matched_without_regard_to_case() {
    let fx = fixture();

    let completions = fx.model.completions(fx.revenue, "UNI");

    assert_eq!(labels(&completions), ["Units", "Costs.Units Bought"]);
}

#[test]
fn a_line_item_of_another_module_matches_its_own_name_as_well() {
    let fx = fixture();

    let completions = fx.model.completions(fx.revenue, "cost");

    assert_eq!(labels(&completions), ["Costs.Cost", "Costs.Units Bought"]);
}

#[test]
fn names_that_need_quotes_are_offered_quoted() {
    let mut model = model();
    let plan = module(&mut model, "Profit & Loss", vec![month_axis()]);
    let margin = line_item(&mut model, plan, "Gross Margin", 0, Format::number());
    line_item(&mut model, plan, "Net (after tax)", 1, Format::number());
    let other = module(&mut model, "Other", vec![month_axis()]);
    let probe = line_item(&mut model, other, "Probe", 0, Format::number());

    let same = model.completions(margin, "net");
    let across = model.completions(probe, "gross");

    assert_eq!(labels(&same), ["'Net (after tax)'"]);
    assert_eq!(labels(&across), ["'Profit & Loss'.Gross Margin"]);
    let typed = model.completions(margin, "'net");
    assert_eq!(labels(&typed), ["'Net (after tax)'"]);
}

#[test]
fn lists_functions_and_keywords_follow_the_line_items() {
    let mut fx = fixture();
    list(&mut fx.model, "Units of Measure", Some("All Units"));

    let completions = fx.model.completions(fx.revenue, "u");

    let kinds: Vec<CompletionKind> = completions
        .iter()
        .map(|completion| completion.kind)
        .collect();
    let mut sorted = kinds.clone();
    sorted.sort_by_key(|kind| match kind {
        CompletionKind::LineItem => 0,
        CompletionKind::List => 1,
        CompletionKind::Function => 2,
        CompletionKind::Keyword => 3,
        CompletionKind::Item | CompletionKind::Version | CompletionKind::Period => 4,
    });
    assert_eq!(kinds, sorted, "{completions:?}");
    let by_kind = |wanted: CompletionKind| -> Vec<&str> {
        completions
            .iter()
            .filter(|completion| completion.kind == wanted)
            .map(|completion| completion.label.as_str())
            .collect()
    };
    assert_eq!(
        by_kind(CompletionKind::LineItem),
        ["Units", "Costs.Units Bought"]
    );
    assert_eq!(by_kind(CompletionKind::List), ["Units of Measure"]);
    assert_eq!(by_kind(CompletionKind::Function), ["UPPER"]);
    assert_eq!(by_kind(CompletionKind::Keyword), ["UP"]);
}

#[test]
fn functions_carry_their_documentation_and_keywords_are_offered() {
    let fx = fixture();

    let functions = fx.model.completions(fx.revenue, "ROU");
    let keywords = fx.model.completions(fx.revenue, "th");

    assert_eq!(functions.len(), 1);
    assert_eq!(functions[0].label, "ROUND");
    assert_eq!(functions[0].kind, CompletionKind::Function);
    assert!(functions[0].detail.contains("Rounds x"));
    assert_eq!(keywords.len(), 1);
    assert_eq!(keywords[0].label, "THEN");
    assert_eq!(keywords[0].kind, CompletionKind::Keyword);
}

#[test]
fn nothing_matches_an_unknown_prefix_or_line_item() {
    let fx = fixture();

    assert!(fx.model.completions(fx.revenue, "zzz").is_empty());
    assert!(fx.model.completions(LineItemId::new(), "u").is_empty());
}

#[test]
fn the_dimensions_of_formulas_are_offered_as_lists() {
    let fx = fixture();

    let completions = fx.model.completions(fx.revenue, "ver");

    assert_eq!(labels(&completions), ["Versions"]);
    assert_eq!(completions[0].kind, CompletionKind::List);
    let time = fx.model.completions(fx.revenue, "tim");
    assert!(labels(&time).contains(&"Time"));
}

fn items(model: &mut Model, list: ListId, names: &[&str]) {
    model
        .apply(Command::UpsertListItems {
            list,
            items: names
                .iter()
                .map(|name| ItemSpec {
                    id: ItemId::new(),
                    code: None,
                    name: (*name).to_string(),
                    parent: None,
                })
                .collect(),
        })
        .unwrap();
}

fn of_kind(completions: &[openplan_engine::Completion], kind: CompletionKind) -> Vec<&str> {
    completions
        .iter()
        .filter(|completion| completion.kind == kind)
        .map(|completion| completion.label.as_str())
        .collect()
}

#[test]
fn after_a_dot_the_line_items_of_that_module_are_offered_whichever_module_it_is() {
    let fx = fixture();

    let own = fx.model.completions(fx.revenue, "Plan.");
    let narrowed = fx.model.completions(fx.revenue, "plan.PR");
    let other = fx.model.completions(fx.revenue, "Costs.");

    assert_eq!(
        labels(&own),
        ["Plan.Units", "Plan.Price", "Plan.Revenue"],
        "{own:?}"
    );
    assert_eq!(own[0].kind, CompletionKind::LineItem);
    assert_eq!(own[0].detail, "Number");
    assert_eq!(labels(&narrowed), ["Plan.Price"]);
    assert_eq!(labels(&other), ["Costs.Cost", "Costs.Units Bought"]);
    assert_eq!(other[0].detail, "Number in Costs");
    assert!(fx.model.completions(fx.revenue, "Nothing.").is_empty());
    assert!(fx.model.completions(fx.revenue, "Plan.zzz").is_empty());
}

#[test]
fn a_module_whose_name_needs_quotes_is_qualified_the_way_its_label_says() {
    let mut model = model();
    let plan = module(&mut model, "Profit & Loss", vec![month_axis()]);
    let margin = line_item(&mut model, plan, "Gross Margin", 0, Format::number());
    line_item(&mut model, plan, "Net (after tax)", 1, Format::number());
    let spaced = module(&mut model, "Revenue Plan", vec![month_axis()]);
    line_item(&mut model, spaced, "Units", 0, Format::number());

    let all = model.completions(margin, "'Profit & Loss'.");
    let narrowed = model.completions(margin, "'Profit & Loss'.Gr");
    let quoted_member = model.completions(margin, "'profit & loss'.'net");
    let spaced_module = model.completions(margin, "revenue plan.u");

    assert_eq!(
        labels(&all),
        [
            "'Profit & Loss'.Gross Margin",
            "'Profit & Loss'.'Net (after tax)'"
        ]
    );
    assert_eq!(labels(&narrowed), ["'Profit & Loss'.Gross Margin"]);
    assert_eq!(
        labels(&quoted_member),
        ["'Profit & Loss'.'Net (after tax)'"]
    );
    assert_eq!(labels(&spaced_module), ["Revenue Plan.Units"]);
}

#[test]
fn after_a_list_name_its_items_are_offered() {
    let mut fx = fixture();
    let countries = list(&mut fx.model, "Countries", None);
    items(
        &mut fx.model,
        countries,
        &["France", "Germany", "St. Kitts", "O'Neill Land"],
    );

    let all = fx.model.completions(fx.revenue, "Countries.");
    let narrowed = fx.model.completions(fx.revenue, "countries.FR");
    let dotted = fx.model.completions(fx.revenue, "Countries.st");
    let quoted = fx.model.completions(fx.revenue, "Countries.'o");

    assert_eq!(
        labels(&all),
        [
            "Countries.France",
            "Countries.Germany",
            "Countries.'St. Kitts'",
            "Countries.'O''Neill Land'"
        ]
    );
    assert!(
        all.iter()
            .all(|completion| completion.kind == CompletionKind::Item)
    );
    assert_eq!(all[0].detail, "Item of Countries");
    assert_eq!(labels(&narrowed), ["Countries.France"]);
    assert_eq!(labels(&dotted), ["Countries.'St. Kitts'"]);
    assert_eq!(labels(&quoted), ["Countries.'O''Neill Land'"]);
}

#[test]
fn after_versions_the_versions_are_offered() {
    let fx = fixture();

    let all = fx.model.completions(fx.revenue, "Versions.");
    let narrowed = fx.model.completions(fx.revenue, "versions.b");

    assert_eq!(
        labels(&all),
        ["Versions.Actual", "Versions.Budget", "Versions.Forecast"]
    );
    assert!(all.iter().all(|completion| {
        completion.kind == CompletionKind::Version && completion.detail == "Version"
    }));
    assert_eq!(labels(&narrowed), ["Versions.Budget"]);
}

#[test]
fn after_time_the_periods_of_every_level_are_offered() {
    let fx = fixture();

    let all = fx.model.completions(fx.revenue, "Time.");
    let months = fx.model.completions(fx.revenue, "Time.'Ja");
    let quarters = fx.model.completions(fx.revenue, "time.q");
    let year = fx.model.completions(fx.revenue, "Time.FY");
    let total = fx.model.completions(fx.revenue, "Time.tot");

    assert_eq!(all.len(), 12 + 4 + 2 + 1 + 1);
    assert!(all.iter().all(|completion| {
        completion.kind == CompletionKind::Period && completion.detail == "Period"
    }));
    assert_eq!(all[0].label, "Time.'Jan 26'");
    assert_eq!(labels(&months), ["Time.'Jan 26'"]);
    assert_eq!(
        labels(&quarters),
        [
            "Time.'Q1 FY26'",
            "Time.'Q2 FY26'",
            "Time.'Q3 FY26'",
            "Time.'Q4 FY26'"
        ]
    );
    assert_eq!(labels(&year), ["Time.FY26"]);
    assert_eq!(labels(&total), ["Time.Total"]);
}

#[test]
fn what_is_offered_after_a_dot_can_be_written_in_a_formula() {
    let mut fx = fixture();
    let countries = list(&mut fx.model, "Countries", None);
    items(&mut fx.model, countries, &["St. Kitts"]);
    let place = line_item(
        &mut fx.model,
        fx.module,
        "Place",
        3,
        Format::List { list: countries },
    );
    let flag = line_item(&mut fx.model, fx.module, "Flag", 4, Format::Boolean);

    for label in fx
        .model
        .completions(place, "Countries.")
        .iter()
        .map(|completion| completion.label.clone())
    {
        assert_eq!(
            fx.model.check_formula(place, &label),
            Ok(ValueType::Item(countries))
        );
    }
    for prefix in ["Versions.", "Time."] {
        let offered = fx.model.completions(flag, prefix);
        assert!(!offered.is_empty());
        for completion in offered {
            let formula = format!("{} = {}", completion.label, completion.label);
            assert_eq!(
                fx.model.check_formula(flag, &formula),
                Ok(ValueType::Boolean),
                "{formula}"
            );
        }
    }
}

#[test]
fn the_keywords_of_function_arguments_are_offered() {
    let fx = fixture();

    let up = fx.model.completions(fx.revenue, "up");
    let near = fx.model.completions(fx.revenue, "near");
    let desc = fx.model.completions(fx.revenue, "DESC");
    let asc = fx.model.completions(fx.revenue, "asc");

    assert_eq!(labels(&up), ["UPPER", "UP"]);
    assert_eq!(of_kind(&up, CompletionKind::Keyword), ["UP"]);
    assert_eq!(up[1].detail, "ROUND mode");
    assert_eq!(labels(&near), ["NEAREST"]);
    assert_eq!(near[0].detail, "ROUND mode");
    assert_eq!(labels(&desc), ["DESCENDING"]);
    assert_eq!(desc[0].detail, "RANK order");
    assert_eq!(labels(&asc), ["ASCENDING"]);
    assert_eq!(fx.model.completions(fx.revenue, "down")[0].label, "DOWN");
}

#[test]
fn no_more_than_the_limit_are_offered() {
    let mut fx = fixture();
    let many = list(&mut fx.model, "Many", None);
    let names: Vec<String> = (0..200).map(|number| format!("Item {number}")).collect();
    let names: Vec<&str> = names.iter().map(String::as_str).collect();
    items(&mut fx.model, many, &names);

    assert_eq!(
        fx.model.completions(fx.revenue, "").len(),
        openplan_engine::MAX_COMPLETIONS
    );
    let members = fx.model.completions(fx.revenue, "Many.");
    assert_eq!(members.len(), openplan_engine::MAX_COMPLETIONS);
    assert_eq!(members[0].label, "Many.Item 0");
}

#[test]
fn a_patch_applied_to_a_copy_gives_the_line_item_the_model_stores() {
    let mut fx = fixture();
    let before = fx.model.structure().line_item(fx.revenue).unwrap().clone();
    let patch = LineItemPatch {
        name: Some("Sales".to_string()),
        ordinal: Some(7),
        format: Some(Format::Boolean),
        formula: Some(Some("TRUE".to_string())),
        summary: Some(SummaryMethod::Any),
        time_summary: Some(Some(SummaryMethod::Last)),
        applies_to: Some(Some(Vec::new())),
        time_scale: Some(TimeScale::None),
        versions: Some(VersionsScope::None),
        notes: Some("Notes".to_string()),
        code: Some(Some("S1".to_string())),
        read_access_driver: Some(Some(fx.units)),
        write_access_driver: Some(Some(fx.cost)),
    };
    let mut copy = before.clone();
    patch.clone().apply_to(&mut copy);

    fx.model
        .apply(Command::UpdateLineItem {
            id: fx.revenue,
            patch: patch.clone(),
        })
        .unwrap();

    assert_ne!(copy, before);
    assert_eq!(fx.model.structure().line_item(fx.revenue), Some(&copy));

    let mut cleared = copy.clone();
    LineItemPatch {
        formula: Some(None),
        time_summary: Some(None),
        applies_to: Some(None),
        code: Some(None),
        read_access_driver: Some(None),
        write_access_driver: Some(None),
        ..LineItemPatch::default()
    }
    .apply_to(&mut cleared);
    assert_eq!(cleared.formula, None);
    assert_eq!(cleared.time_summary, None);
    assert_eq!(cleared.applies_to, None);
    assert_eq!(cleared.code, None);
    assert_eq!(cleared.read_access_driver, None);
    assert_eq!(cleared.write_access_driver, None);
    assert_eq!(cleared.name, "Sales");
}
