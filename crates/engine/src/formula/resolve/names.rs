//! Looking up what a reference in a formula names (spec §4.1): a line item, a list item or
//! property, a version or a time period, and explaining a name that names nothing.

use crate::calendar::TimeLevel;
use crate::error::FormulaError;
use crate::formula::{Expr, Name, SYNTAX, Span, parse};
use crate::ids::{ItemId, ListId, ModuleId};
use crate::structure::{LineItem, List, Module, Structure, Version, fold, same_name};

use super::formula_error;

const UNKNOWN_NAME: &str = "formula.unknown_name";
const AMBIGUOUS_NAME: &str = "formula.ambiguous_name";

/// The most edits between a misspelt name and the name suggested for it.
const MAX_EDITS: usize = 2;

/// What a reference names.
pub(super) enum Referent<'a> {
    LineItem(&'a LineItem),
    ListItem { list: ListId, item: ItemId },
    Period { level: TimeLevel, index: u32 },
    Version(&'a Version),
    List(&'a List),
}

/// Finds the things references name, as seen from a formula in one module.
pub(super) struct Names<'a> {
    structure: &'a Structure,
    module: ModuleId,
}

/// A name offered instead of one that was not found: how it reads in a message and how it is
/// written in a formula.
struct Form {
    shown: String,
    replacement: String,
}

impl Form {
    fn of_name(name: &str) -> Form {
        Form {
            shown: name.to_string(),
            replacement: display_name(name),
        }
    }
}

/// What the first part of `A.B` names: any of a module, a list, the versions and the time
/// dimension, because their names are not kept apart.
struct Places<'a> {
    module: Option<&'a Module>,
    list: Option<&'a List>,
    versions: bool,
    time: bool,
}

impl<'a> Places<'a> {
    fn of(structure: &'a Structure, name: &Name) -> Places<'a> {
        let text = name.text.trim();
        Places {
            module: structure.module_by_name(text),
            list: structure.list_by_name(text),
            versions: same_name(text, "Versions"),
            time: same_name(text, "Time"),
        }
    }

    fn is_empty(&self) -> bool {
        self.module.is_none() && self.list.is_none() && !self.versions && !self.time
    }
}

impl<'a> Names<'a> {
    pub(super) fn new(structure: &'a Structure, module: ModuleId) -> Names<'a> {
        Names { structure, module }
    }

    /// What `A` or `A.B` names. A name that names nothing, or too much, is explained by the
    /// error, which sits on the text to replace with its suggestion.
    pub(super) fn lookup(&self, parts: &[Name]) -> Result<Referent<'a>, FormulaError> {
        match parts {
            [name] => self.unqualified(name),
            [first, second] => self.qualified(first, second),
            _ => {
                let span = match (parts.first(), parts.last()) {
                    (Some(first), Some(last)) => Span {
                        start: first.span.start,
                        end: last.span.end,
                    },
                    _ => Span { start: 0, end: 0 },
                };
                Err(formula_error(
                    SYNTAX,
                    span,
                    "A reference is a name, or two names joined by '.'.",
                    None,
                ))
            }
        }
    }

    /// The error for a list name that is not a list.
    pub(super) fn unknown_list(&self, name: &Name) -> FormulaError {
        let found = closest(
            &name.text,
            self.structure
                .lists()
                .map(|list| (list.name.as_str(), list.name.as_str())),
        );
        let message = format!("Unknown list '{}'.", name.text);
        unknown(name.span, message, found.map(Form::of_name))
    }

    /// A line item of the formula's own module, else the only one of that name in the model,
    /// else a list.
    fn unqualified(&self, name: &Name) -> Result<Referent<'a>, FormulaError> {
        let structure = self.structure;
        if let Some(line_item) = structure.line_item_by_name(Some(self.module), &name.text) {
            return Ok(Referent::LineItem(line_item));
        }
        let mut matches: Vec<&LineItem> = structure
            .line_items()
            .filter(|line_item| same_name(&line_item.name, name.text.trim()))
            .collect();
        match matches.len() {
            0 => {}
            1 => return Ok(Referent::LineItem(matches[0])),
            _ => {
                matches.sort_by_cached_key(|line_item| self.module_name_folded(line_item));
                return Err(self.ambiguous(name, &matches));
            }
        }
        match structure.list_by_name(&name.text) {
            Some(list) => Ok(Referent::List(list)),
            None => Err(self.unknown(name)),
        }
    }

    /// `Module.Line item`, `List.Item`, `List.Property`, `Versions.Version` or `Time.Period`,
    /// in this order.
    fn qualified(&self, first: &Name, second: &Name) -> Result<Referent<'a>, FormulaError> {
        let structure = self.structure;
        let places = Places::of(structure, first);
        if let Some(module) = places.module
            && let Some(line_item) = structure.line_item_by_name(Some(module.id), &second.text)
        {
            return Ok(Referent::LineItem(line_item));
        }
        if let Some(list) = places.list {
            if let Some(idx) = list.find(&second.text) {
                return Ok(Referent::ListItem {
                    list: list.id,
                    item: list.item(idx).id,
                });
            }
            if let Some(properties) = structure.properties_module(list.id)
                && let Some(property) =
                    structure.line_item_by_name(Some(properties.id), &second.text)
            {
                return Ok(Referent::LineItem(property));
            }
        }
        if places.versions
            && let Some(version) = structure.version_by_name(&second.text)
        {
            return Ok(Referent::Version(version));
        }
        if places.time
            && let Some((level, index)) = structure.calendar.parse_label(&second.text)
        {
            return Ok(Referent::Period { level, index });
        }
        Err(self.unknown_qualified(first, second, &places))
    }

    fn module_name_folded(&self, line_item: &LineItem) -> String {
        self.structure
            .module(line_item.module)
            .map_or_else(String::new, |module| fold(&module.name))
    }

    /// `Module.Line item` as it is written in a formula.
    fn qualified_form(&self, line_item: &LineItem) -> Form {
        let module = self
            .structure
            .module(line_item.module)
            .map_or("?", |module| module.name.as_str());
        Form {
            shown: format!("{module}.{}", line_item.name),
            replacement: format!("{}.{}", display_name(module), display_name(&line_item.name)),
        }
    }

    /// The shortest way to write `line_item` that finds it: its name alone when that does.
    fn shortest_form(&self, line_item: &LineItem) -> Form {
        let structure = self.structure;
        let own = structure.line_item_by_name(Some(self.module), &line_item.name);
        let reached = own.is_some_and(|found| found.id == line_item.id)
            || structure
                .line_items()
                .filter(|other| same_name(&other.name, &line_item.name))
                .count()
                == 1;
        if reached {
            Form::of_name(&line_item.name)
        } else {
            self.qualified_form(line_item)
        }
    }

    fn ambiguous(&self, name: &Name, matches: &[&LineItem]) -> FormulaError {
        let forms: Vec<Form> = matches
            .iter()
            .map(|line_item| self.qualified_form(line_item))
            .collect();
        let written: Vec<&str> = forms.iter().map(|form| form.replacement.as_str()).collect();
        let message = format!(
            "'{}' is the name of line items in several modules. Use {} to say which one.",
            name.text,
            written.join(" or ")
        );
        formula_error(
            AMBIGUOUS_NAME,
            name.span,
            message,
            forms.first().map(|form| form.replacement.clone()),
        )
    }

    /// An unqualified name that is no line item and no list: the closest line item or list name
    /// is suggested, line items of the formula's own module first.
    fn unknown(&self, name: &Name) -> FormulaError {
        enum Candidate<'c> {
            LineItem(&'c LineItem),
            List(&'c str),
        }
        let structure = self.structure;
        let own = structure.line_items_in(self.module);
        let others = structure
            .line_items()
            .filter(|line_item| line_item.module != self.module);
        let line_items = own
            .chain(others)
            .map(|line_item| (line_item.name.as_str(), Candidate::LineItem(line_item)));
        let lists = structure
            .lists()
            .map(|list| (list.name.as_str(), Candidate::List(list.name.as_str())));
        let found = closest(&name.text, line_items.chain(lists)).map(|candidate| match candidate {
            Candidate::LineItem(line_item) => self.shortest_form(line_item),
            Candidate::List(list) => Form::of_name(list),
        });
        unknown(name.span, format!("Unknown name '{}'.", name.text), found)
    }

    /// `A.B` where nothing of that name was found: either `A` names nothing, or `B` is not in
    /// what `A` names.
    fn unknown_qualified(&self, first: &Name, second: &Name, places: &Places) -> FormulaError {
        let structure = self.structure;
        if places.is_empty() {
            let known = structure
                .modules()
                .map(|module| module.name.as_str())
                .chain(structure.lists().map(|list| list.name.as_str()))
                .chain(["Versions", "Time"]);
            let found = closest(&first.text, known.map(|name| (name, name)));
            let message = format!("Unknown name '{}'.", first.text);
            return unknown(first.span, message, found.map(Form::of_name));
        }

        let mut inside: Vec<&str> = Vec::new();
        if let Some(module) = places.module {
            inside.extend(
                structure
                    .line_items_in(module.id)
                    .map(|line_item| line_item.name.as_str()),
            );
        }
        if let Some(list) = places.list {
            inside.extend(list.items().map(|(_, item)| item.name.as_str()));
            if let Some(properties) = structure.properties_module(list.id) {
                inside.extend(
                    structure
                        .line_items_in(properties.id)
                        .map(|line_item| line_item.name.as_str()),
                );
            }
        }
        if places.versions {
            inside.extend(
                structure
                    .versions()
                    .iter()
                    .map(|version| version.name.as_str()),
            );
        }
        let message = match (places.module, places.list) {
            (Some(_), Some(_)) => format!(
                "'{}' has no line item, item or property named '{}'.",
                first.text, second.text
            ),
            (Some(module), None) => format!(
                "The module '{}' has no line item named '{}'.",
                module.name, second.text
            ),
            (None, Some(list)) => format!(
                "The list '{}' has no item or property named '{}'.",
                list.name, second.text
            ),
            (None, None) if places.versions => {
                format!("There is no version named '{}'.", second.text)
            }
            (None, None) => format!("'{}' is not a period of the model calendar.", second.text),
        };
        let found = closest(&second.text, inside.into_iter().map(|name| (name, name)));
        unknown(second.span, message, found.map(Form::of_name))
    }
}

/// An unknown-name error that suggests `found` in place of the text at `span`.
fn unknown(span: Span, message: String, found: Option<Form>) -> FormulaError {
    match found {
        Some(form) => formula_error(
            UNKNOWN_NAME,
            span,
            format!("{message}{}", did_you_mean(&form.shown)),
            Some(form.replacement),
        ),
        None => formula_error(UNKNOWN_NAME, span, message, None),
    }
}

/// The end of a message that offers `shown` in place of what was written.
pub(super) fn did_you_mean(shown: &str) -> String {
    format!(" Did you mean '{shown}'?")
}

/// The value of the candidate whose name is closest to `name`, ignoring case, when it is at
/// most two edits away. The first of equally close candidates wins.
pub(super) fn closest<'c, T>(
    name: &str,
    candidates: impl IntoIterator<Item = (&'c str, T)>,
) -> Option<T> {
    let wanted: Vec<char> = fold(name).chars().collect();
    candidates
        .into_iter()
        .filter_map(|(candidate, value)| {
            let candidate: Vec<char> = fold(candidate).chars().collect();
            let edits = edit_distance(&wanted, &candidate);
            (edits <= MAX_EDITS).then_some((edits, value))
        })
        .min_by_key(|(edits, _)| *edits)
        .map(|(_, value)| value)
}

/// The Levenshtein distance between two names; anything over `MAX_EDITS` may be reported as
/// `MAX_EDITS + 1`.
fn edit_distance(a: &[char], b: &[char]) -> usize {
    if a.len().abs_diff(b.len()) > MAX_EDITS {
        return MAX_EDITS + 1;
    }
    let mut previous: Vec<usize> = (0..=b.len()).collect();
    for (i, &left) in a.iter().enumerate() {
        let mut current = vec![i + 1];
        for (j, &right) in b.iter().enumerate() {
            let substitution = previous[j] + usize::from(left != right);
            current.push(substitution.min(previous[j + 1] + 1).min(current[j] + 1));
        }
        previous = current;
    }
    previous[b.len()]
}

/// `name` as it is written in a formula: as it is when that reads back as the same single
/// name, else in quotes.
pub(super) fn display_name(name: &str) -> String {
    let reads_back = matches!(
        parse(name),
        Ok(Expr::Ref { parts, .. })
            if matches!(parts.as_slice(), [part] if !part.quoted && part.text == name)
    );
    if reads_back {
        name.to_string()
    } else {
        format!("'{}'", name.replace('\'', "''"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn distance(a: &str, b: &str) -> usize {
        let a: Vec<char> = a.chars().collect();
        let b: Vec<char> = b.chars().collect();
        edit_distance(&a, &b)
    }

    #[test]
    fn edit_distances() {
        assert_eq!(distance("", ""), 0);
        assert_eq!(distance("abc", "abc"), 0);
        assert_eq!(distance("revnue", "revenue"), 1);
        assert_eq!(distance("revenue", "revnue"), 1);
        assert_eq!(distance("abc", "abd"), 1);
        assert_eq!(distance("ab", "ba"), 2);
        assert_eq!(distance("kitten", "sitting"), MAX_EDITS + 1);
        assert_eq!(distance("flaw", "lawn"), 2);
        assert_eq!(distance("a", "abcd"), MAX_EDITS + 1);
    }

    #[test]
    fn closest_ignores_case_and_prefers_the_first_of_equals() {
        let candidates = [("Revenue", 1), ("Revenge", 2), ("Cost", 3)];
        assert_eq!(closest("REVNUE", candidates), Some(1));
        assert_eq!(closest("Revengu", candidates), Some(2));
        assert_eq!(closest("Revenuf", candidates), Some(1));
        assert_eq!(closest("Margin", candidates), None);
        assert_eq!(closest("Cost", [("Cast", 1), ("Cost", 2)]), Some(2));
    }

    #[test]
    fn names_are_quoted_when_they_would_not_read_back() {
        assert_eq!(display_name("Revenue"), "Revenue");
        assert_eq!(display_name("Gross Margin"), "Gross Margin");
        assert_eq!(display_name("Jan 26"), "Jan 26");
        assert_eq!(display_name("Profit & Loss"), "'Profit & Loss'");
        assert_eq!(display_name("2024"), "'2024'");
        assert_eq!(display_name("A.B"), "'A.B'");
        assert_eq!(display_name("It's"), "'It''s'");
        assert_eq!(display_name("IF"), "'IF'");
        assert_eq!(display_name("True"), "'True'");
        assert_eq!(display_name("Two  spaces"), "'Two  spaces'");
        assert_eq!(display_name("Cost (net)"), "'Cost (net)'");
    }
}
