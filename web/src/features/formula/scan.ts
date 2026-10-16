/** What a stretch of a formula is, as far as the editor needs to tell. */
export type TokenKind =
  | "word"
  | "number"
  | "keyword"
  | "string"
  | "quoted"
  | "comment"
  | "open"
  | "close"
  | "comma"
  | "colon"
  | "dot"
  | "operator"
  | "other"

export interface Token {
  kind: TokenKind
  /** Where it starts and ends, in UTF-16 units. */
  from: number
  to: number
  /** False for text or a quoted name that the formula ends before closing. */
  closed: boolean
}

export const KEYWORDS = new Set(["IF", "THEN", "ELSE", "AND", "OR", "NOT", "TRUE", "FALSE", "BLANK"])

/** Letters, digits and combining marks, and the `_ % # ?` that a name may hold. */
export const WORD = /[\p{L}\p{N}\p{M}_%#?]+/uy
export const NUMBER = /\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/y
const OPERATOR = /<>|<=|>=|[+\-*/&=<>]/y

export function matchAt(pattern: RegExp, text: string, at: number) {
  pattern.lastIndex = at
  return pattern.exec(text)?.[0]
}

/**
 * The number that starts at `at`, or none when a word does instead. A number holds a fraction or
 * an exponent (`2.5`, `1e6`), runs to the end of the word it starts (`3D` is a word), and next
 * to a dot is a part of a reference (`Years.2024`, `2024.X`).
 */
export function numberAt(text: string, at: number, afterDot: boolean) {
  const number = matchAt(NUMBER, text, at)
  const word = matchAt(WORD, text, at)
  if (!number || !word || afterDot || number.length < word.length) {
    return undefined
  }
  const beforeDot = number === word && text[at + word.length] === "." && /^\d+$/.test(word)
  return beforeDot ? undefined : number
}

/** The end of the text or quoted name that opens at `from`, and whether it closes. */
function endOfQuoted(text: string, from: number) {
  const quote = text[from]
  let at = from + 1
  while (at < text.length) {
    if (text[at] === quote) {
      if (text[at + 1] !== quote) {
        return { to: at + 1, closed: true }
      }
      at += 1
    }
    at += 1
  }
  return { to: text.length, closed: false }
}

const SYMBOLS: Record<string, TokenKind> = {
  "(": "open",
  "[": "open",
  ")": "close",
  "]": "close",
  ",": "comma",
  ":": "colon",
  ".": "dot",
}

/**
 * The tokens of a formula, the way the engine reads it: consecutive words are separate tokens
 * here (the engine joins them into one name), and a number next to a dot is a word, as in
 * `Years.2024`. Whitespace gives no token.
 */
export function scan(text: string): Token[] {
  const tokens: Token[] = []
  let at = 0
  while (at < text.length) {
    const character = text[at]
    const push = (kind: TokenKind, to: number, closed = true) => {
      tokens.push({ kind, from: at, to, closed })
      at = to
    }
    if (/\s/.test(character)) {
      at += 1
    } else if (text.startsWith("//", at)) {
      const newline = text.indexOf("\n", at)
      push("comment", newline < 0 ? text.length : newline)
    } else if (character === '"' || character === "'") {
      const { to, closed } = endOfQuoted(text, at)
      push(character === '"' ? "string" : "quoted", to, closed)
    } else if (matchAt(WORD, text, at)) {
      const previous = tokens.at(-1)
      const afterDot = previous?.kind === "dot" && previous.to === at
      const number = numberAt(text, at, afterDot)
      if (number) {
        push("number", at + number.length)
      } else {
        const word = matchAt(WORD, text, at) as string
        push(KEYWORDS.has(word.toUpperCase()) ? "keyword" : "word", at + word.length)
      }
    } else if (matchAt(OPERATOR, text, at)) {
      push("operator", at + (matchAt(OPERATOR, text, at) as string).length)
    } else {
      push(SYMBOLS[character] ?? "other", at + 1)
    }
  }
  return tokens
}
