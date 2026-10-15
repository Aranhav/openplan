//! Front end of the formula language: tokens, syntax tree and parser (spec §4.1–4.2).
//! Nothing here knows about the model; names are resolved and typed in later phases.

mod ast;
mod lexer;
mod parser;

pub use ast::{BinOp, Expr, Modifier, ModifierKind, Name, Span, UnOp};
pub use parser::parse;

use crate::error::FormulaError;

const SYNTAX: &str = "formula.syntax";

fn syntax_error(span: Span, message: impl Into<String>) -> FormulaError {
    FormulaError {
        code: SYNTAX,
        message: message.into(),
        start: span.start,
        end: span.end,
        suggestion: None,
    }
}

/// A syntax error whose likely fix is to quote `name`, the text found at `span`. The suggestion
/// is the quoted name, ready to replace the span.
fn quote_error(span: Span, message: &str, name: &str) -> FormulaError {
    let quoted = format!("'{}'", name.replace('\'', "''"));
    FormulaError {
        code: SYNTAX,
        message: format!("{message} Quote the name: {quoted}."),
        start: span.start,
        end: span.end,
        suggestion: Some(quoted),
    }
}
