//! Splits formula source into tokens (spec §4.1). Whitespace and `//` comments produce no
//! tokens; consecutive words are joined into one name here, so the parser sees whole names.

use unicode_properties::{GeneralCategoryGroup, UnicodeGeneralCategory};

use super::ast::Span;
use super::{quote_error, syntax_error};
use crate::error::FormulaError;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum Keyword {
    If,
    Then,
    Else,
    And,
    Or,
    Not,
    True,
    False,
    Blank,
}

impl Keyword {
    const ALL: [Keyword; 9] = [
        Keyword::If,
        Keyword::Then,
        Keyword::Else,
        Keyword::And,
        Keyword::Or,
        Keyword::Not,
        Keyword::True,
        Keyword::False,
        Keyword::Blank,
    ];

    fn from_word(word: &str) -> Option<Keyword> {
        Keyword::ALL
            .into_iter()
            .find(|keyword| word.eq_ignore_ascii_case(keyword.text()))
    }

    pub(super) fn text(self) -> &'static str {
        match self {
            Keyword::If => "IF",
            Keyword::Then => "THEN",
            Keyword::Else => "ELSE",
            Keyword::And => "AND",
            Keyword::Or => "OR",
            Keyword::Not => "NOT",
            Keyword::True => "TRUE",
            Keyword::False => "FALSE",
            Keyword::Blank => "BLANK",
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub(super) enum TokenKind {
    Number(f64),
    Text(String),
    Name { text: String, quoted: bool },
    Keyword(Keyword),
    LParen,
    RParen,
    LBracket,
    RBracket,
    Comma,
    Colon,
    Dot,
    Plus,
    Minus,
    Star,
    Slash,
    Amp,
    Eq,
    Ne,
    Lt,
    Le,
    Gt,
    Ge,
}

#[derive(Debug, Clone)]
pub(super) struct Token {
    pub(super) kind: TokenKind,
    pub(super) span: Span,
}

/// Tokenizes `src`, stopping at the first lexical problem.
pub(super) fn tokenize(src: &str) -> Result<Vec<Token>, FormulaError> {
    let mut scanner = Scanner {
        src,
        pos: 0,
        tokens: Vec::new(),
    };
    scanner.scan()?;
    let mut tokens = scanner.tokens;
    numeric_words_to_numbers(&mut tokens)?;
    Ok(tokens)
}

struct Scanner<'a> {
    src: &'a str,
    pos: usize,
    tokens: Vec<Token>,
}

impl Scanner<'_> {
    fn scan(&mut self) -> Result<(), FormulaError> {
        while let Some(c) = self.src[self.pos..].chars().next() {
            let start = self.pos;
            match c {
                c if c.is_whitespace() => self.pos += c.len_utf8(),
                '/' if self.src[start..].starts_with("//") => self.skip_comment(),
                '"' => self.text(start)?,
                '\'' => self.quoted_name(start)?,
                c if is_word_char(c) => self.word_or_number(start)?,
                c => self.symbol(c, start)?,
            }
        }
        Ok(())
    }

    fn push(&mut self, kind: TokenKind, start: usize, end: usize) {
        self.tokens.push(Token {
            kind,
            span: Span { start, end },
        });
        self.pos = end;
    }

    fn skip_comment(&mut self) {
        let rest = &self.src[self.pos..];
        self.pos += rest.find('\n').unwrap_or(rest.len());
    }

    /// Text between double quotes, where `""` stands for one quote.
    fn text(&mut self, start: usize) -> Result<(), FormulaError> {
        let Some((value, end)) = self.delimited(start, '"') else {
            return Err(self.unterminated(start, "Unterminated text: add a closing \"."));
        };
        self.push(TokenKind::Text(value), start, end);
        Ok(())
    }

    /// A name between single quotes, where `''` stands for one quote.
    fn quoted_name(&mut self, start: usize) -> Result<(), FormulaError> {
        let Some((text, end)) = self.delimited(start, '\'') else {
            return Err(self.unterminated(start, "Unterminated name: add a closing '."));
        };
        if text.is_empty() {
            let span = Span { start, end };
            return Err(syntax_error(span, "A quoted name cannot be empty."));
        }
        self.push(TokenKind::Name { text, quoted: true }, start, end);
        Ok(())
    }

    fn unterminated(&self, start: usize, message: &str) -> FormulaError {
        let span = Span {
            start,
            end: self.src.len(),
        };
        syntax_error(span, message)
    }

    /// Reads the quoted section opened by the `quote` at `start`: its unescaped content and the
    /// offset just past the closing quote, or `None` when the closing quote is missing.
    fn delimited(&self, start: usize, quote: char) -> Option<(String, usize)> {
        let mut value = String::new();
        let mut chars = self.src[start + 1..].char_indices().peekable();
        while let Some((offset, c)) = chars.next() {
            if c != quote {
                value.push(c);
            } else if chars.next_if(|&(_, next)| next == quote).is_some() {
                value.push(quote);
            } else {
                return Some((value, start + 1 + offset + 1));
            }
        }
        None
    }

    fn symbol(&mut self, c: char, start: usize) -> Result<(), FormulaError> {
        let rest = &self.src[start..];
        let (kind, len) = match c {
            '(' => (TokenKind::LParen, 1),
            ')' => (TokenKind::RParen, 1),
            '[' => (TokenKind::LBracket, 1),
            ']' => (TokenKind::RBracket, 1),
            ',' => (TokenKind::Comma, 1),
            ':' => (TokenKind::Colon, 1),
            '.' => (TokenKind::Dot, 1),
            '+' => (TokenKind::Plus, 1),
            '-' => (TokenKind::Minus, 1),
            '*' => (TokenKind::Star, 1),
            '/' => (TokenKind::Slash, 1),
            '&' => (TokenKind::Amp, 1),
            '=' => (TokenKind::Eq, 1),
            '<' if rest.starts_with("<>") => (TokenKind::Ne, 2),
            '<' if rest.starts_with("<=") => (TokenKind::Le, 2),
            '<' => (TokenKind::Lt, 1),
            '>' if rest.starts_with(">=") => (TokenKind::Ge, 2),
            '>' => (TokenKind::Gt, 1),
            _ => return Err(unexpected_character(self.src, start, c)),
        };
        self.push(kind, start, start + len);
        Ok(())
    }

    /// A run of word characters: a keyword, a number with a fraction or an exponent sign, or a
    /// word, which joins the name before it when there is one.
    fn word_or_number(&mut self, start: usize) -> Result<(), FormulaError> {
        let rest = &self.src[start..];
        let word_len = rest.find(|c| !is_word_char(c)).unwrap_or(rest.len());
        let word = &rest[..word_len];
        let end = start + word_len;

        let number_len = number_prefix_len(rest);
        if number_len > word_len {
            // Only a number can hold a '.' or an exponent sign, so this cannot be a name.
            let number_end = start + number_len;
            let tail = &self.src[number_end..];
            let tail_len = tail.find(|c| !is_word_char(c)).unwrap_or(tail.len());
            let span = Span {
                start,
                end: number_end + tail_len,
            };
            if tail_len > 0 {
                let text = &self.src[start..span.end];
                return Err(syntax_error(span, format!("Invalid number '{text}'.")));
            }
            let value = parse_number(&self.src[start..number_end], span)?;
            self.push(TokenKind::Number(value), start, number_end);
        } else if let Some(keyword) = Keyword::from_word(word) {
            self.push(TokenKind::Keyword(keyword), start, end);
        } else if let Some(Token {
            kind:
                TokenKind::Name {
                    text,
                    quoted: false,
                },
            span,
        }) = self.tokens.last_mut()
        {
            text.push(' ');
            text.push_str(word);
            span.end = end;
            self.pos = end;
        } else {
            let text = word.to_string();
            self.push(
                TokenKind::Name {
                    text,
                    quoted: false,
                },
                start,
                end,
            );
        }
        Ok(())
    }
}

/// Turns a bare name that is a number such as `2024` or `1e6` into a number token. A name of
/// several words (`2024 Plan`) stays a name, and so does one next to a '.', where it is a part
/// of a reference (`Years.2024`).
fn numeric_words_to_numbers(tokens: &mut [Token]) -> Result<(), FormulaError> {
    for i in 0..tokens.len() {
        let TokenKind::Name {
            text,
            quoted: false,
        } = &tokens[i].kind
        else {
            continue;
        };
        let after_dot = i > 0 && tokens[i - 1].kind == TokenKind::Dot;
        let before_dot = tokens.get(i + 1).is_some_and(|t| t.kind == TokenKind::Dot);
        if after_dot || before_dot || number_prefix_len(text) != text.len() {
            continue;
        }
        let value = parse_number(text, tokens[i].span)?;
        tokens[i].kind = TokenKind::Number(value);
    }
    Ok(())
}

/// Letters, digits and `_ % # ?`, plus the combining marks that follow letters in text where an
/// accent is a separate character, such as "a" and U+0308 for "ä".
fn is_word_char(c: char) -> bool {
    c.is_alphanumeric() || matches!(c, '_' | '%' | '#' | '?') || is_combining_mark(c)
}

fn is_combining_mark(c: char) -> bool {
    !c.is_ascii() && c.general_category_group() == GeneralCategoryGroup::Mark
}

/// A character as it reads in an error message: itself in quotes, or its code point when it is
/// a control, format or other character that would be invisible or garble the message.
fn describe_char(c: char) -> String {
    if c.general_category_group() == GeneralCategoryGroup::Other {
        format!("U+{:04X}", u32::from(c))
    } else {
        format!("'{c}'")
    }
}

fn parse_number(text: &str, span: Span) -> Result<f64, FormulaError> {
    match text.parse::<f64>() {
        Ok(value) if value.is_finite() => Ok(value),
        _ => Err(syntax_error(span, "This number is too large.")),
    }
}

/// Length of the longest prefix of `s` that is a number: digits, an optional fraction and an
/// optional exponent (`123`, `1.5`, `1e6`, `2.5E-3`). Zero when `s` does not start with a digit.
fn number_prefix_len(s: &str) -> usize {
    let bytes = s.as_bytes();
    let digits_from = |from: usize| {
        bytes.get(from..).map_or(0, |tail| {
            tail.iter().take_while(|b| b.is_ascii_digit()).count()
        })
    };
    let mut end = digits_from(0);
    if end == 0 {
        return 0;
    }
    if bytes.get(end) == Some(&b'.') && digits_from(end + 1) > 0 {
        end += 1 + digits_from(end + 1);
    }
    if matches!(bytes.get(end), Some(b'e' | b'E')) {
        let sign = usize::from(matches!(bytes.get(end + 1), Some(b'+' | b'-')));
        let exponent = digits_from(end + 1 + sign);
        if exponent > 0 {
            end += 1 + sign + exponent;
        }
    }
    end
}

fn unexpected_character(src: &str, at: usize, c: char) -> FormulaError {
    let message = format!("Unexpected character {}.", describe_char(c));
    match bare_name_around(src, at) {
        Some((span, name)) => quote_error(span, &message, &name),
        None => {
            let span = Span {
                start: at,
                end: at + c.len_utf8(),
            };
            syntax_error(span, message)
        }
    }
}

/// The bare name that the character at `at` most likely belongs to: the space-separated pieces
/// around it up to an operator, bracket, quote, keyword or line break. `None` when the piece
/// holding the character has no word character, as in `a ^ 2`, where it is not part of a name.
fn bare_name_around(src: &str, at: usize) -> Option<(Span, String)> {
    let mut start = piece_start(src, at);
    let mut end = piece_end(src, at);
    if !src[start..end].chars().any(is_word_char) {
        return None;
    }
    loop {
        let before = src[..start].trim_end_matches(is_blank).len();
        let piece = piece_start(src, before);
        if before == start || piece == before || is_keyword(&src[piece..before]) {
            break;
        }
        start = piece;
    }
    loop {
        let rest = &src[end..];
        let next = end + (rest.len() - rest.trim_start_matches(is_blank).len());
        let piece = piece_end(src, next);
        if next == end || piece == next || is_keyword(&src[next..piece]) {
            break;
        }
        end = piece;
    }
    let name = src[start..end]
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ");
    Some((Span { start, end }, name))
}

fn is_keyword(piece: &str) -> bool {
    Keyword::from_word(piece).is_some()
}

/// Whitespace within a line.
fn is_blank(c: char) -> bool {
    c.is_whitespace() && !matches!(c, '\n' | '\r')
}

/// A character that can sit inside a piece of a bare name, forbidden characters included.
fn is_piece_char(c: char) -> bool {
    !c.is_whitespace()
        && !matches!(
            c,
            '(' | ')'
                | '['
                | ']'
                | ','
                | ':'
                | '.'
                | '+'
                | '-'
                | '*'
                | '/'
                | '&'
                | '='
                | '<'
                | '>'
                | '"'
                | '\''
        )
}

fn piece_start(src: &str, mut at: usize) -> usize {
    while let Some(c) = src[..at].chars().next_back()
        && is_piece_char(c)
    {
        at -= c.len_utf8();
    }
    at
}

fn piece_end(src: &str, mut at: usize) -> usize {
    while let Some(c) = src[at..].chars().next()
        && is_piece_char(c)
    {
        at += c.len_utf8();
    }
    at
}
