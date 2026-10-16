import { StreamLanguage, type StreamParser, type StringStream } from "@codemirror/language"
import { tags } from "@lezer/highlight"
import { KEYWORDS, WORD, matchAt, numberAt } from "./scan"

/** Where the tokenizer is, between two lines of a formula. */
export interface FormulaState {
  /** The quote of the text or quoted name that a line break interrupted. */
  quote: '"' | "'" | null
  /** How many `[` are open, which is where a modifier such as SUM can stand. */
  brackets: number
  /** The previous token was a dot, after which a number is a part of a name (`Years.2024`). */
  afterDot: boolean
}

const MODIFIERS = new Set([
  "SUM",
  "LOOKUP",
  "SELECT",
  "AVERAGE",
  "MIN",
  "MAX",
  "ANY",
  "ALL",
  "FIRSTNONBLANK",
  "LASTNONBLANK",
  "TEXTLIST",
])

const OPERATOR = /^(?:<>|<=|>=|[+\-*/&=<>])/

/** Reads on from `stream` to the end of text or a quoted name that opened with `quote`. */
function quoted(stream: StringStream, state: FormulaState, quote: '"' | "'") {
  while (!stream.eol()) {
    const character = stream.next()
    if (character === quote) {
      if (stream.peek() !== quote) {
        state.quote = null
        return
      }
      stream.next()
    }
  }
  state.quote = quote
}

function word(stream: StringStream, state: FormulaState, afterDot: boolean) {
  const number = numberAt(stream.string, stream.pos, afterDot)
  if (number) {
    stream.pos += number.length
    return "number"
  }
  const text = matchAt(WORD, stream.string, stream.pos) ?? ""
  stream.pos += text.length
  const upper = text.toUpperCase()
  if (KEYWORDS.has(upper)) {
    return "keyword"
  }
  if (state.brackets > 0 && MODIFIERS.has(upper) && stream.match(/^\s*:/, false)) {
    return "modifier"
  }
  return stream.peek() === "(" ? "function" : "name"
}

export const formulaParser: StreamParser<FormulaState> = {
  name: "formula",
  startState: () => ({ quote: null, brackets: 0, afterDot: false }),
  copyState: (state) => ({ ...state }),
  token(stream, state) {
    if (state.quote) {
      const quote = state.quote
      quoted(stream, state, quote)
      return quote === '"' ? "string" : "quotedName"
    }
    if (stream.eatSpace()) {
      return null
    }
    const afterDot = state.afterDot
    state.afterDot = false
    if (stream.match("//")) {
      stream.skipToEnd()
      return "comment"
    }
    const character = stream.peek()
    if (character === '"' || character === "'") {
      stream.next()
      quoted(stream, state, character)
      return character === '"' ? "string" : "quotedName"
    }
    if (matchAt(WORD, stream.string, stream.pos)) {
      return word(stream, state, afterDot)
    }
    if (stream.match(OPERATOR)) {
      return "operator"
    }
    stream.next()
    switch (character) {
      case "(":
      case ")":
        return "bracket"
      case "[":
        state.brackets += 1
        return "bracket"
      case "]":
        state.brackets = Math.max(0, state.brackets - 1)
        return "bracket"
      case ".":
        state.afterDot = true
        return "punctuation"
      case ",":
      case ":":
        return "punctuation"
      default:
        return null
    }
  },
  tokenTable: {
    comment: tags.lineComment,
    string: tags.string,
    quotedName: tags.special(tags.variableName),
    number: tags.number,
    keyword: tags.keyword,
    modifier: tags.operatorKeyword,
    function: tags.function(tags.variableName),
    name: tags.variableName,
    operator: tags.operator,
    bracket: tags.bracket,
    punctuation: tags.punctuation,
  },
  languageData: {
    closeBrackets: { brackets: ["(", "[", '"', "'"] },
  },
}

/** The formula language: its tokens and the brackets that close each other. */
export const formulaLanguage = StreamLanguage.define(formulaParser)
