//! Syntax tree of the formula language. Every node records the byte span of the source text it
//! was parsed from, so later phases can point at the exact text they report on.

/// A half-open byte range `start..end` into the formula source.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Span {
    pub start: usize,
    pub end: usize,
}

impl Span {
    /// The span from the start of `self` to the end of `other`.
    pub(super) fn through(self, other: Span) -> Span {
        Span {
            start: self.start,
            end: other.end,
        }
    }
}

/// A name as written in the formula, either bare (`Gross Margin`) or quoted (`'P&L'`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Name {
    /// The name itself: words of a bare name joined by single spaces, quotes removed and
    /// escapes undone for a quoted name.
    pub text: String,
    pub quoted: bool,
    pub span: Span,
}

/// A prefix operator: `-x` or `NOT x`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum UnOp {
    Neg,
    Not,
}

/// An infix operator. `Concat` is `&`; `Ne` is `<>`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BinOp {
    Add,
    Sub,
    Mul,
    Div,
    Concat,
    Eq,
    Ne,
    Lt,
    Le,
    Gt,
    Ge,
    And,
    Or,
}

/// The keyword before the `:` of a modifier, which says how a source dimension is mapped.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ModifierKind {
    Sum,
    Lookup,
    Select,
    Average,
    Min,
    Max,
    Any,
    All,
    FirstNonBlank,
    LastNonBlank,
    TextList,
}

/// One `KIND: argument` entry inside the `[...]` that follows an expression.
#[derive(Debug, Clone, PartialEq)]
pub struct Modifier {
    pub kind: ModifierKind,
    pub arg: Expr,
    pub span: Span,
}

/// A parsed formula expression. Names are not resolved: a reference such as `Revenue` or
/// `Versions.Actual` is only its parts as written.
#[derive(Debug, Clone, PartialEq)]
pub enum Expr {
    Number(f64, Span),
    Text(String, Span),
    Bool(bool, Span),
    Blank(Span),
    /// `name` or `name.name`.
    Ref {
        parts: Vec<Name>,
        span: Span,
    },
    Unary {
        op: UnOp,
        expr: Box<Expr>,
        span: Span,
    },
    Binary {
        op: BinOp,
        lhs: Box<Expr>,
        rhs: Box<Expr>,
        span: Span,
    },
    If {
        cond: Box<Expr>,
        then: Box<Expr>,
        els: Box<Expr>,
        span: Span,
    },
    Call {
        name: Name,
        args: Vec<Expr>,
        span: Span,
    },
    Modified {
        expr: Box<Expr>,
        modifiers: Vec<Modifier>,
        span: Span,
    },
}

impl Expr {
    /// The source text this expression covers, including any parentheses around it.
    pub fn span(&self) -> Span {
        match self {
            Expr::Number(_, span)
            | Expr::Text(_, span)
            | Expr::Bool(_, span)
            | Expr::Blank(span)
            | Expr::Ref { span, .. }
            | Expr::Unary { span, .. }
            | Expr::Binary { span, .. }
            | Expr::If { span, .. }
            | Expr::Call { span, .. }
            | Expr::Modified { span, .. } => *span,
        }
    }

    /// The same expression covering `span` instead, for widening it over surrounding parentheses.
    pub(super) fn with_span(mut self, new: Span) -> Expr {
        match &mut self {
            Expr::Number(_, span)
            | Expr::Text(_, span)
            | Expr::Bool(_, span)
            | Expr::Blank(span)
            | Expr::Ref { span, .. }
            | Expr::Unary { span, .. }
            | Expr::Binary { span, .. }
            | Expr::If { span, .. }
            | Expr::Call { span, .. }
            | Expr::Modified { span, .. } => *span = new,
        }
        self
    }
}
