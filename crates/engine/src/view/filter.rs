use super::cells::{LiPlan, Projection};
use super::members::{Frame, Id, Node, split};
use super::{Cx, FilterOp, MAX_FILTERED_ROWS, Place, RowFilter, ViewDim, invalid};
use crate::calendar::TimeLevel;
use crate::error::EngineError;
use crate::structure::fold;
use crate::value::{Value, ValueType};
use std::cmp::Ordering;
use std::ops::Range;

/// How many row combinations a filter reads at a time, which bounds the memory a filter holds.
const FILTER_CHUNK: usize = 16_384;

/// A filter of a query with its line item, ready to test values.
pub(super) struct ActiveFilter<'a, 'q> {
    plan: LiPlan<'a>,
    filter: &'q RowFilter,
    /// The text the filter wants, in lower case, if it wants text.
    folded: Option<String>,
}

/// Where a filter finds the members of a row.
struct Scan<'f> {
    frame: &'f Frame<'f>,
    /// The row dimensions that a filter can see: rows that differ only by the others pass or
    /// fail together.
    seen: Vec<usize>,
    seen_lens: Vec<usize>,
    /// The members a column dimension is read at.
    defaults: Vec<Node>,
}

impl<'a> Cx<'a> {
    /// The filters of a query with their line items, if each is fit to filter this view.
    pub(super) fn filter_plans<'q>(
        &self,
        filters: &'q [RowFilter],
    ) -> Result<Vec<ActiveFilter<'a, 'q>>, EngineError> {
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
                if compares {
                    let Some(value) = &filter.value else {
                        return Err(invalid(format!("The filter on '{name}' needs a value.")));
                    };
                    let ty = plan.line_item.format.value_type();
                    let (fits, wanted) = if filter.op == FilterOp::Contains {
                        (matches!(value, Value::Text(_)), "text")
                    } else {
                        (has_type(value, ty), type_word(ty))
                    };
                    if !fits {
                        return Err(invalid(format!("Filter on '{name}' needs {wanted}.")));
                    }
                }
                let folded = match &filter.value {
                    Some(Value::Text(text)) if compares => Some(fold(text)),
                    _ => None,
                };
                Ok(ActiveFilter {
                    plan,
                    filter,
                    folded,
                })
            })
            .collect()
    }

    /// The rows that pass the filters, as positions among all rows, or `None` for no filters.
    ///
    /// A filter reads the line item for the members of the row, ignoring the line items
    /// dimension, and for the page's members where the row has none. Dimensions on the columns
    /// are read at their totals and the current version. The rows are read a chunk at a time, and
    /// a view of more rows than [`MAX_FILTERED_ROWS`] is refused.
    pub(super) fn filter_rows(
        &self,
        frame: &Frame<'_>,
        filters: &[ActiveFilter<'a, '_>],
    ) -> Result<Option<Vec<usize>>, EngineError> {
        if filters.is_empty() {
            return Ok(None);
        }
        let rows = frame.rows;
        let total = rows.total();
        if total > MAX_FILTERED_ROWS {
            return Err(invalid(format!(
                "This view has {} rows to filter; the limit is {}. Narrow it with page selections.",
                thousands(total),
                thousands(MAX_FILTERED_ROWS)
            )));
        }
        if total == 0 {
            return Ok(Some(Vec::new()));
        }
        let lens = rows.lens();
        let seen: Vec<usize> = (0..rows.dims.len())
            .filter(|&at| rows.dims[at].dim != ViewDim::LineItems)
            .collect();
        let seen_lens: Vec<usize> = seen.iter().map(|&at| lens[at]).collect();
        let scan = Scan {
            frame,
            seen,
            seen_lens,
            defaults: self.column_defaults(),
        };
        let mut passes = vec![true; scan.seen_lens.iter().product()];
        for start in (0..passes.len()).step_by(FILTER_CHUNK) {
            let chunk = start..(start + FILTER_CHUNK).min(passes.len());
            for filter in filters {
                self.filter_chunk(&scan, filter, chunk.clone(), &mut passes)?;
            }
        }
        let mut passing = Vec::new();
        for at in 0..total {
            let picks = split(at, &lens);
            let key = scan
                .seen
                .iter()
                .fold(0, |key, &dim| key * lens[dim] + picks[dim]);
            if passes[key] {
                passing.push(at);
            }
        }
        Ok(Some(passing))
    }

    /// Applies a filter to the row combinations of a chunk that still pass.
    fn filter_chunk(
        &self,
        scan: &Scan<'_>,
        filter: &ActiveFilter<'a, '_>,
        chunk: Range<usize>,
        passes: &mut [bool],
    ) -> Result<(), EngineError> {
        let plan = &filter.plan;
        let wanted: Vec<usize> = chunk.filter(|&at| passes[at]).collect();
        let mut values = vec![plan.line_item.format.value_type().blank(); wanted.len()];
        let mut reads = Vec::new();
        let mut coords = Vec::new();
        for (at, &key) in wanted.iter().enumerate() {
            let picks = split(key, &scan.seen_lens);
            let projection = plan.project(self, |dim| match scan.frame.places[dim] {
                Place::Row(row_dim) => scan
                    .seen
                    .iter()
                    .position(|&candidate| candidate == row_dim)
                    .map_or(scan.defaults[dim], |seen_at| {
                        scan.frame.rows.dims[row_dim].node(picks[seen_at])
                    }),
                Place::Column(_) => scan.defaults[dim],
                Place::Page(page) => scan.frame.pages[page],
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
            passes[key] = self.passes(filter, value);
        }
        Ok(())
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
    fn passes(&self, filter: &ActiveFilter<'_, '_>, cell: &Value) -> bool {
        let compared = filter
            .filter
            .value
            .as_ref()
            .and_then(|wanted| compare(cell, wanted, filter.folded.as_deref()));
        match filter.filter.op {
            FilterOp::Eq => compared == Some(Ordering::Equal),
            FilterOp::Ne => compared != Some(Ordering::Equal),
            FilterOp::Lt => compared == Some(Ordering::Less),
            FilterOp::Le => matches!(compared, Some(Ordering::Less | Ordering::Equal)),
            FilterOp::Gt => compared == Some(Ordering::Greater),
            FilterOp::Ge => matches!(compared, Some(Ordering::Greater | Ordering::Equal)),
            FilterOp::Contains => match (&filter.folded, cell) {
                (Some(needle), Value::Text(text)) => fold(text).contains(needle.as_str()),
                (Some(needle), item @ Value::Item(Some(_))) => self
                    .text_of(&filter.plan.line_item.format, item)
                    .is_some_and(|name| fold(&name).contains(needle.as_str())),
                _ => false,
            },
            FilterOp::IsBlank => cell.is_blank(),
            FilterOp::NotBlank => !cell.is_blank(),
            FilterOp::IsTrue => matches!(cell, Value::Boolean(true)),
            FilterOp::IsFalse => matches!(cell, Value::Boolean(false)),
        }
    }
}

/// How a cell compares with the value a filter wants, if they can be compared. `folded` is the
/// wanted text in lower case.
fn compare(cell: &Value, wanted: &Value, folded: Option<&str>) -> Option<Ordering> {
    match (cell, wanted) {
        (Value::Number(a), Value::Number(b)) => a.partial_cmp(b),
        (Value::Boolean(a), Value::Boolean(b)) => Some(a.cmp(b)),
        (Value::Text(a), Value::Text(_)) => folded.map(|wanted| fold(a).as_str().cmp(wanted)),
        (Value::Date(a), Value::Date(b)) => Some(a.cmp(b)),
        (Value::Item(a), Value::Item(b)) => (a == b).then_some(Ordering::Equal),
        (Value::Period(a), Value::Period(b)) => (a == b).then_some(Ordering::Equal),
        _ => None,
    }
}

/// Whether a value is of the type a line item holds.
fn has_type(value: &Value, ty: ValueType) -> bool {
    matches!(
        (value, ty),
        (Value::Number(_), ValueType::Number)
            | (Value::Boolean(_), ValueType::Boolean)
            | (Value::Text(_), ValueType::Text)
            | (Value::Date(_), ValueType::Date)
            | (Value::Item(_), ValueType::Item(_))
            | (Value::Period(_), ValueType::Period(_))
    )
}

/// The type as a message says what a filter needs.
fn type_word(ty: ValueType) -> &'static str {
    match ty {
        ValueType::Number => "a number",
        ValueType::Boolean => "a boolean",
        ValueType::Text => "text",
        ValueType::Date => "a date",
        ValueType::Item(_) => "a list item",
        ValueType::Period(_) => "a time period",
    }
}

/// A count with a comma between groups of three digits.
fn thousands(count: usize) -> String {
    let digits = count.to_string();
    let mut grouped = String::new();
    for (at, digit) in digits.chars().enumerate() {
        if at > 0 && (digits.len() - at).is_multiple_of(3) {
            grouped.push(',');
        }
        grouped.push(digit);
    }
    grouped
}
