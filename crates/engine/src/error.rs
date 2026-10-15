use serde::Serialize;

/// A problem found while parsing or compiling a formula, located by byte span.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct FormulaError {
    pub code: &'static str,
    pub message: String,
    pub start: usize,
    pub end: usize,
    pub suggestion: Option<String>,
}

/// A rejected cell of a submitted edit batch.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CellIssue {
    /// Position of the cell in the submitted batch.
    pub index: usize,
    pub message: String,
}

#[derive(Debug, Clone, thiserror::Error)]
pub enum EngineError {
    #[error("formula has {} error(s)", .0.len())]
    Formula(Vec<FormulaError>),
    #[error("{what} not found: {id}")]
    NotFound { what: &'static str, id: String },
    #[error("{what} name already in use: {name}")]
    NameTaken { what: &'static str, name: String },
    #[error("{message}")]
    Invalid { message: String },
    #[error("{message}")]
    InUse { message: String },
    #[error("{} cell(s) have invalid values", .cells.len())]
    InvalidValue { cells: Vec<CellIssue> },
    #[error("line item {line_item} is calculated and cannot be edited")]
    NotInput { line_item: String },
    #[error("{message}")]
    InvalidCoordinate { message: String },
}

impl EngineError {
    /// Stable machine-readable code, mapped one to one to API problem codes.
    ///
    /// A formula error reports the code of its first problem.
    pub fn code(&self) -> &'static str {
        match self {
            Self::Formula(errors) => errors.first().map_or("formula.syntax", |error| error.code),
            Self::NotFound { .. } => "structure.not_found",
            Self::NameTaken { .. } => "structure.name_taken",
            Self::Invalid { .. } => "structure.invalid",
            Self::InUse { .. } => "structure.in_use",
            Self::InvalidValue { .. } => "cells.invalid_value",
            Self::NotInput { .. } => "cells.not_input",
            Self::InvalidCoordinate { .. } => "cells.invalid_coordinate",
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn formula_error(code: &'static str) -> FormulaError {
        FormulaError {
            code,
            message: "boom".to_string(),
            start: 0,
            end: 1,
            suggestion: None,
        }
    }

    #[test]
    fn codes() {
        let cases: Vec<(EngineError, &str)> = vec![
            (
                EngineError::Formula(vec![formula_error("formula.unknown_name")]),
                "formula.unknown_name",
            ),
            (
                EngineError::Formula(vec![
                    formula_error("formula.arity"),
                    formula_error("formula.syntax"),
                ]),
                "formula.arity",
            ),
            (EngineError::Formula(Vec::new()), "formula.syntax"),
            (
                EngineError::NotFound {
                    what: "list",
                    id: "x".to_string(),
                },
                "structure.not_found",
            ),
            (
                EngineError::NameTaken {
                    what: "module",
                    name: "Revenue".to_string(),
                },
                "structure.name_taken",
            ),
            (
                EngineError::Invalid {
                    message: "bad".to_string(),
                },
                "structure.invalid",
            ),
            (
                EngineError::InUse {
                    message: "used".to_string(),
                },
                "structure.in_use",
            ),
            (
                EngineError::InvalidValue {
                    cells: vec![CellIssue {
                        index: 2,
                        message: "not a number".to_string(),
                    }],
                },
                "cells.invalid_value",
            ),
            (
                EngineError::NotInput {
                    line_item: "Margin".to_string(),
                },
                "cells.not_input",
            ),
            (
                EngineError::InvalidCoordinate {
                    message: "out of range".to_string(),
                },
                "cells.invalid_coordinate",
            ),
        ];
        for (error, code) in cases {
            assert_eq!(error.code(), code, "{error}");
        }
    }

    #[test]
    fn display_messages() {
        let not_found = EngineError::NotFound {
            what: "list",
            id: "abc".to_string(),
        };
        assert_eq!(not_found.to_string(), "list not found: abc");
        let name_taken = EngineError::NameTaken {
            what: "module",
            name: "Revenue".to_string(),
        };
        assert_eq!(
            name_taken.to_string(),
            "module name already in use: Revenue"
        );
        let invalid = EngineError::Invalid {
            message: "years must be between 1 and 20".to_string(),
        };
        assert_eq!(invalid.to_string(), "years must be between 1 and 20");
    }

    #[test]
    fn formula_error_serializes_all_fields() {
        let error = FormulaError {
            code: "formula.unknown_name",
            message: "Unknown name 'Revnue'".to_string(),
            start: 4,
            end: 10,
            suggestion: Some("Revenue".to_string()),
        };
        let json = serde_json::to_value(&error).unwrap();
        assert_eq!(
            json,
            serde_json::json!({
                "code": "formula.unknown_name",
                "message": "Unknown name 'Revnue'",
                "start": 4,
                "end": 10,
                "suggestion": "Revenue",
            })
        );
    }
}
