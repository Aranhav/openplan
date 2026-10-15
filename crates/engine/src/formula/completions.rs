//! What the formula editor offers while a formula is typed (spec §4): the line items, lists,
//! functions and keywords whose names start with what has been typed so far.

use crate::ids::LineItemId;
use crate::structure::{LineItem, Structure, fold};

use super::functions;
use super::resolve::display_name;

/// Words of the formula language that are neither functions nor names: the keywords of the
/// syntax and the kinds of modifier. `MIN` and `MAX`, which are modifier kinds too, are offered
/// as the functions they are.
const KEYWORDS: &[(&str, &str)] = &[
    ("IF", "IF condition THEN value ELSE other value"),
    ("THEN", "Follows the condition of IF."),
    ("ELSE", "Follows the value of THEN in IF."),
    ("AND", "TRUE when both sides are TRUE."),
    ("OR", "TRUE when either side is TRUE."),
    ("NOT", "Turns TRUE into FALSE and FALSE into TRUE."),
    ("TRUE", "The boolean TRUE."),
    ("FALSE", "The boolean FALSE."),
    ("BLANK", "A blank list item, text or date."),
    (
        "SUM",
        "Modifier: adds up the source cells that a line item maps to each item, as in Source[SUM: Source.Map].",
    ),
    (
        "LOOKUP",
        "Modifier: gathers the source cell that a line item points to, as in Source[LOOKUP: Target.Map].",
    ),
    (
        "SELECT",
        "Modifier: fixes a dimension of the source to one item, as in Source[SELECT: List.Item].",
    ),
    (
        "AVERAGE",
        "Modifier: like SUM, but averages the mapped source cells.",
    ),
    (
        "ANY",
        "Modifier: like SUM, but TRUE when any mapped source cell is TRUE.",
    ),
    (
        "ALL",
        "Modifier: like SUM, but TRUE when every mapped source cell is TRUE.",
    ),
    (
        "FIRSTNONBLANK",
        "Modifier: like SUM, but takes the first mapped source cell that is not blank.",
    ),
    (
        "LASTNONBLANK",
        "Modifier: like SUM, but takes the last mapped source cell that is not blank.",
    ),
    (
        "TEXTLIST",
        "Modifier: like SUM, but joins the mapped source cells as a list of text.",
    ),
];

/// The dimensions a formula can name besides its lists.
const DIMENSIONS: &[(&str, &str)] = &[
    ("Versions", "The versions of the model"),
    ("Time", "The time periods of the model"),
];

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CompletionKind {
    LineItem,
    List,
    Function,
    Keyword,
}

/// Something the editor can offer at the cursor.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Completion {
    /// What to insert: a name as it is written in a formula, quoted when it needs to be.
    pub label: String,
    pub kind: CompletionKind,
    /// A line of help: the type of a line item, the documentation of a function.
    pub detail: String,
}

/// What may be typed after `prefix` in the formula of the line item `li`, ignoring case.
///
/// The line items of the module of `li` come first, in the order of the module, then those of
/// the other modules by module and order, written as `Module.Line item`, then lists, functions
/// and keywords by name. A line item of another module also matches the start of its own name.
/// A quote at the start of the prefix is ignored, since the label of a name that needs quotes
/// starts with one. Nothing is offered for a line item that does not exist.
pub(crate) fn completions(structure: &Structure, li: LineItemId, prefix: &str) -> Vec<Completion> {
    let Some(target) = structure.line_item(li) else {
        return Vec::new();
    };
    let wanted = fold(prefix.trim().trim_start_matches('\''));
    let starts = |text: &str| fold(text).starts_with(&wanted);

    let mut found = Vec::new();
    for (line_item, module) in ordered_line_items(structure, target) {
        let ty = structure.type_name(line_item.format.value_type());
        match module {
            None if starts(&line_item.name) => found.push(Completion {
                label: display_name(&line_item.name),
                kind: CompletionKind::LineItem,
                detail: ty,
            }),
            Some(module)
                if starts(&format!("{}.{}", module, line_item.name)) || starts(&line_item.name) =>
            {
                found.push(Completion {
                    label: format!("{}.{}", display_name(module), display_name(&line_item.name)),
                    kind: CompletionKind::LineItem,
                    detail: format!("{ty} in {module}"),
                });
            }
            _ => {}
        }
    }

    let mut lists: Vec<(&str, &str)> = structure
        .lists()
        .map(|list| (list.name.as_str(), "List"))
        .chain(DIMENSIONS.iter().copied())
        .filter(|(name, _)| starts(name))
        .collect();
    lists.sort_by_cached_key(|(name, _)| fold(name));
    found.extend(lists.into_iter().map(|(name, detail)| Completion {
        label: display_name(name),
        kind: CompletionKind::List,
        detail: detail.to_string(),
    }));

    let mut defs: Vec<_> = functions::all()
        .iter()
        .filter(|def| starts(def.name))
        .collect();
    defs.sort_by_key(|def| def.name);
    found.extend(defs.into_iter().map(|def| Completion {
        label: def.name.to_string(),
        kind: CompletionKind::Function,
        detail: def.doc.to_string(),
    }));

    let mut keywords: Vec<_> = KEYWORDS.iter().filter(|(word, _)| starts(word)).collect();
    keywords.sort_by_key(|(word, _)| *word);
    found.extend(keywords.into_iter().map(|(word, detail)| Completion {
        label: (*word).to_string(),
        kind: CompletionKind::Keyword,
        detail: (*detail).to_string(),
    }));
    found
}

/// Every line item of the model with the name of its module when that is not the module of
/// `target`: first the line items of that module, then the others, each group by module name
/// and order within the module.
fn ordered_line_items<'a>(
    structure: &'a Structure,
    target: &LineItem,
) -> Vec<(&'a LineItem, Option<&'a str>)> {
    let mut rows: Vec<(&LineItem, &str)> = structure
        .line_items()
        .map(|line_item| {
            let module = structure
                .module(line_item.module)
                .map_or("", |module| module.name.as_str());
            (line_item, module)
        })
        .collect();
    rows.sort_by_cached_key(|(line_item, module)| {
        (
            line_item.module != target.module,
            fold(module),
            line_item.ordinal,
            fold(&line_item.name),
            line_item.id,
        )
    });
    rows.into_iter()
        .map(|(line_item, module)| {
            (
                line_item,
                (line_item.module != target.module).then_some(module),
            )
        })
        .collect()
}
