//! Calls of the built-in functions: how many arguments there are, what kind of thing each
//! position takes, and whether the function table accepts their types.

use crate::formula::functions::{self, ArgType, FuncId, Param, keyword_choice};
use crate::formula::{Expr, Name, Span};

use super::names::{closest, did_you_mean};
use super::{Resolver, TExpr, TYPE_MISMATCH, formula_error};

const UNKNOWN_FUNCTION: &str = "formula.unknown_function";
const ARITY: &str = "formula.arity";

impl Resolver<'_> {
    pub(super) fn call(&mut self, name: &Name, args: &[Expr], span: Span) -> Option<TExpr> {
        let Some(func) = functions::lookup(&name.text) else {
            return self.unknown_function(name);
        };
        let Some(params) = functions::params(func, args.len()) else {
            return self.fail(ARITY, span, functions::arity_message(func, args.len()));
        };
        let mut resolved: Vec<Option<TExpr>> = Vec::with_capacity(args.len());
        for (index, (param, arg)) in params.into_iter().zip(args).enumerate() {
            let typed = self.argument(func, index, param, arg, &resolved);
            resolved.push(typed);
        }
        let args: Vec<TExpr> = resolved.into_iter().collect::<Option<_>>()?;
        let types: Vec<ArgType> = args.iter().map(TExpr::arg_type).collect();
        match functions::check(self.structure, func, &types) {
            Ok(ty) => Some(TExpr::Call {
                func,
                args,
                ty,
                span,
            }),
            Err(error) => {
                let at = error
                    .arg
                    .and_then(|index| args.get(index))
                    .map_or(span, TExpr::span);
                self.mismatch(at, error.message)
            }
        }
    }

    fn unknown_function(&mut self, name: &Name) -> Option<TExpr> {
        let found = closest(
            &name.text,
            functions::all().iter().map(|def| (def.name, def.name)),
        );
        let mut message = format!("Unknown function '{}'.", name.text);
        if let Some(found) = found {
            message.push_str(&did_you_mean(found));
        }
        let error = formula_error(
            UNKNOWN_FUNCTION,
            name.span,
            message,
            found.map(String::from),
        );
        self.report(error)
    }

    /// The argument at `index` of a call to `func`, read as `param` says: a list name, a
    /// keyword, or a value. `earlier` holds the arguments before it.
    fn argument(
        &mut self,
        func: FuncId,
        index: usize,
        param: Param,
        arg: &Expr,
        earlier: &[Option<TExpr>],
    ) -> Option<TExpr> {
        if param == Param::List {
            return self.list_argument(func, index, arg);
        }
        if !param.keywords().is_empty() {
            return self.keyword_argument(func, index, param, arg);
        }
        let first = earlier.first().and_then(Option::as_ref).map(TExpr::ty);
        let hint = param
            .fixed_type()
            .or(first.filter(|_| param.is_same_as_first()));
        self.expr(arg, hint)
    }

    fn list_argument(&mut self, func: FuncId, index: usize, arg: &Expr) -> Option<TExpr> {
        if let Expr::Ref { parts, span } = arg
            && let [name] = parts.as_slice()
        {
            return match self.structure.list_by_name(&name.text) {
                Some(list) => Some(TExpr::ListRef {
                    list: list.id,
                    span: *span,
                }),
                None => {
                    let error = self.names.unknown_list(name);
                    self.report(error)
                }
            };
        }
        let message = format!(
            "Argument {} of {} must be the name of a list.",
            index + 1,
            func.def().name
        );
        self.mismatch(arg.span(), message)
    }

    fn keyword_argument(
        &mut self,
        func: FuncId,
        index: usize,
        param: Param,
        arg: &Expr,
    ) -> Option<TExpr> {
        let keywords = param.keywords();
        let mut suggestion = None;
        if let Expr::Ref { parts, span } = arg
            && let [part] = parts.as_slice()
            && !part.quoted
        {
            let found = keywords
                .iter()
                .find(|word| word.text().eq_ignore_ascii_case(&part.text));
            if let Some(word) = found {
                return Some(TExpr::Word {
                    word: *word,
                    span: *span,
                });
            }
            suggestion = closest(
                &part.text,
                keywords.iter().map(|word| (word.text(), word.text())),
            );
        }
        let mut message = format!(
            "Argument {} of {} must be {}.",
            index + 1,
            func.def().name,
            keyword_choice(keywords)
        );
        if let Some(word) = suggestion {
            message.push_str(&did_you_mean(word));
        }
        let error = formula_error(
            TYPE_MISMATCH,
            arg.span(),
            message,
            suggestion.map(String::from),
        );
        self.report(error)
    }
}
