use std::sync::Arc;

use chrono::NaiveDate;
use serde::{Deserialize, Serialize};

use crate::calendar::TimeLevel;
use crate::ids::{ItemId, ListId};

const BLANK_DATE: i32 = i32::MIN;
const BLANK_ITEM: u32 = u32::MAX;
const BLANK_PERIOD: u32 = u32::MAX;

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

impl Column {
    /// A column of `len` blank cells of type `ty`.
    pub fn new_blank(ty: &ValueType, len: usize) -> Column {
        match ty {
            ValueType::Number => Column::Number(vec![0.0; len]),
            ValueType::Boolean => Column::Boolean(vec![false; len]),
            ValueType::Text => Column::Text(vec![Arc::from(""); len]),
            ValueType::Date => Column::Date(vec![BLANK_DATE; len]),
            ValueType::Item(_) => Column::Item(vec![BLANK_ITEM; len]),
            ValueType::Period(_) => Column::Period(vec![BLANK_PERIOD; len]),
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
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ids::ItemId;
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
