//! Modifiers: `Source[SUM: Mapping]`, `[LOOKUP: ...]`, `[SELECT: ...]` and the other kinds that
//! say how the dimensions of a source line item map onto the target's.

use crate::formula::{Expr, Modifier, ModifierKind, Span};
use crate::structure::LineItem;
use crate::value::ValueType;

use super::names::Referent;
use super::{Resolver, SelectTarget, TExpr, TModifier, TYPE_MISMATCH, type_name};

fn kind_name(kind: ModifierKind) -> &'static str {
    match kind {
        ModifierKind::Sum => "SUM",
        ModifierKind::Lookup => "LOOKUP",
        ModifierKind::Select => "SELECT",
        ModifierKind::Average => "AVERAGE",
        ModifierKind::Min => "MIN",
        ModifierKind::Max => "MAX",
        ModifierKind::Any => "ANY",
        ModifierKind::All => "ALL",
        ModifierKind::FirstNonBlank => "FIRSTNONBLANK",
        ModifierKind::LastNonBlank => "LASTNONBLANK",
        ModifierKind::TextList => "TEXTLIST",
    }
}

/// The type of line item that a modifier of this kind can map.
fn required_source(kind: ModifierKind) -> Option<ValueType> {
    match kind {
        ModifierKind::Sum | ModifierKind::Average | ModifierKind::Min | ModifierKind::Max => {
            Some(ValueType::Number)
        }
        ModifierKind::Any | ModifierKind::All => Some(ValueType::Boolean),
        ModifierKind::TextList => Some(ValueType::Text),
        ModifierKind::Lookup
        | ModifierKind::Select
        | ModifierKind::FirstNonBlank
        | ModifierKind::LastNonBlank => None,
    }
}

const SELECT_TARGETS: &str = "SELECT needs a list item, a version or a time period, such as Products.Widget, Versions.Actual or Time.'Jan 26'.";

impl<'a> Resolver<'a> {
    /// A line item followed by modifiers, which are added to the ones it already has.
    pub(super) fn modified(
        &mut self,
        base: &Expr,
        modifiers: &[Modifier],
        span: Span,
    ) -> Option<TExpr> {
        let source = match self.expr(base, None) {
            Some(TExpr::LineItem {
                id,
                modifiers,
                ty,
                span,
            }) => Some((id, modifiers, ty, span)),
            Some(other) => {
                let message = "Modifiers such as SUM and SELECT can only follow a line item.";
                self.push(TYPE_MISMATCH, other.span(), message);
                None
            }
            None => None,
        };
        let origin = source.as_ref().map(|(_, _, ty, span)| (*ty, *span));
        let mut added = Vec::with_capacity(modifiers.len());
        let mut complete = source.is_some();
        for modifier in modifiers {
            match self.modifier(modifier, origin) {
                Some(modifier) => added.push(modifier),
                None => complete = false,
            }
        }
        let (id, mut all, ty, _) = source?;
        if !complete {
            return None;
        }
        all.extend(added);
        Some(TExpr::LineItem {
            id,
            modifiers: all,
            ty,
            span,
        })
    }

    /// One modifier of a source line item with the type and span `origin`, if it has a valid
    /// source.
    fn modifier(
        &mut self,
        modifier: &Modifier,
        origin: Option<(ValueType, Span)>,
    ) -> Option<TModifier> {
        if modifier.kind == ModifierKind::Select {
            return self.select(&modifier.arg);
        }
        let mapping = self.mapping(modifier);
        if let (Some(wanted), Some((actual, span))) = (required_source(modifier.kind), origin)
            && wanted != actual
        {
            let message = format!(
                "{} needs a {} line item, but this is {}.",
                kind_name(modifier.kind),
                type_name(self.structure, wanted),
                type_name(self.structure, actual)
            );
            return self.mismatch(span, message);
        }
        let mapping = mapping?;
        Some(match modifier.kind {
            ModifierKind::Sum => TModifier::Sum(mapping.id),
            ModifierKind::Lookup => TModifier::Lookup(mapping.id),
            kind => TModifier::Agg(kind, mapping.id),
        })
    }

    /// The line item that maps dimensions for a modifier: one whose values are list items or
    /// time periods.
    fn mapping(&mut self, modifier: &Modifier) -> Option<&'a LineItem> {
        let kind = kind_name(modifier.kind);
        let needs = format!(
            "{kind} needs a line item that maps each value to a list item or time period, such as Employees.Department."
        );
        let Expr::Ref { parts, span } = &modifier.arg else {
            return self.mismatch(modifier.arg.span(), needs);
        };
        let line_item = match self.names.lookup(parts) {
            Ok(Referent::LineItem(line_item)) => line_item,
            Ok(_) => return self.mismatch(*span, needs),
            Err(error) => return self.report(error),
        };
        let ty = line_item.format.value_type();
        if !matches!(ty, ValueType::Item(_) | ValueType::Period(_)) {
            let message = format!(
                "The mapping line item '{}' must be list-formatted or time-period-formatted, but is {}.",
                line_item.name,
                type_name(self.structure, ty)
            );
            return self.mismatch(*span, message);
        }
        Some(line_item)
    }

    fn select(&mut self, arg: &Expr) -> Option<TModifier> {
        let Expr::Ref { parts, span } = arg else {
            return self.mismatch(arg.span(), SELECT_TARGETS);
        };
        let target = match self.names.lookup(parts) {
            Ok(Referent::ListItem { list, item }) => SelectTarget::Item { list, item },
            Ok(Referent::Version(version)) => SelectTarget::Version(version.id),
            Ok(Referent::Period { level, index }) => SelectTarget::Period { level, index },
            Ok(_) => return self.mismatch(*span, SELECT_TARGETS),
            Err(error) => return self.report(error),
        };
        Some(TModifier::Select(target))
    }
}
