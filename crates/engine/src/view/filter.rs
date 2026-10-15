use super::cells::{LiPlan, Projection};
use super::members::{Frame, Id, Node, split};
use super::{Cx, FilterOp, Place, RowFilter, ViewDim, invalid};
use crate::calendar::TimeLevel;
use crate::error::EngineError;
use crate::model::blank_value;
use crate::structure::fold;
use crate::value::{Format, Value};
use std::cmp::Ordering;

impl<'a> Cx<'a> {
    /// The filters of a query with their line items, if each is fit to filter this view.
    pub(super) fn filter_plans<'q>(
        &self,
        filters: &'q [RowFilter],
    ) -> Result<Vec<(LiPlan<'a>, &'q RowFilter)>, EngineError> {
        filters
            .iter()
            .map(|filter| {
                let plan = self.plan(filter.line_item)?;
                let name = &plan.line_item.name;
                if !plan.in_view {
                    return Err(invalid(format!(
                        "Filter line item '{name}' has a dimension this view doesn't have."
                    )));
                }
                let compares = matches!(
                    filter.op,
                    FilterOp::Eq
                        | FilterOp::Ne
                        | FilterOp::Lt
                        | FilterOp::Le
                        | FilterOp::Gt
                        | FilterOp::Ge
                        | FilterOp::Contains
                );
                match &filter.value {
                    None if compares => {
                        return Err(invalid(format!("The filter on '{name}' needs a value.")));
                    }
                    Some(value)
                        if filter.op == FilterOp::Contains && !matches!(value, Value::Text(_)) =>
                    {
                        return Err(invalid(format!(
                            "The contains filter on '{name}' needs a text value."
                        )));
                    }
                    _ => {}
                }
                Ok((plan, filter))
            })
            .collect()
    }

    /// The rows that pass the filters, as positions among all rows, or `None` for no filters.
    ///
    /// A filter reads the line item for the members of the row, ignoring the line items
    /// dimension, and for the page's members where the row has none. Dimensions on the columns
    /// are read at their totals and the current version.
    pub(super) fn filter_rows(
        &self,
        frame: &Frame<'_>,
        filters: &[(LiPlan<'a>, &RowFilter)],
    ) -> Result<Option<Vec<usize>>, EngineError> {
        if filters.is_empty() {
            return Ok(None);
        }
        let rows = frame.rows;
        let lens = rows.lens();
        // The row dimensions that a filter can see: rows that differ only by the others pass or
        // fail together.
        let seen: Vec<usize> = (0..rows.dims.len())
            .filter(|&at| rows.dims[at].dim != ViewDim::LineItems)
            .collect();
        let seen_lens: Vec<usize> = seen.iter().map(|&at| lens[at]).collect();
        let defaults = self.column_defaults();
        let mut passes = vec![true; seen_lens.iter().product()];
        for (plan, filter) in filters {
            let wanted: Vec<usize> = (0..passes.len()).filter(|&at| passes[at]).collect();
            let mut values = vec![blank_value(&plan.line_item.format.value_type()); wanted.len()];
            let mut reads = Vec::new();
            let mut coords = Vec::new();
            for (at, &key) in wanted.iter().enumerate() {
                let picks = split(key, &seen_lens);
                let projection = plan.project(self, |dim| match frame.places[dim] {
                    Place::Row(row_dim) => seen
                        .iter()
                        .position(|&candidate| candidate == row_dim)
                        .map_or(defaults[dim], |seen_at| {
                            rows.dims[row_dim].node(picks[seen_at])
                        }),
                    Place::Column(_) => defaults[dim],
                    Place::Page(page) => frame.pages[page],
                });
                if let Projection::Cell { tokens, .. } = projection
                    && !plan.error
                {
                    reads.push(at);
                    coords.push(tokens);
                }
            }
            if !coords.is_empty() {
                for (at, value) in reads
                    .into_iter()
                    .zip(self.model.read(plan.line_item.id, &coords)?)
                {
                    values[at] = value;
                }
            }
            for (&key, value) in wanted.iter().zip(&values) {
                passes[key] = self.passes(filter, &plan.line_item.format, value);
            }
        }
        let mut passing = Vec::new();
        for at in 0..rows.total() {
            let picks = split(at, &lens);
            let key = seen
                .iter()
                .fold(0, |key, &dim| key * lens[dim] + picks[dim]);
            if passes[key] {
                passing.push(at);
            }
        }
        Ok(Some(passing))
    }

    /// The members a column dimension is read at by a filter: the total of a list, the total
    /// of time and the current version.
    fn column_defaults(&self) -> Vec<Node> {
        self.dims
            .iter()
            .map(|dim| match dim {
                ViewDim::Time => Node::total(Id::Period(TimeLevel::All, 0)),
                ViewDim::Versions => self
                    .structure
                    .versions()
                    .iter()
                    .find(|version| version.is_current)
                    .map_or_else(
                        || Node::total(Id::Top),
                        |version| Node::leaf(Id::Version(version.id)),
                    ),
                ViewDim::LineItems | ViewDim::List { .. } | ViewDim::Subset { .. } => {
                    Node::total(Id::Top)
                }
            })
            .collect()
    }

    /// Whether a cell value passes a filter.
    fn passes(&self, filter: &RowFilter, format: &Format, cell: &Value) -> bool {
        let compared = filter
            .value
            .as_ref()
            .and_then(|wanted| compare(cell, wanted));
        match filter.op {
            FilterOp::Eq => compared == Some(Ordering::Equal),
            FilterOp::Ne => compared != Some(Ordering::Equal),
            FilterOp::Lt => compared == Some(Ordering::Less),
            FilterOp::Le => matches!(compared, Some(Ordering::Less | Ordering::Equal)),
            FilterOp::Gt => compared == Some(Ordering::Greater),
            FilterOp::Ge => matches!(compared, Some(Ordering::Greater | Ordering::Equal)),
            FilterOp::Contains => match (&filter.value, cell) {
                (Some(Value::Text(needle)), Value::Text(text)) => {
                    fold(text).contains(&fold(needle))
                }
                (Some(Value::Text(needle)), item @ Value::Item(Some(_))) => self
                    .text_of(format, item)
                    .is_some_and(|name| fold(&name).contains(&fold(needle))),
                _ => false,
            },
            FilterOp::IsBlank => cell.is_blank(),
            FilterOp::NotBlank => !cell.is_blank(),
            FilterOp::IsTrue => matches!(cell, Value::Boolean(true)),
            FilterOp::IsFalse => matches!(cell, Value::Boolean(false)),
        }
    }
}

/// How a cell compares with the value a filter wants, if they can be compared.
fn compare(cell: &Value, wanted: &Value) -> Option<Ordering> {
    match (cell, wanted) {
        (Value::Number(a), Value::Number(b)) => a.partial_cmp(b),
        (Value::Boolean(a), Value::Boolean(b)) => Some(a.cmp(b)),
        (Value::Text(a), Value::Text(b)) => Some(fold(a).cmp(&fold(b))),
        (Value::Date(a), Value::Date(b)) => Some(a.cmp(b)),
        (Value::Item(a), Value::Item(b)) => (a == b).then_some(Ordering::Equal),
        (Value::Period(a), Value::Period(b)) => (a == b).then_some(Ordering::Equal),
        _ => None,
    }
}
