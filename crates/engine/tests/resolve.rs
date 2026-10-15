use openplan_engine::functions::{self, FuncId, Word};
use openplan_engine::{
    AxisSpec, Calendar, Command, Expr, Format, FormulaError, ItemId, ItemSpec, LineItem,
    LineItemId, ListId, Model, ModifierKind, ModuleId, SelectTarget, Span, SummaryMethod, TExpr,
    TModifier, TimeLevel, TimeScale, Value, ValueType, VersionsScope, parse, resolve,
};

fn calendar() -> Calendar {
    Calendar {
        fiscal_year_start_month: 1,
        first_year: 2026,
        years: 2,
        current_month: None,
    }
}

fn new_list(model: &mut Model, name: &str, parent: Option<ListId>) -> ListId {
    let id = ListId::new();
    model
        .apply(Command::CreateList {
            id,
            name: name.to_string(),
            parent,
            top_level_name: None,
            numbered: false,
            production_data: false,
        })
        .unwrap();
    id
}

fn new_items(
    model: &mut Model,
    list: ListId,
    items: &[(&str, Option<&str>, Option<ItemId>)],
) -> Vec<ItemId> {
    let specs: Vec<ItemSpec> = items
        .iter()
        .map(|(name, code, parent)| ItemSpec {
            id: ItemId::new(),
            code: code.map(str::to_string),
            name: name.to_string(),
            parent: *parent,
        })
        .collect();
    let ids = specs.iter().map(|spec| spec.id).collect();
    model
        .apply(Command::UpsertListItems { list, items: specs })
        .unwrap();
    ids
}

fn new_module(model: &mut Model, name: &str, axes: Vec<AxisSpec>) -> ModuleId {
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

fn add(model: &mut Model, module: ModuleId, name: &str, format: Format) -> LineItemId {
    let id = LineItemId::new();
    model
        .apply(Command::CreateLineItem(LineItem {
            id,
            module,
            name: name.to_string(),
            ordinal: 0,
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

fn month_axis() -> AxisSpec {
    AxisSpec::Time {
        level: TimeLevel::Month,
        range: None,
    }
}

/// A small model with every kind of thing a formula can name.
///
/// Module `Calc` holds one target line item of each format plus a few numbers; `Sales` and
/// `Costs` both have an `Amount`; `Pricing` has the only `Price`; `Staff` is dimensioned by
/// employees and has the mapping line items.
struct World {
    model: Model,
    products: ListId,
    regions: ListId,
    countries: ListId,
    widget: ItemId,
    emea: ItemId,
    france: ItemId,
    calc: ModuleId,
    sales: ModuleId,
    num: LineItemId,
    txt: LineItemId,
    flag: LineItemId,
    day: LineItemId,
    region: LineItemId,
    product: LineItemId,
    period: LineItemId,
    revenue: LineItemId,
    sales_amount: LineItemId,
    costs_amount: LineItemId,
    price: LineItemId,
    population: LineItemId,
    salary: LineItemId,
    department: LineItemId,
    started: LineItemId,
    title: LineItemId,
}

impl World {
    fn new() -> World {
        let mut model = Model::new(calendar());
        let products = new_list(&mut model, "Products", None);
        let regions = new_list(&mut model, "Regions", None);
        let countries = new_list(&mut model, "Countries", Some(regions));
        let departments = new_list(&mut model, "Departments", None);
        let employees = new_list(&mut model, "Employees", None);
        let product_ids = new_items(
            &mut model,
            products,
            &[("Widget", Some("W1"), None), ("Gadget", Some("G1"), None)],
        );
        let region_ids = new_items(
            &mut model,
            regions,
            &[("EMEA", Some("EU"), None), ("APAC", None, None)],
        );
        let country_ids = new_items(
            &mut model,
            countries,
            &[("France", None, Some(region_ids[0]))],
        );
        new_items(&mut model, departments, &[("Ops", None, None)]);
        new_items(&mut model, employees, &[("Ann", None, None)]);

        let calc = new_module(&mut model, "Calc", vec![month_axis()]);
        let sales = new_module(
            &mut model,
            "Sales",
            vec![AxisSpec::List { list: products }, month_axis()],
        );
        let costs = new_module(&mut model, "Costs", vec![month_axis()]);
        let pricing = new_module(
            &mut model,
            "Pricing",
            vec![AxisSpec::List { list: products }],
        );
        let staff = new_module(
            &mut model,
            "Staff",
            vec![AxisSpec::List { list: employees }],
        );

        let num = add(&mut model, calc, "Num", Format::number());
        let txt = add(&mut model, calc, "Txt", Format::Text);
        let flag = add(&mut model, calc, "Flag", Format::Boolean);
        let day = add(&mut model, calc, "Day", Format::Date);
        let region = add(&mut model, calc, "Region", Format::List { list: regions });
        let product = add(&mut model, calc, "Product", Format::List { list: products });
        let period = add(
            &mut model,
            calc,
            "Period",
            Format::TimePeriod {
                level: TimeLevel::Month,
            },
        );
        let revenue = add(&mut model, calc, "Revenue", Format::number());
        add(&mut model, calc, "Gross Margin", Format::number());
        let sales_amount = add(&mut model, sales, "Amount", Format::number());
        let costs_amount = add(&mut model, costs, "Amount", Format::number());
        let price = add(&mut model, pricing, "Price", Format::number());
        let population = add(
            &mut model,
            ModuleId::for_list_properties(regions),
            "Population",
            Format::number(),
        );
        let salary = add(&mut model, staff, "Salary", Format::number());
        let department = add(
            &mut model,
            staff,
            "Department",
            Format::List { list: departments },
        );
        let started = add(
            &mut model,
            staff,
            "Started",
            Format::TimePeriod {
                level: TimeLevel::Month,
            },
        );
        add(&mut model, staff, "Active", Format::Boolean);
        let title = add(&mut model, staff, "Title", Format::Text);

        World {
            model,
            products,
            regions,
            countries,
            widget: product_ids[0],
            emea: region_ids[0],
            france: country_ids[0],
            calc,
            sales,
            num,
            txt,
            flag,
            day,
            region,
            product,
            period,
            revenue,
            sales_amount,
            costs_amount,
            price,
            population,
            salary,
            department,
            started,
            title,
        }
    }

    fn resolve(&self, target: LineItemId, src: &str) -> Result<TExpr, Vec<FormulaError>> {
        let expr = parse(src).unwrap_or_else(|errors| panic!("{src:?} should parse: {errors:?}"));
        resolve(self.model.structure(), target, &expr)
    }

    fn ok(&self, target: LineItemId, src: &str) -> TExpr {
        self.resolve(target, src)
            .unwrap_or_else(|errors| panic!("{src:?} should resolve: {errors:?}"))
    }

    fn errors(&self, target: LineItemId, src: &str) -> Vec<FormulaError> {
        match self.resolve(target, src) {
            Ok(typed) => panic!("{src:?} should not resolve, got {typed:?}"),
            Err(errors) => errors,
        }
    }

    /// The only error of a formula for `Calc.Num`.
    fn error(&self, src: &str) -> FormulaError {
        let mut errors = self.errors(self.num, src);
        assert_eq!(errors.len(), 1, "{src:?}: {errors:?}");
        errors.remove(0)
    }

    /// Adds a line item to a module of the model.
    fn add(&mut self, module: ModuleId, name: &str, format: Format) -> LineItemId {
        add(&mut self.model, module, name, format)
    }
}

/// The type of a node that is a value, which is all but the names of lists, `Time` and keywords.
trait ValueNode {
    fn vty(&self) -> ValueType;
}

impl ValueNode for TExpr {
    fn vty(&self) -> ValueType {
        self.ty().expect("the node is a value")
    }
}

fn span(start: usize, end: usize) -> Span {
    Span { start, end }
}

fn at(error: &FormulaError) -> Span {
    span(error.start, error.end)
}

/// The id, modifiers and type of a typed reference to a line item.
fn reference(typed: &TExpr) -> (LineItemId, &[TModifier], ValueType) {
    match typed {
        TExpr::LineItem {
            id, modifiers, ty, ..
        } => (*id, modifiers, *ty),
        other => panic!("expected a line item reference, got {other:?}"),
    }
}

fn number(value: f64, from: usize, to: usize) -> TExpr {
    TExpr::Const {
        value: Value::Number(value),
        ty: ValueType::Number,
        span: span(from, to),
    }
}

#[test]
fn resolves_same_module_first() {
    let mut world = World::new();
    let sales = world.sales;
    let target = world.add(sales, "Total", Format::number());
    let typed = world.ok(target, "Amount");
    assert_eq!(reference(&typed).0, world.sales_amount);
    let costs = world.model.structure().module_by_name("Costs").unwrap().id;
    let target = world.add(costs, "Total", Format::number());
    let typed = world.ok(target, "amount");
    assert_eq!(reference(&typed).0, world.costs_amount);
}

#[test]
fn model_wide_unique() {
    let world = World::new();
    let typed = world.ok(world.num, "Price * 2");
    let TExpr::Binary {
        lhs,
        rhs,
        ty,
        span: whole,
        ..
    } = &typed
    else {
        panic!("expected a product, got {typed:?}");
    };
    assert_eq!(*ty, ValueType::Number);
    assert_eq!(*whole, span(0, 9));
    assert_eq!(reference(lhs).0, world.price);
    assert_eq!(**rhs, number(2.0, 8, 9));
}

#[test]
fn ambiguous_name_error() {
    let world = World::new();
    let error = world.error("Amount + 1");
    assert_eq!(error.code, "formula.ambiguous_name");
    assert_eq!(at(&error), span(0, 6));
    assert!(
        error.message.contains("Costs.Amount") && error.message.contains("Sales.Amount"),
        "{}",
        error.message
    );
    assert_eq!(error.suggestion.as_deref(), Some("Costs.Amount"));
    // Both qualified forms resolve to their own line item.
    assert_eq!(
        reference(&world.ok(world.num, "Costs.Amount")).0,
        world.costs_amount
    );
    assert_eq!(
        reference(&world.ok(world.num, "Sales.Amount")).0,
        world.sales_amount
    );
}

#[test]
fn ambiguous_names_are_quoted_when_the_forms_need_it() {
    let mut world = World::new();
    let first = new_module(&mut world.model, "P&L", Vec::new());
    let second = new_module(&mut world.model, "Plan", Vec::new());
    world.add(first, "Net Income", Format::number());
    world.add(second, "Net Income", Format::number());
    let error = world.error("Net Income");
    assert_eq!(error.code, "formula.ambiguous_name");
    assert_eq!(error.suggestion.as_deref(), Some("'P&L'.Net Income"));
    assert!(
        error.message.contains("Plan.Net Income"),
        "{}",
        error.message
    );
}

#[test]
fn unknown_name_suggestion() {
    let world = World::new();
    let error = world.error("Revnue + 1");
    assert_eq!(error.code, "formula.unknown_name");
    assert_eq!(at(&error), span(0, 6));
    assert!(
        error.message.contains("Unknown name 'Revnue'"),
        "{}",
        error.message
    );
    assert!(
        error.message.contains("Did you mean 'Revenue'?"),
        "{}",
        error.message
    );
    assert_eq!(error.suggestion.as_deref(), Some("Revenue"));

    // Case does not matter, multi-word names are suggested whole, and lists count too.
    assert_eq!(
        world.error("GROSS MARGN").suggestion.as_deref(),
        Some("Gross Margin")
    );
    let error = world.error("ITEM(Prodcts) + 1");
    assert_eq!(error.suggestion.as_deref(), Some("Products"));

    // Further than two edits away there is nothing to suggest.
    let error = world.error("Quantity");
    assert_eq!(error.code, "formula.unknown_name");
    assert_eq!(error.suggestion, None);
    assert!(!error.message.contains("Did you mean"), "{}", error.message);
}

#[test]
fn suggestions_name_the_module_when_the_bare_name_would_not_resolve() {
    let world = World::new();
    // `Prise` is one edit from Pricing's only Price, which resolves bare from anywhere.
    assert_eq!(world.error("Prise").suggestion.as_deref(), Some("Price"));
    // `Amoun` is close to the Amount of two modules, so the bare form would be ambiguous.
    let suggestion = world.error("Amoun").suggestion.unwrap();
    assert!(
        suggestion == "Sales.Amount" || suggestion == "Costs.Amount",
        "{suggestion}"
    );
}

#[test]
fn qualified_module_line_item() {
    let world = World::new();
    let typed = world.ok(world.num, "Staff.Salary");
    let (id, modifiers, ty) = reference(&typed);
    assert_eq!((id, ty), (world.salary, ValueType::Number));
    assert!(modifiers.is_empty());
    assert_eq!(
        reference(&world.ok(world.num, "staff.SALARY")).0,
        world.salary
    );
    assert_eq!(
        reference(&world.ok(world.num, "'Staff'.'Salary'")).0,
        world.salary
    );

    let error = world.error("Staff.Salry");
    assert_eq!(error.code, "formula.unknown_name");
    assert_eq!(at(&error), span(6, 11));
    assert_eq!(error.suggestion.as_deref(), Some("Salary"));
    assert!(error.message.contains("Staff"), "{}", error.message);

    let error = world.error("Staf.Salary");
    assert_eq!(error.code, "formula.unknown_name");
    assert_eq!(at(&error), span(0, 4));
    assert_eq!(error.suggestion.as_deref(), Some("Staff"));
}

#[test]
fn list_item_literal_and_property() {
    let world = World::new();
    let emea = world.ok(world.flag, "Calc.Region = Regions.EMEA");
    let TExpr::Binary { rhs, .. } = &emea else {
        panic!("expected a comparison, got {emea:?}");
    };
    assert_eq!(
        **rhs,
        TExpr::ListItemConst {
            list: world.regions,
            item: world.emea,
            span: span(14, 26),
        }
    );
    assert_eq!(rhs.vty(), ValueType::Item(world.regions));

    // Items are found by name in any case, or by code.
    for src in ["regions.emea", "Regions.EU", "'Regions'.'EMEA'"] {
        let typed = world.ok(world.region, src);
        assert!(
            matches!(&typed, TExpr::ListItemConst { item, .. } if *item == world.emea),
            "{src}: {typed:?}"
        );
    }
    let typed = world.ok(world.product, "Products.W1");
    assert!(matches!(&typed, TExpr::ListItemConst { item, .. } if *item == world.widget));

    // A list property is a line item of "<List> Properties".
    let typed = world.ok(world.num, "Regions.Population");
    assert_eq!(reference(&typed).0, world.population);
    let typed = world.ok(world.num, "'Regions Properties'.Population");
    assert_eq!(reference(&typed).0, world.population);

    let error = world.error("Regions.Population2");
    assert_eq!(error.code, "formula.unknown_name");
    assert_eq!(error.suggestion.as_deref(), Some("Population"));
    let errors = world.errors(world.region, "Regions.Emea2");
    assert_eq!(errors[0].suggestion.as_deref(), Some("EMEA"));
}

#[test]
fn versions_and_time_literals() {
    let world = World::new();
    let version = world
        .model
        .structure()
        .version_by_name("Actual")
        .unwrap()
        .id;

    let typed = world.ok(world.num, "Revenue[SELECT: Versions.Actual]");
    let (id, modifiers, ty) = reference(&typed);
    assert_eq!((id, ty), (world.revenue, ValueType::Number));
    assert_eq!(
        modifiers,
        [TModifier::Select(SelectTarget::Version(version))]
    );
    let typed = world.ok(world.num, "Revenue[SELECT: versions.budget]");
    assert!(matches!(
        reference(&typed).1,
        [TModifier::Select(SelectTarget::Version(_))]
    ));

    // Periods are written with or without quotes and resolve in the model calendar.
    for (src, level, index) in [
        ("Time.'Jan 26'", TimeLevel::Month, 0),
        ("Time.Jan 26", TimeLevel::Month, 0),
        ("time.dec 27", TimeLevel::Month, 23),
        ("Time.'Q2 FY27'", TimeLevel::Quarter, 5),
        ("Time.H1 FY26", TimeLevel::HalfYear, 0),
        ("Time.FY27", TimeLevel::Year, 1),
        ("Time.Total", TimeLevel::All, 0),
    ] {
        let typed = world.ok(world.num, &format!("Revenue[SELECT: {src}]"));
        let select = TModifier::Select(SelectTarget::Period { level, index });
        assert_eq!(reference(&typed).1, [select], "{src}");
    }
    let typed = world.ok(world.flag, "Period = Time.'Jan 26'");
    let TExpr::Binary { rhs, .. } = &typed else {
        panic!("expected a comparison, got {typed:?}");
    };
    assert_eq!(
        **rhs,
        TExpr::PeriodConst {
            level: TimeLevel::Month,
            index: 0,
            span: span(9, 22),
        }
    );
    assert_eq!(rhs.vty(), ValueType::Period(TimeLevel::Month));
    // A period is a value of a time-period line item, at the level of its label.
    let typed = world.ok(world.period, "Time.'Mar 27'");
    assert_eq!(typed.vty(), ValueType::Period(TimeLevel::Month));
    assert!(matches!(typed, TExpr::PeriodConst { index: 14, .. }));
    assert_eq!(
        world.errors(world.period, "Time.FY26")[0].message,
        "Formula returns Time period (year) but the line item is Time period (month)."
    );

    let error = world.error("Revenue[SELECT: Versions.Actul]");
    assert_eq!(error.code, "formula.unknown_name");
    assert_eq!(error.suggestion.as_deref(), Some("Actual"));
    let error = world.error("Revenue[SELECT: Time.'Jan 99']");
    assert_eq!(error.code, "formula.unknown_name");
    assert!(error.message.contains("Jan 99"), "{}", error.message);
    // Periods outside the two years of the calendar do not exist.
    assert_eq!(
        world.error("Revenue[SELECT: Time.'Jan 28']").code,
        "formula.unknown_name"
    );
}

#[test]
fn versions_are_values_and_lists_are_not() {
    let world = World::new();
    let error = world.error("Versions.Actual + 1");
    assert_eq!(error.code, "formula.type_mismatch");
    assert_eq!(
        error.message,
        "'+' needs Number operands, but this is Version."
    );
    assert_eq!(at(&error), span(0, 15));
    let errors = world.errors(world.num, "Versions.Actual");
    assert_eq!(
        errors[0].message,
        "Formula returns Version but the line item is Number."
    );

    let error = world.error("Products + 1");
    assert_eq!(error.code, "formula.type_mismatch");
    assert!(
        error.message.contains("function argument"),
        "{}",
        error.message
    );
    // Neither `Versions` nor `Time` is a value by itself.
    for src in ["Versions + 1", "Time + 1"] {
        assert_eq!(world.error(src).code, "formula.unknown_name", "{src}");
    }
}

#[test]
fn type_mismatch_text_target() {
    let world = World::new();
    let errors = world.errors(world.txt, "1 + 2");
    assert_eq!(errors.len(), 1);
    assert_eq!(errors[0].code, "formula.type_mismatch");
    assert_eq!(
        errors[0].message,
        "Formula returns Number but the line item is Text."
    );
    assert_eq!(at(&errors[0]), span(0, 5));

    assert_eq!(
        world.errors(world.num, "\"a\"")[0].message,
        "Formula returns Text but the line item is Number."
    );
    assert_eq!(
        world.errors(world.flag, "Revenue")[0].message,
        "Formula returns Number but the line item is Boolean."
    );
    assert_eq!(
        world.errors(world.region, "Product")[0].message,
        "Formula returns List 'Products' but the line item is List 'Regions'."
    );
    assert_eq!(
        world.errors(world.period, "Day")[0].message,
        "Formula returns Date but the line item is Time period (month)."
    );
    // The same types pass, whatever the number's format.
    assert_eq!(world.ok(world.txt, "\"a\"").vty(), ValueType::Text);
    assert_eq!(world.ok(world.num, "1").vty(), ValueType::Number);
    assert_eq!(
        world.ok(world.region, "Region").vty(),
        ValueType::Item(world.regions)
    );
}

#[test]
fn if_branch_types_must_match() {
    let world = World::new();
    let typed = world.ok(world.num, "IF Flag THEN Revenue ELSE 0");
    let TExpr::If {
        cond,
        then,
        els,
        ty,
        ..
    } = &typed
    else {
        panic!("expected an IF, got {typed:?}");
    };
    assert_eq!(*ty, ValueType::Number);
    assert_eq!(cond.vty(), ValueType::Boolean);
    assert_eq!(reference(then).0, world.revenue);
    assert_eq!(**els, number(0.0, 26, 27));

    let error = world.error("IF Flag THEN 1 ELSE \"none\"");
    assert_eq!(error.code, "formula.type_mismatch");
    assert!(error.message.contains("Number"), "{}", error.message);
    assert!(error.message.contains("Text"), "{}", error.message);
    assert_eq!(at(&error), span(20, 26));

    let error = world.error("IF Revenue THEN 1 ELSE 2");
    assert_eq!(error.code, "formula.type_mismatch");
    assert!(error.message.contains("Boolean"), "{}", error.message);
    assert_eq!(at(&error), span(3, 10));

    // Items of different lists are different types.
    let error = world.errors(world.region, "IF Flag THEN Region ELSE Product");
    assert_eq!(error[0].code, "formula.type_mismatch");
    // Both problems of a broken IF are reported, in source order.
    let errors = world.errors(world.num, "IF 1 THEN 2 ELSE \"x\"");
    let codes: Vec<_> = errors
        .iter()
        .map(|error| (error.code, error.start))
        .collect();
    assert_eq!(
        codes,
        [("formula.type_mismatch", 3), ("formula.type_mismatch", 17)]
    );
}

#[test]
fn function_arity_and_unknown() {
    let world = World::new();
    let error = world.error("ABS(1, 2)");
    assert_eq!(error.code, "formula.arity");
    assert_eq!(error.message, "ABS takes 1 argument, but 2 were given.");
    assert_eq!(at(&error), span(0, 9));

    assert_eq!(
        world.error("ABS()").message,
        "ABS takes 1 argument, but 0 were given."
    );
    assert_eq!(
        world.error("ROUND(1)").message,
        "ROUND takes 2 or 3 arguments, but 1 was given."
    );
    assert_eq!(
        world.error("MIN(1)").message,
        "MIN takes at least 2 arguments, but 1 was given."
    );
    assert_eq!(
        world.error("TIMESUM(Revenue, Time.FY26)").message,
        "TIMESUM takes 1 or 3 arguments, but 2 were given."
    );
    assert_eq!(
        world.error("START(1)").message,
        "START takes no arguments, but 1 was given."
    );
    for src in [
        "MIN(1, 2, 3, 4, 5)",
        "min(1, 2)",
        "ROUND(1, 2)",
        "TIMESUM(Revenue)",
        "START()",
    ] {
        let formula = if src.starts_with("START") {
            world.ok(world.day, src)
        } else {
            world.ok(world.num, src)
        };
        assert!(matches!(formula, TExpr::Call { .. }), "{src}");
    }

    let error = world.error("ABSS(1)");
    assert_eq!(error.code, "formula.unknown_function");
    assert_eq!(at(&error), span(0, 4));
    assert_eq!(error.suggestion.as_deref(), Some("ABS"));
    assert!(
        error.message.contains("Did you mean 'ABS'?"),
        "{}",
        error.message
    );

    let error = world.error("Frobnicate(1)");
    assert_eq!(error.code, "formula.unknown_function");
    assert_eq!(error.suggestion, None);
    assert!(!error.message.contains("Did you mean"), "{}", error.message);

    // A multi-word or quoted name before the parenthesis is not a function either.
    let error = world.error("Gross Margin(1)");
    assert_eq!(error.code, "formula.unknown_function");
    assert!(error.message.contains("Gross Margin"), "{}", error.message);
    let error = world.error("'Profit & Loss'(1)");
    assert_eq!(error.code, "formula.unknown_function");
    // A line item called like a function does not make the call valid.
    let error = world.error("Revenue(1)");
    assert_eq!(error.code, "formula.unknown_function");
}

#[test]
fn round_mode_word() {
    let world = World::new();
    for (src, word) in [
        ("ROUND(Revenue, 2, UP)", Word::Up),
        ("ROUND(Revenue, 2, down)", Word::Down),
        ("ROUND(Revenue, 2, Nearest)", Word::Nearest),
    ] {
        let typed = world.ok(world.num, src);
        let TExpr::Call { func, args, ty, .. } = &typed else {
            panic!("expected a call, got {typed:?}");
        };
        assert_eq!(
            (*func, *ty, args.len()),
            (FuncId::Round, ValueType::Number, 3),
            "{src}"
        );
        assert!(
            matches!(&args[2], TExpr::Word { word: found, .. } if *found == word),
            "{src}"
        );
    }
    let typed = world.ok(world.num, "ROUND(Revenue, -1)");
    let TExpr::Call { args, .. } = &typed else {
        panic!("expected a call, got {typed:?}");
    };
    assert_eq!(args.len(), 2);
    assert_eq!(args[1], number(-1.0, 15, 17));

    let error = world.error("ROUND(Revenue, 2, SIDEWAYS)");
    assert_eq!(error.code, "formula.type_mismatch");
    assert_eq!(
        error.message,
        "Argument 3 of ROUND must be UP, DOWN or NEAREST."
    );
    assert_eq!(at(&error), span(18, 26));
    let error = world.error("ROUND(Revenue, 2, Dwn)");
    assert_eq!(error.suggestion.as_deref(), Some("DOWN"));
    assert!(
        error.message.contains("Did you mean 'DOWN'?"),
        "{}",
        error.message
    );
    // RANK's words are not ROUND's, and numbers are not words.
    assert_eq!(
        world.error("ROUND(Revenue, 2, ASCENDING)").code,
        "formula.type_mismatch"
    );
    assert_eq!(
        world.error("ROUND(Revenue, 2, 1)").code,
        "formula.type_mismatch"
    );

    let typed = world.ok(world.num, "RANK(Revenue, ASCENDING)");
    assert!(matches!(
        &typed,
        TExpr::Call { func: FuncId::Rank, args, .. }
            if matches!(args[1], TExpr::Word { word: Word::Ascending, .. })
    ));
    assert!(matches!(
        world.ok(world.num, "RANK(Revenue)"),
        TExpr::Call {
            func: FuncId::Rank,
            ..
        }
    ));
    assert_eq!(
        world.error("RANK(Revenue, UP)").code,
        "formula.type_mismatch"
    );

    // The words mean nothing anywhere else: elsewhere they are just unknown names.
    for src in [
        "UP",
        "Revenue + DOWN",
        "ROUND(UP, 2)",
        "ABS(NEAREST)",
        "RANK(DESCENDING)",
    ] {
        assert_eq!(world.error(src).code, "formula.unknown_name", "{src}");
    }
    // A line item with the same name is still an ordinary name outside those positions.
    let mut world = World::new();
    let calc = world.calc;
    let up = world.add(calc, "Up", Format::number());
    let typed = world.ok(world.num, "Up + 1");
    let TExpr::Binary { lhs, .. } = &typed else {
        panic!("expected a sum, got {typed:?}");
    };
    assert_eq!(reference(lhs).0, up);
}

#[test]
fn item_comparison_requires_same_list() {
    let world = World::new();
    let typed = world.ok(world.flag, "Region = Regions.EMEA");
    assert!(matches!(
        &typed,
        TExpr::Binary {
            ty: ValueType::Boolean,
            ..
        }
    ));
    world.ok(world.flag, "Region <> Regions.EMEA");
    world.ok(world.flag, "Regions.EMEA = Region");

    let error = world.errors(world.flag, "Region = Products.Widget");
    assert_eq!(error.len(), 1);
    assert_eq!(error[0].code, "formula.type_mismatch");
    assert!(
        error[0].message.contains("Regions") && error[0].message.contains("Products"),
        "{}",
        error[0].message
    );
    assert_eq!(at(&error[0]), span(0, 24));
    let error = world.errors(world.flag, "Region = Product");
    assert_eq!(error[0].code, "formula.type_mismatch");
    // A country is an item of another list than its region.
    let error = world.errors(world.flag, "Region = Countries.France");
    assert_eq!(error[0].code, "formula.type_mismatch");
    assert_ne!(world.france, world.emea);
    assert_ne!(world.countries, world.regions);
    assert_ne!(world.products, world.regions);
}

#[test]
fn comparisons_need_equal_types() {
    let world = World::new();
    for src in [
        "Revenue = 1",
        "Txt = \"a\"",
        "Flag = TRUE",
        "Day <> Day",
        "Period = Time.'Jan 26'",
        "Revenue >= Gross Margin",
        "Txt < \"b\"",
        "Day < Day",
    ] {
        let typed = world.ok(world.flag, src);
        assert_eq!(typed.vty(), ValueType::Boolean, "{src}");
    }
    // Nothing coerces: not numbers to text, booleans to numbers, nor periods of other levels.
    for src in [
        "Revenue = \"1\"",
        "Flag = 1",
        "Txt = Revenue",
        "Day = Revenue",
    ] {
        assert_eq!(
            world.errors(world.flag, src)[0].code,
            "formula.type_mismatch",
            "{src}"
        );
    }
    let error = world.errors(world.flag, "Period = Time.FY26");
    assert_eq!(error[0].code, "formula.type_mismatch");
    assert!(error[0].message.contains("month") && error[0].message.contains("year"));
    assert!(
        world.errors(world.flag, "Revenue = \"1\"")[0]
            .message
            .contains("Cannot compare Number with Text")
    );
    // Booleans and list items can be tested for equality but not ordered.
    for src in ["Flag < Flag", "Region > Regions.EMEA"] {
        let error = &world.errors(world.flag, src)[0];
        assert_eq!(error.code, "formula.type_mismatch", "{src}");
        assert!(
            error.message.contains("= or <>"),
            "{src}: {}",
            error.message
        );
    }
}

#[test]
fn operators_check_their_operands() {
    let world = World::new();
    let error = world.error("Txt + 1");
    assert_eq!(error.code, "formula.type_mismatch");
    assert_eq!(
        error.message,
        "'+' needs Number operands, but this is Text."
    );
    assert_eq!(at(&error), span(0, 3));
    let errors = world.errors(world.num, "Txt * Flag");
    assert_eq!(errors.len(), 2, "{errors:?}");
    assert_eq!(
        world.error("-Txt").message,
        "'-' needs a Number, but this is Text."
    );
    assert_eq!(world.error("1 / TRUE").code, "formula.type_mismatch");
    assert_eq!(
        world.errors(world.flag, "NOT Revenue")[0].message,
        "NOT needs a Boolean, but this is Number."
    );
    assert_eq!(
        world.errors(world.flag, "Flag AND 1")[0].message,
        "AND needs Boolean operands, but this is Number."
    );
    assert_eq!(
        world.errors(world.flag, "0 OR Flag")[0].message,
        "OR needs Boolean operands, but this is Number."
    );
    for src in ["NOT Flag", "Flag AND Revenue > 1 OR NOT Flag", "(Flag)"] {
        assert_eq!(world.ok(world.flag, src).vty(), ValueType::Boolean, "{src}");
    }
    // Dates have functions of their own; they do not take part in arithmetic.
    assert_eq!(world.error("Day + 1").code, "formula.type_mismatch");
}

#[test]
fn concatenation_accepts_text_numbers_dates_and_items() {
    let world = World::new();
    for src in [
        "Txt & \"x\"",
        "\"Total: \" & Revenue",
        "Day & \"\"",
        "Region & \" region\"",
        "Txt & Txt & Revenue",
    ] {
        let typed = world.ok(world.txt, src);
        assert_eq!(typed.vty(), ValueType::Text, "{src}");
    }
    let error = &world.errors(world.txt, "Txt & Flag")[0];
    assert_eq!(error.code, "formula.type_mismatch");
    assert!(
        error.message.contains("'&'") && error.message.contains("Boolean"),
        "{}",
        error.message
    );
    assert_eq!(
        world.errors(world.txt, "Txt & Period")[0].code,
        "formula.type_mismatch"
    );
    // The result is Text, so it cannot feed a number.
    assert_eq!(world.error("Txt & \"x\"").code, "formula.type_mismatch");
}

#[test]
fn negative_numbers_are_constants() {
    let world = World::new();
    assert_eq!(world.ok(world.num, "-5"), number(-5.0, 0, 2));
    assert_eq!(world.ok(world.num, "- -5"), number(5.0, 0, 4));
    assert_eq!(world.ok(world.num, "-0"), number(0.0, 0, 2));
    let TExpr::Const {
        value: Value::Number(zero),
        ..
    } = world.ok(world.num, "-0")
    else {
        panic!("expected a constant");
    };
    assert!(zero.is_sign_positive());
    let typed = world.ok(world.num, "-Revenue");
    assert!(matches!(
        &typed,
        TExpr::Unary {
            ty: ValueType::Number,
            ..
        }
    ));
}

#[test]
fn blank_takes_the_type_it_is_used_with() {
    let world = World::new();
    let blank = |value: Value, ty: ValueType, from, to| TExpr::Const {
        value,
        ty,
        span: span(from, to),
    };
    assert_eq!(
        world.ok(world.txt, "BLANK"),
        blank(Value::Text("".into()), ValueType::Text, 0, 5)
    );
    assert_eq!(
        world.ok(world.day, "BLANK"),
        blank(Value::Date(None), ValueType::Date, 0, 5)
    );
    assert_eq!(
        world.ok(world.region, "BLANK"),
        blank(Value::Item(None), ValueType::Item(world.regions), 0, 5)
    );
    assert_eq!(
        world.ok(world.period, "BLANK"),
        blank(
            Value::Period(None),
            ValueType::Period(TimeLevel::Month),
            0,
            5
        )
    );
    assert_eq!(
        world.ok(world.flag, "BLANK"),
        blank(Value::Boolean(false), ValueType::Boolean, 0, 5)
    );
    assert_eq!(
        world.ok(world.num, "BLANK"),
        blank(Value::Number(0.0), ValueType::Number, 0, 5)
    );

    // Inside IF, comparisons and function defaults it follows the other side.
    let typed = world.ok(world.region, "IF Flag THEN BLANK ELSE Region");
    assert!(matches!(&typed, TExpr::If { then, ty, .. }
        if *ty == ValueType::Item(world.regions) && then.vty() == *ty));
    let typed = world.ok(world.txt, "IF Flag THEN Txt ELSE BLANK");
    assert!(matches!(&typed, TExpr::If { els, .. } if els.vty() == ValueType::Text));
    let typed = world.ok(world.flag, "Region = BLANK");
    assert!(
        matches!(&typed, TExpr::Binary { rhs, .. } if rhs.vty() == ValueType::Item(world.regions))
    );
    let typed = world.ok(world.flag, "BLANK = Day");
    assert!(matches!(&typed, TExpr::Binary { lhs, .. } if lhs.vty() == ValueType::Date));
    let typed = world.ok(world.day, "OFFSET(Day, -1, BLANK)");
    assert!(matches!(&typed, TExpr::Call { args, .. } if args[2].vty() == ValueType::Date));

    // With nothing to take the type from it is an error.
    let error = world.errors(world.flag, "ISBLANK(BLANK)");
    assert_eq!(error[0].code, "formula.type_mismatch");
    assert!(error[0].message.contains("BLANK"), "{}", error[0].message);
    let errors = world.errors(world.flag, "BLANK = BLANK");
    assert_eq!(errors.len(), 1, "one problem is reported once: {errors:?}");
    assert_eq!(at(&errors[0]), span(0, 5));
}

#[test]
fn literals_and_grouping() {
    let world = World::new();
    assert_eq!(world.ok(world.txt, "\"a\" & \"b\"").vty(), ValueType::Text);
    let typed = world.ok(world.txt, "\"hello\"");
    assert_eq!(
        typed,
        TExpr::Const {
            value: Value::Text("hello".into()),
            ty: ValueType::Text,
            span: span(0, 7),
        }
    );
    let typed = world.ok(world.flag, "TRUE");
    assert_eq!(
        typed,
        TExpr::Const {
            value: Value::Boolean(true),
            ty: ValueType::Boolean,
            span: span(0, 4),
        }
    );
    // Parentheses widen the span of what they wrap.
    assert_eq!(world.ok(world.num, "(1)").span(), span(0, 3));
    assert_eq!(world.ok(world.num, "(Revenue)").span(), span(0, 9));
}

#[test]
fn modifiers_map_dimensions() {
    let world = World::new();
    // SUM: a list-formatted line item in the source's dimensions maps its cells into the target.
    let typed = world.ok(world.num, "Staff.Salary[SUM: Staff.Department]");
    let (id, modifiers, ty) = reference(&typed);
    assert_eq!((id, ty), (world.salary, ValueType::Number));
    assert_eq!(modifiers, [TModifier::Sum(world.department)]);
    assert_eq!(typed.span(), span(0, 35));

    // The mapping may also be time-period formatted, and the name may be unqualified.
    let typed = world.ok(world.num, "Salary[SUM: Started]");
    assert_eq!(reference(&typed).1, [TModifier::Sum(world.started)]);

    // LOOKUP maps the other way and takes any type of source.
    let typed = world.ok(world.txt, "Staff.Title[LOOKUP: Calc.Product]");
    let (id, modifiers, ty) = reference(&typed);
    assert_eq!((id, ty), (world.title, ValueType::Text));
    assert_eq!(modifiers, [TModifier::Lookup(world.product)]);
    let typed = world.ok(world.num, "Salary[LOOKUP: Region]");
    assert_eq!(reference(&typed).1, [TModifier::Lookup(world.region)]);

    // Several modifiers apply in the order written, however they are bracketed.
    let version = world
        .model
        .structure()
        .version_by_name("Actual")
        .unwrap()
        .id;
    let want = vec![
        TModifier::Sum(world.department),
        TModifier::Select(SelectTarget::Version(version)),
        TModifier::Lookup(world.region),
    ];
    for src in [
        "Salary[SUM: Department, SELECT: Versions.Actual, LOOKUP: Region]",
        "Salary[SUM: Department][SELECT: Versions.Actual][LOOKUP: Region]",
        "Salary[SUM: Department, SELECT: Versions.Actual][LOOKUP: Region]",
    ] {
        assert_eq!(reference(&world.ok(world.num, src)).1, want, "{src}");
    }
    let typed = world.ok(world.num, "(Salary[SUM: Department])[LOOKUP: Region]");
    assert_eq!(
        reference(&typed).1,
        [
            TModifier::Sum(world.department),
            TModifier::Lookup(world.region)
        ]
    );

    // SELECT fixes a dimension to one item.
    let typed = world.ok(world.num, "Revenue[SELECT: Regions.EMEA]");
    assert_eq!(
        reference(&typed).1,
        [TModifier::Select(SelectTarget::Item {
            list: world.regions,
            item: world.emea,
        })]
    );
    // A modified reference is a value like any other.
    let typed = world.ok(world.num, "Salary[SUM: Department] * 2 + 1");
    assert_eq!(typed.vty(), ValueType::Number);
}

#[test]
fn aggregating_modifiers_check_the_source_type() {
    let world = World::new();
    for kind in ["SUM", "AVERAGE", "MIN", "MAX"] {
        let typed = world.ok(world.num, &format!("Salary[{kind}: Department]"));
        let modifier = match kind {
            "SUM" => TModifier::Sum(world.department),
            "AVERAGE" => TModifier::Agg(ModifierKind::Average, world.department),
            "MIN" => TModifier::Agg(ModifierKind::Min, world.department),
            _ => TModifier::Agg(ModifierKind::Max, world.department),
        };
        assert_eq!(reference(&typed).1, [modifier], "{kind}");
        let error = &world.errors(world.txt, &format!("Title[{kind}: Department]"))[0];
        assert_eq!(error.code, "formula.type_mismatch", "{kind}");
        assert!(
            error
                .message
                .starts_with(&format!("{kind} needs a Number line item")),
            "{}",
            error.message
        );
        assert!(error.message.contains("Text"), "{}", error.message);
    }
    for (kind, kind_enum) in [("ANY", ModifierKind::Any), ("ALL", ModifierKind::All)] {
        let typed = world.ok(world.flag, &format!("Active[{kind}: Department]"));
        assert_eq!(
            reference(&typed).1,
            [TModifier::Agg(kind_enum, world.department)]
        );
        assert_eq!(reference(&typed).2, ValueType::Boolean);
        let error = &world.errors(world.flag, &format!("Salary[{kind}: Department] = 1"))[0];
        assert!(
            error
                .message
                .starts_with(&format!("{kind} needs a Boolean line item")),
            "{}",
            error.message
        );
    }
    // FIRSTNONBLANK and LASTNONBLANK accept any type; TEXTLIST needs text.
    for (kind, kind_enum) in [
        ("FIRSTNONBLANK", ModifierKind::FirstNonBlank),
        ("LASTNONBLANK", ModifierKind::LastNonBlank),
    ] {
        for (target, source) in [
            (world.num, "Salary"),
            (world.txt, "Title"),
            (world.flag, "Active"),
        ] {
            let typed = world.ok(target, &format!("{source}[{kind}: Department]"));
            assert_eq!(
                reference(&typed).1,
                [TModifier::Agg(kind_enum, world.department)]
            );
        }
    }
    let typed = world.ok(world.txt, "Title[TEXTLIST: Department]");
    assert_eq!(
        reference(&typed).1,
        [TModifier::Agg(ModifierKind::TextList, world.department)]
    );
    let error = &world.errors(world.txt, "Salary[TEXTLIST: Department] & \"\"")[0];
    assert!(
        error.message.starts_with("TEXTLIST needs a Text line item"),
        "{}",
        error.message
    );
    // The error points at the source being aggregated.
    assert_eq!(at(error), span(0, 6));
}

#[test]
fn modifier_arguments_must_be_mapping_line_items() {
    let world = World::new();
    // A mapping line item is list- or time-period-formatted.
    for (target, src) in [
        (world.num, "Salary[SUM: Salary]"),
        (world.num, "Salary[AVERAGE: Salary]"),
        (world.num, "Salary[LOOKUP: Salary]"),
        (world.flag, "Active[ANY: Salary]"),
    ] {
        let error = &world.errors(target, src)[0];
        assert_eq!(error.code, "formula.type_mismatch", "{src}");
        assert_eq!(
            error.message,
            "The mapping line item 'Salary' must be list-formatted or time-period-formatted, but is Number.",
            "{src}"
        );
        let start = src.rfind("Salary").unwrap();
        assert_eq!(at(error), span(start, start + 6), "{src}");
    }
    // Neither is a computation or a literal a mapping.
    for src in [
        "Salary[SUM: Salary + 1]",
        "Salary[SUM: 1]",
        "Salary[LOOKUP: Regions.EMEA]",
        "Salary[SUM: Regions]",
    ] {
        let error = &world.errors(world.num, src)[0];
        assert_eq!(error.code, "formula.type_mismatch", "{src}");
    }
    assert_eq!(
        world.error("Salary[SUM: Departmnt]").suggestion.as_deref(),
        Some("Department")
    );

    // SELECT takes a list item, a version or a time period.
    for src in [
        "Salary[SELECT: Department]",
        "Salary[SELECT: 1]",
        "Salary[SELECT: Regions]",
        "Salary[SELECT: Staff.Salary]",
    ] {
        let error = &world.errors(world.num, src)[0];
        assert_eq!(error.code, "formula.type_mismatch", "{src}");
        assert!(error.message.contains("SELECT"), "{}", error.message);
    }
    assert_eq!(
        world.error("Salary[SELECT: Regions.APAC2]").code,
        "formula.unknown_name"
    );

    // Only a line item can be mapped.
    for src in [
        "(Revenue + 1)[SUM: Department]",
        "Regions.EMEA[SELECT: Versions.Actual]",
        "ABS(1)[SUM: Department]",
    ] {
        let error = &world.errors(world.num, src)[0];
        assert_eq!(error.code, "formula.type_mismatch", "{src}");
        assert!(
            error.message.contains("line item"),
            "{src}: {}",
            error.message
        );
    }
}

#[test]
fn list_arguments() {
    let world = World::new();
    let typed = world.ok(world.product, "ITEM(Products)");
    let TExpr::Call { func, args, ty, .. } = &typed else {
        panic!("expected a call, got {typed:?}");
    };
    assert_eq!(
        (*func, *ty),
        (FuncId::Item, ValueType::Item(world.products))
    );
    assert_eq!(
        args[0],
        TExpr::ListRef {
            list: world.products,
            span: span(5, 13)
        }
    );
    assert_eq!(args[0].ty(), None, "a list name is not a value");

    // A list is looked up by name in an argument position that wants one, ahead of line items.
    let mut world = World::new();
    let calc = world.calc;
    world.add(calc, "Products", Format::number());
    let target = world.product;
    assert_eq!(
        world.ok(target, "ITEM(Products)").vty(),
        ValueType::Item(world.products)
    );
    assert_eq!(
        world.ok(target, "ITEM('products')").vty(),
        ValueType::Item(world.products)
    );

    let typed = world.ok(world.flag, "ISFIRSTOCCURRENCE(Region, Regions)");
    assert!(matches!(&typed, TExpr::Call { args, .. } if matches!(args[1], TExpr::ListRef { .. })));
    let typed = world.ok(world.product, "FINDITEM(Products, \"Widget\")");
    assert_eq!(typed.vty(), ValueType::Item(world.products));

    let error = &world.errors(world.product, "ITEM(Prodcts)")[0];
    assert_eq!(error.code, "formula.unknown_name");
    assert!(
        error.message.contains("Unknown list 'Prodcts'"),
        "{}",
        error.message
    );
    assert_eq!(error.suggestion.as_deref(), Some("Products"));
    assert_eq!(at(error), span(5, 12));
    // A line item is not a list, and neither is anything else.
    for (src, code) in [
        ("ITEM(Revenue)", "formula.unknown_name"),
        ("ITEM(1)", "formula.type_mismatch"),
        ("ITEM(Regions.EMEA)", "formula.type_mismatch"),
        ("ITEM(Products + 1)", "formula.type_mismatch"),
    ] {
        let errors = world.errors(world.product, src);
        assert_eq!(errors.len(), 1, "{src}: {errors:?}");
        assert_eq!(errors[0].code, code, "{src}");
    }
    assert_eq!(
        world.errors(world.product, "ITEM(1)")[0].message,
        "Argument 1 of ITEM must be the name of a list, Versions or Time."
    );
}

#[test]
fn function_results_are_typed() {
    let world = World::new();
    let cases: Vec<(LineItemId, &str, ValueType)> = vec![
        (world.num, "ABS(Revenue)", ValueType::Number),
        (world.num, "MIN(Revenue, 1, 2, 3)", ValueType::Number),
        (world.num, "LOG(Revenue)", ValueType::Number),
        (world.num, "LOG(Revenue, 2)", ValueType::Number),
        (world.flag, "ISBLANK(Txt)", ValueType::Boolean),
        (world.flag, "ISNOTBLANK(Region)", ValueType::Boolean),
        (world.txt, "LEFT(Txt, 2) & UPPER(Txt)", ValueType::Text),
        (world.num, "FIND(\"a\", Txt)", ValueType::Number),
        (world.num, "FIND(\"a\", Txt, 2)", ValueType::Number),
        (world.num, "LEN(TRIM(Txt))", ValueType::Number),
        (world.txt, "SUBSTITUTE(Txt, \"a\", \"b\")", ValueType::Text),
        (world.txt, "TEXT(Revenue)", ValueType::Text),
        (world.txt, "TEXT(Day)", ValueType::Text),
        (world.txt, "TEXT(Region)", ValueType::Text),
        (world.num, "VALUE(Txt)", ValueType::Number),
        (world.txt, "NAME(Region)", ValueType::Text),
        (world.txt, "CODE(Region)", ValueType::Text),
        (world.num, "PREVIOUS(Revenue)", ValueType::Number),
        (world.txt, "NEXT(Txt)", ValueType::Text),
        (
            world.region,
            "PREVIOUS(Region)",
            ValueType::Item(world.regions),
        ),
        (world.num, "OFFSET(Revenue, -1, 0)", ValueType::Number),
        (world.num, "LAG(Revenue, 1, 0)", ValueType::Number),
        (world.txt, "LEAD(Txt, 1, \"\")", ValueType::Text),
        (world.num, "CUMULATE(Revenue)", ValueType::Number),
        (world.num, "MOVINGSUM(Revenue, -2, 0)", ValueType::Number),
        (world.num, "YEARVALUE(Revenue)", ValueType::Number),
        (world.num, "TIMESUM(Revenue)", ValueType::Number),
        (
            world.num,
            "TIMESUM(Revenue, Time.'Jan 26', Time.'Jun 26')",
            ValueType::Number,
        ),
        (world.num, "YEARTODATE(Revenue)", ValueType::Number),
        (world.day, "START()", ValueType::Date),
        (world.day, "CURRENTPERIODEND()", ValueType::Date),
        (
            world.flag,
            "INPERIOD(Day, Time.'Jan 26')",
            ValueType::Boolean,
        ),
        (
            world.period,
            "PERIOD(Day)",
            ValueType::Period(TimeLevel::Month),
        ),
        (world.day, "DATE(2026, 4, 1)", ValueType::Date),
        (
            world.num,
            "WEEKDAY(Day) + DAY(Day) + MONTH(Day) + YEAR(Day)",
            ValueType::Number,
        ),
        (world.day, "ADDMONTHS(ADDYEARS(Day, 1), 2)", ValueType::Date),
        (world.num, "DAYS(START(), END())", ValueType::Number),
        (world.num, "CURRENTVERSION(Revenue)", ValueType::Number),
        (
            world.num,
            "PREVIOUSVERSION(Revenue) + NEXTVERSION(Revenue)",
            ValueType::Number,
        ),
        (world.num, "RANK(Revenue)", ValueType::Number),
        (world.num, "NPV(0.1, Revenue)", ValueType::Number),
        (world.num, "IRR(Revenue)", ValueType::Number),
        (
            world.num,
            "PMT(0.05, 12, 1000) + PV(0.05, 12, 100) + FV(0.05, 12, 100, 0)",
            ValueType::Number,
        ),
    ];
    for (target, src, ty) in cases {
        let typed = world.ok(target, src);
        assert_eq!(typed.vty(), ty, "{src}");
    }
    let typed = world.ok(world.region, "PARENT(ITEM(Countries))");
    assert_eq!(typed.vty(), ValueType::Item(world.regions));
    let typed = world.ok(world.flag, "ISANCESTOR(Regions.EMEA, ITEM(Countries))");
    assert_eq!(typed.vty(), ValueType::Boolean);
}

#[test]
fn function_arguments_are_type_checked() {
    let world = World::new();
    let error = world.error("ABS(Txt)");
    assert_eq!(error.code, "formula.type_mismatch");
    assert_eq!(
        error.message,
        "Argument 1 of ABS must be a Number, but is Text."
    );
    assert_eq!(at(&error), span(4, 7));

    assert_eq!(
        world.error("POWER(2, Flag)").message,
        "Argument 2 of POWER must be a Number, but is Boolean."
    );
    assert_eq!(
        world.errors(world.txt, "UPPER(1)")[0].message,
        "Argument 1 of UPPER must be Text, but is Number."
    );
    assert_eq!(
        world.errors(world.txt, "TEXT(Txt)")[0].message,
        "Argument 1 of TEXT must be a Number, Date or list item, but is Text."
    );
    assert_eq!(
        world.errors(world.txt, "NAME(Revenue)")[0].message,
        "Argument 1 of NAME must be a list item, but is Number."
    );
    assert_eq!(
        world.errors(world.num, "OFFSET(Revenue, 1, \"x\")")[0].message,
        "Argument 3 of OFFSET must be the same type as argument 1 (Number), but is Text."
    );
    assert_eq!(
        world.errors(world.num, "TIMESUM(Revenue, 1, 2)")[0].message,
        "Argument 2 of TIMESUM must be a time period, but is Number."
    );
    assert_eq!(
        world.errors(world.flag, "INPERIOD(Revenue, Time.FY26)")[0].message,
        "Argument 1 of INPERIOD must be a Date, but is Number."
    );
    // Calls nest, and each one reports the arguments that are wrong.
    let errors = world.errors(world.num, "POWER(Txt, Flag)");
    assert_eq!(errors.len(), 2);
    let errors = world.errors(world.num, "ABS(Txt) + ABS(Flag)");
    assert_eq!(errors.len(), 2);
    assert_eq!((errors[0].start, errors[1].start), (4, 15));

    // PARENT needs a list with a parent list, ISANCESTOR items of one hierarchy.
    let error = &world.errors(world.region, "PARENT(Region)")[0];
    assert_eq!(error.code, "formula.type_mismatch");
    assert!(
        error.message.contains("Regions") && error.message.contains("parent"),
        "{}",
        error.message
    );
    assert_eq!(at(error), span(7, 13));
    let error = &world.errors(world.flag, "ISANCESTOR(Product, Region)")[0];
    assert_eq!(error.code, "formula.type_mismatch");
    assert!(
        error.message.contains("Products") && error.message.contains("Regions"),
        "{}",
        error.message
    );
    let error = &world.errors(world.flag, "ISANCESTOR(ITEM(Countries), ITEM(Regions))")[0];
    assert_eq!(error.code, "formula.type_mismatch");
    assert_eq!(
        world.ok(world.flag, "ISANCESTOR(Region, Region)").vty(),
        ValueType::Boolean
    );
}

#[test]
fn calls_report_the_type_of_their_result_in_formulas() {
    let world = World::new();
    // A function's result type feeds the operators around it.
    let error = world.error("LEFT(Txt, 1) + 1");
    assert_eq!(
        error.message,
        "'+' needs Number operands, but this is Text."
    );
    assert_eq!(at(&error), span(0, 12));
    let error = &world.errors(world.txt, "LEN(Txt)")[0];
    assert_eq!(
        error.message,
        "Formula returns Number but the line item is Text."
    );
    assert_eq!(
        world
            .ok(world.num, "IF ISBLANK(Txt) THEN 0 ELSE LEN(Txt)")
            .vty(),
        ValueType::Number
    );
}

#[test]
fn errors_are_reported_together_in_source_order() {
    let world = World::new();
    let errors = world.errors(world.num, "Revnue + Nope(1) + ABS(Txt, 1) + Gross Margn");
    let found: Vec<_> = errors
        .iter()
        .map(|error| (error.code, error.start))
        .collect();
    assert_eq!(
        found,
        [
            ("formula.unknown_name", 0),
            ("formula.unknown_function", 9),
            ("formula.arity", 19),
            ("formula.unknown_name", 33),
        ]
    );
    let sorted = {
        let mut copy = errors.clone();
        copy.sort_by_key(|error| error.start);
        copy
    };
    assert_eq!(errors, sorted);
}

#[test]
fn a_hostile_reference_shape_is_an_error_not_a_panic() {
    let world = World::new();
    let name = |text: &str, start: usize| openplan_engine::Name {
        text: text.to_string(),
        quoted: false,
        span: span(start, start + text.len()),
    };
    let target = world.num;
    for parts in [Vec::new(), vec![name("A", 0), name("B", 2), name("C", 4)]] {
        let expr = Expr::Ref {
            parts,
            span: span(0, 5),
        };
        let errors = resolve(world.model.structure(), target, &expr).unwrap_err();
        assert_eq!(errors.len(), 1);
        assert_eq!(errors[0].code, "formula.syntax");
    }
}

#[test]
fn deeply_nested_formulas_resolve_on_a_small_stack() {
    // The parser accepts trees up to 256 nodes tall and 64 levels of nesting. Resolving the
    // worst of them must fit in a quarter of a test thread's stack, or the whole test binary
    // aborts.
    fn nested(open: &str, core: &str, close: &str, depth: usize) -> String {
        format!("{}{core}{}", open.repeat(depth), close.repeat(depth))
    }
    let resolved = std::thread::Builder::new()
        .stack_size(1 << 20)
        .spawn(|| {
            let world = World::new();
            let numbers = [
                vec!["Revenue"; 255].join(" + "),
                format!("{}Revenue", "-".repeat(250)),
                nested("ABS(", "Revenue", ")", 62),
                nested("(", "Revenue", ")", 62),
                nested("IF Flag THEN 1 ELSE ", "2", "", 62),
                nested("MIN(1, ", "Revenue", ")", 62),
                nested("Revenue[SUM: Staff.Department] + (", "Revenue", ")", 30),
            ];
            let mut outcomes: Vec<bool> = numbers
                .iter()
                .map(|src| world.resolve(world.num, src).is_ok())
                .collect();
            let not = format!("{}Flag", "NOT ".repeat(250));
            outcomes.push(world.resolve(world.flag, &not).is_ok());
            // A problem at the bottom of the deepest nesting is still reported.
            let broken = nested("ABS(", "Revnue", ")", 62);
            let errors = world.resolve(world.num, &broken).unwrap_err();
            outcomes.push(errors.len() == 1 && errors[0].code == "formula.unknown_name");
            outcomes
        })
        .expect("the thread should start")
        .join()
        .expect("resolving should not overflow the stack or panic");
    assert!(resolved.iter().all(|ok| *ok), "{resolved:?}");
}

#[test]
fn unknown_first_parts_suggest_places() {
    let world = World::new();
    for (src, wrong, suggestion) in [
        ("Versionz.Actual", "Versionz", "Versions"),
        ("Tiem.Total", "Tiem", "Time"),
        ("Regionz.EMEA", "Regionz", "Regions"),
        ("Pricin.Price", "Pricin", "Pricing"),
    ] {
        let error = world.error(src);
        assert_eq!(error.code, "formula.unknown_name", "{src}");
        assert_eq!(at(&error), span(0, wrong.len()), "{src}");
        assert_eq!(error.suggestion.as_deref(), Some(suggestion), "{src}");
        assert!(
            error.message.contains(&format!("Unknown name '{wrong}'")),
            "{}",
            error.message
        );
    }
    let error = world.error("Nowhere.Land");
    assert_eq!(error.suggestion, None);
    assert_eq!(at(&error), span(0, 7));
}

#[test]
fn a_name_shared_by_a_module_and_a_list_finds_both() {
    let mut world = World::new();
    let module = new_module(&mut world.model, "Regions", Vec::new());
    let rank = world.add(module, "Rank", Format::number());
    let typed = world.ok(world.num, "Regions.Rank");
    assert_eq!(reference(&typed).0, rank);
    // The module has no such line item, so the list's items are tried next.
    let typed = world.ok(world.region, "Regions.EMEA");
    assert!(matches!(typed, TExpr::ListItemConst { item, .. } if item == world.emea));
    let typed = world.ok(world.num, "Regions.Population");
    assert_eq!(reference(&typed).0, world.population);

    let error = world.error("Regions.Zzz");
    assert_eq!(error.code, "formula.unknown_name");
    assert_eq!(
        error.message,
        "'Regions' has no line item, item or property named 'Zzz'."
    );
    assert_eq!(at(&error), span(8, 11));
    assert_eq!(
        world.error("Regions.Rnk").suggestion.as_deref(),
        Some("Rank")
    );
}

#[test]
fn deleted_items_cannot_be_named() {
    let mut world = World::new();
    let regions = world.model.structure().list(world.regions).unwrap();
    let apac = regions.item(regions.find("APAC").unwrap()).id;
    world.ok(world.region, "Regions.APAC");
    world
        .model
        .apply(Command::DeleteListItems {
            list: world.regions,
            ids: vec![apac],
        })
        .unwrap();
    let errors = world.errors(world.region, "Regions.APAC");
    assert_eq!(errors.len(), 1);
    assert_eq!(errors[0].code, "formula.unknown_name");
    assert_eq!(
        errors[0].message,
        "The list 'Regions' has no item or property named 'APAC'."
    );
}

#[test]
fn names_that_need_quotes_are_suggested_in_quotes() {
    let mut world = World::new();
    let calc = world.calc;
    let profit = world.add(calc, "Profit & Loss", Format::number());
    let error = world.error("'Profit & Lss'");
    assert_eq!(error.code, "formula.unknown_name");
    assert_eq!(at(&error), span(0, 14));
    assert_eq!(error.suggestion.as_deref(), Some("'Profit & Loss'"));
    assert!(
        error.message.contains("Did you mean 'Profit & Loss'?"),
        "{}",
        error.message
    );
    let typed = world.ok(world.num, "'profit & loss' + 1");
    let TExpr::Binary { lhs, .. } = &typed else {
        panic!("expected a sum, got {typed:?}");
    };
    assert_eq!(reference(lhs).0, profit);
}

#[test]
#[should_panic(expected = "is in the structure")]
fn resolving_for_a_missing_line_item_panics() {
    let world = World::new();
    let expr = parse("1").unwrap();
    let _ = resolve(world.model.structure(), LineItemId::new(), &expr);
}

#[test]
fn versions_are_items_that_can_be_compared() {
    let world = World::new();
    for src in [
        "ITEM(Versions) = Versions.Budget",
        "Versions.Budget = ITEM(Versions)",
        "ITEM(Versions) <> Versions.Actual",
        "NAME(ITEM(Versions)) = \"Budget\"",
        "CODE(ITEM(Versions)) = \"\"",
        "versions.FORECAST = item(versions)",
    ] {
        assert_eq!(world.ok(world.flag, src).vty(), ValueType::Boolean, "{src}");
    }
    let typed = world.ok(
        world.num,
        "IF ITEM(Versions) = Versions.Budget THEN 1 ELSE 0",
    );
    assert_eq!(typed.vty(), ValueType::Number);
    // Versions are not ordered, and not items of a user list.
    let error = &world.errors(world.flag, "ITEM(Versions) < Versions.Budget")[0];
    assert_eq!(error.code, "formula.type_mismatch");
    assert!(error.message.contains("= or <>"), "{}", error.message);
    let error = &world.errors(world.flag, "ITEM(Versions) = Regions.EMEA")[0];
    assert_eq!(error.code, "formula.type_mismatch");
    assert!(error.message.contains("Version"), "{}", error.message);
    assert_eq!(
        world.errors(world.flag, "Region = Versions.Budget")[0].code,
        "formula.type_mismatch"
    );
    // A version is an item of the built-in list of versions, and `Versions` is that list.
    let budget = world
        .model
        .structure()
        .version_by_name("Budget")
        .unwrap()
        .id;
    let typed = world.ok(world.flag, "ITEM(Versions) = Versions.Budget");
    let TExpr::Binary { lhs, rhs, .. } = &typed else {
        panic!("expected a comparison, got {typed:?}");
    };
    assert_eq!(
        **rhs,
        TExpr::VersionConst {
            version: budget,
            span: span(17, 32),
        }
    );
    assert_eq!(rhs.vty(), ValueType::Item(ListId::VERSIONS));
    let TExpr::Call { func, args, ty, .. } = &**lhs else {
        panic!("expected a call, got {lhs:?}");
    };
    assert_eq!(
        (*func, *ty),
        (FuncId::Item, ValueType::Item(ListId::VERSIONS))
    );
    assert_eq!(
        args[0],
        TExpr::ListRef {
            list: ListId::VERSIONS,
            span: span(5, 13)
        }
    );
    // FINDITEM and ISFIRSTOCCURRENCE work on the lists of the model only.
    let error = &world.errors(world.flag, "ISFIRSTOCCURRENCE(Region, Versions)")[0];
    assert_eq!(error.code, "formula.unknown_name");
    assert_eq!(
        world
            .error("ITEM(Versionz) = Versions.Actual")
            .suggestion
            .as_deref(),
        Some("Versions")
    );
    assert_eq!(
        world.errors(world.flag, "ITEM(Tim) = Time.'Jan 26'")[0]
            .suggestion
            .as_deref(),
        Some("Time")
    );

    // The names of the versions are checked as other names are.
    let error = world.errors(world.flag, "ITEM(Versions) = Versions.Budgt");
    assert_eq!(error[0].code, "formula.unknown_name");
    assert_eq!(error[0].suggestion.as_deref(), Some("Budget"));
}

#[test]
fn item_of_time_is_a_period_at_the_level_of_the_target() {
    let mut world = World::new();
    let typed = world.ok(world.period, "ITEM(Time)");
    assert_eq!(typed.vty(), ValueType::Period(TimeLevel::Month));
    assert_eq!(
        world.ok(world.flag, "ITEM(Time) = Time.'Jan 26'").vty(),
        ValueType::Boolean
    );
    assert_eq!(
        world.ok(world.flag, "ITEM(time) = Time.'Jan 26'").vty(),
        ValueType::Boolean
    );

    // A line item that rolls up to years has years.
    let calc = world.calc;
    let yearly = world.add(
        calc,
        "Yearly",
        Format::TimePeriod {
            level: TimeLevel::Year,
        },
    );
    world
        .model
        .apply(Command::UpdateLineItem {
            id: yearly,
            patch: openplan_engine::LineItemPatch {
                time_scale: Some(TimeScale::Level(TimeLevel::Year)),
                ..Default::default()
            },
        })
        .unwrap();
    assert_eq!(
        world.ok(yearly, "ITEM(Time)").vty(),
        ValueType::Period(TimeLevel::Year)
    );
    let error = &world.errors(world.period, "ITEM(Time) + 1")[0];
    assert_eq!(error.code, "formula.type_mismatch");
    assert!(
        error.message.contains("Time period (month)"),
        "{}",
        error.message
    );

    // Without a Time dimension there is no period to be.
    let pricing = world
        .model
        .structure()
        .module_by_name("Pricing")
        .unwrap()
        .id;
    let target = world.add(
        pricing,
        "When",
        Format::TimePeriod {
            level: TimeLevel::Month,
        },
    );
    let errors = world.errors(target, "ITEM(Time)");
    assert_eq!(errors.len(), 1);
    assert_eq!(errors[0].code, "formula.dimension");
    assert_eq!(at(&errors[0]), span(5, 9));
    let untimed = world.add(
        calc,
        "Untimed",
        Format::TimePeriod {
            level: TimeLevel::Month,
        },
    );
    world
        .model
        .apply(Command::UpdateLineItem {
            id: untimed,
            patch: openplan_engine::LineItemPatch {
                time_scale: Some(TimeScale::None),
                ..Default::default()
            },
        })
        .unwrap();
    assert_eq!(
        world.errors(untimed, "ITEM(Time)")[0].code,
        "formula.dimension"
    );
}

#[test]
fn blank_next_to_a_failed_operand_adds_no_second_error() {
    let world = World::new();
    for (target, src) in [
        (world.flag, "BLANK = Nope"),
        (world.flag, "Nope = BLANK"),
        (world.num, "OFFSET(Nope, 1, BLANK)"),
        (world.num, "IF Flag THEN BLANK ELSE Nope"),
        (world.num, "IF Flag THEN Nope ELSE BLANK"),
        (world.flag, "IF Flag THEN BLANK ELSE Nope = 1"),
    ] {
        let errors = world.errors(target, src);
        assert_eq!(errors.len(), 1, "{src}: {errors:?}");
        assert_eq!(errors[0].code, "formula.unknown_name", "{src}");
    }
}

#[test]
fn quoted_names_are_not_function_names() {
    let world = World::new();
    let error = world.error("'ABS'(1)");
    assert_eq!(error.code, "formula.unknown_function");
    assert_eq!(at(&error), span(0, 5));
    assert_eq!(error.suggestion.as_deref(), Some("ABS"));
    assert!(error.message.contains("quote"), "{}", error.message);
    assert_eq!(
        world.error("'Round'(1, 2)").suggestion.as_deref(),
        Some("ROUND")
    );
}

#[test]
fn every_bad_argument_of_a_call_is_reported() {
    let world = World::new();
    let errors = world.errors(world.num, "POWER(Txt, Flag)");
    let found: Vec<_> = errors.iter().map(|e| (e.code, e.start, e.end)).collect();
    assert_eq!(
        found,
        [
            ("formula.type_mismatch", 6, 9),
            ("formula.type_mismatch", 11, 15)
        ]
    );
    assert!(errors[0].message.starts_with("Argument 1 of POWER"));
    assert!(errors[1].message.starts_with("Argument 2 of POWER"));
    // The good arguments in between say nothing.
    let errors = world.errors(world.num, "MIN(Txt, 1, Flag, 2)");
    assert_eq!(errors.len(), 2, "{errors:?}");
}

mod function_table {
    use super::*;

    /// Every function of spec section 4.5, in the order of its table.
    const SPEC: &[(&str, &str)] = &[
        (
            "Math",
            "ABS ROUND MIN MAX POWER SQRT EXP LN LOG MOD DIVIDE SIGN",
        ),
        ("Logic", "ISBLANK ISNOTBLANK ISANCESTOR ISFIRSTOCCURRENCE"),
        (
            "Text",
            "LEFT RIGHT MID LEN FIND UPPER LOWER TRIM SUBSTITUTE TEXT VALUE",
        ),
        ("List", "ITEM PARENT NAME CODE FINDITEM"),
        (
            "Time",
            "PREVIOUS NEXT OFFSET LAG LEAD CUMULATE MOVINGSUM YEARVALUE QUARTERVALUE \
             HALFYEARVALUE MONTHVALUE TIMESUM YEARTODATE QUARTERTODATE HALFYEARTODATE \
             START END INPERIOD PERIOD CURRENTPERIODSTART CURRENTPERIODEND",
        ),
        (
            "Date",
            "DATE DAY MONTH YEAR WEEKDAY ADDMONTHS ADDYEARS DAYS",
        ),
        ("Version", "CURRENTVERSION PREVIOUSVERSION NEXTVERSION"),
        ("Rank", "RANK"),
        ("Finance", "NPV IRR PMT PV FV"),
    ];

    #[test]
    fn covers_every_function_of_the_spec() {
        let expected: Vec<(&str, &str)> = SPEC
            .iter()
            .flat_map(|(category, names)| {
                names.split_whitespace().map(move |name| (*category, name))
            })
            .collect();
        let actual: Vec<(&str, &str)> = functions::all()
            .iter()
            .map(|def| (def.category, def.name))
            .collect();
        assert_eq!(actual, expected);
        assert_eq!(actual.len(), 70);
    }

    #[test]
    fn lookup_finds_every_function_by_any_case() {
        for def in functions::all() {
            let func = functions::lookup(def.name).unwrap_or_else(|| panic!("{}", def.name));
            assert_eq!(func.def(), def);
            assert_eq!(functions::lookup(&def.name.to_lowercase()), Some(func));
        }
        assert_eq!(functions::lookup("Round"), Some(FuncId::Round));
        assert_eq!(functions::lookup(" abs "), Some(FuncId::Abs));
        assert_eq!(functions::lookup("ROUNDS"), None);
        assert_eq!(functions::lookup(""), None);
        assert_eq!(functions::lookup("Gross Margin"), None);
    }

    #[test]
    fn names_are_unique() {
        let mut names: Vec<&str> = functions::all().iter().map(|def| def.name).collect();
        names.sort_unstable();
        let before = names.len();
        names.dedup();
        assert_eq!(names.len(), before);
    }

    #[test]
    fn every_function_is_documented_for_the_editor() {
        for def in functions::all() {
            assert!(
                def.doc.ends_with('.') && def.doc.chars().next().unwrap().is_uppercase(),
                "{}: {:?}",
                def.name,
                def.doc
            );
            assert_eq!(
                def.doc.matches(". ").count(),
                0,
                "{} has one sentence",
                def.name
            );
            assert!(!def.example.is_empty(), "{}", def.name);
            assert!(
                parse(def.example).is_ok(),
                "{}: {:?} should parse",
                def.name,
                def.example
            );
            assert!(
                def.example
                    .to_uppercase()
                    .contains(&format!("{}(", def.name)),
                "{} is missing from its example {:?}",
                def.name,
                def.example
            );
            assert!(def.min_args <= def.max_args, "{}", def.name);
        }
    }

    #[test]
    fn arities() {
        let arity = |name: &str| {
            let def = functions::lookup(name).unwrap().def();
            (def.min_args, def.max_args)
        };
        assert_eq!(arity("ABS"), (1, 1));
        assert_eq!(arity("ROUND"), (2, 3));
        assert_eq!(arity("MIN"), (2, usize::MAX));
        assert_eq!(arity("MAX"), (2, usize::MAX));
        assert_eq!(arity("POWER"), (2, 2));
        assert_eq!(arity("LOG"), (1, 2));
        assert_eq!(arity("ISFIRSTOCCURRENCE"), (2, 2));
        assert_eq!(arity("MID"), (3, 3));
        assert_eq!(arity("FIND"), (2, 3));
        assert_eq!(arity("SUBSTITUTE"), (3, 3));
        assert_eq!(arity("ITEM"), (1, 1));
        assert_eq!(arity("FINDITEM"), (2, 2));
        assert_eq!(arity("PREVIOUS"), (1, 1));
        assert_eq!(arity("OFFSET"), (3, 3));
        assert_eq!(arity("LAG"), (3, 3));
        assert_eq!(arity("LEAD"), (3, 3));
        assert_eq!(arity("MOVINGSUM"), (3, 3));
        assert_eq!(arity("TIMESUM"), (1, 3));
        assert_eq!(arity("START"), (0, 0));
        assert_eq!(arity("CURRENTPERIODEND"), (0, 0));
        assert_eq!(arity("INPERIOD"), (2, 2));
        assert_eq!(arity("DATE"), (3, 3));
        assert_eq!(arity("DAYS"), (2, 2));
        assert_eq!(arity("RANK"), (1, 2));
        assert_eq!(arity("NPV"), (2, 2));
        assert_eq!(arity("IRR"), (1, 1));
        assert_eq!(arity("PMT"), (3, 3));
        assert_eq!(arity("PV"), (3, 3));
        assert_eq!(arity("FV"), (4, 4));
    }

    #[test]
    fn word_texts() {
        let words = [
            (Word::Up, "UP"),
            (Word::Down, "DOWN"),
            (Word::Nearest, "NEAREST"),
            (Word::Ascending, "ASCENDING"),
            (Word::Descending, "DESCENDING"),
        ];
        for (word, text) in words {
            assert_eq!(word.text(), text);
        }
    }
}
