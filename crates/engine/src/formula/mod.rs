//! The formula language: tokens, syntax tree and parser (spec §4.1–4.2), name resolution and
//! type checking against the model (spec §4.3–4.5), and the evaluation of a typed formula over
//! the cells of a line item (spec §3.6, §4.4 and §4.6).

mod align;
mod ast;
mod completions;
mod eval;
pub mod functions;
mod lexer;
mod parser;
mod resolve;

pub use ast::{BinOp, Expr, Modifier, ModifierKind, Name, Span, UnOp};
pub(crate) use completions::completions;
pub use completions::{Completion, CompletionKind};
pub(crate) use eval::{ColumnSource, EvalCtx, eval_all, eval_cells};
pub use parser::parse;
pub use resolve::{SelectTarget, TExpr, TModifier, resolve};

use crate::error::FormulaError;

const SYNTAX: &str = "formula.syntax";
const DIMENSION: &str = "formula.dimension";

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
