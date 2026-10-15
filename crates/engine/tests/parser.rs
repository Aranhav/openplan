use openplan_engine::{BinOp, Expr, FormulaError, ModifierKind, Name, Span, UnOp, parse};
use proptest::prelude::*;

/// Renders a tree as an s-expression so precedence and associativity read at a glance:
/// references in braces, binary operators in prefix form, calls and modifiers as written.
fn show(expr: &Expr) -> String {
    match expr {
        Expr::Number(value, _) => value.to_string(),
        Expr::Text(text, _) => format!("{text:?}"),
        Expr::Bool(value, _) => if *value { "TRUE" } else { "FALSE" }.to_string(),
        Expr::Blank(_) => "BLANK".to_string(),
        Expr::Ref { parts, .. } => {
            let parts: Vec<String> = parts.iter().map(show_name).collect();
            format!("{{{}}}", parts.join("."))
        }
        Expr::Unary { op, expr, .. } => {
            let op = match op {
                UnOp::Neg => "neg",
                UnOp::Not => "not",
            };
            format!("({op} {})", show(expr))
        }
        Expr::Binary { op, lhs, rhs, .. } => {
            let op = match op {
                BinOp::Add => "+",
                BinOp::Sub => "-",
                BinOp::Mul => "*",
                BinOp::Div => "/",
                BinOp::Concat => "&",
                BinOp::Eq => "=",
                BinOp::Ne => "<>",
                BinOp::Lt => "<",
                BinOp::Le => "<=",
                BinOp::Gt => ">",
                BinOp::Ge => ">=",
                BinOp::And => "AND",
                BinOp::Or => "OR",
            };
            format!("({op} {} {})", show(lhs), show(rhs))
        }
        Expr::If {
            cond, then, els, ..
        } => format!("(if {} {} {})", show(cond), show(then), show(els)),
        Expr::Call { name, args, .. } => {
            let args: Vec<String> = args.iter().map(show).collect();
            format!("{}({})", show_name(name), args.join(", "))
        }
        Expr::Modified {
            expr, modifiers, ..
        } => {
            let modifiers: Vec<String> = modifiers
                .iter()
                .map(|modifier| {
                    let kind = format!("{:?}", modifier.kind).to_uppercase();
                    format!("{kind}: {}", show(&modifier.arg))
                })
                .collect();
            format!("{}[{}]", show(expr), modifiers.join(", "))
        }
    }
}

fn show_name(name: &Name) -> String {
    if name.quoted {
        format!("'{}'", name.text.replace('\'', "''"))
    } else {
        name.text.clone()
    }
}

fn parsed(src: &str) -> Expr {
    parse(src).unwrap_or_else(|errors| panic!("{src:?} should parse, got {errors:?}"))
}

fn tree(src: &str) -> String {
    show(&parsed(src))
}

fn error(src: &str) -> FormulaError {
    let mut errors = match parse(src) {
        Ok(expr) => panic!("{src:?} should not parse, got {}", show(&expr)),
        Err(errors) => errors,
    };
    assert_eq!(errors.len(), 1, "{errors:?}");
    errors.remove(0)
}

fn span(start: usize, end: usize) -> Span {
    Span { start, end }
}

fn name_parts(src: &str) -> Vec<(String, bool, Span)> {
    match parsed(src) {
        Expr::Ref { parts, .. } => parts
            .into_iter()
            .map(|part| (part.text, part.quoted, part.span))
            .collect(),
        other => panic!("{src:?} should be a reference, got {other:?}"),
    }
}

#[test]
fn precedence() {
    assert_eq!(tree("1 + 2 * 3 = 7"), "(= (+ 1 (* 2 3)) 7)");
    assert_eq!(tree("(1 + 2) * 3"), "(* (+ 1 2) 3)");
    assert_eq!(tree("8 - 3 - 2"), "(- (- 8 3) 2)");
    assert_eq!(tree("8 / 4 / 2"), "(/ (/ 8 4) 2)");
    assert_eq!(tree("2 * 3 / 4"), "(/ (* 2 3) 4)");
    assert_eq!(tree("-a * b"), "(* (neg {a}) {b})");
    assert_eq!(tree("- - 2"), "(neg (neg 2))");
    assert_eq!(tree("2 * -3"), "(* 2 (neg 3))");
    assert_eq!(tree("1 - -2"), "(- 1 (neg 2))");
    assert_eq!(tree("a + b = c - d"), "(= (+ {a} {b}) (- {c} {d}))");
}

#[test]
fn comparison_operators() {
    assert_eq!(tree("a = b"), "(= {a} {b})");
    assert_eq!(tree("a <> b"), "(<> {a} {b})");
    assert_eq!(tree("a < b"), "(< {a} {b})");
    assert_eq!(tree("a <= b"), "(<= {a} {b})");
    assert_eq!(tree("a > b"), "(> {a} {b})");
    assert_eq!(tree("a >= b"), "(>= {a} {b})");
    assert_eq!(tree("a < b AND c >= d"), "(AND (< {a} {b}) (>= {c} {d}))");
}

#[test]
fn names_with_spaces() {
    assert_eq!(
        tree("Gross Margin / Revenue"),
        "(/ {Gross Margin} {Revenue})"
    );
    assert_eq!(
        tree("Net Income + Other Operating Income"),
        "(+ {Net Income} {Other Operating Income})"
    );
    assert_eq!(tree("Flag AND Other Flag"), "(AND {Flag} {Other Flag})");
}

#[test]
fn name_whitespace_is_normalized_but_spans_stay_in_the_source() {
    let src = "Gross \t  Margin\n  Percent";
    assert_eq!(
        name_parts(src),
        vec![(
            "Gross Margin Percent".to_string(),
            false,
            span(0, src.len())
        )]
    );
}

#[test]
fn keywords_are_case_insensitive_and_end_names() {
    assert_eq!(tree("if a then 1 else 2"), "(if {a} 1 2)");
    assert_eq!(tree("Not a And b Or c"), "(OR (AND (not {a}) {b}) {c})");
    assert_eq!(tree("true"), "TRUE");
    assert_eq!(tree("False"), "FALSE");
    assert_eq!(tree("blank"), "BLANK");
}

#[test]
fn literals() {
    assert_eq!(tree("TRUE"), "TRUE");
    assert_eq!(tree("FALSE"), "FALSE");
    assert_eq!(tree("BLANK"), "BLANK");
    assert_eq!(tree("123"), "123");
    assert_eq!(tree("1.5"), "1.5");
    assert_eq!(tree("1e6"), "1000000");
    assert_eq!(tree("1E3"), "1000");
    assert_eq!(tree("2.5e-3"), "0.0025");
    assert_eq!(tree("1e+2"), "100");
    assert_eq!(tree("Revenue = BLANK"), "(= {Revenue} BLANK)");
}

#[test]
fn words_may_start_with_a_digit_unless_the_run_is_a_number() {
    assert_eq!(tree("2024"), "2024");
    assert_eq!(tree("2024 Plan"), "{2024 Plan}");
    assert_eq!(tree("Revenue 2024"), "{Revenue 2024}");
    assert_eq!(tree("3rd Quarter"), "{3rd Quarter}");
    assert_eq!(tree("2024Plan"), "{2024Plan}");
    assert_eq!(tree("1e"), "{1e}");
    assert_eq!(tree("1 2"), "{1 2}");
    assert_eq!(tree("2024 Plan + 1"), "(+ {2024 Plan} 1)");
    assert_eq!(tree("3 + 4"), "(+ 3 4)");
    assert_eq!(tree("Years.2024"), "{Years.2024}");
    assert_eq!(tree("2024.Plan"), "{2024.Plan}");
}

#[test]
fn qualified_and_quoted() {
    assert_eq!(
        name_parts("'P&L'.'Net Income'"),
        vec![
            ("P&L".to_string(), true, span(0, 5)),
            ("Net Income".to_string(), true, span(6, 18)),
        ]
    );
    assert_eq!(
        name_parts("Revenue Plan.Units"),
        vec![
            ("Revenue Plan".to_string(), false, span(0, 12)),
            ("Units".to_string(), false, span(13, 18)),
        ]
    );
    assert_eq!(
        name_parts("'Profit & Loss'"),
        vec![("Profit & Loss".to_string(), true, span(0, 15))]
    );
    assert_eq!(
        tree("'P&L'.'Net Income' / Revenue Plan.Units"),
        "(/ {'P&L'.'Net Income'} {Revenue Plan.Units})"
    );
    assert_eq!(tree("Revenue.'Net Units'"), "{Revenue.'Net Units'}");
}

#[test]
fn quoted_names_may_hold_keywords_and_operators() {
    assert_eq!(tree("'IF Flag' + 1"), "(+ {'IF Flag'} 1)");
    assert_eq!(tree("'a + b'"), "{'a + b'}");
    assert_eq!(tree("'Margin %' * 2"), "(* {'Margin %'} 2)");
    assert_eq!(tree("'AND'"), "{'AND'}");
}

#[test]
fn if_then_else_nested() {
    assert_eq!(tree("IF a THEN 1 ELSE 2"), "(if {a} 1 2)");
    assert_eq!(
        tree("IF a THEN 1 ELSE IF b THEN 2 ELSE 3"),
        "(if {a} 1 (if {b} 2 3))"
    );
    assert_eq!(
        tree("IF a THEN IF b THEN 1 ELSE 2 ELSE 3"),
        "(if {a} (if {b} 1 2) 3)"
    );
    assert_eq!(
        tree("IF a > 1 AND b THEN x + 1 ELSE y * 2"),
        "(if (AND (> {a} 1) {b}) (+ {x} 1) (* {y} 2))"
    );
    assert_eq!(tree("1 + (IF a THEN 1 ELSE 2)"), "(+ 1 (if {a} 1 2))");
    assert_eq!(tree("IF a THEN 1 ELSE 2 + 3"), "(if {a} 1 (+ 2 3))");
}

#[test]
fn and_or_not_precedence() {
    assert_eq!(tree("NOT a AND b OR c"), "(OR (AND (not {a}) {b}) {c})");
    assert_eq!(tree("a OR b AND c"), "(OR {a} (AND {b} {c}))");
    assert_eq!(tree("a AND b AND c"), "(AND (AND {a} {b}) {c})");
    assert_eq!(tree("NOT a = b"), "(not (= {a} {b}))");
    assert_eq!(tree("NOT NOT a"), "(not (not {a}))");
    assert_eq!(tree("a AND NOT b"), "(AND {a} (not {b}))");
}

#[test]
fn concat() {
    assert_eq!(
        tree(r#""Total: " & Region Name & "!""#),
        r#"(& (& "Total: " {Region Name}) "!")"#
    );
    assert_eq!(tree("a & b + c"), "(& {a} (+ {b} {c}))");
    assert_eq!(tree("a = b & c"), "(= {a} (& {b} {c}))");
}

#[test]
fn function_calls() {
    assert_eq!(tree("ROUND(x, 2, UP)"), "ROUND({x}, 2, {UP})");
    match parsed("ROUND(x, 2, UP)") {
        Expr::Call {
            name,
            args,
            span: s,
        } => {
            assert_eq!(name.text, "ROUND");
            assert!(!name.quoted);
            assert_eq!(name.span, span(0, 5));
            assert_eq!(s, span(0, 15));
            assert_eq!(args.len(), 3);
            assert!(matches!(&args[2], Expr::Ref { parts, .. } if parts[0].text == "UP"));
        }
        other => panic!("expected a call, got {other:?}"),
    }
    assert_eq!(tree("START()"), "START()");
    assert_eq!(
        tree("MAX(a, MIN(b, c)) + 1"),
        "(+ MAX({a}, MIN({b}, {c})) 1)"
    );
    assert_eq!(tree("MAX(Gross Margin, 0)"), "MAX({Gross Margin}, 0)");
    assert_eq!(tree("ABS(IF a THEN 1 ELSE -2)"), "ABS((if {a} 1 (neg 2)))");
    assert_eq!(tree("ROUND (x, 2)"), "ROUND({x}, 2)");
    assert_eq!(tree("lag(x, 1, 0)"), "lag({x}, 1, 0)");
    assert_eq!(
        tree("TIMESUM(x, 'Jan 26', 'Jun 26')"),
        "TIMESUM({x}, {'Jan 26'}, {'Jun 26'})"
    );
}

#[test]
fn modifiers() {
    let src = "Revenue[SUM: Map, SELECT: Versions.Actual]";
    assert_eq!(
        tree(src),
        "{Revenue}[SUM: {Map}, SELECT: {Versions.Actual}]"
    );
    match parsed(src) {
        Expr::Modified {
            expr,
            modifiers,
            span: s,
        } => {
            assert_eq!(s, span(0, src.len()));
            assert_eq!(expr.span(), span(0, 7));
            assert_eq!(modifiers.len(), 2);
            assert_eq!(modifiers[0].kind, ModifierKind::Sum);
            assert_eq!(modifiers[0].span, span(8, 16));
            assert_eq!(modifiers[1].kind, ModifierKind::Select);
            assert_eq!(modifiers[1].span, span(18, 41));
            assert_eq!(modifiers[1].arg.span(), span(26, 41));
        }
        other => panic!("expected modifiers, got {other:?}"),
    }
}

#[test]
fn every_modifier_kind() {
    let kinds = [
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
    for (word, kind) in kinds {
        for spelled in [word.to_string(), word.to_lowercase()] {
            let src = format!("x[{spelled}: m]");
            match parsed(&src) {
                Expr::Modified { modifiers, .. } => {
                    assert_eq!(modifiers.len(), 1, "{src}");
                    assert_eq!(modifiers[0].kind, kind, "{src}");
                }
                other => panic!("{src}: expected modifiers, got {other:?}"),
            }
        }
    }
}

#[test]
fn modifier_arguments_and_chains() {
    assert_eq!(
        tree("x[ lookup : Target.Map ]"),
        "{x}[LOOKUP: {Target.Map}]"
    );
    assert_eq!(
        tree("x[SELECT: Time.'Jan 26']"),
        "{x}[SELECT: {Time.'Jan 26'}]"
    );
    assert_eq!(tree("x[LOOKUP: a][SUM: b]"), "{x}[LOOKUP: {a}][SUM: {b}]");
    assert_eq!(tree("-x[SUM: m] * 2"), "(* (neg {x}[SUM: {m}]) 2)");
    assert_eq!(tree("SUM(x[SUM: m], 1)"), "SUM({x}[SUM: {m}], 1)");
    assert_eq!(
        tree("x[SELECT: IF a THEN Versions.Actual ELSE Versions.Budget, SUM: m]"),
        "{x}[SELECT: (if {a} {Versions.Actual} {Versions.Budget}), SUM: {m}]"
    );
}

#[test]
fn list_item_literal() {
    assert_eq!(
        name_parts("Time.'Jan 26'"),
        vec![
            ("Time".to_string(), false, span(0, 4)),
            ("Jan 26".to_string(), true, span(5, 13)),
        ]
    );
    assert_eq!(tree("Versions.Budget"), "{Versions.Budget}");
    assert_eq!(tree("Time.Jan 26"), "{Time.Jan 26}");
    assert_eq!(
        tree("Version = Versions.Actual"),
        "(= {Version} {Versions.Actual})"
    );
}

#[test]
fn text_escapes() {
    assert_eq!(tree(r#""plain""#), r#""plain""#);
    assert_eq!(tree(r#""say ""hi""""#), r#""say \"hi\"""#);
    assert_eq!(tree(r#""""#), r#""""#);
    assert_eq!(tree(r#""""""""#), r#""\"\"""#);
    assert_eq!(tree(r#""it's""#), r#""it's""#);
    assert_eq!(
        name_parts("'Bob''s Plan'"),
        vec![("Bob's Plan".to_string(), true, span(0, 13))]
    );
    match parsed(r#""a ""b"" c""#) {
        Expr::Text(text, s) => {
            assert_eq!(text, r#"a "b" c"#);
            assert_eq!(s, span(0, 11));
        }
        other => panic!("expected text, got {other:?}"),
    }
}

#[test]
fn comments_ignored() {
    assert_eq!(tree("1 + // add two\n 2"), "(+ 1 2)");
    assert_eq!(tree("1 + 2 // trailing"), "(+ 1 2)");
    assert_eq!(tree("// leading\n1"), "1");
    assert_eq!(tree("a // x\n+ b"), "(+ {a} {b})");
    assert_eq!(tree(r#""// not a comment""#), r#""// not a comment""#);
    assert_eq!(tree("'a // b'"), "{'a // b'}");
    assert_eq!(tree("a / b"), "(/ {a} {b})");
}

#[test]
fn a_comment_between_words_still_joins_them_into_one_name() {
    assert_eq!(tree("Gross // the comment\n Margin"), "{Gross Margin}");
    assert_eq!(
        tree("Gross // the comment\n Margin + 1"),
        "(+ {Gross Margin} 1)"
    );
    let src = "Gross // c\nMargin";
    assert_eq!(
        name_parts(src),
        vec![("Gross Margin".to_string(), false, span(0, src.len()))]
    );
}

#[test]
fn percent_in_name() {
    assert_eq!(tree("Margin % * 2"), "(* {Margin %} 2)");
    assert_eq!(tree("Margin %"), "{Margin %}");
    assert_eq!(tree("Units # + Rate?"), "(+ {Units #} {Rate?})");
    assert_eq!(tree("Net_Income % / 100"), "(/ {Net_Income %} 100)");
    assert_eq!(tree("Is Active?"), "{Is Active?}");
}

#[test]
fn non_ascii_names() {
    assert_eq!(tree("Umsätze + Überschuss"), "(+ {Umsätze} {Überschuss})");
    assert_eq!(tree("収益 / コスト"), "(/ {収益} {コスト})");
}

#[test]
fn combining_marks_belong_to_words() {
    // "Umsätze" with the ä written as "a" plus U+0308, as macOS file names and some editors do.
    let decomposed = "Umsa\u{308}tze";
    assert_eq!(
        name_parts(decomposed),
        vec![(decomposed.to_string(), false, span(0, 9))]
    );
    assert_eq!(
        tree("Umsa\u{308}tze + 1"),
        "(+ {Umsa\u{308}tze} 1)".to_string()
    );
    assert_eq!(
        tree("Gross Mar\u{301}gin / Revenue"),
        "(/ {Gross Mar\u{301}gin} {Revenue})"
    );
    assert_eq!(tree("\u{e9}\u{301}x"), "{\u{e9}\u{301}x}");
    assert_eq!(tree("नमस्ते + 1"), "(+ {नमस्ते} 1)");
}

#[test]
fn spans_are_byte_offsets() {
    let expr = parsed("Umsätze");
    assert_eq!(expr.span(), span(0, 8));
    assert_eq!(
        name_parts("Umsätze"),
        vec![("Umsätze".to_string(), false, span(0, 8))]
    );

    let src = "Umsätze + Übersicht";
    match parsed(src) {
        Expr::Binary {
            lhs, rhs, span: s, ..
        } => {
            assert_eq!(lhs.span(), span(0, 8));
            assert_eq!(rhs.span(), span(11, 21));
            assert_eq!(s, span(0, 21));
            assert_eq!(src.len(), 21);
        }
        other => panic!("expected a binary expression, got {other:?}"),
    }

    match parsed("日本語 + 1") {
        Expr::Binary {
            lhs, rhs, span: s, ..
        } => {
            assert_eq!(lhs.span(), span(0, 9));
            assert_eq!(rhs.span(), span(12, 13));
            assert_eq!(s, span(0, 13));
        }
        other => panic!("expected a binary expression, got {other:?}"),
    }

    let e = error("Umsätze +");
    assert_eq!((e.start, e.end), (9, 10));
}

#[test]
fn spans_cover_whole_nodes() {
    let src = "(a + b) * c";
    match parsed(src) {
        Expr::Binary {
            lhs, rhs, span: s, ..
        } => {
            assert_eq!(s, span(0, 11));
            assert_eq!(lhs.span(), span(0, 7));
            assert_eq!(rhs.span(), span(10, 11));
        }
        other => panic!("expected a binary expression, got {other:?}"),
    }
    assert_eq!(parsed("((a))").span(), span(0, 5));

    let src = "IF a THEN 1 ELSE -2";
    match parsed(src) {
        Expr::If {
            cond,
            then,
            els,
            span: s,
        } => {
            assert_eq!(s, span(0, src.len()));
            assert_eq!(cond.span(), span(3, 4));
            assert_eq!(then.span(), span(10, 11));
            assert_eq!(els.span(), span(17, 19));
        }
        other => panic!("expected an IF, got {other:?}"),
    }

    match parsed("NOT a") {
        Expr::Unary { op, span: s, .. } => {
            assert_eq!(op, UnOp::Not);
            assert_eq!(s, span(0, 5));
        }
        other => panic!("expected a unary expression, got {other:?}"),
    }
    assert_eq!(parsed("  1 + 2  ").span(), span(2, 7));
}

#[test]
fn keyword_name_error_suggests_quotes() {
    let e = error("IF Flag");
    assert_eq!(e.code, "formula.syntax");
    assert_eq!(
        e.message,
        "Expected THEN after the IF condition. Quote the name: 'IF Flag'."
    );
    assert_eq!(e.suggestion.as_deref(), Some("'IF Flag'"));
    assert_eq!((e.start, e.end), (0, 7));

    let e = error("TRUE Story");
    assert!(
        e.message.ends_with("Quote the name: 'TRUE Story'."),
        "{}",
        e.message
    );
    assert_eq!(e.suggestion.as_deref(), Some("'TRUE Story'"));
    assert_eq!((e.start, e.end), (0, 10));

    let e = error("Revenue + BLANK Check");
    assert!(
        e.message.ends_with("Quote the name: 'BLANK Check'."),
        "{}",
        e.message
    );
    assert_eq!((e.start, e.end), (10, 21));

    let e = error("1 + (IF Flag)");
    assert!(
        e.message.ends_with("Quote the name: 'IF Flag'."),
        "{}",
        e.message
    );
    assert_eq!((e.start, e.end), (5, 12));

    let e = error("THEN Stage");
    assert!(
        e.message.ends_with("Quote the name: 'THEN Stage'."),
        "{}",
        e.message
    );
}

#[test]
fn quote_hint_is_only_given_for_keyword_led_names() {
    for src in [
        "IF a THEN 1",
        "IF a THEN 1 ELSE",
        "NOT",
        "x + IF",
        "a AND",
        "Flag IF",
        "NOT a )",
    ] {
        let e = error(src);
        assert!(
            !e.message.contains("Quote the name"),
            "{src}: {}",
            e.message
        );
        assert_eq!(e.suggestion, None, "{src}");
    }
}

#[test]
fn forbidden_character_suggests_quotes() {
    let e = error("Net$ Income");
    assert_eq!(e.code, "formula.syntax");
    assert_eq!(
        e.message,
        "Unexpected character '$'. Quote the name: 'Net$ Income'."
    );
    assert_eq!(e.suggestion.as_deref(), Some("'Net$ Income'"));
    assert_eq!((e.start, e.end), (0, 11));

    let e = error("1 + Cost@Unit * 2");
    assert_eq!(
        e.message,
        "Unexpected character '@'. Quote the name: 'Cost@Unit'."
    );
    assert_eq!((e.start, e.end), (4, 13));

    let e = error("a AND b@ c");
    assert_eq!(e.suggestion.as_deref(), Some("'b@ c'"));
    assert_eq!((e.start, e.end), (6, 10));

    for (src, character, start) in [
        ("1 + $", '$', 4),
        ("a ^ 2", '^', 2),
        ("Net $ Income", '$', 4),
    ] {
        let e = error(src);
        assert_eq!(
            e.message,
            format!("Unexpected character '{character}'."),
            "{src}"
        );
        assert_eq!(e.suggestion, None, "{src}");
        assert_eq!((e.start, e.end), (start, start + 1), "{src}");
    }
}

#[test]
fn unterminated_string_span() {
    let e = error("\"abc");
    assert_eq!(e.code, "formula.syntax");
    assert_eq!(e.message, "Unterminated text: add a closing \".");
    assert_eq!((e.start, e.end), (0, 4));

    let e = error("1 + \"abc");
    assert_eq!(e.message, "Unterminated text: add a closing \".");
    assert_eq!((e.start, e.end), (4, 8));

    let e = error("\"say \"\"hi\"\"");
    assert_eq!(e.message, "Unterminated text: add a closing \".");
    assert_eq!((e.start, e.end), (0, 11));

    let e = error("'Net Income");
    assert_eq!(e.message, "Unterminated name: add a closing '.");
    assert_eq!((e.start, e.end), (0, 11));
}

#[test]
fn trailing_operator_error() {
    let e = error("1 +");
    assert_eq!(e.code, "formula.syntax");
    assert_eq!(e.message, "Expected an expression after '+'.");
    assert_eq!((e.start, e.end), (2, 3));

    for (src, message) in [
        ("a -", "Expected an expression after '-'."),
        ("a *", "Expected an expression after '*'."),
        ("a /", "Expected an expression after '/'."),
        ("a &", "Expected an expression after '&'."),
        ("a =", "Expected an expression after '='."),
        ("a <>", "Expected an expression after '<>'."),
        ("a AND", "Expected an expression after AND."),
        ("a OR", "Expected an expression after OR."),
        ("NOT", "Expected an expression after NOT."),
        ("-", "Expected an expression after '-'."),
        ("IF", "Expected an expression after IF."),
        ("IF a THEN", "Expected an expression after THEN."),
        ("IF a THEN 1 ELSE", "Expected an expression after ELSE."),
        ("f(1,", "Expected an expression after ','."),
        ("f(", "Expected an expression after '('."),
        ("(", "Expected an expression after '('."),
        ("x[SUM:", "Expected an expression after ':'."),
    ] {
        assert_eq!(error(src).message, message, "{src}");
    }

    let e = error("1 + * 2");
    assert_eq!(e.message, "Expected an expression after '+'.");
    assert_eq!((e.start, e.end), (4, 5));
}

#[test]
fn empty_and_comment_only_formulas() {
    for src in ["", "   ", "// nothing here", "\n"] {
        let e = error(src);
        assert_eq!(e.message, "Expected an expression.", "{src:?}");
        assert_eq!((e.start, e.end), (src.len(), src.len()), "{src:?}");
    }
}

#[test]
fn leading_operator_error() {
    let e = error("* 2");
    assert_eq!(e.message, "Expected an expression, found '*'.");
    assert_eq!((e.start, e.end), (0, 1));
    assert_eq!(error(")").message, "Expected an expression, found ')'.");
    assert_eq!(
        error("THEN 1").message,
        "Expected an expression, found THEN."
    );
    assert_eq!(error("+ 1").message, "Expected an expression, found '+'.");
}

#[test]
fn unbalanced_brackets() {
    let e = error("(1 + 2");
    assert_eq!(e.message, "Expected ')' to close '('.");
    assert_eq!((e.start, e.end), (0, 1));

    let e = error("f(1, 2");
    assert_eq!(e.message, "Expected ')' to close '('.");
    assert_eq!((e.start, e.end), (1, 2));

    let e = error("(1 + 2 \"x\")");
    assert_eq!(e.message, "Expected ')' to close '('.");
    assert_eq!((e.start, e.end), (7, 10));

    let e = error("x[SUM: m");
    assert_eq!(e.message, "Expected ']' to close '['.");
    assert_eq!((e.start, e.end), (1, 2));

    let e = error("1 + 2)");
    assert_eq!(e.message, "Unexpected ')': there is no matching '('.");
    assert_eq!((e.start, e.end), (5, 6));

    let e = error("a]");
    assert_eq!(e.message, "Unexpected ']': there is no matching '['.");

    assert_eq!(error("()").message, "Expected an expression after '('.");
}

#[test]
fn stray_tokens_after_an_expression() {
    assert_eq!(
        error("a, b").message,
        "Unexpected ',' after the expression."
    );
    assert_eq!(
        error("a : b").message,
        "Unexpected ':' after the expression."
    );
    assert_eq!(
        error("1 2.5").message,
        "Unexpected number after the expression."
    );
    assert_eq!(
        error("a \"x\"").message,
        "Unexpected text after the expression."
    );
    assert_eq!(
        error("1 \"x\"").message,
        "Unexpected text after the expression."
    );
    assert_eq!(
        error("1.5 b").message,
        "Unexpected name 'b' after the expression."
    );
    assert_eq!(
        error("a THEN b").message,
        "Unexpected THEN after the expression."
    );
    assert_eq!(
        error("a ELSE b").message,
        "Unexpected ELSE after the expression."
    );
    assert_eq!(
        error("1 (2)").message,
        "Unexpected '(' after the expression."
    );
}

#[test]
fn if_errors() {
    let e = error("IF a THEN 1");
    assert_eq!(e.message, "Expected ELSE after the THEN value.");
    assert_eq!((e.start, e.end), (0, 2));

    let e = error("IF a b THEN 1 ELSE");
    assert_eq!(e.message, "Expected an expression after ELSE.");
    assert_eq!((e.start, e.end), (14, 18));

    let e = error("IF a THEN 1 \"x\"");
    assert_eq!(e.message, "Expected ELSE after the THEN value.");
    assert_eq!((e.start, e.end), (12, 15));
}

#[test]
fn if_and_not_need_parentheses_as_operands() {
    let e = error("1 + IF a THEN 1 ELSE 2");
    assert_eq!(e.message, "Put IF in parentheses to use it here.");
    assert_eq!((e.start, e.end), (4, 6));

    assert_eq!(
        error("a = NOT b").message,
        "Put NOT in parentheses to use it here."
    );
    assert_eq!(
        error("-NOT a").message,
        "Put NOT in parentheses to use it here."
    );
    assert_eq!(tree("a = (NOT b)"), "(= {a} (not {b}))");
}

#[test]
fn comparisons_cannot_be_chained() {
    let e = error("a < b < c");
    assert_eq!(
        e.message,
        "Comparisons cannot be chained: combine them with AND or OR."
    );
    assert_eq!((e.start, e.end), (6, 7));
    assert_eq!(tree("a < b AND b < c"), "(AND (< {a} {b}) (< {b} {c}))");
    assert_eq!(tree("(a < b) = (b < c)"), "(= (< {a} {b}) (< {b} {c}))");
}

#[test]
fn modifier_errors() {
    let modifier_message = "Expected a modifier such as SUM, LOOKUP or SELECT.";

    let e = error("x[]");
    assert_eq!(e.message, modifier_message);
    assert_eq!((e.start, e.end), (2, 3));

    let e = error("x[Total: m]");
    assert_eq!(e.message, modifier_message);
    assert_eq!((e.start, e.end), (2, 7));

    let e = error("x['SUM': m]");
    assert_eq!(e.message, modifier_message);

    let e = error("x[SUM: m,]");
    assert_eq!(e.message, modifier_message);
    assert_eq!((e.start, e.end), (9, 10));

    let e = error("x[");
    assert_eq!(e.message, modifier_message);
    assert_eq!((e.start, e.end), (1, 2));

    let e = error("x[SUM]");
    assert_eq!(e.message, "Expected ':' after SUM.");
    assert_eq!((e.start, e.end), (5, 6));

    let e = error("x[SUM: ]");
    assert_eq!(e.message, "Expected an expression after ':'.");
    assert_eq!((e.start, e.end), (7, 8));

    let e = error("x[SUM: m SELECT: n]");
    assert_eq!(e.message, "Expected ']' to close '['.");
}

#[test]
fn reference_errors() {
    let e = error("a.");
    assert_eq!(e.message, "Expected a name after '.'.");
    assert_eq!((e.start, e.end), (1, 2));

    let e = error("a.+ 1");
    assert_eq!(e.message, "Expected a name after '.'.");
    assert_eq!((e.start, e.end), (2, 3));

    let e = error("a.b.c");
    assert_eq!(
        e.message,
        "A reference has at most two parts: List.Item or Module.Line Item."
    );
    assert_eq!((e.start, e.end), (3, 4));

    let e = error("Years.1.5");
    assert_eq!(e.message, "Expected a name after '.'.");

    let e = error(".5");
    assert_eq!(e.message, "Expected an expression, found '.'.");
}

#[test]
fn lexical_errors() {
    let e = error("''");
    assert_eq!(e.message, "A quoted name cannot be empty.");
    assert_eq!((e.start, e.end), (0, 2));

    let e = error("1e999");
    assert_eq!(e.message, "This number is too large.");
    assert_eq!((e.start, e.end), (0, 5));

    let e = error("1 + 2.5e999");
    assert_eq!(e.message, "This number is too large.");
    assert_eq!((e.start, e.end), (4, 11));

    let e = error("1.5x + 2");
    assert_eq!(e.message, "Invalid number '1.5x'.");
    assert_eq!((e.start, e.end), (0, 4));

    let e = error("1 +\u{0}");
    assert_eq!(e.message, "Unexpected character U+0000.");
    assert_eq!((e.start, e.end), (3, 4));
}

#[test]
fn unexpected_characters_are_shown_when_printable_and_by_code_point_otherwise() {
    for (src, shown) in [
        ("1 + €", "'€'"),
        ("1 + ^", "'^'"),
        ("1 + \u{0}", "U+0000"),
        ("1 + \u{7f}", "U+007F"),
        ("1 + \u{200b}", "U+200B"),
        ("1 + \u{feff}", "U+FEFF"),
        ("1 + \u{e000}", "U+E000"),
    ] {
        let e = error(src);
        assert_eq!(
            e.message,
            format!("Unexpected character {shown}."),
            "{src:?}"
        );
        assert_eq!((e.start, e.end), (4, 4 + src[4..].len()), "{src:?}");
    }
}

#[test]
fn all_errors_use_the_syntax_code_and_end_with_a_period() {
    for src in [
        "",
        "(",
        ")",
        "1 +",
        "IF",
        "IF a",
        "\"abc",
        "'abc",
        "''",
        "a $ b",
        "x[",
        "x[]",
        "a.",
        "a < b < c",
        "1 + IF a THEN 1 ELSE 2",
        "f(,)",
        "1e999",
        "1.5x",
    ] {
        let e = error(src);
        assert_eq!(e.code, "formula.syntax", "{src:?}");
        assert!(e.message.ends_with('.'), "{src:?}: {}", e.message);
        assert!(
            e.message.chars().next().is_some_and(char::is_uppercase),
            "{src:?}: {}",
            e.message
        );
    }
}

const TOO_COMPLEX: &str = "This formula is too complex: split it across line items.";

/// Parses on a 1 MB stack, a quarter of what a test thread has by default. A parser that recurses
/// too deeply overflows it and aborts the whole test binary, which no assertion can catch.
fn parse_on_small_stack(src: &str) -> Result<Expr, Vec<FormulaError>> {
    let src = src.to_string();
    std::thread::Builder::new()
        .stack_size(1 << 20)
        .spawn(move || parse(&src))
        .expect("the thread should start")
        .join()
        .expect("the parser should not panic")
}

fn error_on_small_stack(src: &str) -> FormulaError {
    let mut errors = parse_on_small_stack(src).expect_err("the formula should not parse");
    assert_eq!(errors.len(), 1, "{errors:?}");
    errors.remove(0)
}

/// `depth` levels of nesting, each opened by `opener` after an operator of every precedence tier,
/// the most stack the parser can use per level.
fn tiered_nesting(opener: &str, depth: usize) -> String {
    let level = format!("a OR a AND a = a & a + a * {opener}");
    format!("{}1{}", level.repeat(depth), ")".repeat(depth))
}

/// `depth` levels of nesting made of `prefix` and `suffix`, with `core` in the middle.
fn nesting(prefix: &str, core: &str, suffix: &str, depth: usize) -> String {
    format!("{}{core}{}", prefix.repeat(depth), suffix.repeat(depth))
}

#[test]
fn deep_nesting_is_an_error_not_a_stack_overflow() {
    for (prefix, core, suffix) in [
        ("(", "1", ")"),
        ("f(", "1", ")"),
        ("a[SUM: ", "b", ""),
        ("IF a THEN 1 ELSE ", "2", ""),
        ("IF ", "a", " THEN 1 ELSE 2"),
        ("NOT ", "a", ""),
        ("-", "1", ""),
    ] {
        let src = nesting(prefix, core, suffix, 100_000);
        assert_eq!(error_on_small_stack(&src).message, TOO_COMPLEX, "{prefix}");
    }
    for opener in ["(", "f(", "a[SUM: "] {
        let src = tiered_nesting(opener, 100_000);
        assert_eq!(error_on_small_stack(&src).message, TOO_COMPLEX, "{opener}");
    }

    let long_chain = vec!["1"; 100_000].join(" + ");
    assert_eq!(error_on_small_stack(&long_chain).message, TOO_COMPLEX);

    let long_product = vec!["a"; 100_000].join(" * ");
    assert_eq!(error_on_small_stack(&long_product).message, TOO_COMPLEX);
}

#[test]
fn the_most_stack_hungry_shapes_fit_a_small_debug_stack_up_to_the_limit() {
    // The formula itself is the first level of nesting and every group, call, modifier or ELSE
    // branch is one more, so the limit of 64 levels is reached with 63 of them.
    for (prefix, core, suffix) in [
        ("a * (", "1", ")"),
        ("a * f(", "1", ")"),
        ("a * a[SUM: ", "b", "]"),
        ("IF a THEN 1 ELSE ", "2", ""),
        ("IF ", "a", " THEN 1 ELSE 2"),
    ] {
        let at_the_limit = nesting(prefix, core, suffix, 63);
        assert!(parse_on_small_stack(&at_the_limit).is_ok(), "{prefix}");

        let past_the_limit = nesting(prefix, core, suffix, 64);
        let message = error_on_small_stack(&past_the_limit).message;
        assert_eq!(message, TOO_COMPLEX, "{prefix}");
    }
}

#[test]
fn nesting_through_every_precedence_tier_is_safe_on_a_small_debug_stack() {
    // Each level is also seven nodes tall, so these formulas are rejected for their height
    // before the nesting limit; what matters is that parsing them neither aborts nor panics.
    for opener in ["(", "f("] {
        for depth in [32, 62, 63, 64, 65, 200] {
            let src = tiered_nesting(opener, depth);
            if let Err(errors) = parse_on_small_stack(&src) {
                assert_eq!(errors[0].message, TOO_COMPLEX, "{opener} {depth}");
            }
        }
        let past_the_limit = tiered_nesting(opener, 64);
        assert_eq!(error_on_small_stack(&past_the_limit).message, TOO_COMPLEX);
    }
}

#[test]
fn realistic_depth_still_parses() {
    let parens = format!("{}1{}", "(".repeat(50), ")".repeat(50));
    assert_eq!(tree(&parens), "1");

    let sum = vec!["x"; 200].join(" + ");
    assert!(parse(&sum).is_ok());

    let chain = format!("{}0", "IF a THEN 1 ELSE ".repeat(50));
    assert!(parse(&chain).is_ok());
}

#[test]
fn nesting_and_chain_limits() {
    let parens = format!("{}1{}", "(".repeat(100), ")".repeat(100));
    assert_eq!(error(&parens).message, TOO_COMPLEX);

    let sum = vec!["x"; 300].join(" + ");
    assert_eq!(error(&sum).message, TOO_COMPLEX);
}

/// Checks that every child span lies inside its parent's and that siblings keep source order.
fn assert_nested(expr: &Expr) {
    let parent = expr.span();
    assert!(parent.start < parent.end, "empty span {parent:?}");
    let mut cursor = parent.start;
    let mut child = |span: Span| {
        assert!(
            span.start < span.end,
            "empty child span {span:?} in {parent:?}"
        );
        assert!(
            cursor <= span.start && span.end <= parent.end,
            "child {span:?} is outside {parent:?} or overlaps the sibling ending at {cursor}"
        );
        cursor = span.end;
    };
    match expr {
        Expr::Number(..) | Expr::Text(..) | Expr::Bool(..) | Expr::Blank(..) => {}
        Expr::Ref { parts, .. } => parts.iter().for_each(|part| child(part.span)),
        Expr::Unary { expr, .. } => {
            child(expr.span());
            assert_nested(expr);
        }
        Expr::Binary { lhs, rhs, .. } => {
            for operand in [lhs, rhs] {
                child(operand.span());
                assert_nested(operand);
            }
        }
        Expr::If {
            cond, then, els, ..
        } => {
            for branch in [cond, then, els] {
                child(branch.span());
                assert_nested(branch);
            }
        }
        Expr::Call { name, args, .. } => {
            child(name.span);
            for arg in args {
                child(arg.span());
                assert_nested(arg);
            }
        }
        Expr::Modified {
            expr, modifiers, ..
        } => {
            child(expr.span());
            assert_nested(expr);
            for modifier in modifiers {
                child(modifier.span);
                let arg = modifier.arg.span();
                assert!(
                    modifier.span.start < arg.start && arg.end <= modifier.span.end,
                    "argument {arg:?} is outside its modifier {:?}",
                    modifier.span
                );
                assert_nested(&modifier.arg);
            }
        }
    }
}

#[test]
fn spans_nest_in_parents_and_siblings_are_ordered() {
    for src in [
        "1 + 2 * 3 = 7",
        "(a + b) * -c",
        "((a))",
        "  NOT a OR b  ",
        "\"t\" & Gross Margin & 'P&L'.'Net Income'",
        "ROUND(x, 2, UP) + MAX(a, MIN(b, c))",
        "IF a > 1 AND NOT b THEN f(x, Time.'Jan 26') ELSE -y",
        "x[SUM: m, SELECT: Versions.Actual][LOOKUP: IF a THEN n ELSE (o)]",
        "START()",
    ] {
        assert_nested(&parsed(src));
    }
}

fn check_invariants(src: &str) {
    let in_bounds = |start: usize, end: usize| {
        start <= end && end <= src.len() && src.is_char_boundary(start) && src.is_char_boundary(end)
    };
    match parse(src) {
        Ok(expr) => {
            let s = expr.span();
            assert!(in_bounds(s.start, s.end), "{src:?}: {s:?}");
            assert_nested(&expr);
        }
        Err(errors) => {
            assert!(!errors.is_empty(), "{src:?}");
            for e in errors {
                assert_eq!(e.code, "formula.syntax", "{src:?}");
                assert!(in_bounds(e.start, e.end), "{src:?}: {e:?}");
                assert!(e.message.ends_with('.'), "{src:?}: {}", e.message);
            }
        }
    }
}

fn formula_like() -> impl Strategy<Value = String> {
    let fragments = prop::sample::select(vec![
        "IF",
        "THEN",
        "ELSE",
        "AND",
        "OR",
        "NOT",
        "TRUE",
        "FALSE",
        "BLANK",
        "SUM",
        "LOOKUP",
        ":",
        "(",
        ")",
        "[",
        "]",
        ",",
        ".",
        "'",
        "\"",
        "//",
        "+",
        "-",
        "*",
        "/",
        "&",
        "=",
        "<>",
        "<=",
        ">",
        "%",
        "#",
        "?",
        "_",
        "1",
        "2.5",
        "1e",
        "1e-",
        "Revenue",
        "Gross Margin",
        "Umsätze",
        "Umsa\u{308}tze",
        "\u{200b}",
        "日本",
        "$",
        "^",
        " ",
        "\n",
        "\t",
    ]);
    prop::collection::vec(fragments, 0..30).prop_map(|parts| parts.concat())
}

proptest! {
    #![proptest_config(ProptestConfig::with_cases(512))]

    #[test]
    fn parse_never_panics_on_arbitrary_text(src in any::<String>()) {
        check_invariants(&src);
    }

    #[test]
    fn parse_never_panics_on_formula_like_text(src in formula_like()) {
        check_invariants(&src);
    }
}
