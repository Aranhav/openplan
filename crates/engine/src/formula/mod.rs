//! Front end of the formula language: tokens, syntax tree and parser (spec §4.1–4.2), then
//! name resolution and type checking against the model (spec §4.3–4.5).

mod ast;
pub mod functions;
mod lexer;
mod parser;
mod resolve;

pub use ast::{BinOp, Expr, Modifier, ModifierKind, Name, Span, UnOp};
pub use parser::parse;
pub use resolve::{SelectTarget, TExpr, TModifier, resolve};

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
