import {
  type Completion as EditorCompletion,
  type CompletionSource,
  autocompletion,
  insertBracket,
} from "@codemirror/autocomplete"
import type { EditorView } from "@codemirror/view"
import type { Completion } from "./api"
import { kindIcon } from "./kind-icons"
import { KEYWORDS, isNumber, scan } from "./scan"

/** How long the editor waits after a key before it asks the server what to offer, in milliseconds. */
export const COMPLETION_DELAY_MS = 150

const PLAIN_NAME = /^[\p{L}\p{N}\p{M}_%# ?]+$/u

/**
 * `name` as it is written in a formula: as it is when the engine reads it back as the same single
 * name, else in single quotes with any quote inside doubled. A name reads back when it holds only
 * letters, digits, single spaces and `_ % # ?`, none of its words is a keyword (which would end
 * the name), and it is not a number.
 */
export function quoteName(name: string) {
  const reads =
    PLAIN_NAME.test(name) &&
    name.split(" ").every((word) => word !== "" && !KEYWORDS.has(word.toUpperCase())) &&
    !isNumber(name)
  return reads ? name : `'${name.replaceAll("'", "''")}'`
}

/** The tokens that run together into the name being typed: words, quoted names and the dots between. */
const NAME_PARTS = new Set(["word", "quoted", "dot"])

/**
 * Where the name being typed at `pos` starts, and the text of it to `pos`, which is what the
 * server is asked about. A name may have several words (`Unit c`), a dot (`Plan.Un`) and quotes
 * (`'Profit & Lo`). None where a name is not being typed: in text or a comment, in a number, or
 * after something that is not part of a name, unless the person asked (`explicit`), when the
 * prefix is empty and everything is offered.
 */
export function completionRange(text: string, pos: number, explicit = false) {
  const before = text.slice(0, pos)
  const tokens = scan(before)
  const last = tokens.at(-1)
  if (last && last.to === pos && (last.kind === "comment" || (last.kind === "string" && !last.closed))) {
    return null
  }
  let start = tokens.length
  while (start > 0 && NAME_PARTS.has(tokens[start - 1].kind)) {
    start -= 1
  }
  if (start === tokens.length) {
    return explicit ? { from: pos, prefix: "" } : null
  }
  const endedByASpace = last !== undefined && last.to < pos
  if (endedByASpace && !explicit) {
    return null
  }
  const from = tokens[start].from
  return { from, prefix: before.slice(from) }
}

/** Inserts the name of a function and opens its parentheses, which the editor closes. */
function applyFunction(view: EditorView, completion: EditorCompletion, from: number, to: number) {
  view.dispatch({
    changes: { from, to, insert: completion.label },
    selection: { anchor: from + completion.label.length },
    userEvent: "input.complete",
  })
  view.dispatch(insertBracket(view.state, "(") ?? view.state.replaceSelection("("))
}

/** A function or keyword has a sentence of help, which fits beside the list; the others have a few words. */
function toOption({ label, kind, detail }: Completion): EditorCompletion {
  const sentence = kind === "function" || kind === "keyword"
  return {
    label,
    type: kind,
    detail: sentence ? undefined : detail,
    info: sentence ? detail : undefined,
    apply: kind === "function" ? applyFunction : undefined,
  }
}

/** What the server offers after the name being typed; its own order and matching stand. */
function completionSource(fetch: (prefix: string) => Promise<Completion[]>): CompletionSource {
  return async (context) => {
    const range = completionRange(context.state.doc.toString(), context.pos, context.explicit)
    if (!range) {
      return null
    }
    let found: Completion[]
    try {
      found = await fetch(range.prefix)
    } catch {
      return null
    }
    if (context.aborted || found.length === 0) {
      return null
    }
    return { from: range.from, options: found.map(toOption), filter: false }
  }
}

/** Completions from the server in a list that is announced by assistive technology and reached with the keyboard. */
export function formulaAutocompletion(fetch: (prefix: string) => Promise<Completion[]>) {
  return autocompletion({
    override: [completionSource(fetch)],
    activateOnTypingDelay: COMPLETION_DELAY_MS,
    icons: false,
    addToOptions: [{ render: (completion) => kindIcon(completion.type ?? ""), position: 20 }],
  })
}
