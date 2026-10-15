use std::ops::Range;

use chrono::{Datelike, NaiveDate};
use serde::{Deserialize, Serialize};

use crate::error::EngineError;
use crate::ids::TimeRangeId;

const MONTH_NAMES: [&str; 12] = [
    "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

/// Granularity of a time axis, finest first.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TimeLevel {
    Month,
    Quarter,
    HalfYear,
    Year,
    All,
}

impl TimeLevel {
    /// Months in one period of this level; `None` for `All`, which spans the whole calendar.
    fn months_per_period(self) -> Option<u32> {
        match self {
            TimeLevel::Month => Some(1),
            TimeLevel::Quarter => Some(3),
            TimeLevel::HalfYear => Some(6),
            TimeLevel::Year => Some(12),
            TimeLevel::All => None,
        }
    }
}

/// The model timeline: whole fiscal years of months.
///
/// `first_year` is the label year of the first fiscal year, which is the calendar year in
/// which that fiscal year ends. Month index 0 is the first month of that fiscal year.
/// Methods other than [`Calendar::validate`] assume a valid calendar.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Calendar {
    pub fiscal_year_start_month: u8,
    pub first_year: i32,
    pub years: u8,
    #[serde(default)]
    pub current_month: Option<u32>,
}

/// A named run of whole fiscal years that a module or line item may use instead of the
/// model calendar.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct TimeRange {
    pub id: TimeRangeId,
    pub name: String,
    pub first_year: i32,
    pub years: u8,
}

impl Calendar {
    pub fn validate(&self) -> Result<(), EngineError> {
        if !(1..=12).contains(&self.fiscal_year_start_month) {
            return Err(EngineError::Invalid {
                message: "fiscal_year_start_month must be between 1 and 12".to_string(),
            });
        }
        if !(1..=20).contains(&self.years) {
            return Err(EngineError::Invalid {
                message: "years must be between 1 and 20".to_string(),
            });
        }
        if !(1..=9999).contains(&self.first_year) {
            return Err(EngineError::Invalid {
                message: "first_year must be between 1 and 9999".to_string(),
            });
        }
        Ok(())
    }

    pub fn months(&self) -> u32 {
        u32::from(self.years) * 12
    }

    pub fn periods(&self, level: TimeLevel) -> u32 {
        match level.months_per_period() {
            Some(months) => self.months() / months,
            None => 1,
        }
    }

    pub fn period_of_month(&self, month: u32, level: TimeLevel) -> u32 {
        match level.months_per_period() {
            Some(months) => month / months,
            None => 0,
        }
    }

    pub fn months_in_period(&self, level: TimeLevel, period: u32) -> Range<u32> {
        match level.months_per_period() {
            Some(months) => period * months..(period + 1) * months,
            None => 0..self.months(),
        }
    }

    /// Display label of a period: `Jan 26`, `Q1 FY26`, `H1 FY26`, `FY26` or `Total`.
    pub fn label(&self, level: TimeLevel, period: u32) -> String {
        match level {
            TimeLevel::Month => {
                let date = self.month_start_date(period);
                format!(
                    "{} {:02}",
                    MONTH_NAMES[date.month0() as usize],
                    date.year().rem_euclid(100)
                )
            }
            TimeLevel::Quarter => {
                format!(
                    "Q{} FY{:02}",
                    period % 4 + 1,
                    self.fiscal_year_digits(period / 4)
                )
            }
            TimeLevel::HalfYear => {
                format!(
                    "H{} FY{:02}",
                    period % 2 + 1,
                    self.fiscal_year_digits(period / 2)
                )
            }
            TimeLevel::Year => format!("FY{:02}", self.fiscal_year_digits(period)),
            TimeLevel::All => "Total".to_string(),
        }
    }

    /// Inverse of [`Calendar::label`]; case-insensitive, `None` for anything that is not a
    /// period of this calendar.
    pub fn parse_label(&self, label: &str) -> Option<(TimeLevel, u32)> {
        let mut words = label.split_whitespace();
        let first = words.next()?;
        let second = words.next();
        if words.next().is_some() {
            return None;
        }
        match second {
            None if first.eq_ignore_ascii_case("total") => Some((TimeLevel::All, 0)),
            None => Some((TimeLevel::Year, self.parse_fiscal_year(first)?)),
            Some(second) if has_fiscal_year_prefix(second) => {
                let year = self.parse_fiscal_year(second)?;
                let (level, per_year, number) = match first.as_bytes() {
                    [b'q' | b'Q', digit] => (TimeLevel::Quarter, 4, digit.checked_sub(b'1')?),
                    [b'h' | b'H', digit] => (TimeLevel::HalfYear, 2, digit.checked_sub(b'1')?),
                    _ => return None,
                };
                let number = u32::from(number);
                (number < per_year).then_some((level, year * per_year + number))
            }
            Some(second) => Some((TimeLevel::Month, self.parse_month(first, second)?)),
        }
    }

    /// First day of the calendar month at index `month`, which must lie within the calendar.
    pub fn month_start_date(&self, month: u32) -> NaiveDate {
        let ordinal = self.first_month_ordinal() + i64::from(month);
        let year = i32::try_from(ordinal.div_euclid(12)).expect("year fits in i32");
        NaiveDate::from_ymd_opt(year, ordinal.rem_euclid(12) as u32 + 1, 1)
            .expect("month of a valid calendar is a representable date")
    }

    /// Index of the calendar month containing `d`, or `None` outside the calendar.
    pub fn month_of_date(&self, d: NaiveDate) -> Option<u32> {
        let ordinal = i64::from(d.year()) * 12 + i64::from(d.month0());
        u32::try_from(ordinal - self.first_month_ordinal())
            .ok()
            .filter(|&month| month < self.months())
    }

    /// Month offset of the start of `range` relative to month 0; negative when the range
    /// starts before the calendar.
    pub fn range_month_offset(&self, r: &TimeRange) -> i64 {
        (i64::from(r.first_year) - i64::from(self.first_year)) * 12
    }

    /// Calendar months (year * 12 + month0) from year 0 to the first month of the calendar.
    fn first_month_ordinal(&self) -> i64 {
        let start_year = if self.fiscal_year_start_month == 1 {
            self.first_year
        } else {
            self.first_year - 1
        };
        i64::from(start_year) * 12 + i64::from(self.fiscal_year_start_month) - 1
    }

    /// Two-digit label year of the fiscal year `index` years after the first one.
    fn fiscal_year_digits(&self, index: u32) -> i32 {
        (self.first_year + index as i32).rem_euclid(100)
    }

    /// Parses `FYyy` into the index of that fiscal year within the calendar.
    fn parse_fiscal_year(&self, word: &str) -> Option<u32> {
        let digits = word.get(2..).filter(|_| has_fiscal_year_prefix(word))?;
        let label_year = parse_two_digits(digits)?;
        (0..u32::from(self.years))
            .find(|&index| i64::from(self.fiscal_year_digits(index)) == label_year)
    }

    /// Parses a month name and two-digit year into a month index within the calendar.
    fn parse_month(&self, name: &str, year_digits: &str) -> Option<u32> {
        let month0 = MONTH_NAMES
            .iter()
            .position(|month| month.eq_ignore_ascii_case(name))? as i64;
        let label_year = parse_two_digits(year_digits)?;
        let first_ordinal = self.first_month_ordinal();
        let first_year = first_ordinal.div_euclid(12);
        (first_year..=first_year + i64::from(self.years)).find_map(|year| {
            if year.rem_euclid(100) != label_year {
                return None;
            }
            u32::try_from(year * 12 + month0 - first_ordinal)
                .ok()
                .filter(|&month| month < self.months())
        })
    }
}

fn has_fiscal_year_prefix(word: &str) -> bool {
    word.get(..2)
        .is_some_and(|prefix| prefix.eq_ignore_ascii_case("fy"))
}

fn parse_two_digits(text: &str) -> Option<i64> {
    if text.len() == 2 && text.bytes().all(|byte| byte.is_ascii_digit()) {
        text.parse().ok()
    } else {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn calendar(fiscal_year_start_month: u8, first_year: i32, years: u8) -> Calendar {
        Calendar {
            fiscal_year_start_month,
            first_year,
            years,
            current_month: None,
        }
    }

    const LEVELS: [TimeLevel; 5] = [
        TimeLevel::Month,
        TimeLevel::Quarter,
        TimeLevel::HalfYear,
        TimeLevel::Year,
        TimeLevel::All,
    ];

    #[test]
    fn jan_start_labels() {
        let cal = calendar(1, 2026, 2);
        assert_eq!(cal.months(), 24);
        assert_eq!(cal.label(TimeLevel::Month, 0), "Jan 26");
        assert_eq!(cal.label(TimeLevel::Month, 23), "Dec 27");
        assert_eq!(cal.label(TimeLevel::Quarter, 4), "Q1 FY27");
        assert_eq!(cal.label(TimeLevel::HalfYear, 1), "H2 FY26");
        assert_eq!(cal.label(TimeLevel::Year, 1), "FY27");
        assert_eq!(cal.label(TimeLevel::All, 0), "Total");
        assert_eq!(cal.period_of_month(13, TimeLevel::Quarter), 4);
    }

    #[test]
    fn april_start_fiscal() {
        let cal = calendar(4, 2027, 1);
        assert_eq!(cal.label(TimeLevel::Month, 0), "Apr 26");
        assert_eq!(cal.label(TimeLevel::Month, 11), "Mar 27");
        assert_eq!(cal.label(TimeLevel::Year, 0), "FY27");
        assert_eq!(cal.label(TimeLevel::Quarter, 3), "Q4 FY27");
        assert_eq!(cal.months_in_period(TimeLevel::Quarter, 1), 3..6);
        assert_eq!(
            cal.month_start_date(0),
            NaiveDate::from_ymd_opt(2026, 4, 1).unwrap()
        );
        assert_eq!(
            cal.month_of_date(NaiveDate::from_ymd_opt(2027, 3, 15).unwrap()),
            Some(11)
        );
        assert_eq!(
            cal.month_of_date(NaiveDate::from_ymd_opt(2027, 4, 1).unwrap()),
            None
        );
        assert_eq!(
            cal.month_of_date(NaiveDate::from_ymd_opt(2026, 3, 31).unwrap()),
            None
        );
    }

    #[test]
    fn periods_and_months_in_period() {
        let cal = calendar(7, 2026, 3);
        assert_eq!(cal.months(), 36);
        assert_eq!(cal.periods(TimeLevel::Month), 36);
        assert_eq!(cal.periods(TimeLevel::Quarter), 12);
        assert_eq!(cal.periods(TimeLevel::HalfYear), 6);
        assert_eq!(cal.periods(TimeLevel::Year), 3);
        assert_eq!(cal.periods(TimeLevel::All), 1);
        assert_eq!(cal.months_in_period(TimeLevel::Month, 7), 7..8);
        assert_eq!(cal.months_in_period(TimeLevel::HalfYear, 2), 12..18);
        assert_eq!(cal.months_in_period(TimeLevel::Year, 2), 24..36);
        assert_eq!(cal.months_in_period(TimeLevel::All, 0), 0..36);
        assert_eq!(cal.period_of_month(35, TimeLevel::Month), 35);
        assert_eq!(cal.period_of_month(35, TimeLevel::HalfYear), 5);
        assert_eq!(cal.period_of_month(35, TimeLevel::Year), 2);
        assert_eq!(cal.period_of_month(35, TimeLevel::All), 0);
        for level in LEVELS {
            for period in 0..cal.periods(level) {
                for month in cal.months_in_period(level, period) {
                    assert_eq!(cal.period_of_month(month, level), period);
                }
            }
        }
    }

    #[test]
    fn parse_labels_roundtrip() {
        let cal = calendar(4, 2027, 2);
        for level in LEVELS {
            for period in 0..cal.periods(level) {
                let label = cal.label(level, period);
                assert_eq!(
                    cal.parse_label(&label),
                    Some((level, period)),
                    "label {label}"
                );
            }
        }
        assert_eq!(cal.parse_label("q1 fy27"), Some((TimeLevel::Quarter, 0)));
        assert_eq!(cal.parse_label("  JAN 27 "), Some((TimeLevel::Month, 9)));
        assert_eq!(cal.parse_label("total"), Some((TimeLevel::All, 0)));
        assert_eq!(cal.parse_label("fy28"), Some((TimeLevel::Year, 1)));
        assert_eq!(cal.parse_label("Foo"), None);
    }

    #[test]
    fn parse_label_rejects_out_of_range_and_malformed() {
        let cal = calendar(4, 2027, 2);
        for label in [
            "",
            "Mar 26",
            "Apr 28",
            "Jan 2027",
            "Jan 7",
            "Foo 27",
            "FY26",
            "FY29",
            "FY2027",
            "Q5 FY27",
            "Q0 FY27",
            "H3 FY27",
            "X1 FY27",
            "Q1 FY26",
            "Q1 27",
            "Q1 FY27 extra",
            "Total 1",
        ] {
            assert_eq!(cal.parse_label(label), None, "label {label:?}");
        }
    }

    #[test]
    fn validate_bounds() {
        assert!(calendar(1, 2026, 1).validate().is_ok());
        assert!(calendar(12, 2026, 20).validate().is_ok());
        for bad in [
            calendar(0, 2026, 2),
            calendar(13, 2026, 2),
            calendar(1, 2026, 0),
            calendar(1, 2026, 21),
            calendar(1, 0, 2),
            calendar(1, 10000, 2),
        ] {
            let error = bad.validate().unwrap_err();
            assert_eq!(error.code(), "structure.invalid", "{bad:?}");
        }
    }

    #[test]
    fn range_month_offset_is_relative_to_calendar_start() {
        let cal = calendar(4, 2027, 3);
        let range = |first_year| TimeRange {
            id: TimeRangeId::new(),
            name: "Range".to_string(),
            first_year,
            years: 1,
        };
        assert_eq!(cal.range_month_offset(&range(2027)), 0);
        assert_eq!(cal.range_month_offset(&range(2029)), 24);
        assert_eq!(cal.range_month_offset(&range(2026)), -12);
    }

    #[test]
    fn json_forms() {
        let cal: Calendar =
            serde_json::from_str(r#"{"fiscal_year_start_month":4,"first_year":2027,"years":1}"#)
                .unwrap();
        assert_eq!(cal, calendar(4, 2027, 1));
        let with_current = Calendar {
            current_month: Some(5),
            ..cal
        };
        let json = serde_json::to_value(with_current).unwrap();
        assert_eq!(json["current_month"], 5);
        assert_eq!(
            serde_json::to_string(&TimeLevel::HalfYear).unwrap(),
            "\"half_year\""
        );
        assert_eq!(
            serde_json::from_str::<TimeLevel>("\"all\"").unwrap(),
            TimeLevel::All
        );
    }

    #[test]
    fn every_fiscal_start_month_roundtrips_dates_and_labels() {
        for start_month in 1..=12 {
            let cal = calendar(start_month, 2026, 2);
            let start_year = if start_month == 1 { 2026 } else { 2025 };
            assert_eq!(
                cal.month_start_date(0),
                NaiveDate::from_ymd_opt(start_year, u32::from(start_month), 1).unwrap(),
                "start month {start_month}"
            );
            for month in 0..cal.months() {
                assert_eq!(
                    cal.month_of_date(cal.month_start_date(month)),
                    Some(month),
                    "start month {start_month}, month {month}"
                );
            }
            for level in LEVELS {
                for period in 0..cal.periods(level) {
                    let label = cal.label(level, period);
                    assert_eq!(
                        cal.parse_label(&label),
                        Some((level, period)),
                        "start month {start_month}, label {label}"
                    );
                }
            }
        }
    }

    #[test]
    fn levels_order_finest_to_coarsest() {
        assert!(LEVELS.windows(2).all(|pair| pair[0] < pair[1]));
    }
}
