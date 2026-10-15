//! The rules that calls are checked against: what each argument position accepts and what a
//! call returns. The table in the parent module says which function has which rules.

use crate::calendar::TimeLevel;
use crate::ids::ListId;
use crate::structure::Structure;
use crate::value::ValueType;

use super::FuncId;

/// A keyword that stands for a choice in the arguments of a function, as `UP` does in
/// `ROUND(x, 2, UP)`. Keywords are only valid where the function table expects one.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum Word {
    Up,
    Down,
    Nearest,
    Ascending,
    Descending,
}

impl Word {
    /// The keyword as it is written in a formula.
    pub fn text(self) -> &'static str {
        match self {
            Word::Up => "UP",
            Word::Down => "DOWN",
            Word::Nearest => "NEAREST",
            Word::Ascending => "ASCENDING",
            Word::Descending => "DESCENDING",
        }
    }
}

/// What an argument of a call turned out to be, which is all `check` looks at.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ArgType {
    /// An expression with a value of this type.
    Value(ValueType),
    /// The name of a list, or `Versions`, for functions that work on a whole dimension.
    List(ListId),
    /// `Time`, at the level of the line item the formula is for.
    Time(TimeLevel),
    /// A keyword such as `UP`.
    Word(Word),
}

/// One problem `check` found in a call. `arg` is the position of the offending argument, or
/// `None` when the problem is the call as a whole.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CheckError {
    pub arg: Option<usize>,
    pub message: String,
}

/// What one argument position of a function accepts.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Param {
    Number,
    Text,
    Date,
    /// A value of any type.
    Any,
    /// An item of any list.
    Item,
    /// A time period of any level.
    Period,
    /// A value that can be turned into text: a number, a date or a list item.
    Printable,
    /// The name of a list.
    List,
    /// The name of a list, or `Versions` or `Time`.
    Dimension,
    /// `UP`, `DOWN` or `NEAREST`.
    RoundMode,
    /// `ASCENDING` or `DESCENDING`.
    RankOrder,
    /// A value of the same type as the first argument.
    SameAsFirst,
}

impl Param {
    /// The keywords this position accepts; empty when it takes none.
    pub fn keywords(self) -> &'static [Word] {
        match self {
            Param::RoundMode => &[Word::Up, Word::Down, Word::Nearest],
            Param::RankOrder => &[Word::Ascending, Word::Descending],
            _ => &[],
        }
    }

    /// The type a value in this position must have, when it does not depend on other
    /// arguments. A `BLANK` there takes this type.
    pub fn fixed_type(self) -> Option<ValueType> {
        match self {
            Param::Number => Some(ValueType::Number),
            Param::Text => Some(ValueType::Text),
            Param::Date => Some(ValueType::Date),
            _ => None,
        }
    }

    /// Whether a value here must have the type of the first argument.
    pub fn is_same_as_first(self) -> bool {
        self == Param::SameAsFirst
    }

    fn accepts(self, arg: ArgType, args: &[ArgType]) -> bool {
        match (self, arg) {
            (Param::Number, ArgType::Value(ValueType::Number))
            | (Param::Text, ArgType::Value(ValueType::Text))
            | (Param::Date, ArgType::Value(ValueType::Date))
            | (Param::Any, ArgType::Value(_))
            | (Param::Item, ArgType::Value(ValueType::Item(_)))
            | (Param::Period, ArgType::Value(ValueType::Period(_)))
            | (
                Param::Printable,
                ArgType::Value(ValueType::Number | ValueType::Date | ValueType::Item(_)),
            )
            | (Param::List, ArgType::List(_))
            | (Param::Dimension, ArgType::List(_) | ArgType::Time(_)) => true,
            (Param::RoundMode | Param::RankOrder, ArgType::Word(word)) => {
                self.keywords().contains(&word)
            }
            (Param::SameAsFirst, ArgType::Value(_)) => args.first() == Some(&arg),
            _ => false,
        }
    }

    fn expectation(self, structure: &Structure, args: &[ArgType]) -> String {
        match self {
            Param::Number => "a Number".to_string(),
            Param::Text => "Text".to_string(),
            Param::Date => "a Date".to_string(),
            Param::Any => "a value".to_string(),
            Param::Item => "a list item".to_string(),
            Param::Period => "a time period".to_string(),
            Param::Printable => "a Number, Date or list item".to_string(),
            Param::List => "the name of a list".to_string(),
            Param::Dimension => "the name of a list, Versions or Time".to_string(),
            Param::RoundMode | Param::RankOrder => keyword_choice(self.keywords()),
            Param::SameAsFirst => {
                let first = args
                    .first()
                    .map_or_else(String::new, |arg| describe(structure, *arg));
                format!("the same type as argument 1 ({first})")
            }
        }
    }
}

/// `UP, DOWN or NEAREST`
pub fn keyword_choice(words: &[Word]) -> String {
    let texts: Vec<&str> = words.iter().map(|word| word.text()).collect();
    join_choice(&texts)
}

/// `a, b or c`
pub(super) fn join_choice(items: &[&str]) -> String {
    match items {
        [] => String::new(),
        [only] => (*only).to_string(),
        [init @ .., last] => format!("{} or {last}", init.join(", ")),
    }
}

/// How an argument reads in an error message.
fn describe(structure: &Structure, arg: ArgType) -> String {
    match arg {
        ArgType::Value(ty) => structure.type_name(ty),
        ArgType::List(ListId::VERSIONS) => "the dimension Versions".to_string(),
        ArgType::List(list) => format!("the list '{}'", structure.list_name(list)),
        ArgType::Time(_) => "the dimension Time".to_string(),
        ArgType::Word(word) => format!("the keyword {}", word.text()),
    }
}

/// The type of the result of a call.
#[derive(Clone, Copy, Debug)]
pub(super) enum Ret {
    Number,
    Boolean,
    Text,
    Date,
    /// A time period at month level.
    Month,
    /// The type of the argument at this position.
    SameAs(usize),
    /// An item of the list named by the argument at this position, or a period when it is Time.
    ItemOf(usize),
    /// An item of the list above that of the item argument at this position.
    ParentOf(usize),
}

/// The ways of calling a function: the argument positions of each accepted form, and the kind
/// of argument that further positions repeat after the only form, for functions that take any
/// number of arguments.
#[derive(Clone, Copy, Debug)]
pub(super) struct Signature {
    pub(super) forms: &'static [&'static [Param]],
    pub(super) rest: Option<Param>,
    pub(super) ret: Ret,
}

impl Signature {
    /// The parameters of a call with `argc` arguments, or `None` if no form takes that many.
    fn params(&self, argc: usize) -> Option<Vec<Param>> {
        if let Some(form) = self.forms.iter().find(|form| form.len() == argc) {
            return Some(form.to_vec());
        }
        let (base, rest) = (self.forms.first()?, self.rest?);
        (argc >= base.len()).then(|| {
            let mut params = base.to_vec();
            params.resize(argc, rest);
            params
        })
    }
}

pub(super) const fn min_arity(signature: &Signature) -> usize {
    let mut fewest = usize::MAX;
    let mut form = 0;
    while form < signature.forms.len() {
        if signature.forms[form].len() < fewest {
            fewest = signature.forms[form].len();
        }
        form += 1;
    }
    fewest
}

pub(super) const fn max_arity(signature: &Signature) -> usize {
    if signature.rest.is_some() {
        return usize::MAX;
    }
    let mut most = 0;
    let mut form = 0;
    while form < signature.forms.len() {
        if signature.forms[form].len() > most {
            most = signature.forms[form].len();
        }
        form += 1;
    }
    most
}

/// The parameters of a call to `func` with `argc` arguments, or `None` if it takes no such
/// number of arguments.
pub fn params(func: FuncId, argc: usize) -> Option<Vec<Param>> {
    func.signature().params(argc)
}

/// Says that `func` does not take `given` arguments.
pub fn arity_message(func: FuncId, given: usize) -> String {
    let def = func.def();
    let signature = func.signature();
    let mut counts: Vec<usize> = signature.forms.iter().map(|form| form.len()).collect();
    counts.sort_unstable();
    let takes = match (signature.rest, counts.as_slice()) {
        (Some(_), _) => format!("at least {} arguments", def.min_args),
        (None, [0]) => "no arguments".to_string(),
        (None, [1]) => "1 argument".to_string(),
        (None, counts) => {
            let numbers: Vec<String> = counts.iter().map(usize::to_string).collect();
            let numbers: Vec<&str> = numbers.iter().map(String::as_str).collect();
            format!("{} arguments", join_choice(&numbers))
        }
    };
    let were = if given == 1 { "was" } else { "were" };
    format!("{} takes {takes}, but {given} {were} given.", def.name)
}

/// Checks the arguments of a call to `func` against the function table and returns the type
/// of its result, or every problem found.
pub fn check(
    structure: &Structure,
    func: FuncId,
    args: &[ArgType],
) -> Result<ValueType, Vec<CheckError>> {
    let Some(expected) = params(func, args.len()) else {
        return Err(vec![CheckError {
            arg: None,
            message: arity_message(func, args.len()),
        }]);
    };
    let mut errors: Vec<CheckError> = expected
        .iter()
        .zip(args)
        .enumerate()
        .filter(|(_, (param, arg))| !param.accepts(**arg, args))
        .map(|(index, (param, arg))| CheckError {
            arg: Some(index),
            message: format!(
                "Argument {} of {} must be {}, but is {}.",
                index + 1,
                func.def().name,
                param.expectation(structure, args),
                describe(structure, *arg),
            ),
        })
        .collect();
    if errors.is_empty() && func == FuncId::IsAncestor {
        errors.extend(check_same_hierarchy(structure, args));
    }
    if !errors.is_empty() {
        return Err(errors);
    }
    result_type(structure, func.signature().ret, args).map_err(|error| vec![error])
}

/// `ISANCESTOR` compares items of lists in one hierarchy: the first item's list is the second
/// item's list or one of the lists above it.
fn check_same_hierarchy(structure: &Structure, args: &[ArgType]) -> Option<CheckError> {
    let [
        ArgType::Value(ValueType::Item(ancestor)),
        ArgType::Value(ValueType::Item(descendant)),
    ] = args
    else {
        return None;
    };
    let mut current = Some(*descendant);
    while let Some(list) = current {
        if list == *ancestor {
            return None;
        }
        current = structure.list(list).and_then(|list| list.parent);
    }
    Some(CheckError {
        arg: Some(0),
        message: format!(
            "ISANCESTOR needs the list '{}' to be above the list '{}' in a hierarchy.",
            structure.list_name(*ancestor),
            structure.list_name(*descendant)
        ),
    })
}

fn result_type(structure: &Structure, ret: Ret, args: &[ArgType]) -> Result<ValueType, CheckError> {
    Ok(match ret {
        Ret::Number => ValueType::Number,
        Ret::Boolean => ValueType::Boolean,
        Ret::Text => ValueType::Text,
        Ret::Date => ValueType::Date,
        Ret::Month => ValueType::Period(TimeLevel::Month),
        Ret::SameAs(position) => match args.get(position) {
            Some(ArgType::Value(ty)) => *ty,
            _ => unreachable!("the parameter at {position} takes a value"),
        },
        Ret::ItemOf(position) => match args.get(position) {
            Some(ArgType::List(list)) => ValueType::Item(*list),
            Some(ArgType::Time(level)) => ValueType::Period(*level),
            _ => unreachable!("the parameter at {position} takes a dimension"),
        },
        Ret::ParentOf(position) => {
            let Some(ArgType::Value(ValueType::Item(list))) = args.get(position) else {
                unreachable!("the parameter at {position} takes an item");
            };
            match structure.list(*list).and_then(|list| list.parent) {
                Some(parent) => ValueType::Item(parent),
                None => {
                    return Err(CheckError {
                        arg: Some(position),
                        message: format!(
                            "PARENT needs an item of a list that has a parent list, but '{}' has none.",
                            structure.list_name(*list)
                        ),
                    });
                }
            }
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::calendar::Calendar;

    fn structure() -> Structure {
        Structure::new(Calendar {
            fiscal_year_start_month: 1,
            first_year: 2026,
            years: 1,
            current_month: None,
        })
    }

    const NUMBER: ArgType = ArgType::Value(ValueType::Number);
    const TEXT: ArgType = ArgType::Value(ValueType::Text);

    #[test]
    fn results_follow_the_signature() {
        let structure = structure();
        assert_eq!(
            check(&structure, FuncId::Abs, &[NUMBER]),
            Ok(ValueType::Number)
        );
        assert_eq!(
            check(&structure, FuncId::Min, &[NUMBER; 6]),
            Ok(ValueType::Number)
        );
        assert_eq!(
            check(&structure, FuncId::Previous, &[TEXT]),
            Ok(ValueType::Text)
        );
        assert_eq!(
            check(
                &structure,
                FuncId::Round,
                &[NUMBER, NUMBER, ArgType::Word(Word::Down)]
            ),
            Ok(ValueType::Number)
        );
        assert_eq!(
            check(
                &structure,
                FuncId::Period,
                &[ArgType::Value(ValueType::Date)]
            ),
            Ok(ValueType::Period(TimeLevel::Month))
        );
    }

    #[test]
    fn items_of_a_dimension_have_the_type_of_that_dimension() {
        let structure = structure();
        let dimension = |arg| check(&structure, FuncId::Item, &[arg]);
        assert_eq!(
            dimension(ArgType::List(ListId::VERSIONS)),
            Ok(ValueType::Item(ListId::VERSIONS))
        );
        assert_eq!(
            dimension(ArgType::Time(TimeLevel::Quarter)),
            Ok(ValueType::Period(TimeLevel::Quarter))
        );
        assert!(dimension(NUMBER).is_err());
        // Only ITEM takes Time and Versions; FINDITEM needs a list of the model.
        let errors = check(
            &structure,
            FuncId::FindItem,
            &[ArgType::Time(TimeLevel::Month), TEXT],
        )
        .unwrap_err();
        assert_eq!(errors.len(), 1);
        assert_eq!(errors[0].arg, Some(0));
    }

    #[test]
    fn every_bad_argument_is_reported_by_position() {
        let structure = structure();
        let errors = check(&structure, FuncId::Mid, &[NUMBER, TEXT, TEXT]).unwrap_err();
        let positions: Vec<_> = errors.iter().map(|error| error.arg).collect();
        assert_eq!(positions, [Some(0), Some(1), Some(2)]);
    }

    #[test]
    fn a_wrong_number_of_arguments_is_a_problem_of_the_call() {
        let structure = structure();
        let errors = check(&structure, FuncId::Abs, &[NUMBER, NUMBER]).unwrap_err();
        assert_eq!(
            errors,
            [CheckError {
                arg: None,
                message: "ABS takes 1 argument, but 2 were given.".to_string(),
            }]
        );
    }
}
