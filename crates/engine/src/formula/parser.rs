//! Recursive-descent parser for the grammar in spec §4.2, climbing precedence levels for the
//! binary operators.

use super::ast::{BinOp, Expr, Modifier, ModifierKind, Name, Span, UnOp};
use super::lexer::{Keyword, Token, TokenKind, tokenize};
use super::{quote_error, syntax_error};
use crate::error::FormulaError;

/// How deeply expressions may nest, and how tall the tree may grow. Both keep the parser's own
/// recursion, and that of everything walking the tree later, far from the stack limit however
/// hostile the input. Nesting costs more stack per level than height, so its limit is lower.
const MAX_NESTING: usize = 64;
const MAX_HEIGHT: usize = 256;

/// How tightly each level of binary operator binds, loosest first.
const OR: u8 = 1;
const AND: u8 = 2;
const COMPARE: u8 = 3;
const CONCAT: u8 = 4;
const ADD: u8 = 5;
const MUL: u8 = 6;

const TOO_COMPLEX: &str = "This formula is too complex: split it across line items.";
const MODIFIER_EXPECTED: &str = "Expected a modifier such as SUM, LOOKUP or SELECT.";

const MODIFIERS: [(&str, ModifierKind); 11] = [
    ("SUM", ModifierKind::Sum),
    ("LOOKUP", ModifierKind::Lookup),
    ("SELECT", ModifierKind::Select),
    ("AVERAGE", ModifierKind::Average),
    ("MIN", ModifierKind::Min),
    ("MAX", ModifierKind::Max),
    ("ANY", ModifierKind::Any),
    ("ALL", ModifierKind::All),
    ("FIRSTNONBLANK", ModifierKind::FirstNonBlank),
    ("LASTNONBLANK", ModifierKind::LastNonBlank),
    ("TEXTLIST", ModifierKind::TextList),
];

/// Parses one formula into its syntax tree. Nothing is resolved: names stay as written.
///
/// On failure the returned list holds the first problem found, as a `formula.syntax` error.
pub fn parse(src: &str) -> Result<Expr, Vec<FormulaError>> {
    let tokens = tokenize(src).map_err(|error| vec![error])?;
    let parser = Parser {
        src,
        tokens,
        pos: 0,
        nesting: 0,
    };
    parser.parse_formula().map_err(|error| vec![error])
}

/// A parsed expression with the height of its tree.
struct Parsed {
    expr: Expr,
    depth: usize,
}

type Node = Result<Parsed, FormulaError>;

struct Parser<'a> {
    src: &'a str,
    tokens: Vec<Token>,
    pos: usize,
    nesting: usize,
}

impl Parser<'_> {
    fn parse_formula(mut self) -> Result<Expr, FormulaError> {
        let formula = self.parse_expr()?;
        if let Some(token) = self.peek() {
            return Err(self.unexpected_leftover(&token.kind));
        }
        Ok(formula.expr)
    }

    // expr := if_expr | or_expr
    fn parse_expr(&mut self) -> Node {
        self.nested(|parser| {
            if parser.at_keyword(Keyword::If) {
                parser.parse_if()
            } else {
                parser.parse_binary(OR)
            }
        })
    }

    // if_expr := IF expr THEN expr ELSE expr
    fn parse_if(&mut self) -> Node {
        let keyword = self.pos;
        let start = self.span_at(keyword);
        self.pos += 1;
        let cond = self.parse_expr()?;
        self.expect_keyword(
            Keyword::Then,
            keyword,
            "Expected THEN after the IF condition.",
        )?;
        let then = self.parse_expr()?;
        self.expect_keyword(
            Keyword::Else,
            keyword,
            "Expected ELSE after the THEN value.",
        )?;
        let els = self.parse_expr()?;
        let span = start.through(els.expr.span());
        let depth = cond.depth.max(then.depth).max(els.depth) + 1;
        let expr = Expr::If {
            cond: Box::new(cond.expr),
            then: Box::new(then.expr),
            els: Box::new(els.expr),
            span,
        };
        self.node(expr, depth)
    }

    // The remaining levels of expr, loosest first, are parsed by precedence climbing:
    //   or_expr  := and_expr (OR and_expr)*
    //   and_expr := not_expr (AND not_expr)*
    //   not_expr := NOT not_expr | cmp_expr
    //   cmp_expr := concat (( = | <> | < | <= | > | >= ) concat)?
    //   concat   := add (& add)*
    //   add      := mul (( + | - ) mul)*
    //   mul      := unary (( * | / ) unary)*
    // Only operators binding at least as tightly as `min` are taken.
    fn parse_binary(&mut self, min: u8) -> Node {
        let mut lhs = if min <= COMPARE
            && let Some(not) = self.eat(&TokenKind::Keyword(Keyword::Not))
        {
            let operand = self.nested(|parser| parser.parse_binary(COMPARE))?;
            let span = not.through(operand.expr.span());
            let expr = Expr::Unary {
                op: UnOp::Not,
                expr: Box::new(operand.expr),
                span,
            };
            self.node(expr, operand.depth + 1)?
        } else {
            self.parse_unary()?
        };
        while let Some((op, level)) = self.peek_kind().and_then(binary_operator) {
            if level < min {
                break;
            }
            self.pos += 1;
            let rhs = self.parse_binary(level + 1)?;
            lhs = self.binary(op, lhs, rhs)?;
            let chained = self.peek_kind().and_then(binary_operator);
            if level == COMPARE && chained.is_some_and(|(_, next)| next == COMPARE) {
                return Err(
                    self.error_here("Comparisons cannot be chained: combine them with AND or OR.")
                );
            }
        }
        Ok(lhs)
    }

    // unary := - unary | postfix
    fn parse_unary(&mut self) -> Node {
        let Some(minus) = self.eat(&TokenKind::Minus) else {
            return self.parse_postfix();
        };
        let operand = self.nested(Self::parse_unary)?;
        let span = minus.through(operand.expr.span());
        let expr = Expr::Unary {
            op: UnOp::Neg,
            expr: Box::new(operand.expr),
            span,
        };
        self.node(expr, operand.depth + 1)
    }

    // postfix := primary ( '[' modifier (',' modifier)* ']' )*
    fn parse_postfix(&mut self) -> Node {
        let mut base = self.parse_primary()?;
        while self.eat(&TokenKind::LBracket).is_some() {
            let open = self.pos - 1;
            let mut modifiers = Vec::new();
            let mut deepest = base.depth;
            loop {
                let (modifier, depth) = self.parse_modifier()?;
                deepest = deepest.max(depth);
                modifiers.push(modifier);
                if self.eat(&TokenKind::Comma).is_none() {
                    break;
                }
            }
            let close =
                self.expect_closer(&TokenKind::RBracket, open, "Expected ']' to close '['.")?;
            let span = base.expr.span().through(close);
            let expr = Expr::Modified {
                expr: Box::new(base.expr),
                modifiers,
                span,
            };
            base = self.node(expr, deepest + 1)?;
        }
        Ok(base)
    }

    // modifier := (SUM | LOOKUP | ...) ':' expr
    fn parse_modifier(&mut self) -> Result<(Modifier, usize), FormulaError> {
        let anchor = self.pos - 1;
        let found = match self.peek_kind() {
            Some(TokenKind::Name {
                text,
                quoted: false,
            }) => modifier_kind(text),
            _ => None,
        };
        let Some((word, kind)) = found else {
            return Err(self.fail(anchor, MODIFIER_EXPECTED));
        };
        let name = self.pos;
        let start = self.span_at(name);
        self.pos += 1;
        if self.eat(&TokenKind::Colon).is_none() {
            return Err(self.fail(name, format!("Expected ':' after {word}.")));
        }
        let arg = self.parse_expr()?;
        let span = start.through(arg.expr.span());
        let modifier = Modifier {
            kind,
            arg: arg.expr,
            span,
        };
        Ok((modifier, arg.depth))
    }

    // primary := number | string | TRUE | FALSE | BLANK | call | reference | '(' expr ')'
    fn parse_primary(&mut self) -> Node {
        let Some(token) = self.peek().cloned() else {
            return Err(self.expected_expression());
        };
        let span = token.span;
        let literal = match token.kind {
            TokenKind::Number(value) => Expr::Number(value, span),
            TokenKind::Text(text) => Expr::Text(text, span),
            TokenKind::Keyword(Keyword::True) => Expr::Bool(true, span),
            TokenKind::Keyword(Keyword::False) => Expr::Bool(false, span),
            TokenKind::Keyword(Keyword::Blank) => Expr::Blank(span),
            TokenKind::Name { text, quoted } => {
                self.pos += 1;
                return self.parse_name_expr(Name { text, quoted, span });
            }
            TokenKind::LParen => return self.parse_group(),
            _ => return Err(self.expected_expression()),
        };
        self.pos += 1;
        Ok(Parsed {
            expr: literal,
            depth: 1,
        })
    }

    // call := NAME '(' (expr (',' expr)*)? ')'    reference := name ('.' name)?
    fn parse_name_expr(&mut self, first: Name) -> Node {
        if self.at(&TokenKind::LParen) {
            return self.parse_call(first);
        }
        let mut span = first.span;
        let mut parts = vec![first];
        if self.eat(&TokenKind::Dot).is_some() {
            let Some(second) = self.take_name() else {
                return Err(self.fail(self.pos - 1, "Expected a name after '.'."));
            };
            span = span.through(second.span);
            parts.push(second);
            if self.at(&TokenKind::Dot) {
                return Err(self.error_here(
                    "A reference has at most two parts: List.Item or Module.Line Item.",
                ));
            }
        }
        Ok(Parsed {
            expr: Expr::Ref { parts, span },
            depth: 1,
        })
    }

    fn parse_call(&mut self, name: Name) -> Node {
        let open = self.pos;
        self.pos += 1;
        let mut args = Vec::new();
        let mut deepest = 0;
        if !self.at(&TokenKind::RParen) {
            loop {
                let arg = self.parse_expr()?;
                deepest = deepest.max(arg.depth);
                args.push(arg.expr);
                if self.eat(&TokenKind::Comma).is_none() {
                    break;
                }
            }
        }
        let close = self.expect_closer(&TokenKind::RParen, open, "Expected ')' to close '('.")?;
        let span = name.span.through(close);
        self.node(Expr::Call { name, args, span }, deepest + 1)
    }

    fn parse_group(&mut self) -> Node {
        let open = self.pos;
        let open_span = self.span_at(open);
        self.pos += 1;
        let inner = self.parse_expr()?;
        let close = self.expect_closer(&TokenKind::RParen, open, "Expected ')' to close '('.")?;
        Ok(Parsed {
            expr: inner.expr.with_span(open_span.through(close)),
            depth: inner.depth,
        })
    }

    fn binary(&self, op: BinOp, lhs: Parsed, rhs: Parsed) -> Node {
        let span = lhs.expr.span().through(rhs.expr.span());
        let depth = lhs.depth.max(rhs.depth) + 1;
        let expr = Expr::Binary {
            op,
            lhs: Box::new(lhs.expr),
            rhs: Box::new(rhs.expr),
            span,
        };
        self.node(expr, depth)
    }

    fn node(&self, expr: Expr, depth: usize) -> Node {
        if depth > MAX_HEIGHT {
            return Err(syntax_error(expr.span(), TOO_COMPLEX));
        }
        Ok(Parsed { expr, depth })
    }

    /// Runs `parse`, one nesting level deeper than the caller.
    fn nested(&mut self, parse: fn(&mut Self) -> Node) -> Node {
        self.nesting += 1;
        if self.nesting > MAX_NESTING {
            return Err(self.error_here(TOO_COMPLEX));
        }
        let parsed = parse(self);
        self.nesting -= 1;
        parsed
    }

    fn peek(&self) -> Option<&Token> {
        self.tokens.get(self.pos)
    }

    fn peek_kind(&self) -> Option<&TokenKind> {
        self.peek().map(|token| &token.kind)
    }

    fn at(&self, kind: &TokenKind) -> bool {
        self.peek_kind() == Some(kind)
    }

    fn at_keyword(&self, keyword: Keyword) -> bool {
        self.at(&TokenKind::Keyword(keyword))
    }

    /// Consumes the next token if it is `kind`, returning its span.
    fn eat(&mut self, kind: &TokenKind) -> Option<Span> {
        let span = self.peek().filter(|token| &token.kind == kind)?.span;
        self.pos += 1;
        Some(span)
    }

    fn take_name(&mut self) -> Option<Name> {
        let Token {
            kind: TokenKind::Name { text, quoted },
            span,
        } = self.peek()?.clone()
        else {
            return None;
        };
        self.pos += 1;
        Some(Name { text, quoted, span })
    }

    fn expect_keyword(
        &mut self,
        keyword: Keyword,
        anchor: usize,
        message: &str,
    ) -> Result<(), FormulaError> {
        match self.eat(&TokenKind::Keyword(keyword)) {
            Some(_) => Ok(()),
            None => Err(self.fail(anchor, message)),
        }
    }

    /// Consumes the `closer` that ends the group opened by the token at `open`.
    fn expect_closer(
        &mut self,
        closer: &TokenKind,
        open: usize,
        message: &str,
    ) -> Result<Span, FormulaError> {
        self.eat(closer).ok_or_else(|| self.fail(open, message))
    }

    fn span_at(&self, index: usize) -> Span {
        self.tokens.get(index).map_or(
            Span {
                start: self.src.len(),
                end: self.src.len(),
            },
            |token| token.span,
        )
    }

    /// An error at the next token. At the end of the formula it is at the token `anchor`
    /// instead: the one still waiting for what is missing. Where the parser stopped in or after
    /// a keyword followed by plain words, such as `IF Flag`, it suggests quoting them as a name.
    fn fail(&self, anchor: usize, message: impl Into<String>) -> FormulaError {
        let message = message.into();
        if let Some((span, name)) = self.keyword_led_name() {
            return quote_error(span, &message, &name);
        }
        let at = if self.pos < self.tokens.len() {
            self.pos
        } else {
            anchor
        };
        syntax_error(self.span_at(at), message)
    }

    /// An error at the next token, without a suggestion.
    fn error_here(&self, message: impl Into<String>) -> FormulaError {
        syntax_error(self.span_at(self.pos), message)
    }

    fn expected_expression(&self) -> FormulaError {
        if let Some(TokenKind::Keyword(keyword @ (Keyword::If | Keyword::Not))) = self.peek_kind() {
            let message = format!("Put {} in parentheses to use it here.", keyword.text());
            return self.error_here(message);
        }
        let previous = self.pos.checked_sub(1);
        let message = match (previous, self.peek()) {
            (Some(previous), _) => format!(
                "Expected an expression after {}.",
                describe(&self.tokens[previous].kind)
            ),
            (None, Some(token)) => {
                format!("Expected an expression, found {}.", describe(&token.kind))
            }
            (None, None) => "Expected an expression.".to_string(),
        };
        self.fail(previous.unwrap_or(0), message)
    }

    fn unexpected_leftover(&self, kind: &TokenKind) -> FormulaError {
        let message = match kind {
            TokenKind::RParen => "Unexpected ')': there is no matching '('.".to_string(),
            TokenKind::RBracket => "Unexpected ']': there is no matching '['.".to_string(),
            other => format!("Unexpected {} after the expression.", describe(other)),
        };
        self.fail(self.pos, message)
    }

    /// The span and text of a run like `IF Flag` — a keyword followed only by plain words —
    /// when the parser stopped in or right after it: most likely a name that needs quotes.
    fn keyword_led_name(&self) -> Option<(Span, String)> {
        let is_word = |index: usize| {
            matches!(
                self.tokens.get(index).map(|token| &token.kind),
                Some(TokenKind::Keyword(_) | TokenKind::Name { quoted: false, .. })
            )
        };
        let probe = if is_word(self.pos) {
            self.pos
        } else {
            self.pos.checked_sub(1).filter(|&index| is_word(index))?
        };
        let mut first = probe;
        while first > 0 && is_word(first - 1) {
            first -= 1;
        }
        let mut last = probe;
        while is_word(last + 1) {
            last += 1;
        }
        let TokenKind::Keyword(keyword) = self.tokens[first].kind else {
            return None;
        };
        let run = &self.tokens[first..=last];
        if run.len() < 2
            || !run[1..]
                .iter()
                .all(|token| matches!(token.kind, TokenKind::Name { .. }))
        {
            return None;
        }
        // An IF is only known to be a name once the THEN that should follow its condition is
        // missing, which is found one token past the run.
        let stopped_inside = (first..=last).contains(&self.pos);
        if !stopped_inside && !(self.pos == last + 1 && keyword == Keyword::If) {
            return None;
        }
        let words: Vec<&str> = run
            .iter()
            .map(|token| match &token.kind {
                TokenKind::Name { text, .. } => text.as_str(),
                _ => &self.src[token.span.start..token.span.end],
            })
            .collect();
        let span = Span {
            start: run[0].span.start,
            end: run[run.len() - 1].span.end,
        };
        Some((span, words.join(" ")))
    }
}

fn binary_operator(kind: &TokenKind) -> Option<(BinOp, u8)> {
    let operator = match kind {
        TokenKind::Keyword(Keyword::Or) => (BinOp::Or, OR),
        TokenKind::Keyword(Keyword::And) => (BinOp::And, AND),
        TokenKind::Eq => (BinOp::Eq, COMPARE),
        TokenKind::Ne => (BinOp::Ne, COMPARE),
        TokenKind::Lt => (BinOp::Lt, COMPARE),
        TokenKind::Le => (BinOp::Le, COMPARE),
        TokenKind::Gt => (BinOp::Gt, COMPARE),
        TokenKind::Ge => (BinOp::Ge, COMPARE),
        TokenKind::Amp => (BinOp::Concat, CONCAT),
        TokenKind::Plus => (BinOp::Add, ADD),
        TokenKind::Minus => (BinOp::Sub, ADD),
        TokenKind::Star => (BinOp::Mul, MUL),
        TokenKind::Slash => (BinOp::Div, MUL),
        _ => return None,
    };
    Some(operator)
}

/// The modifier spelled `word`, with its canonical upper-case spelling.
fn modifier_kind(word: &str) -> Option<(&'static str, ModifierKind)> {
    MODIFIERS
        .into_iter()
        .find(|(name, _)| word.eq_ignore_ascii_case(name))
}

/// A token as it reads in an error message.
fn describe(kind: &TokenKind) -> String {
    let symbol = match kind {
        TokenKind::Number(_) => return "number".to_string(),
        TokenKind::Text(_) => return "text".to_string(),
        TokenKind::Name { text, .. } => return format!("name '{text}'"),
        TokenKind::Keyword(keyword) => return keyword.text().to_string(),
        TokenKind::LParen => "(",
        TokenKind::RParen => ")",
        TokenKind::LBracket => "[",
        TokenKind::RBracket => "]",
        TokenKind::Comma => ",",
        TokenKind::Colon => ":",
        TokenKind::Dot => ".",
        TokenKind::Plus => "+",
        TokenKind::Minus => "-",
        TokenKind::Star => "*",
        TokenKind::Slash => "/",
        TokenKind::Amp => "&",
        TokenKind::Eq => "=",
        TokenKind::Ne => "<>",
        TokenKind::Lt => "<",
        TokenKind::Le => "<=",
        TokenKind::Gt => ">",
        TokenKind::Ge => ">=",
    };
    format!("'{symbol}'")
}
