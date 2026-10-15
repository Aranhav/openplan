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
    assert!(by_kind(CompletionKind::Keyword).is_empty());
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
