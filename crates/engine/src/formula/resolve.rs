//! Name resolution and type checking (spec §4.3–§4.4): turns the syntax tree of a formula into
//! a typed tree in which every name is a line item, list item or period of the model and every
//! node has a type, or says everything that is wrong with it. Whether the dimensions of the
//! line items it uses fit the target is for the evaluator to decide.

use std::sync::Arc;

use crate::calendar::TimeLevel;
use crate::error::FormulaError;
use crate::ids::{ItemId, LineItemId, ListId, VersionId};
use crate::structure::{Structure, level_name};
use crate::value::{Value, ValueType};

use super::ast::{BinOp, Expr, ModifierKind, Name, Span, UnOp};
use super::functions::{ArgType, FuncId, Word};

mod calls;
mod modifiers;
mod names;

use names::{Names, Referent, display_name};

const TYPE_MISMATCH: &str = "formula.type_mismatch";

/// A formula whose names are resolved and whose every node has a type.
///
/// Every node records the span of the source text it was made from.
#[derive(Clone, Debug, PartialEq)]
pub enum TExpr {
    /// A literal, or a `BLANK` of the type it was used as.
    Const {
        value: Value,
        ty: ValueType,
        span: Span,
    },
    /// A line item, with the modifiers that map its dimensions, in the order they were written.
    LineItem {
        id: LineItemId,
        modifiers: Vec<TModifier>,
        ty: ValueType,
        span: Span,
    },
    /// An item of a list, written `List.Item`.
    ListItemConst {
        list: ListId,
        item: ItemId,
        span: Span,
    },
    /// A time period, written `Time.'Jan 26'`.
    PeriodConst {
        level: TimeLevel,
        index: u32,
        span: Span,
    },
    /// The name of a list, only as the argument of a function that takes one.
    ListRef { list: ListId, span: Span },
    /// A keyword such as `UP`, only as the argument of a function that takes one.
    Word { word: Word, span: Span },
    Unary {
        op: UnOp,
        expr: Box<TExpr>,
        ty: ValueType,
        span: Span,
    },
    Binary {
        op: BinOp,
        lhs: Box<TExpr>,
        rhs: Box<TExpr>,
        ty: ValueType,
        span: Span,
    },
    If {
        cond: Box<TExpr>,
        then: Box<TExpr>,
        els: Box<TExpr>,
        ty: ValueType,
        span: Span,
    },
    Call {
        func: FuncId,
        args: Vec<TExpr>,
        ty: ValueType,
        span: Span,
    },
}

impl TExpr {
    /// The type of the value of this node. A list name is typed as an item of the list and a
    /// keyword as Text; neither is a value, and they only occur as function arguments, where
    /// the function table looks at [`TExpr::arg_type`] instead.
    pub fn ty(&self) -> ValueType {
        match self {
            TExpr::Const { ty, .. }
            | TExpr::LineItem { ty, .. }
            | TExpr::Unary { ty, .. }
            | TExpr::Binary { ty, .. }
            | TExpr::If { ty, .. }
            | TExpr::Call { ty, .. } => *ty,
            TExpr::ListItemConst { list, .. } | TExpr::ListRef { list, .. } => {
                ValueType::Item(*list)
            }
            TExpr::PeriodConst { level, .. } => ValueType::Period(*level),
            TExpr::Word { .. } => ValueType::Text,
        }
    }

    /// The source text this node was made from, including parentheses around it.
    pub fn span(&self) -> Span {
        match self {
            TExpr::Const { span, .. }
            | TExpr::LineItem { span, .. }
            | TExpr::ListItemConst { span, .. }
            | TExpr::PeriodConst { span, .. }
            | TExpr::ListRef { span, .. }
            | TExpr::Word { span, .. }
            | TExpr::Unary { span, .. }
            | TExpr::Binary { span, .. }
            | TExpr::If { span, .. }
            | TExpr::Call { span, .. } => *span,
        }
    }

    /// What this node is as an argument of a function.
    pub fn arg_type(&self) -> ArgType {
        match self {
            TExpr::ListRef { list, .. } => ArgType::List(*list),
            TExpr::Word { word, .. } => ArgType::Word(*word),
            other => ArgType::Value(other.ty()),
        }
    }
}

/// How a `[KIND: argument]` after a line item maps its dimensions.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TModifier {
    /// Adds up the source cells that the list- or period-formatted line item maps to each
    /// target item.
    Sum(LineItemId),
    /// Reads the source cell that the list- or period-formatted line item picks for each
    /// target cell.
    Lookup(LineItemId),
    /// Fixes a dimension of the source to one item.
    Select(SelectTarget),
    /// Combines the mapped source cells with `AVERAGE`, `MIN`, `MAX`, `ANY`, `ALL`,
    /// `FIRSTNONBLANK`, `LASTNONBLANK` or `TEXTLIST`, as the kind says.
    Agg(ModifierKind, LineItemId),
}

/// What a `SELECT` modifier fixes a dimension to.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SelectTarget {
    Item { list: ListId, item: ItemId },
    Version(VersionId),
    Period { level: TimeLevel, index: u32 },
}

/// Resolves the names in `expr` against `structure` and checks its types, for the formula of
/// the line item `target`. The result has the type of the line item's format.
///
/// Names that are not qualified are looked up in the module of `target` first. Every problem
/// found is returned, in the order of the text, so that one pass shows what to fix.
///
/// # Panics
///
/// If `target` is not a line item of `structure`.
pub fn resolve(
    structure: &Structure,
    target: LineItemId,
    expr: &Expr,
) -> Result<TExpr, Vec<FormulaError>> {
    let line_item = structure
        .line_item(target)
        .expect("the line item whose formula is resolved is in the structure");
    let wanted = line_item.format.value_type();
    let mut resolver = Resolver {
        structure,
        names: Names::new(structure, line_item.module),
        errors: Vec::new(),
    };
    let typed = resolver.expr(expr, Some(wanted));
    if let Some(typed) = &typed
        && typed.ty() != wanted
    {
        let message = format!(
            "Formula returns {} but the line item is {}.",
            type_name(structure, typed.ty()),
            type_name(structure, wanted)
        );
        resolver.push(TYPE_MISMATCH, typed.span(), message);
    }
    match typed {
        Some(typed) if resolver.errors.is_empty() => Ok(typed),
        _ => {
            resolver
                .errors
                .sort_by_key(|error| (error.start, error.end));
            Err(resolver.errors)
        }
    }
}

fn formula_error(
    code: &'static str,
    span: Span,
    message: impl Into<String>,
    suggestion: Option<String>,
) -> FormulaError {
    FormulaError {
        code,
        message: message.into(),
        start: span.start,
        end: span.end,
        suggestion,
    }
}

/// A type as it reads in an error message.
pub(super) fn type_name(structure: &Structure, ty: ValueType) -> String {
    match ty {
        ValueType::Number => "Number".to_string(),
        ValueType::Boolean => "Boolean".to_string(),
        ValueType::Text => "Text".to_string(),
        ValueType::Date => "Date".to_string(),
        ValueType::Item(list) => {
            let name = structure.list(list).map_or("?", |list| list.name.as_str());
            format!("List '{name}'")
        }
        ValueType::Period(level) => format!("Time period ({})", level_name(level)),
    }
}

/// The value of an unset cell of type `ty`.
fn blank_value(ty: ValueType) -> Value {
    match ty {
        ValueType::Number => Value::Number(0.0),
        ValueType::Boolean => Value::Boolean(false),
        ValueType::Text => Value::Text(Arc::from("")),
        ValueType::Date => Value::Date(None),
        ValueType::Item(_) => Value::Item(None),
        ValueType::Period(_) => Value::Period(None),
    }
}

/// The operator as it reads in an error message.
fn symbol(op: BinOp) -> &'static str {
    match op {
        BinOp::Add => "'+'",
        BinOp::Sub => "'-'",
        BinOp::Mul => "'*'",
        BinOp::Div => "'/'",
        BinOp::Concat => "'&'",
        BinOp::Eq => "'='",
        BinOp::Ne => "'<>'",
        BinOp::Lt => "'<'",
        BinOp::Le => "'<='",
        BinOp::Gt => "'>'",
        BinOp::Ge => "'>='",
        BinOp::And => "AND",
        BinOp::Or => "OR",
    }
}

fn constant(value: Value, ty: ValueType, span: Span) -> TExpr {
    TExpr::Const { value, ty, span }
}

/// The operands an arithmetic, logical or text operator takes and the type of its result.
struct Operator {
    /// The type a `BLANK` operand takes.
    hint: ValueType,
    /// What the operands must be, as it reads in an error message.
    needs: &'static str,
    accepts: fn(ValueType) -> bool,
    result: ValueType,
}

impl Operator {
    /// The operator for `op`; comparisons, whose operands only have to agree, have none.
    fn of(op: BinOp) -> Option<Operator> {
        match op {
            BinOp::Add | BinOp::Sub | BinOp::Mul | BinOp::Div => Some(Operator {
                hint: ValueType::Number,
                needs: "Number operands",
                accepts: |ty| ty == ValueType::Number,
                result: ValueType::Number,
            }),
            BinOp::And | BinOp::Or => Some(Operator {
                hint: ValueType::Boolean,
                needs: "Boolean operands",
                accepts: |ty| ty == ValueType::Boolean,
                result: ValueType::Boolean,
            }),
            BinOp::Concat => Some(Operator {
                hint: ValueType::Text,
                needs: "Text, Number, Date or list item operands",
                accepts: |ty| {
                    matches!(
                        ty,
                        ValueType::Text | ValueType::Number | ValueType::Date | ValueType::Item(_)
                    )
                },
                result: ValueType::Text,
            }),
            BinOp::Eq | BinOp::Ne | BinOp::Lt | BinOp::Le | BinOp::Gt | BinOp::Ge => None,
        }
    }
}

struct Resolver<'a> {
    structure: &'a Structure,
    names: Names<'a>,
    errors: Vec<FormulaError>,
}

impl<'a> Resolver<'a> {
    fn push(&mut self, code: &'static str, span: Span, message: impl Into<String>) {
        self.errors.push(formula_error(code, span, message, None));
    }

    /// Records a problem and gives up on the node that has it.
    fn fail<T>(&mut self, code: &'static str, span: Span, message: impl Into<String>) -> Option<T> {
        self.push(code, span, message);
        None
    }

    fn report<T>(&mut self, error: FormulaError) -> Option<T> {
        self.errors.push(error);
        None
    }

    fn mismatch<T>(&mut self, span: Span, message: impl Into<String>) -> Option<T> {
        self.fail(TYPE_MISMATCH, span, message)
    }

    /// Resolves an expression. `hint` is the type the surroundings expect, which a `BLANK`
    /// takes; anything else is typed by what it is. `None` means problems were recorded.
    fn expr(&mut self, expr: &Expr, hint: Option<ValueType>) -> Option<TExpr> {
        match expr {
            Expr::Number(value, span) => {
                Some(constant(Value::Number(*value), ValueType::Number, *span))
            }
            Expr::Text(text, span) => Some(constant(
                Value::Text(Arc::from(text.as_str())),
                ValueType::Text,
                *span,
            )),
            Expr::Bool(value, span) => {
                Some(constant(Value::Boolean(*value), ValueType::Boolean, *span))
            }
            Expr::Blank(span) => self.blank(hint, *span),
            Expr::Ref { parts, span } => self.reference(parts, *span),
            Expr::Unary { op, expr, span } => self.unary(*op, expr, *span),
            Expr::Binary { op, lhs, rhs, span } => self.binary(*op, lhs, rhs, *span),
            Expr::If {
                cond,
                then,
                els,
                span,
            } => self.conditional(cond, then, els, *span, hint),
            Expr::Call { name, args, span } => self.call(name, args, *span),
            Expr::Modified {
                expr,
                modifiers,
                span,
            } => self.modified(expr, modifiers, *span),
        }
    }

    fn blank(&mut self, hint: Option<ValueType>, span: Span) -> Option<TExpr> {
        match hint {
            Some(ty) => Some(constant(blank_value(ty), ty, span)),
            None => self.mismatch(
                span,
                "BLANK takes the type of what it is used with, but nothing here says which type that is.",
            ),
        }
    }

    fn reference(&mut self, parts: &[Name], span: Span) -> Option<TExpr> {
        match self.names.lookup(parts) {
            Ok(referent) => self.value_of(referent, span),
            Err(error) => self.report(error),
        }
    }

    /// The typed node for something a reference names, when it is used as a value.
    fn value_of(&mut self, referent: Referent<'_>, span: Span) -> Option<TExpr> {
        match referent {
            Referent::LineItem(line_item) => Some(TExpr::LineItem {
                id: line_item.id,
                modifiers: Vec::new(),
                ty: line_item.format.value_type(),
                span,
            }),
            Referent::ListItem { list, item } => Some(TExpr::ListItemConst { list, item, span }),
            Referent::Period { level, index } => Some(TExpr::PeriodConst { level, index, span }),
            Referent::Version(version) => {
                let message = format!(
                    "The version '{}' can only be used to fix a dimension, as in SELECT: Versions.{}.",
                    version.name,
                    display_name(&version.name)
                );
                self.mismatch(span, message)
            }
            Referent::List(list) => {
                let message = format!(
                    "'{}' is a list, which can only be a function argument where the function asks for a list, as in ITEM({}).",
                    list.name,
                    display_name(&list.name)
                );
                self.mismatch(span, message)
            }
        }
    }

    fn unary(&mut self, op: UnOp, operand: &Expr, span: Span) -> Option<TExpr> {
        let (label, needs) = match op {
            UnOp::Neg => ("'-'", ValueType::Number),
            UnOp::Not => ("NOT", ValueType::Boolean),
        };
        let operand = self.expr(operand, Some(needs))?;
        if operand.ty() != needs {
            let message = format!(
                "{label} needs a {}, but this is {}.",
                type_name(self.structure, needs),
                type_name(self.structure, operand.ty())
            );
            return self.mismatch(operand.span(), message);
        }
        if let (
            UnOp::Neg,
            TExpr::Const {
                value: Value::Number(number),
                ..
            },
        ) = (op, &operand)
        {
            let negated = if *number == 0.0 { 0.0 } else { -number };
            return Some(constant(Value::Number(negated), needs, span));
        }
        Some(TExpr::Unary {
            op,
            expr: Box::new(operand),
            ty: needs,
            span,
        })
    }

    fn binary(&mut self, op: BinOp, lhs: &Expr, rhs: &Expr, span: Span) -> Option<TExpr> {
        let Some(operator) = Operator::of(op) else {
            return self.comparison(op, lhs, rhs, span);
        };
        let left = self.expr(lhs, Some(operator.hint));
        let right = self.expr(rhs, Some(operator.hint));
        let (left, right) = (left?, right?);
        let left_fits = self.operand_fits(op, &operator, &left);
        let right_fits = self.operand_fits(op, &operator, &right);
        if !(left_fits && right_fits) {
            return None;
        }
        Some(TExpr::Binary {
            op,
            lhs: Box::new(left),
            rhs: Box::new(right),
            ty: operator.result,
            span,
        })
    }

    fn operand_fits(&mut self, op: BinOp, operator: &Operator, operand: &TExpr) -> bool {
        if (operator.accepts)(operand.ty()) {
            return true;
        }
        let message = format!(
            "{} needs {}, but this is {}.",
            symbol(op),
            operator.needs,
            type_name(self.structure, operand.ty())
        );
        self.push(TYPE_MISMATCH, operand.span(), message);
        false
    }

    /// Both sides of a comparison have one type. A `BLANK` on one side takes the type of the
    /// other.
    fn comparison(&mut self, op: BinOp, lhs: &Expr, rhs: &Expr, span: Span) -> Option<TExpr> {
        let (left, right) = if matches!(lhs, Expr::Blank(_)) {
            let right = self.expr(rhs, None);
            let left = self.expr(lhs, right.as_ref().map(TExpr::ty));
            (left, right)
        } else {
            let left = self.expr(lhs, None);
            let right = self.expr(rhs, left.as_ref().map(TExpr::ty));
            (left, right)
        };
        let (left, right) = (left?, right?);
        let ty = left.ty();
        if ty != right.ty() {
            let message = format!(
                "Cannot compare {} with {}.",
                type_name(self.structure, ty),
                type_name(self.structure, right.ty())
            );
            return self.mismatch(span, message);
        }
        let ordering = !matches!(op, BinOp::Eq | BinOp::Ne);
        if ordering && matches!(ty, ValueType::Boolean | ValueType::Item(_)) {
            let message = format!(
                "{} cannot compare {} values by size; use = or <>.",
                symbol(op),
                type_name(self.structure, ty)
            );
            return self.mismatch(span, message);
        }
        Some(TExpr::Binary {
            op,
            lhs: Box::new(left),
            rhs: Box::new(right),
            ty: ValueType::Boolean,
            span,
        })
    }

    /// `IF cond THEN then ELSE els`. A `BLANK` branch takes the type of the other branch, or
    /// else the type the surroundings expect.
    fn conditional(
        &mut self,
        cond: &Expr,
        then: &Expr,
        els: &Expr,
        span: Span,
        hint: Option<ValueType>,
    ) -> Option<TExpr> {
        let cond = self.expr(cond, Some(ValueType::Boolean));
        let (then, els) = if matches!(then, Expr::Blank(_)) && !matches!(els, Expr::Blank(_)) {
            let els = self.expr(els, hint);
            let then = self.expr(then, els.as_ref().map(TExpr::ty).or(hint));
            (then, els)
        } else {
            let then = self.expr(then, hint);
            let els = self.expr(els, then.as_ref().map(TExpr::ty).or(hint));
            (then, els)
        };
        let (cond, then, els) = (cond?, then?, els?);
        let mut fits = true;
        if cond.ty() != ValueType::Boolean {
            let message = format!(
                "IF needs a Boolean condition, but this is {}.",
                type_name(self.structure, cond.ty())
            );
            self.push(TYPE_MISMATCH, cond.span(), message);
            fits = false;
        }
        if then.ty() != els.ty() {
            let message = format!(
                "The branches of IF must have the same type, but THEN gives {} and ELSE gives {}.",
                type_name(self.structure, then.ty()),
                type_name(self.structure, els.ty())
            );
            self.push(TYPE_MISMATCH, els.span(), message);
            fits = false;
        }
        if !fits {
            return None;
        }
        let ty = then.ty();
        Some(TExpr::If {
            cond: Box::new(cond),
            then: Box::new(then),
            els: Box::new(els),
            ty,
            span,
        })
    }
}
