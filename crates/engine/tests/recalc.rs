use std::collections::BTreeMap;

use openplan_engine::{
    Axis, AxisSpec, Calendar, CellEdit, ChangeSet, Command, CoordToken, EngineError, Format,
    FormulaError, ItemId, ItemSpec, LevelSpec, LineItem, LineItemId, LineItemPatch, ListId, Model,
    ModuleId, SummaryMethod, TimeLevel, TimeScale, Value, VersionId, VersionsScope,
};
use proptest::prelude::*;

fn calendar(years: u8) -> Calendar {
    Calendar {
        fiscal_year_start_month: 1,
        first_year: 2026,
        years,
        current_month: None,
    }
}

const MONTHS: [&str; 12] = [
    "Jan 26", "Feb 26", "Mar 26", "Apr 26", "May 26", "Jun 26", "Jul 26", "Aug 26", "Sep 26",
    "Oct 26", "Nov 26", "Dec 26",
];

fn period(label: &str) -> CoordToken {
    CoordToken::Period(label.to_string())
}

fn month(index: usize) -> CoordToken {
    period(MONTHS[index])
}

fn item(id: ItemId) -> CoordToken {
    CoordToken::Item(id)
}

fn list_axis(list: ListId) -> AxisSpec {
    AxisSpec::List { list }
}

fn month_axis() -> AxisSpec {
    AxisSpec::Time {
        level: TimeLevel::Month,
        range: None,
    }
}

fn line_item(module: ModuleId, name: &str, format: Format, formula: Option<&str>) -> LineItem {
    LineItem {
        id: LineItemId::new(),
        module,
        name: name.to_string(),
        ordinal: 0,
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

fn formula_patch(formula: &str) -> LineItemPatch {
    LineItemPatch {
        formula: Some(Some(formula.to_string())),
        ..LineItemPatch::default()
    }
}

fn sorted(mut ids: Vec<LineItemId>) -> Vec<LineItemId> {
    ids.sort();
    ids
}

/// A model under construction.
struct Fx {
    model: Model,
}

impl Fx {
    fn new(years: u8) -> Fx {
        Fx {
            model: Model::new(calendar(years)),
        }
    }

    fn list(&mut self, name: &str, top: Option<&str>) -> ListId {
        let id = ListId::new();
        self.model
            .apply(Command::CreateList {
                id,
                name: name.to_string(),
                parent: None,
                top_level_name: top.map(str::to_string),
                numbered: false,
                production_data: false,
            })
            .unwrap();
        id
    }

    fn items(&mut self, list: ListId, names: &[String]) -> Vec<ItemId> {
        let specs: Vec<ItemSpec> = names
            .iter()
            .map(|name| ItemSpec {
                id: ItemId::new(),
                code: None,
                name: name.clone(),
                parent: None,
            })
            .collect();
        let ids = specs.iter().map(|spec| spec.id).collect();
        self.model
            .apply(Command::UpsertListItems { list, items: specs })
            .unwrap();
        ids
    }

    fn named_items(&mut self, list: ListId, prefix: &str, count: usize) -> Vec<ItemId> {
        let names: Vec<String> = (0..count).map(|i| format!("{prefix}{i}")).collect();
        self.items(list, &names)
    }

    fn module(&mut self, name: &str, axes: Vec<AxisSpec>) -> ModuleId {
        let id = ModuleId::new();
        self.model
            .apply(Command::CreateModule {
                id,
                name: name.to_string(),
                axes,
                functional_area: String::new(),
            })
            .unwrap();
        id
    }

    fn add(&mut self, line_item: LineItem) -> LineItemId {
        let id = line_item.id;
        self.model
            .apply(Command::CreateLineItem(line_item))
            .unwrap();
        id
    }

    fn number(&mut self, module: ModuleId, name: &str) -> LineItemId {
        self.add(line_item(module, name, Format::number(), None))
    }

    fn calc(&mut self, module: ModuleId, name: &str, formula: &str) -> LineItemId {
        self.add(line_item(module, name, Format::number(), Some(formula)))
    }

    fn try_calc(
        &mut self,
        module: ModuleId,
        name: &str,
        formula: &str,
    ) -> Result<ChangeSet, EngineError> {
        self.model.apply(Command::CreateLineItem(line_item(
            module,
            name,
            Format::number(),
            Some(formula),
        )))
    }

    fn update_formula(&mut self, id: LineItemId, formula: &str) -> Result<ChangeSet, EngineError> {
        self.model.apply(Command::UpdateLineItem {
            id,
            patch: formula_patch(formula),
        })
    }

    fn set(&mut self, id: LineItemId, cells: Vec<(Vec<CoordToken>, f64)>) -> ChangeSet {
        let edits = cells
            .into_iter()
            .map(|(coords, number)| CellEdit {
                coords,
                value: Value::Number(number),
            })
            .collect();
        self.model
            .apply(Command::SetCells {
                line_item: id,
                edits,
            })
            .unwrap()
    }

    fn set_number(&mut self, id: LineItemId, coords: Vec<CoordToken>, number: f64) -> ChangeSet {
        self.set(id, vec![(coords, number)])
    }

    fn number_at(&self, id: LineItemId, coords: Vec<CoordToken>) -> f64 {
        match self.model.read_cells(id, &[coords]).unwrap().pop().unwrap() {
            Value::Number(number) => number,
            other => panic!("expected a number, found {other:?}"),
        }
    }

    fn months_of(&self, id: LineItemId) -> Vec<f64> {
        (0..12)
            .map(|m| self.number_at(id, vec![month(m)]))
            .collect()
    }

    fn errors(&self, id: LineItemId) -> Vec<FormulaError> {
        self.model
            .line_item_errors(id)
            .expect("the line item should be in error")
            .to_vec()
    }
}

fn formula_errors(result: Result<ChangeSet, EngineError>) -> Vec<FormulaError> {
    match result {
        Err(EngineError::Formula(errors)) => errors,
        other => panic!("expected formula errors, found {other:?}"),
    }
}

#[test]
fn chain_recalcs_downstream_only() {
    let mut fx = Fx::new(1);
    let sheet = fx.module("Sheet", vec![month_axis()]);
    let a = fx.number(sheet, "A");
    let b = fx.calc(sheet, "B", "A * 2");
    let c = fx.calc(sheet, "C", "B + 1");
    let e = fx.number(sheet, "E");
    let d = fx.calc(sheet, "D", "E * 3");
    fx.set_number(a, vec![month(0)], 1.0);
    fx.set_number(e, vec![month(0)], 5.0);

    let changes = fx.set_number(a, vec![month(0)], 10.0);

    assert_eq!(sorted(changes.changed_line_items), sorted(vec![a, b, c]));
    assert_eq!(fx.number_at(b, vec![month(0)]), 20.0);
    assert_eq!(fx.number_at(c, vec![month(0)]), 21.0);
    assert_eq!(fx.number_at(d, vec![month(0)]), 15.0);
    assert_eq!(fx.model.last_recalc_stats().line_items, 2);
}

#[test]
fn pointwise_fast_path_touches_only_edited_cells() {
    let mut fx = Fx::new(1);
    let products = fx.list("Products", None);
    let ids = fx.named_items(products, "P", 10_000);
    let sales = fx.module("Sales", vec![list_axis(products)]);
    let units = fx.number(sales, "Units");
    let price = fx.number(sales, "Price");
    let revenue = fx.calc(sales, "Revenue", "Units * Price");
    let cost = fx.calc(sales, "Cost", "Revenue * 0.6");
    let margin = fx.calc(sales, "Margin", "Revenue - Cost");
    fx.set_number(units, vec![item(ids[0])], 10.0);
    fx.set_number(price, vec![item(ids[0])], 2.0);

    let changes = fx.set_number(units, vec![item(ids[5_000])], 4.0);

    let stats = fx.model.last_recalc_stats();
    assert_eq!(
        stats.evaluated_cells, 3,
        "one cell for each of three dependents"
    );
    assert_eq!(stats.line_items, 3);
    assert_eq!(
        sorted(changes.changed_line_items),
        sorted(vec![units, revenue, cost, margin])
    );
    assert_eq!(fx.number_at(revenue, vec![item(ids[0])]), 20.0);
    assert_eq!(fx.number_at(cost, vec![item(ids[0])]), 12.0);
    assert_eq!(fx.number_at(margin, vec![item(ids[0])]), 8.0);
    assert_eq!(fx.number_at(revenue, vec![item(ids[5_000])]), 0.0);

    fx.set_number(price, vec![item(ids[5_000])], 3.0);

    assert_eq!(fx.model.last_recalc_stats().evaluated_cells, 3);
    assert_eq!(fx.number_at(revenue, vec![item(ids[5_000])]), 12.0);
    assert_eq!(fx.number_at(cost, vec![item(ids[5_000])]), 12.0 * 0.6);
    assert_eq!(
        fx.number_at(margin, vec![item(ids[5_000])]),
        12.0 - 12.0 * 0.6
    );
    assert_eq!(fx.number_at(revenue, vec![item(ids[0])]), 20.0);
}

#[test]
fn non_pointwise_recalcs_whole_line_item() {
    let mut fx = Fx::new(1);
    let products = fx.list("Products", None);
    let ids = fx.named_items(products, "P", 50);
    let sales = fx.module("Sales", vec![list_axis(products), month_axis()]);
    let units = fx.number(sales, "Units");
    let running = fx.calc(sales, "Running", "CUMULATE(Units)");
    let above = fx.calc(sales, "Above", "Running + 1");
    let doubled = fx.calc(sales, "Doubled", "Units * 2");
    fx.set(
        units,
        (0..12)
            .map(|m| (vec![item(ids[7]), month(m)], 1.0))
            .collect(),
    );

    fx.set_number(units, vec![item(ids[7]), month(3)], 10.0);

    let stats = fx.model.last_recalc_stats();
    assert_eq!(stats.line_items, 3);
    assert_eq!(
        stats.evaluated_cells,
        600 + 600 + 1,
        "CUMULATE and what reads it are recalculated whole, the pointwise sibling by cell"
    );
    let totals: Vec<f64> = (0..12)
        .map(|m| fx.number_at(running, vec![item(ids[7]), month(m)]))
        .collect();
    assert_eq!(
        totals,
        vec![
            1.0, 2.0, 3.0, 13.0, 14.0, 15.0, 16.0, 17.0, 18.0, 19.0, 20.0, 21.0
        ]
    );
    assert_eq!(fx.number_at(above, vec![item(ids[7]), month(3)]), 14.0);
    assert_eq!(fx.number_at(doubled, vec![item(ids[7]), month(3)]), 20.0);
    assert_eq!(fx.number_at(running, vec![item(ids[8]), month(3)]), 0.0);
}

#[test]
fn only_the_read_that_is_not_pointwise_recalculates_whole() {
    let mut fx = Fx::new(1);
    let products = fx.list("Products", None);
    let ids = fx.named_items(products, "P", 20);
    let sales = fx.module("Sales", vec![list_axis(products), month_axis()]);
    let units = fx.number(sales, "Units");
    let base = fx.number(sales, "Base");
    let mixed = fx.calc(sales, "Mixed", "Units + CUMULATE(Base)");

    fx.set_number(units, vec![item(ids[1]), month(2)], 5.0);
    assert_eq!(fx.model.last_recalc_stats().evaluated_cells, 1);

    fx.set_number(base, vec![item(ids[1]), month(2)], 2.0);
    assert_eq!(fx.model.last_recalc_stats().evaluated_cells, 240);
    assert_eq!(fx.number_at(mixed, vec![item(ids[1]), month(2)]), 7.0);
    assert_eq!(fx.number_at(mixed, vec![item(ids[1]), month(5)]), 2.0);
}

#[test]
fn illegal_cycle_rejected() {
    let mut fx = Fx::new(1);
    let sheet = fx.module("Sheet", vec![month_axis()]);
    let a = fx.number(sheet, "A");
    let b = fx.number(sheet, "B");
    fx.update_formula(a, "B + 1").unwrap();
    let before = fx.model.generation();

    let errors = formula_errors(fx.update_formula(b, "A"));

    assert_eq!(errors.len(), 1);
    assert_eq!(errors[0].code, "formula.cycle");
    assert_eq!(errors[0].message, "Circular reference: A → B → A");
    assert_eq!((errors[0].start, errors[0].end), (0, 1));
    assert_eq!(fx.model.generation(), before);
    assert!(fx.model.structure().line_item(b).unwrap().formula.is_none());
    assert!(fx.model.line_item_errors(a).is_none());

    let errors = formula_errors(fx.update_formula(a, "A + 1"));
    assert_eq!(errors[0].code, "formula.cycle");
    assert_eq!(errors[0].message, "Circular reference: A → A");
    let errors = formula_errors(fx.try_calc(sheet, "C", "C * 2"));
    assert_eq!(errors[0].message, "Circular reference: C → C");
}

#[test]
fn a_longer_illegal_cycle_names_its_members_in_order() {
    let mut fx = Fx::new(1);
    let sheet = fx.module("Sheet", vec![month_axis()]);
    let a = fx.number(sheet, "A");
    let b = fx.calc(sheet, "B", "A + 1");
    let c = fx.calc(sheet, "C", "B + 1");

    let errors = formula_errors(fx.update_formula(a, "C + 1"));

    assert_eq!(errors[0].message, "Circular reference: A → C → B → A");
    assert!(fx.model.line_item_errors(b).is_none());
    assert!(fx.model.line_item_errors(c).is_none());
}

#[test]
fn balance_cycle_with_previous_is_valid() {
    let mut fx = Fx::new(1);
    let sheet = fx.module("Sheet", vec![month_axis()]);
    let income = fx.number(sheet, "In");
    let outgoings = fx.number(sheet, "Out");
    let closing = fx.number(sheet, "Closing");
    let opening = fx.calc(sheet, "Opening", "PREVIOUS(Closing)");
    fx.update_formula(closing, "Opening + In - Out").unwrap();
    fx.set(income, (0..12).map(|m| (vec![month(m)], 10.0)).collect());
    fx.set(outgoings, (0..12).map(|m| (vec![month(m)], 3.0)).collect());

    let expected_closing: Vec<f64> = (1..=12).map(|m| 7.0 * f64::from(m)).collect();
    let expected_opening: Vec<f64> = (0..12).map(|m| 7.0 * f64::from(m)).collect();
    assert_eq!(fx.months_of(closing), expected_closing);
    assert_eq!(fx.months_of(opening), expected_opening);
    assert!(fx.model.line_item_errors(closing).is_none());

    fx.set_number(income, vec![month(2)], 20.0);

    let stats = fx.model.last_recalc_stats();
    assert_eq!((stats.line_items, stats.evaluated_cells), (2, 24));
    let mut balance = 0.0;
    let mut expected = Vec::new();
    for m in 0..12 {
        balance += if m == 2 { 20.0 } else { 10.0 } - 3.0;
        expected.push(balance);
    }
    assert_eq!(fx.months_of(closing), expected);
    assert_eq!(fx.number_at(opening, vec![month(3)]), expected[2]);
    assert_eq!(fx.number_at(opening, vec![month(0)]), 0.0);
}

#[test]
fn a_running_total_may_read_itself_from_a_previous_period() {
    let mut fx = Fx::new(1);
    let sheet = fx.module("Sheet", vec![month_axis()]);
    let flow = fx.number(sheet, "Flow");
    let total = fx.calc(sheet, "Total", "Flow + LAG(Total, 1, 0)");
    let jump = fx.calc(sheet, "Jump", "Flow + OFFSET(Jump, -2, 100)");
    fx.set(flow, (0..12).map(|m| (vec![month(m)], 1.0)).collect());

    let totals: Vec<f64> = (1..=12).map(f64::from).collect();
    assert_eq!(fx.months_of(total), totals);
    let jumps: Vec<f64> = (0..12).map(|m| 101.0 + f64::from(m / 2)).collect();
    assert_eq!(fx.months_of(jump), jumps);
}

#[test]
fn deleting_referenced_line_item_puts_dependent_in_error() {
    let mut fx = Fx::new(1);
    let sheet = fx.module("Sheet", vec![month_axis()]);
    let units = fx.number(sheet, "Units");
    let revenue = fx.calc(sheet, "Revenue", "Units * 2");
    let report = fx.calc(sheet, "Report", "Revenue + 1");
    fx.set_number(units, vec![month(0)], 5.0);
    assert_eq!(fx.number_at(revenue, vec![month(0)]), 10.0);

    let changes = fx
        .model
        .apply(Command::DeleteLineItem { id: units })
        .unwrap();

    let errors = fx.errors(revenue);
    assert_eq!(errors[0].code, "formula.unknown_name");
    assert_eq!(fx.number_at(revenue, vec![month(0)]), 0.0);
    assert_eq!(fx.number_at(report, vec![month(0)]), 1.0);
    assert!(fx.model.line_item_errors(report).is_none());
    assert!(changes.changed_line_items.contains(&revenue));
    assert!(changes.changed_line_items.contains(&report));

    let units = fx.number(sheet, "Units");
    fx.set_number(units, vec![month(0)], 7.0);
    fx.update_formula(revenue, "Units * 2").unwrap();

    assert!(fx.model.line_item_errors(revenue).is_none());
    assert_eq!(fx.number_at(revenue, vec![month(0)]), 14.0);
    assert_eq!(fx.number_at(report, vec![month(0)]), 15.0);
}

#[test]
fn recreating_a_deleted_line_item_repairs_the_formulas_that_use_it() {
    let mut fx = Fx::new(1);
    let sheet = fx.module("Sheet", vec![month_axis()]);
    let units = fx.number(sheet, "Units");
    let revenue = fx.calc(sheet, "Revenue", "Units * 2");
    fx.model
        .apply(Command::DeleteLineItem { id: units })
        .unwrap();
    assert!(fx.model.line_item_errors(revenue).is_some());

    let units = fx.number(sheet, "Units");
    assert!(fx.model.line_item_errors(revenue).is_none());
    fx.set_number(units, vec![month(1)], 3.0);

    assert_eq!(fx.number_at(revenue, vec![month(1)]), 6.0);
}

#[test]
fn a_cycle_made_by_renaming_puts_its_members_in_error() {
    let mut fx = Fx::new(1);
    let sheet = fx.module("Sheet", vec![month_axis()]);
    let zed = fx.number(sheet, "Zed");
    let a = fx.calc(sheet, "A", "Zed + 1");
    let b = fx.calc(sheet, "B", "A + 1");
    fx.model.apply(Command::DeleteLineItem { id: zed }).unwrap();
    assert_eq!(fx.errors(a)[0].code, "formula.unknown_name");

    fx.model
        .apply(Command::UpdateLineItem {
            id: b,
            patch: LineItemPatch {
                name: Some("Zed".to_string()),
                ..LineItemPatch::default()
            },
        })
        .unwrap();

    for id in [a, b] {
        let errors = fx.errors(id);
        assert_eq!(errors[0].code, "formula.cycle");
        assert_eq!(errors[0].message, "Circular reference: A → Zed → A");
        assert_eq!(fx.number_at(id, vec![month(0)]), 0.0);
    }
}

#[test]
fn a_formula_with_errors_rejects_the_command() {
    let mut fx = Fx::new(1);
    let sheet = fx.module("Sheet", vec![month_axis()]);
    let flat = fx.module("Flat", Vec::new());
    let units = fx.number(sheet, "Units");
    let doubled = fx.calc(sheet, "Doubled", "Units * 2");
    fx.set_number(units, vec![month(0)], 4.0);
    let before = fx.model.generation();

    assert_eq!(
        formula_errors(fx.try_calc(sheet, "Broken", "Unitz + 1"))[0].code,
        "formula.unknown_name"
    );
    assert_eq!(
        formula_errors(fx.try_calc(sheet, "Broken", "Units +"))[0].code,
        "formula.syntax"
    );
    assert_eq!(
        formula_errors(fx.try_calc(sheet, "Broken", "Units > 1"))[0].code,
        "formula.type_mismatch"
    );
    let errors = formula_errors(fx.try_calc(flat, "Broken", "PREVIOUS(Units)"));
    assert_eq!(errors[0].code, "formula.dimension");
    assert_eq!(errors[0].message, "This function needs a Time dimension.");
    assert_eq!(
        formula_errors(fx.update_formula(doubled, "Units * Nothing"))[0].code,
        "formula.unknown_name"
    );

    assert_eq!(fx.model.generation(), before);
    assert!(
        fx.model
            .structure()
            .line_item_by_name(None, "Broken")
            .is_none()
    );
    assert_eq!(
        fx.model
            .structure()
            .line_item(doubled)
            .unwrap()
            .formula
            .as_deref(),
        Some("Units * 2")
    );
    assert!(fx.model.line_item_errors(doubled).is_none());
    assert_eq!(fx.number_at(doubled, vec![month(0)]), 8.0);
}

#[test]
fn a_batch_is_rejected_whole_by_a_formula_error_and_may_build_on_itself() {
    let mut fx = Fx::new(1);
    let sheet = fx.module("Sheet", vec![month_axis()]);
    let units = line_item(sheet, "Units", Format::number(), None);
    let doubled = line_item(sheet, "Doubled", Format::number(), Some("Units * 2"));
    let broken = line_item(sheet, "Broken", Format::number(), Some("Units + Missing"));
    let (units_id, doubled_id) = (units.id, doubled.id);

    let result = fx.model.apply_batch(vec![
        Command::CreateLineItem(units.clone()),
        Command::CreateLineItem(doubled.clone()),
        Command::CreateLineItem(broken),
    ]);
    assert!(matches!(result, Err(EngineError::Formula(_))));
    assert!(fx.model.structure().line_item(units_id).is_none());

    fx.model
        .apply_batch(vec![
            Command::CreateLineItem(units),
            Command::CreateLineItem(doubled),
            Command::SetCells {
                line_item: units_id,
                edits: vec![CellEdit {
                    coords: vec![month(0)],
                    value: Value::Number(4.0),
                }],
            },
        ])
        .unwrap();
    assert_eq!(fx.number_at(doubled_id, vec![month(0)]), 8.0);
}

#[test]
fn structural_changes_recalculate_without_recalc_all() {
    let mut fx = Fx::new(1);
    let products = fx.list("Products", None);
    let [widget] = fx.named_items(products, "W", 1)[..] else {
        unreachable!()
    };
    let sales = fx.module("Sales", vec![list_axis(products), month_axis()]);
    let units = fx.number(sales, "Units");
    let revenue = fx.calc(sales, "Revenue", "Units * 2");
    let report = fx.calc(sales, "Report", "Revenue + 1");
    fx.set_number(units, vec![item(widget), month(0)], 5.0);

    let [gadget] = fx.named_items(products, "G", 1)[..] else {
        unreachable!()
    };
    fx.set_number(units, vec![item(gadget), month(0)], 6.0);
    assert_eq!(fx.number_at(revenue, vec![item(gadget), month(0)]), 12.0);
    assert_eq!(fx.number_at(report, vec![item(gadget), month(0)]), 13.0);
    assert_eq!(fx.number_at(revenue, vec![item(widget), month(0)]), 10.0);

    let changes = fx.update_formula(revenue, "Units * 3").unwrap();
    assert!(changes.changed_line_items.contains(&revenue));
    assert!(changes.changed_line_items.contains(&report));
    assert_eq!(fx.number_at(revenue, vec![item(gadget), month(0)]), 18.0);
    assert_eq!(fx.number_at(report, vec![item(gadget), month(0)]), 19.0);

    fx.model
        .apply(Command::SetCalendar {
            calendar: calendar(2),
        })
        .unwrap();
    // A new calendar clears what was typed in over Time, and what is calculated follows.
    assert_eq!(
        fx.number_at(revenue, vec![item(widget), period("Jan 26")]),
        0.0
    );
    assert_eq!(
        fx.number_at(report, vec![item(widget), period("Dec 27")]),
        1.0
    );
    fx.set_number(units, vec![item(widget), period("Dec 27")], 2.0);
    assert_eq!(
        fx.number_at(revenue, vec![item(widget), period("Dec 27")]),
        6.0
    );
    assert_eq!(
        fx.number_at(report, vec![item(widget), period("Dec 27")]),
        7.0
    );
}

#[test]
fn unrelated_commands_leave_calculated_line_items_alone() {
    let mut fx = Fx::new(1);
    let sheet = fx.module("Sheet", vec![month_axis()]);
    let units = fx.number(sheet, "Units");
    fx.calc(sheet, "Doubled", "Units * 2");
    fx.set_number(units, vec![month(0)], 4.0);

    let changes = fx.model.apply(Command::CreateList {
        id: ListId::new(),
        name: "Regions".to_string(),
        parent: None,
        top_level_name: None,
        numbered: false,
        production_data: false,
    });

    assert!(changes.unwrap().changed_line_items.is_empty());
    assert_eq!(fx.model.last_recalc_stats().line_items, 0);
}

#[test]
fn an_edit_of_an_actual_cell_reaches_the_versions_that_show_it() {
    let mut fx = Fx::new(1);
    let sheet = fx.module("Sheet", vec![month_axis(), AxisSpec::Versions]);
    let units = fx.number(sheet, "Units");
    let revenue = fx.calc(sheet, "Revenue", "Units * 2");
    let budget = fx
        .model
        .structure()
        .version_by_name("Budget")
        .unwrap()
        .clone();
    let actual = fx
        .model
        .structure()
        .version_by_name("Actual")
        .unwrap()
        .clone();
    fx.model
        .apply(Command::UpsertVersion {
            id: budget.id,
            name: budget.name.clone(),
            is_actual: false,
            is_current: true,
            switchover: Some(3),
        })
        .unwrap();
    let version = |id: openplan_engine::VersionId| item(ItemId(id.0));

    fx.set_number(units, vec![month(1), version(actual.id)], 5.0);

    assert_eq!(
        fx.number_at(revenue, vec![month(1), version(actual.id)]),
        10.0
    );
    assert_eq!(
        fx.number_at(revenue, vec![month(1), version(budget.id)]),
        10.0,
        "Budget shows the actual Units before its switchover"
    );
    fx.set_number(units, vec![month(1), version(actual.id)], 6.0);
    assert_eq!(
        fx.number_at(revenue, vec![month(1), version(budget.id)]),
        12.0
    );
    assert_eq!(
        fx.number_at(revenue, vec![month(4), version(budget.id)]),
        0.0
    );
}

#[test]
fn an_edit_of_a_broadcast_source_reaches_every_cell_it_feeds() {
    let mut fx = Fx::new(1);
    let products = fx.list("Products", None);
    let ids = fx.named_items(products, "P", 30);
    let sales = fx.module("Sales", vec![list_axis(products), month_axis()]);
    let rates = fx.module("Rates", vec![month_axis()]);
    let units = fx.number(sales, "Units");
    let price = fx.number(rates, "Price");
    let revenue = fx.calc(sales, "Revenue", "Units * Price");
    fx.set(
        units,
        ids.iter()
            .map(|&id| (vec![item(id), month(2)], 2.0))
            .collect(),
    );

    fx.set_number(price, vec![month(2)], 5.0);

    assert_eq!(fx.model.last_recalc_stats().evaluated_cells, 30);
    for &id in &ids {
        assert_eq!(fx.number_at(revenue, vec![item(id), month(2)]), 10.0);
        assert_eq!(fx.number_at(revenue, vec![item(id), month(3)]), 0.0);
    }
}

#[test]
fn what_a_modifier_reads_is_recalculated_whole() {
    let mut fx = Fx::new(1);
    let employees = fx.list("Employees", None);
    let people = fx.named_items(employees, "E", 4);
    let departments = fx.list("Departments", None);
    let depts = fx.named_items(departments, "D", 2);
    let staff = fx.module("Staff", vec![list_axis(employees), month_axis()]);
    let info = fx.module("Info", vec![list_axis(employees)]);
    let costs = fx.module("Costs", vec![list_axis(departments), month_axis()]);
    let salary = fx.number(staff, "Salary");
    let dept = fx.add(line_item(
        info,
        "Dept",
        Format::List { list: departments },
        None,
    ));
    let payroll = fx.calc(costs, "Payroll", "Salary[SUM: Dept]");
    for (index, &person) in people.iter().enumerate() {
        fx.model
            .apply(Command::SetCells {
                line_item: dept,
                edits: vec![CellEdit {
                    coords: vec![item(person)],
                    value: Value::Item(Some(depts[index % 2])),
                }],
            })
            .unwrap();
    }

    fx.set_number(salary, vec![item(people[0]), month(0)], 100.0);
    assert_eq!(fx.model.last_recalc_stats().evaluated_cells, 24);
    fx.set_number(salary, vec![item(people[2]), month(0)], 50.0);

    assert_eq!(fx.number_at(payroll, vec![item(depts[0]), month(0)]), 150.0);
    assert_eq!(fx.number_at(payroll, vec![item(depts[1]), month(0)]), 0.0);
    fx.model
        .apply(Command::SetCells {
            line_item: dept,
            edits: vec![CellEdit {
                coords: vec![item(people[2])],
                value: Value::Item(Some(depts[1])),
            }],
        })
        .unwrap();
    assert_eq!(fx.number_at(payroll, vec![item(depts[0]), month(0)]), 100.0);
    assert_eq!(fx.number_at(payroll, vec![item(depts[1]), month(0)]), 50.0);
}

fn assert_close(actual: f64, expected: f64) {
    assert!(
        (actual - expected).abs() < 1e-12,
        "expected {expected}, found {actual}"
    );
}

#[test]
fn formula_summary_method() {
    let mut fx = Fx::new(1);
    let products = fx.list("Products", Some("All Products"));
    let [widget, gadget] = fx.named_items(products, "P", 2)[..] else {
        unreachable!()
    };
    let sales = fx.module("Sales", vec![list_axis(products), month_axis()]);
    let revenue = fx.number(sales, "Revenue");
    let margin = fx.number(sales, "Margin");
    let mut percent = line_item(
        sales,
        "Margin %",
        Format::number(),
        Some("Margin / Revenue"),
    );
    percent.summary = SummaryMethod::Formula;
    let percent = fx.add(percent);
    fx.set(
        revenue,
        vec![
            (vec![item(widget), month(0)], 100.0),
            (vec![item(widget), month(1)], 300.0),
            (vec![item(gadget), month(0)], 50.0),
        ],
    );
    fx.set(
        margin,
        vec![
            (vec![item(widget), month(0)], 20.0),
            (vec![item(widget), month(1)], 30.0),
            (vec![item(gadget), month(0)], 25.0),
        ],
    );
    let year = Axis::Time {
        level: TimeLevel::Year,
        range: None,
    };
    let month_level = Axis::Time {
        level: TimeLevel::Month,
        range: None,
    };
    let per_year = LevelSpec(vec![Axis::List(products), year.clone()]);
    let per_product = LevelSpec(vec![Axis::ListTop(products), month_level]);
    let total = LevelSpec(vec![Axis::ListTop(products), year]);
    let read = |fx: &Fx, levels: &LevelSpec, coords: Vec<CoordToken>| match fx
        .model
        .read_summary(percent, &coords, levels)
        .unwrap()
    {
        Value::Number(number) => number,
        other => panic!("expected a number, found {other:?}"),
    };

    assert_close(fx.number_at(percent, vec![item(widget), month(0)]), 0.2);
    assert_close(
        read(&fx, &per_year, vec![item(widget), period("FY26")]),
        50.0 / 400.0,
    );
    assert_close(
        read(&fx, &per_product, vec![period("top"), month(0)]),
        45.0 / 150.0,
    );
    assert_close(
        read(&fx, &total, vec![period("top"), period("FY26")]),
        75.0 / 450.0,
    );

    fx.set_number(revenue, vec![item(widget), month(0)], 200.0);

    assert_close(
        read(&fx, &per_year, vec![item(widget), period("FY26")]),
        50.0 / 500.0,
    );
    assert_close(
        read(&fx, &total, vec![period("top"), period("FY26")]),
        75.0 / 550.0,
    );
}

#[test]
fn formula_summaries_are_read_by_the_formulas_that_use_them() {
    let mut fx = Fx::new(1);
    let products = fx.list("Products", Some("All Products"));
    let [widget] = fx.named_items(products, "P", 1)[..] else {
        unreachable!()
    };
    let sales = fx.module("Sales", vec![list_axis(products), month_axis()]);
    let yearly = fx.module(
        "Yearly",
        vec![AxisSpec::Time {
            level: TimeLevel::Year,
            range: None,
        }],
    );
    let revenue = fx.number(sales, "Revenue");
    let margin = fx.number(sales, "Margin");
    let mut percent = line_item(
        sales,
        "Margin %",
        Format::number(),
        Some("Margin / Revenue"),
    );
    percent.summary = SummaryMethod::Formula;
    fx.add(percent);
    let shown = fx.calc(yearly, "Shown", "'Margin %'");
    fx.set(
        revenue,
        vec![
            (vec![item(widget), month(0)], 100.0),
            (vec![item(widget), month(1)], 300.0),
        ],
    );
    fx.set(
        margin,
        vec![
            (vec![item(widget), month(0)], 20.0),
            (vec![item(widget), month(1)], 30.0),
        ],
    );

    assert_close(fx.number_at(shown, vec![period("FY26")]), 50.0 / 400.0);
    fx.set_number(margin, vec![item(widget), month(1)], 100.0);
    assert_close(fx.number_at(shown, vec![period("FY26")]), 120.0 / 400.0);
}

fn dump(fx: &Fx, ids: &[LineItemId], products: &[ItemId]) -> Vec<Value> {
    let mut values = Vec::new();
    for &id in ids {
        let coords: Vec<Vec<CoordToken>> = products
            .iter()
            .flat_map(|&product| (0..12).map(move |m| vec![item(product), month(m)]))
            .collect();
        values.extend(fx.model.read_cells(id, &coords).unwrap());
    }
    values
}

#[test]
fn parallel_layers_deterministic() {
    let mut fx = Fx::new(1);
    let products = fx.list("Products", None);
    let ids = fx.named_items(products, "P", 40);
    let sales = fx.module("Sales", vec![list_axis(products), month_axis()]);
    let units = fx.number(sales, "Units");
    let mut running = Vec::new();
    for i in 0..12 {
        let scaled = fx.calc(sales, &format!("Scaled {i}"), &format!("Units * {}", i + 1));
        running.push(fx.calc(
            sales,
            &format!("Running {i}"),
            &format!("CUMULATE('Scaled {i}')"),
        ));
        assert!(fx.model.line_item_errors(scaled).is_none());
    }
    let sum = running
        .iter()
        .enumerate()
        .map(|(i, _)| format!("'Running {i}'"))
        .collect::<Vec<_>>()
        .join(" + ");
    let total = fx.calc(sales, "Total", &sum);
    let unit_at = |p: usize, m: usize| ((p * 7 + m * 3) % 11) as f64;
    fx.set(
        units,
        (0..40)
            .flat_map(|p| (0..12).map(move |m| (p, m)))
            .map(|(p, m)| (vec![item(ids[p]), month(m)], unit_at(p, m)))
            .collect(),
    );
    let mut watched = running.clone();
    watched.push(total);
    let reference = dump(&fx, &watched, &ids);

    for p in [0, 17, 39] {
        let mut cumulative = 0.0;
        for m in 0..12 {
            cumulative += unit_at(p, m);
            assert_eq!(
                fx.number_at(total, vec![item(ids[p]), month(m)]),
                78.0 * cumulative
            );
        }
    }
    for threads in [1, 2, 3, 8, 1, 4] {
        let pool = rayon::ThreadPoolBuilder::new()
            .num_threads(threads)
            .build()
            .unwrap();
        pool.install(|| fx.model.recalc_all().unwrap());
        assert_eq!(dump(&fx, &watched, &ids), reference, "{threads} threads");
    }
    fx.set_number(units, vec![item(ids[3]), month(4)], 100.0);
    let edited = dump(&fx, &watched, &ids);
    assert_ne!(edited, reference);
    fx.model.recalc_all().unwrap();
    assert_eq!(dump(&fx, &watched, &ids), edited);
}

/// The benchmark shape of the engine: 10,000 products by 36 months by 3 versions, about 1.08
/// million cells in every line item.
#[test]
#[cfg_attr(
    debug_assertions,
    ignore = "needs an optimized build: cargo test --release -p openplan-engine edit_1m_cells -- --nocapture"
)]
fn edit_1m_cells_recalculates_in_milliseconds() {
    const PRODUCTS: usize = 10_000;
    let mut fx = Fx::new(3);
    let products = fx.list("Products", None);
    let ids = fx.named_items(products, "P", PRODUCTS);
    let sales = fx.module(
        "Sales",
        vec![list_axis(products), month_axis(), AxisSpec::Versions],
    );
    let units = fx.number(sales, "Units");
    let price = fx.number(sales, "Price");
    let versions: Vec<ItemId> = fx
        .model
        .structure()
        .versions()
        .iter()
        .map(|version| ItemId(version.id.0))
        .collect();
    let months: Vec<String> = (0..36)
        .map(|m| format!("{} {}", &MONTHS[m % 12][..3], 26 + m / 12))
        .collect();
    for (line_item, base) in [(units, 10.0), (price, 2.0)] {
        for block in ids.chunks(1_000) {
            let edits = block
                .iter()
                .flat_map(|&product| {
                    let months = &months;
                    let versions = &versions;
                    (0..36).flat_map(move |m| {
                        versions.iter().map(move |&version| CellEdit {
                            coords: vec![item(product), period(&months[m]), item(version)],
                            value: Value::Number(base + (m % 5) as f64),
                        })
                    })
                })
                .collect();
            fx.model
                .apply(Command::SetCells { line_item, edits })
                .unwrap();
        }
    }
    let revenue = fx.calc(sales, "Revenue", "Units * Price");
    let cost = fx.calc(sales, "Cost", "Revenue * 0.6");
    fx.calc(sales, "Margin", "Revenue - Cost");
    let cumulative = fx.calc(sales, "Cumulative Margin", "CUMULATE(Margin)");

    let coords = |product: usize, m: usize, version: usize| {
        vec![
            item(ids[product]),
            period(&months[m]),
            item(versions[version]),
        ]
    };
    let mut best = std::time::Duration::MAX;
    for round in 0..5 {
        let started = std::time::Instant::now();
        fx.set_number(units, coords(4_321, 7, 1), 100.0 + f64::from(round));
        let elapsed = started.elapsed();
        println!("edit {round}: {elapsed:?}");
        best = best.min(elapsed);
    }

    let stats = fx.model.last_recalc_stats();
    println!("last edit: {stats:?}, best {best:?}");
    assert_eq!(stats.line_items, 4);
    assert_eq!(stats.evaluated_cells, 3 + PRODUCTS * 36 * 3);
    let edited = 104.0;
    let price_there = 2.0 + 2.0;
    assert_eq!(
        fx.number_at(revenue, coords(4_321, 7, 1)),
        edited * price_there
    );
    assert_eq!(
        fx.number_at(cost, coords(4_321, 7, 1)),
        edited * price_there * 0.6
    );
    let margins: f64 = (0..=7)
        .map(|m| {
            let units = if m == 7 {
                edited
            } else {
                10.0 + (m % 5) as f64
            };
            let revenue = units * (2.0 + (m % 5) as f64);
            revenue - revenue * 0.6
        })
        .sum();
    assert_close(fx.number_at(cumulative, coords(4_321, 7, 1)), margins);
    assert!(
        best < std::time::Duration::from_millis(50),
        "one edit took {best:?}, over the 50 ms target"
    );
}

#[test]
fn a_cycle_goes_back_in_time_only_by_a_literal_number_of_periods() {
    let mut fx = Fx::new(1);
    let sheet = fx.module("Sheet", vec![month_axis()]);
    fx.number(sheet, "Flow");
    fx.number(sheet, "Shift");
    let a = fx.number(sheet, "A");

    for formula in [
        "PREVIOUS(A) + Flow",
        "LAG(A, 1, 0) + Flow",
        "LAG(A, 2.7, 0) + Flow",
        "OFFSET(A, -1, 0) + Flow",
        "OFFSET(A, -(1), 0) + Flow",
        "OFFSET(A, - 3, Flow) + Flow",
        "LAG(PREVIOUS(A), 1, 0) + Flow",
        "IF Flow > 0 THEN PREVIOUS(A) ELSE 0",
        "CUMULATE(PREVIOUS(A)) + Flow",
        "PREVIOUS(CUMULATE(A)) + Flow",
        "YEARTODATE(PREVIOUS(A)) + Flow",
    ] {
        assert!(fx.update_formula(a, formula).is_ok(), "{formula}");
    }
    for formula in [
        "A + Flow",
        "OFFSET(A, 0, 0) + Flow",
        "LAG(A, 0, 0) + Flow",
        "LAG(A, 0.5, 0) + Flow",
        "OFFSET(A, -0.5, 0) + Flow",
        "LAG(A, -1, 0) + Flow",
        "OFFSET(A, 1, 0) + Flow",
        "LEAD(A, 1, 0) + Flow",
        "LEAD(A, -1, 0) + Flow",
        "NEXT(A) + Flow",
        "LAG(A, Shift, 0) + Flow",
        "OFFSET(A, Shift, 0) + Flow",
        "LAG(Flow, 1, A)",
        "OFFSET(Flow, -1, A)",
        "PREVIOUS(A) + A",
        "PREVIOUS(NEXT(A))",
        "NEXT(PREVIOUS(A))",
        "TIMESUM(A)",
        "CUMULATE(A)",
        "PREVIOUS(A[SELECT: Time.'Jan 26'])",
        "MOVINGSUM(A, -2, -1)",
    ] {
        let errors = formula_errors(fx.update_formula(a, formula));
        assert_eq!(errors[0].code, "formula.cycle", "{formula}");
        assert!(
            errors[0].message.starts_with("Circular reference: A → A"),
            "{formula}: {}",
            errors[0].message
        );
    }
    assert_eq!(
        fx.model
            .structure()
            .line_item(a)
            .unwrap()
            .formula
            .as_deref(),
        Some("YEARTODATE(PREVIOUS(A)) + Flow")
    );
}

#[test]
fn scans_inside_a_cycle_read_only_the_periods_before_the_current_one() {
    let mut fx = Fx::new(1);
    let sheet = fx.module("Sheet", vec![month_axis()]);
    let flow = fx.number(sheet, "Flow");
    let a = fx.number(sheet, "A");
    let b = fx.number(sheet, "B");
    fx.update_formula(a, "CUMULATE(PREVIOUS(A)) + Flow")
        .unwrap();
    fx.update_formula(b, "PREVIOUS(CUMULATE(B)) + Flow")
        .unwrap();
    let flows = [3.0, 1.0, 4.0, 1.0, 5.0, 9.0, 2.0, 6.0, 5.0, 3.0, 5.0, 8.0];
    fx.set(
        flow,
        flows
            .iter()
            .enumerate()
            .map(|(m, &number)| (vec![month(m)], number))
            .collect(),
    );

    let (mut by_a, mut by_b) = (Vec::new(), Vec::new());
    for flow in flows {
        // CUMULATE(PREVIOUS(A)) at a month is the total of A before it.
        by_a.push(by_a.iter().sum::<f64>() + flow);
        // PREVIOUS(CUMULATE(B)) at a month is the total of B before it too.
        by_b.push(by_b.iter().sum::<f64>() + flow);
    }
    assert_eq!(fx.months_of(a), by_a);
    assert_eq!(fx.months_of(b), by_b);
}

#[test]
fn a_cycle_that_reads_ahead_or_across_time_axes_is_rejected_with_the_reason() {
    let mut fx = Fx::new(2);
    let months = fx.module("Months", vec![month_axis()]);
    let quarters = fx.module(
        "Quarters",
        vec![AxisSpec::Time {
            level: TimeLevel::Quarter,
            range: None,
        }],
    );
    let a = fx.number(months, "A");
    let b = fx.number(months, "B");
    fx.update_formula(a, "PREVIOUS(B)").unwrap();

    let errors = formula_errors(fx.update_formula(b, "TIMESUM(A)"));
    assert_eq!(errors[0].code, "formula.cycle");
    assert!(
        errors[0]
            .message
            .starts_with("Circular reference: A → B → A. "),
        "{}",
        errors[0].message
    );
    assert!(errors[0].message.contains("PREVIOUS, LAG or OFFSET"));

    let c = fx.number(quarters, "C");
    fx.update_formula(a, "PREVIOUS(C)").unwrap();
    let errors = formula_errors(fx.update_formula(c, "A"));
    assert!(
        errors[0]
            .message
            .starts_with("Circular reference: A → C → A. "),
        "{}",
        errors[0].message
    );
    assert!(errors[0].message.contains("same Time dimension"));
}

#[test]
fn a_cycle_made_in_one_batch_is_rejected_whole() {
    let mut fx = Fx::new(1);
    let sheet = fx.module("Sheet", vec![month_axis()]);
    let a = fx.number(sheet, "A");
    let b = fx.number(sheet, "B");

    let result = fx.model.apply_batch(vec![
        Command::UpdateLineItem {
            id: a,
            patch: formula_patch("B + 1"),
        },
        Command::UpdateLineItem {
            id: b,
            patch: formula_patch("A + 1"),
        },
    ]);

    let errors = formula_errors(result);
    assert_eq!(errors[0].message, "Circular reference: A → B → A");
    assert!(fx.model.structure().line_item(a).unwrap().formula.is_none());
    assert!(fx.model.structure().line_item(b).unwrap().formula.is_none());
}

#[test]
fn a_balance_cycle_runs_for_every_product_and_recalculates_after_an_edit() {
    let mut fx = Fx::new(1);
    let products = fx.list("Products", None);
    let ids = fx.named_items(products, "P", 3);
    let sheet = fx.module("Stock", vec![list_axis(products), month_axis()]);
    let received = fx.number(sheet, "Received");
    let sold = fx.number(sheet, "Sold");
    let closing = fx.number(sheet, "Closing");
    let opening = fx.calc(sheet, "Opening", "PREVIOUS(Closing)");
    fx.update_formula(closing, "Opening + Received - Sold")
        .unwrap();
    let all: Vec<(Vec<CoordToken>, f64)> = (0..3)
        .flat_map(|p| (0..12).map(move |m| (p, m)))
        .map(|(p, m)| (vec![item(ids[p]), month(m)], (p + 1) as f64))
        .collect();
    fx.set(received, all);
    fx.set_number(sold, vec![item(ids[1]), month(2)], 5.0);

    let balance = |fx: &Fx, p: usize| -> Vec<f64> {
        (0..12)
            .map(|m| fx.number_at(closing, vec![item(ids[p]), month(m)]))
            .collect()
    };
    assert_eq!(balance(&fx, 0), (1..=12).map(f64::from).collect::<Vec<_>>());
    let second: Vec<f64> = (0..12)
        .map(|m| 2.0 * f64::from(m + 1) - if m >= 2 { 5.0 } else { 0.0 })
        .collect();
    assert_eq!(balance(&fx, 1), second);
    assert_eq!(fx.number_at(opening, vec![item(ids[2]), month(4)]), 12.0);

    fx.set_number(sold, vec![item(ids[2]), month(0)], 1.0);

    let stats = fx.model.last_recalc_stats();
    assert_eq!((stats.line_items, stats.evaluated_cells), (2, 72));
    assert_eq!(fx.number_at(closing, vec![item(ids[2]), month(0)]), 2.0);
    assert_eq!(fx.number_at(closing, vec![item(ids[2]), month(11)]), 35.0);
    assert_eq!(balance(&fx, 0), (1..=12).map(f64::from).collect::<Vec<_>>());
}

#[test]
fn a_cycle_may_pass_through_line_items_with_different_dimensions() {
    let mut fx = Fx::new(1);
    let products = fx.list("Products", Some("All Products"));
    let ids = fx.named_items(products, "P", 2);
    let stock = fx.module("Stock", vec![list_axis(products), month_axis()]);
    let totals = fx.module("Totals", vec![month_axis()]);
    let flow = fx.number(stock, "Flow");
    let closing = fx.number(stock, "Closing");
    fx.calc(stock, "Opening", "PREVIOUS(Closing)");
    let total = fx.calc(totals, "Total", "Closing");
    fx.update_formula(closing, "Opening + Flow + PREVIOUS(Total)")
        .unwrap();
    let flows = |p: usize, m: usize| (p * 3 + m % 4) as f64;
    fx.set(
        flow,
        (0..2)
            .flat_map(|p| (0..12).map(move |m| (p, m)))
            .map(|(p, m)| (vec![item(ids[p]), month(m)], flows(p, m)))
            .collect(),
    );

    let mut expected_closing = [[0.0; 12]; 2];
    let mut expected_total = [0.0; 12];
    for m in 0..12 {
        let earlier = if m == 0 { 0.0 } else { expected_total[m - 1] };
        for (p, closing) in expected_closing.iter_mut().enumerate() {
            let opening = if m == 0 { 0.0 } else { closing[m - 1] };
            closing[m] = opening + flows(p, m) + earlier;
        }
        expected_total[m] = expected_closing[0][m] + expected_closing[1][m];
    }
    for (m, total_at) in expected_total.iter().enumerate() {
        assert_eq!(fx.number_at(total, vec![month(m)]), *total_at);
        for (p, per_month) in expected_closing.iter().enumerate() {
            assert_eq!(
                fx.number_at(closing, vec![item(ids[p]), month(m)]),
                per_month[m]
            );
        }
    }
    assert_eq!(fx.model.last_recalc_stats().line_items, 3);
}

#[test]
fn the_parts_of_a_ratio_are_calculated_before_the_ratio_is_read_rolled_up() {
    let mut fx = Fx::new(1);
    let countries = fx.list("Countries", Some("All Countries"));
    let ids = fx.named_items(countries, "C", 2);
    let detail = fx.module("Detail", vec![list_axis(countries)]);
    let units = fx.number(detail, "Units");
    let revenue = fx.calc(detail, "Revenue", "Units * 2");
    let margin = fx.calc(detail, "Margin", "Units");
    let mut percent = line_item(detail, "Margin %", Format::number(), None);
    percent.summary = SummaryMethod::Ratio {
        numerator: margin,
        denominator: revenue,
    };
    fx.add(percent);
    let total = fx.module("Total", Vec::new());
    let shown = fx.calc(total, "Shown", "'Margin %'");

    fx.set(
        units,
        vec![(vec![item(ids[0])], 10.0), (vec![item(ids[1])], 30.0)],
    );

    // Margin over revenue of both countries, which is read after both are calculated.
    assert_eq!(fx.number_at(shown, Vec::new()), 0.5);
    fx.set_number(units, vec![item(ids[0])], 50.0);
    assert_eq!(fx.number_at(shown, Vec::new()), 0.5);
}

#[test]
fn a_change_of_dimensions_that_breaks_a_formula_leaves_it_in_error_until_it_is_undone() {
    let mut fx = Fx::new(1);
    let regions = fx.list("Regions", None);
    fx.named_items(regions, "R", 2);
    let source = fx.module("Source", vec![month_axis()]);
    let report = fx.module("Report", vec![month_axis()]);
    let base = fx.number(source, "Base");
    let shown = fx.calc(report, "Shown", "Base + 1");
    fx.set_number(base, vec![month(0)], 4.0);
    assert_eq!(fx.number_at(shown, vec![month(0)]), 5.0);

    // Base now has a Regions dimension that Shown has no way to map.
    fx.model
        .apply(Command::UpdateModule {
            id: source,
            name: None,
            axes: Some(vec![list_axis(regions), month_axis()]),
            functional_area: None,
        })
        .unwrap();

    let errors = fx.errors(shown);
    assert_eq!(errors[0].code, "formula.dimension");
    assert_eq!(fx.number_at(shown, vec![month(0)]), 0.0);

    fx.model
        .apply(Command::UpdateModule {
            id: source,
            name: None,
            axes: Some(vec![month_axis()]),
            functional_area: None,
        })
        .unwrap();

    assert!(fx.model.line_item_errors(shown).is_none());
    fx.set_number(base, vec![month(1)], 6.0);
    assert_eq!(fx.number_at(shown, vec![month(1)]), 7.0);
    assert_eq!(fx.number_at(shown, vec![month(0)]), 1.0);
}

#[test]
fn a_formula_summary_that_reads_itself_is_an_error_not_a_loop() {
    let mut fx = Fx::new(1);
    let sheet = fx.module("Sheet", vec![month_axis()]);
    let flow = fx.number(sheet, "Flow");
    let mut total = line_item(
        sheet,
        "Total",
        Format::number(),
        Some("PREVIOUS(Total) + Flow"),
    );
    total.summary = SummaryMethod::Formula;
    let total = fx.add(total);
    fx.set_number(flow, vec![month(0)], 2.0);
    let year = LevelSpec(vec![Axis::Time {
        level: TimeLevel::Year,
        range: None,
    }]);

    let error = fx
        .model
        .read_summary(total, &[period("FY26")], &year)
        .unwrap_err();

    let EngineError::Formula(errors) = error else {
        panic!("expected a formula error, found {error:?}");
    };
    assert!(errors[0].message.contains("reads itself"), "{errors:?}");
    assert_eq!(fx.number_at(total, vec![month(0)]), 2.0);
}

#[test]
fn a_batch_may_mix_structure_and_cells() {
    let mut fx = Fx::new(1);
    let products = fx.list("Products", None);
    let [widget] = fx.named_items(products, "W", 1)[..] else {
        unreachable!()
    };
    let sales = fx.module("Sales", vec![list_axis(products)]);
    let units = fx.number(sales, "Units");
    let doubled = fx.calc(sales, "Doubled", "Units * 2");
    let gadget = ItemId::new();
    let edit = |coords, number| CellEdit {
        coords: vec![item(coords)],
        value: Value::Number(number),
    };

    let changes = fx
        .model
        .apply_batch(vec![
            Command::SetCells {
                line_item: units,
                edits: vec![edit(widget, 3.0)],
            },
            Command::UpsertListItems {
                list: products,
                items: vec![ItemSpec {
                    id: gadget,
                    code: None,
                    name: "Gadget".to_string(),
                    parent: None,
                }],
            },
            Command::SetCells {
                line_item: units,
                edits: vec![edit(gadget, 5.0)],
            },
        ])
        .unwrap();

    assert!(changes.structure_changed);
    assert!(changes.changed_line_items.contains(&doubled));
    assert_eq!(fx.number_at(doubled, vec![item(widget)]), 6.0);
    assert_eq!(fx.number_at(doubled, vec![item(gadget)]), 10.0);

    fx.model
        .apply_batch(vec![
            Command::SetCells {
                line_item: units,
                edits: vec![edit(widget, 4.0)],
            },
            Command::UpsertListItems {
                list: products,
                items: Vec::new(),
            },
        ])
        .unwrap();
    assert_eq!(fx.number_at(doubled, vec![item(widget)]), 8.0);
}

/// The kinds of module of the property test: by countries, months and versions, by regions,
/// months and versions, and by months alone.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Kind {
    Fine,
    Coarse,
    Flat,
}

/// A read of a line item in a generated formula: how it is wrapped, which of the line items
/// that can be read it is, and how a read across kinds of module is written.
#[derive(Clone, Debug)]
struct Operand {
    wrap: u8,
    source: usize,
    form: u8,
}

#[derive(Clone, Debug)]
struct Spec {
    first: Operand,
    second: Option<(u8, Operand)>,
}

/// Cells to type in: the input, the position among its cells and the number.
type Picks = Vec<(u8, usize, i8)>;

#[derive(Clone, Debug)]
enum Edit {
    Cells(Picks),
    /// Cells, then a country with a cell of its own, in one batch.
    Grown {
        cells: Picks,
        region: u8,
        value: i8,
    },
    Formula {
        derived: usize,
        spec: Spec,
    },
    Summary {
        input: u8,
        method: u8,
    },
    AddCountry {
        region: u8,
    },
    DeleteCountry {
        which: usize,
    },
    Reparent {
        which: usize,
        region: u8,
    },
    Switchover {
        month: u8,
    },
}

fn operand() -> impl Strategy<Value = Operand> {
    (0u8..10, any::<usize>(), 0u8..2).prop_map(|(wrap, source, form)| Operand {
        wrap,
        source,
        form,
    })
}

fn spec() -> impl Strategy<Value = Spec> {
    (operand(), proptest::option::of((0u8..4, operand())))
        .prop_map(|(first, second)| Spec { first, second })
}

fn picks() -> impl Strategy<Value = Picks> {
    proptest::collection::vec((0u8..5, any::<usize>(), -4i8..5), 1..5)
}

fn edit() -> impl Strategy<Value = Edit> {
    prop_oneof![
        6 => picks().prop_map(Edit::Cells),
        1 => (picks(), 0u8..2, -4i8..5)
            .prop_map(|(cells, region, value)| Edit::Grown { cells, region, value }),
        3 => (any::<usize>(), spec()).prop_map(|(derived, spec)| Edit::Formula { derived, spec }),
        1 => (0u8..4, 0u8..4).prop_map(|(input, method)| Edit::Summary { input, method }),
        1 => (0u8..2).prop_map(|region| Edit::AddCountry { region }),
        1 => any::<usize>().prop_map(|which| Edit::DeleteCountry { which }),
        1 => (any::<usize>(), 0u8..2).prop_map(|(which, region)| Edit::Reparent { which, region }),
        1 => (0u8..12).prop_map(|month| Edit::Switchover { month }),
    ]
}

/// The formula a spec stands for in a line item of kind `kind`, reading from `sources`, the
/// line items before it.
fn formula_for(kind: Kind, spec: &Spec, sources: &[(String, Kind)]) -> String {
    let readable: Vec<&(String, Kind)> = sources
        .iter()
        .filter(|(_, source)| kind != Kind::Flat || *source == Kind::Flat)
        .collect();
    let read = |operand: &Operand| {
        let (name, source) = readable[operand.source % readable.len()];
        let reference = match (kind, source, operand.form) {
            (Kind::Fine, Kind::Coarse, 1) => format!("{name}[LOOKUP: Dept]"),
            (Kind::Coarse, Kind::Fine, 1) => format!("{name}[SUM: Dept]"),
            _ => name.clone(),
        };
        match (operand.wrap, kind) {
            (2, _) => format!("PREVIOUS({reference})"),
            (3, _) => format!("CUMULATE({reference})"),
            (4, _) => format!("({reference} * 2)"),
            (5, _) => format!("LAG({reference}, 2, 0)"),
            (6, _) => format!("OFFSET({reference}, -1, 0)"),
            (7, _) => format!("YEARTODATE({reference})"),
            (8, Kind::Fine | Kind::Coarse) => format!("CURRENTVERSION({reference})"),
            (9, Kind::Fine | Kind::Coarse) => format!("PREVIOUSVERSION({reference})"),
            _ => reference,
        }
    };
    let first = read(&spec.first);
    match &spec.second {
        None => first,
        Some((op, second)) => {
            let second = read(second);
            match op {
                0 => format!("({first}) + ({second})"),
                1 => format!("({first}) * ({second})"),
                2 => format!("({first}) - ({second})"),
                _ => format!("IF ({first}) > ({second}) THEN ({first}) ELSE ({second})"),
            }
        }
    }
}

/// A model built from commands that can be built again from the same commands, to check that
/// what recalculating after each command gives is what calculating everything gives.
struct Rig {
    model: Model,
    history: Vec<Vec<Command>>,
    regions: Vec<ItemId>,
    countries_list: ListId,
    regions_list: ListId,
    countries: Vec<ItemId>,
    next_country: usize,
    /// The actual version and the current version, which the model adds to its own.
    versions: [VersionId; 2],
    /// Countries, months and versions by `F1` and `F2`, regions, months and versions by `C1`,
    /// months by `T1`, and the region of each country by `Dept`.
    inputs: [LineItemId; 5],
    /// The line items that generated formulas can read, with their kinds.
    bases: Vec<(String, LineItemId, Kind)>,
    derived: Vec<(String, LineItemId, Kind)>,
}

impl Rig {
    fn new(initial: &[(u8, Spec)]) -> Rig {
        let regions_list = ListId::new();
        let countries_list = ListId::new();
        let regions: Vec<ItemId> = (0..2).map(|_| ItemId::new()).collect();
        let countries: Vec<ItemId> = (0..4).map(|_| ItemId::new()).collect();
        let versions = [VersionId::new(), VersionId::new()];
        let module = |name: &str, axes: Vec<AxisSpec>| {
            let id = ModuleId::new();
            let command = Command::CreateModule {
                id,
                name: name.to_string(),
                axes,
                functional_area: String::new(),
            };
            (id, command)
        };
        let (fine, create_fine) = module(
            "Fine",
            vec![list_axis(countries_list), month_axis(), AxisSpec::Versions],
        );
        let (coarse, create_coarse) = module(
            "Coarse",
            vec![list_axis(regions_list), month_axis(), AxisSpec::Versions],
        );
        let (flat, create_flat) = module("Flat", vec![month_axis()]);
        let (info, create_info) = module("Info", vec![list_axis(countries_list)]);
        let new = |module, name: &str, format, formula: Option<&str>| {
            let line_item = line_item(module, name, format, formula);
            (line_item.id, Command::CreateLineItem(line_item))
        };
        let (f1, create_f1) = new(fine, "F1", Format::number(), None);
        let (f2, create_f2) = new(fine, "F2", Format::number(), None);
        let (c1, create_c1) = new(coarse, "C1", Format::number(), None);
        let (t1, create_t1) = new(flat, "T1", Format::number(), None);
        let (dept, create_dept) = new(info, "Dept", Format::List { list: regions_list }, None);
        let (closing, create_closing) = new(fine, "Closing", Format::number(), None);
        let (opening, create_opening) =
            new(fine, "Opening", Format::number(), Some("PREVIOUS(Closing)"));
        let mut rig = Rig {
            model: Model::new(calendar(1)),
            history: Vec::new(),
            regions: regions.clone(),
            countries_list,
            regions_list,
            countries: countries.clone(),
            next_country: 4,
            versions,
            inputs: [f1, f2, c1, t1, dept],
            bases: vec![
                ("F1".to_string(), f1, Kind::Fine),
                ("F2".to_string(), f2, Kind::Fine),
                ("C1".to_string(), c1, Kind::Coarse),
                ("T1".to_string(), t1, Kind::Flat),
                ("Opening".to_string(), opening, Kind::Fine),
                ("Closing".to_string(), closing, Kind::Fine),
            ],
            derived: Vec::new(),
        };
        let region_specs = regions.iter().enumerate().map(|(at, &id)| ItemSpec {
            id,
            code: None,
            name: format!("r{at}"),
            parent: None,
        });
        let country_specs = countries.iter().enumerate().map(|(at, &id)| ItemSpec {
            id,
            code: None,
            name: format!("c{at}"),
            parent: Some(regions[at % 2]),
        });
        let list = |id, name: &str, parent| Command::CreateList {
            id,
            name: name.to_string(),
            parent,
            top_level_name: None,
            numbered: false,
            production_data: false,
        };
        assert!(rig.run(vec![
            Command::UpsertVersion {
                id: versions[0],
                name: "Act".to_string(),
                is_actual: true,
                is_current: false,
                switchover: None,
            },
            Command::UpsertVersion {
                id: versions[1],
                name: "Cur".to_string(),
                is_actual: false,
                is_current: true,
                switchover: None,
            },
            list(regions_list, "Regions", None),
            list(countries_list, "Countries", Some(regions_list)),
            Command::UpsertListItems {
                list: regions_list,
                items: region_specs.collect(),
            },
            Command::UpsertListItems {
                list: countries_list,
                items: country_specs.collect(),
            },
            create_fine,
            create_coarse,
            create_flat,
            create_info,
            create_f1,
            create_f2,
            create_c1,
            create_t1,
            create_dept,
            create_closing,
        ]));
        assert!(rig.run(vec![create_opening]));
        assert!(rig.run(vec![Command::UpdateLineItem {
            id: closing,
            patch: formula_patch("Opening + F1 - F2"),
        }]));
        assert!(rig.run(vec![Command::SetCells {
            line_item: dept,
            edits: countries
                .iter()
                .enumerate()
                .map(|(at, &country)| CellEdit {
                    coords: vec![item(country)],
                    value: Value::Item(Some(regions[at % 2])),
                })
                .collect(),
        }]));
        for (at, (kind, spec)) in initial.iter().enumerate() {
            let kind = [Kind::Fine, Kind::Coarse, Kind::Flat][usize::from(*kind) % 3];
            let module = match kind {
                Kind::Fine => fine,
                Kind::Coarse => coarse,
                Kind::Flat => flat,
            };
            let name = format!("D{at}");
            let formula = formula_for(kind, spec, &rig.sources_before(at));
            let (id, create) = new(module, &name, Format::number(), Some(&formula));
            assert!(rig.run(vec![create]), "{name} = {formula}");
            rig.derived.push((name, id, kind));
        }
        rig
    }

    /// Applies commands as one batch, and keeps them to build the model again if they were
    /// accepted.
    fn run(&mut self, commands: Vec<Command>) -> bool {
        match self.model.apply_batch(commands.clone()) {
            Ok(_) => {
                self.history.push(commands);
                true
            }
            Err(_) => false,
        }
    }

    /// The line items before the derived line item at `at`.
    fn sources_before(&self, at: usize) -> Vec<(String, Kind)> {
        self.bases
            .iter()
            .chain(&self.derived[..at.min(self.derived.len())])
            .map(|(name, _, kind)| (name.clone(), *kind))
            .collect()
    }

    fn version(&self, at: usize) -> CoordToken {
        item(ItemId(self.versions[at % 2].0))
    }

    /// The commands that type in cells, one for each input among `picks`.
    fn type_in(&self, picks: &[(u8, usize, i8)]) -> Vec<Command> {
        let mut by_input: BTreeMap<u8, Vec<CellEdit>> = BTreeMap::new();
        for &(input, cell, value) in picks {
            let country = self.countries[cell / 12 % self.countries.len()];
            let region = self.regions[cell / 12 % self.regions.len()];
            let number = Value::Number(f64::from(value));
            let version = self.version(cell / 5);
            let (coords, value) = match input {
                0 | 1 => (vec![item(country), month(cell % 12), version], number),
                2 => (vec![item(region), month(cell % 12), version], number),
                3 => (vec![month(cell % 12)], number),
                _ => (
                    vec![item(self.countries[cell % self.countries.len()])],
                    Value::Item(Some(self.regions[value.rem_euclid(2) as usize])),
                ),
            };
            by_input
                .entry(input.min(4))
                .or_default()
                .push(CellEdit { coords, value });
        }
        by_input
            .into_iter()
            .map(|(input, edits)| Command::SetCells {
                line_item: self.inputs[usize::from(input)],
                edits,
            })
            .collect()
    }

    fn apply(&mut self, edit: &Edit) {
        match edit {
            Edit::Cells(picks) => {
                let commands = self.type_in(picks);
                self.run(commands);
            }
            Edit::Grown {
                cells,
                region,
                value,
            } => {
                let mut commands = self.type_in(cells);
                let id = ItemId::new();
                commands.push(self.new_country(id, *region));
                commands.push(Command::SetCells {
                    line_item: self.inputs[0],
                    edits: vec![CellEdit {
                        coords: vec![item(id), month(0), self.version(0)],
                        value: Value::Number(f64::from(*value)),
                    }],
                });
                if self.run(commands) {
                    self.countries.push(id);
                }
            }
            Edit::Formula { derived, spec } => {
                let at = derived % self.derived.len();
                let (_, id, kind) = self.derived[at];
                let formula = formula_for(kind, spec, &self.sources_before(at));
                assert!(
                    self.run(vec![Command::UpdateLineItem {
                        id,
                        patch: formula_patch(&formula),
                    }]),
                    "{formula}"
                );
            }
            Edit::Summary { input, method } => {
                let summary = [
                    SummaryMethod::Sum,
                    SummaryMethod::Average,
                    SummaryMethod::Max,
                    SummaryMethod::Min,
                ][usize::from(*method)]
                .clone();
                let id = self.inputs[usize::from(*input)];
                assert!(self.run(vec![Command::UpdateLineItem {
                    id,
                    patch: LineItemPatch {
                        summary: Some(summary),
                        ..LineItemPatch::default()
                    },
                }]));
            }
            Edit::AddCountry { region } => {
                let id = ItemId::new();
                let command = self.new_country(id, *region);
                assert!(self.run(vec![command]));
                self.countries.push(id);
            }
            Edit::Reparent { which, region } => {
                let id = self.countries[which % self.countries.len()];
                assert!(self.run(vec![Command::UpsertListItems {
                    list: self.countries_list,
                    items: vec![ItemSpec {
                        id,
                        code: None,
                        name: format!("moved {id:?}"),
                        parent: Some(self.regions[usize::from(*region)]),
                    }],
                }]));
            }
            Edit::DeleteCountry { which } => {
                if self.countries.len() > 1 {
                    let id = self.countries.remove(which % self.countries.len());
                    assert!(self.run(vec![Command::DeleteListItems {
                        list: self.countries_list,
                        ids: vec![id],
                    }]));
                }
            }
            Edit::Switchover { month } => {
                assert!(self.run(vec![Command::UpsertVersion {
                    id: self.versions[1],
                    name: "Cur".to_string(),
                    is_actual: false,
                    is_current: true,
                    switchover: (*month > 0).then_some(u32::from(*month)),
                }]));
            }
        }
    }

    fn new_country(&mut self, id: ItemId, region: u8) -> Command {
        let name = format!("c{}", self.next_country);
        self.next_country += 1;
        Command::UpsertListItems {
            list: self.countries_list,
            items: vec![ItemSpec {
                id,
                code: None,
                name,
                parent: Some(self.regions[usize::from(region)]),
            }],
        }
    }

    /// A model built from the same commands that calculates every line item from scratch.
    fn rebuilt(&self) -> Model {
        let mut model = Model::new(calendar(1));
        for commands in &self.history {
            model.apply_batch(commands.clone()).unwrap();
        }
        model.recalc_all().unwrap();
        model
    }

    /// Everything a model shows of its line items: errors, cells and summaries.
    fn shown(&self, model: &Model) -> Vec<String> {
        let year = Axis::Time {
            level: TimeLevel::Year,
            range: None,
        };
        let by_region = LevelSpec(vec![
            Axis::List(self.regions_list),
            year.clone(),
            Axis::Versions,
        ]);
        let by_year = LevelSpec(vec![year]);
        let mut shown = Vec::new();
        for (name, id, kind) in self.bases.iter().chain(&self.derived) {
            let rows: Vec<Vec<CoordToken>> = match kind {
                Kind::Fine => self.countries.iter().map(|&c| vec![item(c)]).collect(),
                Kind::Coarse => self.regions.iter().map(|&r| vec![item(r)]).collect(),
                Kind::Flat => vec![Vec::new()],
            };
            let versioned = |mut coords: Vec<CoordToken>, version: usize| {
                if *kind != Kind::Flat {
                    coords.push(self.version(version));
                }
                coords
            };
            let mut cells = Vec::new();
            for row in &rows {
                for m in 0..12 {
                    for version in 0..2 {
                        let mut coords = row.clone();
                        coords.push(month(m));
                        cells.extend(
                            model
                                .read_cells(*id, &[versioned(coords, version)])
                                .unwrap(),
                        );
                    }
                }
            }
            let (rows, levels) = match kind {
                Kind::Flat => (vec![Vec::new()], &by_year),
                _ => (
                    self.regions.iter().map(|&r| vec![item(r)]).collect(),
                    &by_region,
                ),
            };
            let mut summaries = Vec::new();
            for row in rows {
                for version in 0..2 {
                    let mut coords = row.clone();
                    coords.push(period("FY26"));
                    let summary = model.read_summary(*id, &versioned(coords, version), levels);
                    summaries.push(summary.map_err(|error| error.to_string()));
                }
            }
            shown.push(format!(
                "{name} errors={} cells={cells:?} summaries={summaries:?}",
                model.line_item_errors(*id).is_some()
            ));
        }
        let dept: Vec<Vec<CoordToken>> = self.countries.iter().map(|&c| vec![item(c)]).collect();
        shown.push(format!(
            "Dept {:?}",
            model.read_cells(self.inputs[4], &dept).unwrap()
        ));
        shown
    }

    fn check(&self) -> Result<(), TestCaseError> {
        let (incremental, full) = (self.shown(&self.model), self.shown(&self.rebuilt()));
        prop_assert_eq!(incremental.len(), full.len());
        for (incremental, full) in incremental.iter().zip(&full) {
            prop_assert_eq!(incremental, full);
        }
        Ok(())
    }
}

proptest! {
    #![proptest_config(ProptestConfig::with_cases(48))]

    #[test]
    fn incremental_equals_full(
        initial in proptest::collection::vec((0u8..3, spec()), 3..7),
        edits in proptest::collection::vec(edit(), 1..10),
    ) {
        let mut rig = Rig::new(&initial);
        rig.check()?;
        for edit in &edits {
            rig.apply(edit);
            rig.check()?;
        }
    }
}
