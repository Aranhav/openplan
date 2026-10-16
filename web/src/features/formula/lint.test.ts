import { EditorState } from "@codemirror/state"
import { EditorView } from "@codemirror/view"
import { describe, expect, it } from "vitest"
import type { FormulaProblem } from "@/lib/api/client"
import { problemMessage, toDiagnostic } from "./lint"

function problem(overrides: Partial<FormulaProblem>): FormulaProblem {
  return {
    code: "formula.unknown_name",
    message: "Unknown name 'Revnue'.",
    start: 0,
    end: 6,
    suggestion: null,
    ...overrides,
  }
}

describe("problemMessage", () => {
  it("adds the suggestion when the message does not offer it", () => {
    expect(problemMessage(problem({ suggestion: "Revenue" }))).toBe(
      "Unknown name 'Revnue'. Did you mean 'Revenue'?",
    )
  })

  it("does not say it twice when the server already did", () => {
    const offered = "Unknown name 'Revnue'. Did you mean 'Revenue'?"
    expect(problemMessage(problem({ message: offered, suggestion: "Revenue" }))).toBe(offered)
    const quote = "Unexpected character '&'. Quote the name: 'Profit & Loss'."
    expect(problemMessage(problem({ message: quote, suggestion: "'Profit & Loss'" }))).toBe(quote)
  })

  it("is the message when there is no suggestion", () => {
    expect(problemMessage(problem({ suggestion: null }))).toBe("Unknown name 'Revnue'.")
  })
})

describe("toDiagnostic", () => {
  it("puts the problem where the text is, whatever the characters before it take in bytes", () => {
    // "Umsätze + " is 11 bytes and 10 UTF-16 units.
    const text = "Umsätze + Revnue"
    const diagnostic = toDiagnostic(text, problem({ start: 11, end: 17, suggestion: "Revenue" }))
    expect(text.slice(diagnostic.from, diagnostic.to)).toBe("Revnue")
    expect(diagnostic).toMatchObject({ from: 10, to: 16, severity: "error" })
    expect(diagnostic.message).toBe("Unknown name 'Revnue'. Did you mean 'Revenue'?")
  })

  it("puts a problem after an emoji in text where it is", () => {
    const text = '"🙂" & Revnue'
    const diagnostic = toDiagnostic(text, problem({ start: 9, end: 15 }))
    expect(text.slice(diagnostic.from, diagnostic.to)).toBe("Revnue")
  })

  it("underlines the last character for a problem at the very end", () => {
    const text = "Revenue *"
    const diagnostic = toDiagnostic(text, problem({ code: "formula.syntax", start: 9, end: 9 }))
    expect(text.slice(diagnostic.from, diagnostic.to)).toBe("*")
  })

  it("underlines a whole character beside the problem, never half of a pair of UTF-16 units", () => {
    const text = '"🙂'
    const atTheEnd = toDiagnostic(text, problem({ code: "formula.syntax", start: 5, end: 5 }))
    expect(text.slice(atTheEnd.from, atTheEnd.to)).toBe("🙂")

    const atTheStart = toDiagnostic("🙂 + 1", problem({ start: 0, end: 0 }))
    expect("🙂 + 1".slice(atTheStart.from, atTheStart.to)).toBe("🙂")
  })

  it("underlines the first character of a formula whose problem is at the very start", () => {
    const diagnostic = toDiagnostic("*", problem({ start: 0, end: 0 }))
    expect([diagnostic.from, diagnostic.to]).toEqual([0, 1])
  })

  it("keeps a problem past the end of the text inside it", () => {
    const diagnostic = toDiagnostic("abc", problem({ start: 2, end: 99 }))
    expect([diagnostic.from, diagnostic.to]).toEqual([2, 3])
  })

  it("offers to use the suggestion in place of the part with the problem", () => {
    const text = "Revnue * 2"
    const diagnostic = toDiagnostic(text, problem({ suggestion: "Revenue" }))
    const [action] = diagnostic.actions ?? []
    expect(action.name).toBe("Use Revenue")
    const view = new EditorView({ state: EditorState.create({ doc: text }) })

    action.apply(view, diagnostic.from, diagnostic.to)

    expect(view.state.doc.toString()).toBe("Revenue * 2")
  })

  it("has no action without a suggestion", () => {
    expect(toDiagnostic("x", problem({ start: 0, end: 1 })).actions).toEqual([])
  })
})
