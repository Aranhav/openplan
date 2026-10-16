import { type Diagnostic, forEachDiagnostic, linter } from "@codemirror/lint"
import type { FormulaProblem } from "@/lib/api/client"
import { byteToUtf16 } from "./offsets"

/** How long the editor waits after a key before it asks the server to check the formula, in milliseconds. */
export const LINT_DELAY_MS = 300

/**
 * What a person reads for a problem. The server often words its suggestion into the message
 * already ("Did you mean 'Revenue'?", "Quote the name: 'A & B'."), and then it is not said twice.
 */
export function problemMessage({ message, suggestion }: FormulaProblem) {
  if (!suggestion || message.includes("Did you mean") || message.includes(suggestion)) {
    return message
  }
  return `${message} Did you mean '${suggestion}'?`
}

/**
 * A problem in the place of `text` it is about. The server counts in bytes and the editor in
 * UTF-16 units. A problem about no part of the text, such as an operand missing at the end, is
 * shown on the character before it (or after it at the very start), so that there is something
 * to underline.
 */
export function toDiagnostic(text: string, problem: FormulaProblem): Diagnostic {
  let from = byteToUtf16(text, problem.start)
  let to = Math.max(from, byteToUtf16(text, problem.end))
  if (from === to) {
    if (from > 0) {
      from -= 1
    } else if (to < text.length) {
      to += 1
    }
  }
  const { suggestion } = problem
  return {
    from,
    to,
    severity: "error",
    message: problemMessage(problem),
    actions: suggestion
      ? [
          {
            name: `Use ${suggestion}`,
            apply: (view, start, end) =>
              view.dispatch({
                changes: { from: start, to: end, insert: suggestion },
                selection: { anchor: start + suggestion.length },
              }),
          },
        ]
      : [],
  }
}

/** What the server has already said about a formula, which needs no check. */
export interface KnownProblems {
  formula: string
  problems: FormulaProblem[]
  /** The server said it in refusing to save the formula, rather than about the formula it has saved. */
  refused?: boolean
}

interface FormulaLinterOptions {
  /** Asks the server what is wrong with a formula. */
  check: (formula: string, signal: AbortSignal) => Promise<FormulaProblem[]>
  /** What is already known; read at each check, so that it can change. */
  known: () => KnownProblems | undefined
  /** Told what is wrong with a formula after each check by the server. */
  onProblems: (formula: string, problems: FormulaProblem[]) => void
}

/**
 * Marks the problems of the formula: the ones the server already said when the text is the one it
 * said them about, else those of a check, which waits for a pause in typing. A check that fails
 * leaves the marks as they are.
 */
export function formulaLinter({ check, known, onProblems }: FormulaLinterOptions) {
  let running: AbortController | undefined
  return linter(
    async (view) => {
      const text = view.state.doc.toString()
      running?.abort()
      const said = known()
      const show = (problems: FormulaProblem[]) => {
        onProblems(text, problems)
        return problems.map((problem) => toDiagnostic(text, problem))
      }
      if (said && said.formula === text) {
        return said.problems.map((problem) => toDiagnostic(text, problem))
      }
      if (text.trim() === "") {
        return show([])
      }
      const controller = new AbortController()
      running = controller
      try {
        return show(await check(text, controller.signal))
      } catch {
        const current: Diagnostic[] = []
        forEachDiagnostic(view.state, (diagnostic, from, to) =>
          current.push({ ...diagnostic, from, to }),
        )
        return current
      }
    },
    { delay: LINT_DELAY_MS },
  )
}
