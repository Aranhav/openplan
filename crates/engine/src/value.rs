use std::sync::Arc;

use chrono::NaiveDate;
use serde::{Deserialize, Serialize};

use crate::calendar::TimeLevel;
use crate::ids::{ItemId, ListId};
use crate::shape::Shape;

pub(crate) const BLANK_DATE: i32 = i32::MIN;
pub(crate) const BLANK_ITEM: u32 = u32::MAX;
pub(crate) const BLANK_PERIOD: u32 = u32::MAX;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum NumberUnit {
    None,
    Currency { code: String },
    Percent,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum NegativeStyle {
    Minus,
    Parens,
}

/// How a line item's values are typed and displayed.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum Format {
    Number {
        decimals: u8,
        thousands_sep: bool,
        unit: NumberUnit,
        negative: NegativeStyle,
    },
    Boolean,
    Text,
    Date,
    List {
        list: ListId,
    },
    TimePeriod {
        level: TimeLevel,
    },
}

impl Format {
    /// Plain number: no decimals, thousands separators, no unit, minus sign for negatives.
    pub fn number() -> Format {
        Format::Number {
            decimals: 0,
            thousands_sep: true,
            unit: NumberUnit::None,
            negative: NegativeStyle::Minus,
        }
    }

    pub fn value_type(&self) -> ValueType {
        match self {
            Format::Number { .. } => ValueType::Number,
            Format::Boolean => ValueType::Boolean,
            Format::Text => ValueType::Text,
            Format::Date => ValueType::Date,
            Format::List { list } => ValueType::Item(*list),
            Format::TimePeriod { level } => ValueType::Period(*level),
        }
    }
}

/// The type a formula expression or line item evaluates to.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum ValueType {
    Number,
    Boolean,
    Text,
    Date,
    Item(ListId),
    Period(TimeLevel),
}

/// A single cell value; blank dates, items and periods are `None`.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "t", content = "v", rename_all = "snake_case")]
pub enum Value {
    Number(f64),
    Boolean(bool),
    Text(Arc<str>),
    Date(Option<NaiveDate>),
    Item(Option<ItemId>),
    Period(Option<(TimeLevel, u32)>),
}

/// Typed storage for the cells of one line item.
///
/// Dates are days since 1970-01-01 (`i32::MIN` is blank); items are dense indices into
/// their list (`u32::MAX` is blank); periods are indices at the format's level
/// (`u32::MAX` is blank). Blank numbers are `0.0`, blank booleans `false`, blank text `""`.
#[derive(Clone, Debug, PartialEq)]
pub enum Column {
    Number(Vec<f64>),
    Boolean(Vec<bool>),
    Text(Vec<Arc<str>>),
    Date(Vec<i32>),
    Item(Vec<u32>),
    Period(Vec<u32>),
}

/// One cell in the storage form of its [`Column`].
#[derive(Clone, Debug, PartialEq)]
pub(crate) enum Cell {
    Number(f64),
    Boolean(bool),
    Text(Arc<str>),
    Date(i32),
    Item(u32),
    Period(u32),
}

/// A number as a cell can hold it: one that overflowed or has no value is 0, and so is a
/// negative zero.
pub(crate) fn sanitize_number(number: f64) -> f64 {
    if number.is_finite() && number != 0.0 {
        number
    } else {
        0.0
    }
}

impl Column {
    /// A column of `len` blank cells of type `ty`.
    pub fn new_blank(ty: &ValueType, len: usize) -> Column {
        match ty {
            ValueType::Number => Column::Number(Vec::new()),
            ValueType::Boolean => Column::Boolean(Vec::new()),
            ValueType::Text => Column::Text(Vec::new()),
            ValueType::Date => Column::Date(Vec::new()),
            ValueType::Item(_) => Column::Item(Vec::new()),
            ValueType::Period(_) => Column::Period(Vec::new()),
        }
        .blank_like(len)
    }

    /// A column of `len` blank cells of the same kind as this one.
    pub(crate) fn blank_like(&self, len: usize) -> Column {
        match self {
            Column::Number(_) => Column::Number(vec![0.0; len]),
            Column::Boolean(_) => Column::Boolean(vec![false; len]),
            Column::Text(_) => Column::Text(vec![Arc::from(""); len]),
            Column::Date(_) => Column::Date(vec![BLANK_DATE; len]),
            Column::Item(_) => Column::Item(vec![BLANK_ITEM; len]),
            Column::Period(_) => Column::Period(vec![BLANK_PERIOD; len]),
        }
    }

    #[allow(clippy::len_without_is_empty)]
    pub fn len(&self) -> usize {
        match self {
            Column::Number(cells) => cells.len(),
            Column::Boolean(cells) => cells.len(),
            Column::Text(cells) => cells.len(),
            Column::Date(cells) => cells.len(),
            Column::Item(cells) => cells.len(),
            Column::Period(cells) => cells.len(),
        }
    }

    /// Makes every number of a number column one that a cell can hold (see
    /// [`sanitize_number`]). Other columns are left alone.
    pub(crate) fn sanitize(&mut self) {
        if let Column::Number(cells) = self {
            for cell in cells {
                *cell = sanitize_number(*cell);
            }
        }
    }

    /// Whether the cell at `i` holds the blank value of its type. Panics if `i` is out of range.
    pub fn is_blank_at(&self, i: usize) -> bool {
        match self {
            Column::Number(cells) => cells[i] == 0.0,
            Column::Boolean(cells) => !cells[i],
            Column::Text(cells) => cells[i].is_empty(),
            Column::Date(cells) => cells[i] == BLANK_DATE,
            Column::Item(cells) => cells[i] == BLANK_ITEM,
            Column::Period(cells) => cells[i] == BLANK_PERIOD,
        }
    }

    /// The cell at `i`. Panics if `i` is out of range.
    pub(crate) fn get(&self, i: usize) -> Cell {
        match self {
            Column::Number(cells) => Cell::Number(cells[i]),
            Column::Boolean(cells) => Cell::Boolean(cells[i]),
            Column::Text(cells) => Cell::Text(Arc::clone(&cells[i])),
            Column::Date(cells) => Cell::Date(cells[i]),
            Column::Item(cells) => Cell::Item(cells[i]),
            Column::Period(cells) => Cell::Period(cells[i]),
        }
    }

    /// Overwrites the cell at `i`. Panics if `i` is out of range or `cell` is not of the
    /// column's kind, which callers rule out by deriving both from the same format.
    pub(crate) fn set(&mut self, i: usize, cell: Cell) {
        match (self, cell) {
            (Column::Number(cells), Cell::Number(value)) => cells[i] = value,
            (Column::Boolean(cells), Cell::Boolean(value)) => cells[i] = value,
            (Column::Text(cells), Cell::Text(value)) => cells[i] = value,
            (Column::Date(cells), Cell::Date(value)) => cells[i] = value,
            (Column::Item(cells), Cell::Item(value)) => cells[i] = value,
            (Column::Period(cells), Cell::Period(value)) => cells[i] = value,
            _ => unreachable!("cell kind does not match column kind"),
        }
    }

    /// Lays the cells of a column over `old` out again over `new`. `maps[axis][old position]`
    /// is the position that coordinate takes on `new`, or `None` to drop its cells; cells of
    /// positions nothing maps to are blank.
    pub(crate) fn remap(&self, old: &Shape, new: &Shape, maps: &[&[Option<u32>]]) -> Column {
        match self {
            Column::Number(cells) => Column::Number(remap_cells(cells, 0.0, old, new, maps)),
            Column::Boolean(cells) => Column::Boolean(remap_cells(cells, false, old, new, maps)),
            Column::Text(cells) => Column::Text(remap_cells(cells, Arc::from(""), old, new, maps)),
            Column::Date(cells) => Column::Date(remap_cells(cells, BLANK_DATE, old, new, maps)),
            Column::Item(cells) => Column::Item(remap_cells(cells, BLANK_ITEM, old, new, maps)),
            Column::Period(cells) => {
                Column::Period(remap_cells(cells, BLANK_PERIOD, old, new, maps))
            }
        }
    }
}

fn remap_cells<T: Clone>(
    cells: &[T],
    blank: T,
    old: &Shape,
    new: &Shape,
    maps: &[&[Option<u32>]],
) -> Vec<T> {
    let mut out = vec![blank; new.size()];
    let mut coords = vec![0; old.lens.len()];
    'cells: for (index, cell) in cells.iter().enumerate() {
        old.coords(index, &mut coords);
        let mut target = 0;
        for ((&coord, map), &stride) in coords.iter().zip(maps).zip(&new.strides) {
            match map[coord as usize] {
                Some(position) => target += position as usize * stride,
                None => continue 'cells,
            }
        }
        out[target] = cell.clone();
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ids::ItemId;
    use crate::shape::Axis;
    use serde_json::json;

    #[test]
    fn blank_columns() {
        let list = ListId::new();
        let items = Column::new_blank(&ValueType::Item(list), 3);
        assert_eq!(items.len(), 3);
        assert!((0..3).all(|i| items.is_blank_at(i)));
        assert_eq!(items, Column::Item(vec![u32::MAX; 3]));

        let numbers = Column::new_blank(&ValueType::Number, 2);
        assert_eq!(numbers, Column::Number(vec![0.0, 0.0]));
        assert!((0..2).all(|i| numbers.is_blank_at(i)));

        assert_eq!(
            Column::new_blank(&ValueType::Boolean, 2),
            Column::Boolean(vec![false, false])
        );
        assert_eq!(
            Column::new_blank(&ValueType::Text, 2),
            Column::Text(vec![Arc::from(""), Arc::from("")])
        );
        assert_eq!(
            Column::new_blank(&ValueType::Date, 2),
            Column::Date(vec![i32::MIN; 2])
        );
        assert_eq!(
            Column::new_blank(&ValueType::Period(TimeLevel::Quarter), 2),
            Column::Period(vec![u32::MAX; 2])
        );
        assert_eq!(Column::new_blank(&ValueType::Text, 0).len(), 0);
    }

    #[test]
    fn blank_detection_distinguishes_values() {
        assert!(!Column::Number(vec![0.0, 1.5, f64::NAN]).is_blank_at(1));
        assert!(Column::Number(vec![0.0, 1.5]).is_blank_at(0));
        assert!(!Column::Number(vec![f64::NAN]).is_blank_at(0));
        assert!(Column::Boolean(vec![false, true]).is_blank_at(0));
        assert!(!Column::Boolean(vec![false, true]).is_blank_at(1));
        assert!(Column::Text(vec![Arc::from(""), Arc::from("a")]).is_blank_at(0));
        assert!(!Column::Text(vec![Arc::from(""), Arc::from("a")]).is_blank_at(1));
        assert!(Column::Date(vec![i32::MIN, 0]).is_blank_at(0));
        assert!(!Column::Date(vec![i32::MIN, 0]).is_blank_at(1));
        assert!(Column::Item(vec![u32::MAX, 0]).is_blank_at(0));
        assert!(!Column::Item(vec![u32::MAX, 0]).is_blank_at(1));
        assert!(Column::Period(vec![u32::MAX, 0]).is_blank_at(0));
        assert!(!Column::Period(vec![u32::MAX, 0]).is_blank_at(1));
    }

    #[test]
    fn column_lengths() {
        assert_eq!(Column::Number(vec![1.0, 2.0, 3.0]).len(), 3);
        assert_eq!(Column::Boolean(vec![true]).len(), 1);
        assert_eq!(Column::Text(vec![Arc::from("a"); 4]).len(), 4);
        assert_eq!(Column::Date(vec![0; 5]).len(), 5);
        assert_eq!(Column::Item(vec![0; 6]).len(), 6);
        assert_eq!(Column::Period(vec![0; 7]).len(), 7);
    }

    #[test]
    fn cells_roundtrip_through_columns() {
        let cases = [
            (Column::Number(vec![0.0, 0.0]), Cell::Number(2.5)),
            (Column::Boolean(vec![false, false]), Cell::Boolean(true)),
            (
                Column::Text(vec![Arc::from(""), Arc::from("")]),
                Cell::Text(Arc::from("x")),
            ),
            (
                Column::Date(vec![BLANK_DATE, BLANK_DATE]),
                Cell::Date(19_000),
            ),
            (Column::Item(vec![BLANK_ITEM, BLANK_ITEM]), Cell::Item(4)),
            (
                Column::Period(vec![BLANK_PERIOD, BLANK_PERIOD]),
                Cell::Period(3),
            ),
        ];
        for (mut column, cell) in cases {
            column.set(1, cell.clone());
            assert_eq!(column.get(1), cell);
            assert!(column.is_blank_at(0));
            assert!(!column.is_blank_at(1));
        }
    }

    #[test]
    #[should_panic(expected = "does not match column kind")]
    fn setting_a_cell_of_another_kind_panics() {
        Column::Number(vec![0.0]).set(0, Cell::Boolean(true));
    }

    #[test]
    fn remap_moves_cells_and_drops_unmapped_positions() {
        let old = Shape::new(vec![Axis::Versions, Axis::Versions], vec![2, 2]);
        let new = Shape::new(vec![Axis::Versions, Axis::Versions], vec![3, 2]);
        let rows: &[Option<u32>] = &[Some(2), None];
        let columns: &[Option<u32>] = &[Some(0), Some(1)];

        let numbers = Column::Number(vec![1.0, 2.0, 3.0, 4.0]);
        assert_eq!(
            numbers.remap(&old, &new, &[rows, columns]),
            Column::Number(vec![0.0, 0.0, 0.0, 0.0, 1.0, 2.0])
        );
        let texts = Column::Text(["a", "b", "c", "d"].map(Arc::from).to_vec());
        assert_eq!(
            texts.remap(&old, &new, &[rows, columns]),
            Column::Text(["", "", "", "", "a", "b"].map(Arc::from).to_vec())
        );
        let items = Column::Item(vec![0, 1, 2, 3]);
        assert_eq!(
            items.remap(&old, &new, &[rows, columns]),
            Column::Item(vec![BLANK_ITEM, BLANK_ITEM, BLANK_ITEM, BLANK_ITEM, 0, 1])
        );
        let dates = Column::Date(vec![0, 1, 2, 3]);
        assert_eq!(
            dates.remap(&old, &new, &[rows, columns]),
            Column::Date(vec![BLANK_DATE, BLANK_DATE, BLANK_DATE, BLANK_DATE, 0, 1])
        );

        let swapped: &[Option<u32>] = &[Some(1), Some(0)];
        let booleans = Column::Boolean(vec![true, false, false, false]);
        let square = Shape::new(vec![Axis::Versions, Axis::Versions], vec![2, 2]);
        assert_eq!(
            booleans.remap(&square, &square, &[columns, swapped]),
            Column::Boolean(vec![false, true, false, false])
        );
        let periods = Column::Period(vec![7]);
        let scalar = Shape::new(Vec::new(), Vec::new());
        assert_eq!(
            periods.remap(&scalar, &scalar, &[]),
            Column::Period(vec![7])
        );
    }

    #[test]
    fn number_format_defaults() {
        assert_eq!(
            Format::number(),
            Format::Number {
                decimals: 0,
                thousands_sep: true,
                unit: NumberUnit::None,
                negative: NegativeStyle::Minus,
            }
        );
    }

    #[test]
    fn format_value_types() {
        let list = ListId::new();
        assert_eq!(Format::number().value_type(), ValueType::Number);
        assert_eq!(Format::Boolean.value_type(), ValueType::Boolean);
        assert_eq!(Format::Text.value_type(), ValueType::Text);
        assert_eq!(Format::Date.value_type(), ValueType::Date);
        assert_eq!(Format::List { list }.value_type(), ValueType::Item(list));
        assert_eq!(
            Format::TimePeriod {
                level: TimeLevel::Year
            }
            .value_type(),
            ValueType::Period(TimeLevel::Year)
        );
    }

    #[test]
    fn format_json_forms() {
        let list = ListId::new();
        let number = Format::Number {
            decimals: 2,
            thousands_sep: false,
            unit: NumberUnit::Currency {
                code: "USD".to_string(),
            },
            negative: NegativeStyle::Parens,
        };
        let expected = json!({
            "type": "number",
            "decimals": 2,
            "thousands_sep": false,
            "unit": {"type": "currency", "code": "USD"},
            "negative": "parens",
        });
        assert_eq!(serde_json::to_value(&number).unwrap(), expected);
        assert_eq!(serde_json::from_value::<Format>(expected).unwrap(), number);

        let cases = [
            (Format::Boolean, json!({"type": "boolean"})),
            (Format::Text, json!({"type": "text"})),
            (Format::Date, json!({"type": "date"})),
            (
                Format::List { list },
                json!({"type": "list", "list": list.0.to_string()}),
            ),
            (
                Format::TimePeriod {
                    level: TimeLevel::HalfYear,
                },
                json!({"type": "time_period", "level": "half_year"}),
            ),
            (
                Format::Number {
                    decimals: 1,
                    thousands_sep: true,
                    unit: NumberUnit::Percent,
                    negative: NegativeStyle::Minus,
                },
                json!({
                    "type": "number",
                    "decimals": 1,
                    "thousands_sep": true,
                    "unit": {"type": "percent"},
                    "negative": "minus",
                }),
            ),
        ];
        for (format, expected) in cases {
            assert_eq!(serde_json::to_value(&format).unwrap(), expected);
            assert_eq!(serde_json::from_value::<Format>(expected).unwrap(), format);
        }
    }

    #[test]
    fn value_json_forms() {
        let item = ItemId::new();
        let cases = [
            (Value::Number(1.5), json!({"t": "number", "v": 1.5})),
            (Value::Boolean(true), json!({"t": "boolean", "v": true})),
            (
                Value::Text(Arc::from("hi")),
                json!({"t": "text", "v": "hi"}),
            ),
            (
                Value::Date(NaiveDate::from_ymd_opt(2026, 4, 1)),
                json!({"t": "date", "v": "2026-04-01"}),
            ),
            (Value::Date(None), json!({"t": "date", "v": null})),
            (
                Value::Item(Some(item)),
                json!({"t": "item", "v": item.0.to_string()}),
            ),
            (Value::Item(None), json!({"t": "item", "v": null})),
            (
                Value::Period(Some((TimeLevel::Quarter, 3))),
                json!({"t": "period", "v": ["quarter", 3]}),
            ),
            (Value::Period(None), json!({"t": "period", "v": null})),
        ];
        for (value, expected) in cases {
            assert_eq!(serde_json::to_value(&value).unwrap(), expected);
            assert_eq!(serde_json::from_value::<Value>(expected).unwrap(), value);
        }
    }
}
