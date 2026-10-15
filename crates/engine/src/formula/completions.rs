//! What the formula editor offers while a formula is typed (spec §4): the line items, lists,
//! functions and keywords whose names start with what has been typed so far, and after a dot the
//! members of what the name before it names: the line items of a module, the items of a list,
//! the versions and the periods of the calendar.

use crate::calendar::TimeLevel;
use crate::ids::LineItemId;
use crate::structure::{LineItem, Structure, fold, same_name};

use super::functions;
use super::resolve::display_name;

/// Words of the formula language that are neither functions nor names: the keywords of the
/// syntax, the kinds of modifier and the keywords that stand for a choice in the arguments of
/// a function. `MIN` and `MAX`, which are modifier kinds too, are offered as the functions they
/// are.
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
    ("UP", ROUND_MODE),
    ("DOWN", ROUND_MODE),
    ("NEAREST", ROUND_MODE),
    ("ASCENDING", RANK_ORDER),
    ("DESCENDING", RANK_ORDER),
];

const ROUND_MODE: &str = "ROUND mode";
const RANK_ORDER: &str = "RANK order";

/// The dimensions a formula can name besides its lists.
const DIMENSIONS: &[(&str, &str)] = &[
    ("Versions", "The versions of the model"),
    ("Time", "The time periods of the model"),
];

/// The levels of time, finest first.
const LEVELS: [TimeLevel; 5] = [
    TimeLevel::Month,
    TimeLevel::Quarter,
    TimeLevel::HalfYear,
    TimeLevel::Year,
    TimeLevel::All,
];

/// What kind of thing a completion is.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CompletionKind {
    LineItem,
    List,
    Function,
    Keyword,
    /// An item of a list, offered after the name of the list.
    Item,
    /// A version, offered after `Versions`.
    Version,
    /// A period of the calendar at any level, offered after `Time`.
    Period,
}

/// The most completions offered at once.
pub const MAX_COMPLETIONS: usize = 50;

/// Something the editor can offer at the cursor.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Completion {
    /// What to insert in place of what was typed: a name as it is written in a formula, quoted
    /// when it needs to be, and qualified by what it belongs to after a dot.
    pub label: String,
    pub kind: CompletionKind,
    /// A line of help: the type of a line item, the documentation of a function.
    pub detail: String,
}

/// The completions found so far, which stop at [`MAX_COMPLETIONS`].
#[derive(Default)]
struct Found(Vec<Completion>);

impl Found {
    fn full(&self) -> bool {
        self.0.len() >= MAX_COMPLETIONS
    }

    fn push(&mut self, label: String, kind: CompletionKind, detail: String) {
        if !self.full() {
            self.0.push(Completion {
                label,
                kind,
                detail,
            });
        }
    }
}

/// What may be typed after `prefix`, the name being typed, in the formula of the line item
/// `li`, ignoring case. At most [`MAX_COMPLETIONS`] are offered.
///
/// A prefix without a dot is the start of a name. The line items of the module of `li` come
/// first, in the order of the module, then those of the other modules by module and order,
/// written as `Module.Line item`, then lists, functions and keywords by name. A line item of
/// another module also matches the start of its own name. A quote at the start of the prefix
/// is ignored, since the label of a name that needs quotes starts with one.
///
/// A prefix with a dot, such as `Plan.Un`, `'Profit & Loss'.` or `Countries.Fr`, is a name
/// followed by the start of one of its members: the line items of the module of that name, in
/// the order of the module; the items of the list, in the order of the list; the versions after
/// `Versions`; the periods of the calendar after `Time`, at every level from the finest. The
/// labels are the whole qualified name.
///
/// Nothing is offered for a line item that does not exist.
pub(crate) fn completions(structure: &Structure, li: LineItemId, prefix: &str) -> Vec<Completion> {
    let Some(target) = structure.line_item(li) else {
        return Vec::new();
    };
    let prefix = prefix.trim();
    let mut found = Found::default();
    match split_qualified(prefix) {
        Some((qualifier, member)) => members(structure, target, &qualifier, member, &mut found),
        None => names(structure, target, prefix, &mut found),
    }
    found.0
}

/// Whether `text`, ignoring case, starts with `wanted`, which is in lower case.
fn starts(text: &str, wanted: &str) -> bool {
    let mut letters = text.chars().flat_map(char::to_lowercase);
    wanted.chars().all(|letter| letters.next() == Some(letter))
}

/// The part of the prefix before its last dot that is not inside quotes, unquoted, and the part
/// after it.
fn split_qualified(prefix: &str) -> Option<(String, &str)> {
    let (mut quoted, mut dot) = (false, None);
    let mut chars = prefix.char_indices().peekable();
    while let Some((at, c)) = chars.next() {
        match c {
            '\'' if quoted && chars.next_if(|(_, next)| *next == '\'').is_some() => {}
            '\'' => quoted = !quoted,
            '.' if !quoted => dot = Some(at),
            _ => {}
        }
    }
    let dot = dot?;
    let qualifier = prefix[..dot].trim();
    let qualifier = match qualifier
        .strip_prefix('\'')
        .and_then(|rest| rest.strip_suffix('\''))
    {
        Some(inner) => inner.replace("\'\'", "\'"),
        None => qualifier.to_string(),
    };
    Some((qualifier, &prefix[dot + 1..]))
}

/// The completions of a prefix that is the start of a name.
fn names(structure: &Structure, target: &LineItem, prefix: &str, found: &mut Found) {
    let wanted = fold(prefix.trim_start_matches('\''));

    let mut matched: Vec<(&LineItem, &str)> = structure
        .line_items()
        .filter_map(|line_item| {
            let module = structure
                .module(line_item.module)
                .map_or("", |module| module.name.as_str());
            let own = line_item.module == target.module;
            let matches = starts(&line_item.name, &wanted)
                || (!own && starts(&format!("{module}.{}", line_item.name), &wanted));
            matches.then_some((line_item, module))
        })
        .collect();
    matched.sort_by_cached_key(|(line_item, module)| {
        (
            line_item.module != target.module,
            fold(module),
            line_item.ordinal,
            fold(&line_item.name),
            line_item.id,
        )
    });
    for (line_item, module) in matched {
        let ty = structure.type_name(line_item.format.value_type());
        if line_item.module == target.module {
            found.push(display_name(&line_item.name), CompletionKind::LineItem, ty);
        } else {
            found.push(
                format!("{}.{}", display_name(module), display_name(&line_item.name)),
                CompletionKind::LineItem,
                format!("{ty} in {module}"),
            );
        }
    }

    let mut lists: Vec<(&str, &str)> = structure
        .lists()
        .map(|list| (list.name.as_str(), "List"))
        .chain(DIMENSIONS.iter().copied())
        .filter(|(name, _)| starts(name, &wanted))
        .collect();
    lists.sort_by_cached_key(|(name, _)| fold(name));
    for (name, detail) in lists {
        found.push(display_name(name), CompletionKind::List, detail.to_string());
    }

    let mut defs: Vec<_> = functions::all()
        .iter()
        .filter(|def| starts(def.name, &wanted))
        .collect();
    defs.sort_by_key(|def| def.name);
    for def in defs {
        found.push(
            def.name.to_string(),
            CompletionKind::Function,
            def.doc.to_string(),
        );
    }

    let mut keywords: Vec<_> = KEYWORDS
        .iter()
        .filter(|(word, _)| starts(word, &wanted))
        .collect();
    keywords.sort_by_key(|(word, _)| *word);
    for (word, detail) in keywords {
        found.push(
            (*word).to_string(),
            CompletionKind::Keyword,
            (*detail).to_string(),
        );
    }
}

/// The completions of a prefix that is `qualifier.member`. The qualifier can name a module, a
/// list, `Versions` and `Time`, since their names are not kept apart.
fn members(
    structure: &Structure,
    target: &LineItem,
    qualifier: &str,
    member: &str,
    found: &mut Found,
) {
    let wanted = fold(member.trim_start_matches('\''));

    if let Some(module) = structure.module_by_name(qualifier) {
        let mut line_items: Vec<&LineItem> = structure
            .line_items_in(module.id)
            .filter(|line_item| starts(&line_item.name, &wanted))
            .collect();
        line_items.sort_by_cached_key(|line_item| {
            (line_item.ordinal, fold(&line_item.name), line_item.id)
        });
        for line_item in line_items {
            let ty = structure.type_name(line_item.format.value_type());
            found.push(
                format!(
                    "{}.{}",
                    display_name(&module.name),
                    display_name(&line_item.name)
                ),
                CompletionKind::LineItem,
                if module.id == target.module {
                    ty
                } else {
                    format!("{ty} in {}", module.name)
                },
            );
        }
    }

    if let Some(list) = structure.list_by_name(qualifier) {
        for (_, item) in list.items().filter(|(_, item)| starts(&item.name, &wanted)) {
            found.push(
                format!("{}.{}", display_name(&list.name), display_name(&item.name)),
                CompletionKind::Item,
                format!("Item of {}", list.name),
            );
        }
    }

    if same_name(qualifier, "Versions") {
        for version in structure
            .versions()
            .iter()
            .filter(|version| starts(&version.name, &wanted))
        {
            found.push(
                format!("Versions.{}", display_name(&version.name)),
                CompletionKind::Version,
                "Version".to_string(),
            );
        }
    }

    if same_name(qualifier, "Time") {
        let calendar = &structure.calendar;
        for level in LEVELS {
            for period in 0..calendar.periods(level) {
                let label = calendar.label(level, period);
                if starts(&label, &wanted) {
                    // Periods with a space are written in quotes, as `Time.'Jan 26'` is in the spec.
                    let written = if label.contains(' ') {
                        format!("'{}'", label.replace('\'', "''"))
                    } else {
                        display_name(&label)
                    };
                    found.push(
                        format!("Time.{written}"),
                        CompletionKind::Period,
                        "Period".to_string(),
                    );
                }
            }
        }
    }
}
