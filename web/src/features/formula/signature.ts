import { type EditorState, StateEffect, StateField } from "@codemirror/state"
import { EditorView, type Tooltip, ViewPlugin, showTooltip } from "@codemirror/view"
import type { FormulaFunction } from "./api"
import { scan } from "./scan"

/** The call the cursor is in: the name of the function, where it starts, and the argument the cursor is at (from 0). */
export interface Call {
  name: string
  from: number
  argument: number
}

/**
 * The innermost call around `pos`: a function name right before a parenthesis that is still open
 * at `pos`. Parentheses that only group, and the brackets of modifiers, are looked through, and
 * the commas inside them belong to them, not to the call.
 */
export function enclosingCall(text: string, pos: number): Call | null {
  const tokens = scan(text.slice(0, pos))
  let depth = 0
  let commas = 0
  for (let at = tokens.length - 1; at >= 0; at -= 1) {
    const token = tokens[at]
    if (token.kind === "close") {
      depth += 1
    } else if (token.kind === "open") {
      if (depth > 0) {
        depth -= 1
        continue
      }
      const name = tokens[at - 1]
      if (text[token.from] === "(" && name?.kind === "word" && name.to === token.from) {
        return { name: text.slice(name.from, name.to), from: name.from, argument: commas }
      }
      commas = 0
    } else if (token.kind === "comma" && depth === 0) {
      commas += 1
    }
  }
  return null
}

function argumentsText({ min_args: min, max_args: max }: FormulaFunction) {
  const arguments_ = (count: number) => (count === 1 ? "1 argument" : `${count} arguments`)
  if (max === undefined || max === null) {
    return `Takes at least ${arguments_(min)}.`
  }
  if (min === max) {
    return min === 0 ? "Takes no arguments." : `Takes ${arguments_(min)}.`
  }
  return `Takes ${min} to ${arguments_(max)}.`
}

/** What a screen reader is told when the cursor enters a call. */
function announcement(def: FormulaFunction) {
  return `${def.name}. ${def.doc} For example ${def.example}. ${argumentsText(def)}`
}

function signatureDom(def: FormulaFunction) {
  const dom = document.createElement("div")
  dom.className = "cm-formulaSignature"
  const example = document.createElement("code")
  example.textContent = def.example
  const doc = document.createElement("p")
  doc.textContent = def.doc
  const count = document.createElement("p")
  count.className = "cm-formulaSignatureCount"
  count.textContent = argumentsText(def)
  dom.append(example, doc, count)
  return dom
}

const setFunctions = StateEffect.define<Map<string, FormulaFunction>>()
const setFocused = StateEffect.define<boolean>()

interface Signature {
  functions: Map<string, FormulaFunction> | undefined
  focused: boolean
  call: Call | undefined
  def: FormulaFunction | undefined
  tooltip: Tooltip | null
}

function tooltipFor(call: Call, def: FormulaFunction): Tooltip {
  return {
    pos: call.from,
    above: true,
    create: () => ({ dom: signatureDom(def) }),
  }
}

/** The signature of the call at the cursor, kept as it was while the cursor stays in the same call. */
function signatureAt(
  state: EditorState,
  functions: Map<string, FormulaFunction> | undefined,
  focused: boolean,
  previous?: Signature,
): Signature {
  const { main } = state.selection
  const call = focused && functions && main.empty ? enclosingCall(state.doc.toString(), main.head) : null
  const def = call ? functions?.get(call.name.toUpperCase()) : undefined
  if (!call || !def) {
    return { functions, focused, call: undefined, def: undefined, tooltip: null }
  }
  if (previous?.def === def && previous.call?.from === call.from) {
    return { functions, focused, call, def, tooltip: previous.tooltip }
  }
  return { functions, focused, call, def, tooltip: tooltipFor(call, def) }
}

const signatureField = StateField.define<Signature>({
  create: (state) => signatureAt(state, undefined, false),
  update(value, transaction) {
    let { functions, focused } = value
    for (const effect of transaction.effects) {
      if (effect.is(setFunctions)) {
        functions = effect.value
      } else if (effect.is(setFocused)) {
        focused = effect.value
      }
    }
    const changed =
      transaction.docChanged ||
      transaction.selection !== undefined ||
      functions !== value.functions ||
      focused !== value.focused
    return changed ? signatureAt(transaction.state, functions, focused, value) : value
  },
  provide: (field) => showTooltip.from(field, (value) => value.tooltip),
})

/** Reads the functions once the cursor first enters a call, and says the signature of each call entered. */
function signaturePlugin(load: () => Promise<FormulaFunction[]>) {
  return ViewPlugin.fromClass(
    class {
      requested = false
      announced: FormulaFunction | undefined
      destroyed = false

      view: EditorView

      constructor(view: EditorView) {
        this.view = view
      }

      update(update: { state: EditorState }) {
        const { functions, def } = update.state.field(signatureField)
        if (!this.requested && !functions) {
          const { main } = update.state.selection
          if (update.state.field(signatureField).focused && enclosingCall(update.state.doc.toString(), main.head)) {
            this.requested = true
            load().then(
              (list) => {
                this.requested = false
                if (!this.destroyed) {
                  const index = new Map(list.map((item) => [item.name.toUpperCase(), item]))
                  this.view.dispatch({ effects: setFunctions.of(index) })
                }
              },
              () => {
                this.requested = false
              },
            )
          }
        }
        if (def !== this.announced) {
          this.announced = def
          if (def) {
            const text = announcement(def)
            queueMicrotask(() => {
              if (!this.destroyed) {
                this.view.dispatch({ effects: EditorView.announce.of(text) })
              }
            })
          }
        }
      }

      destroy() {
        this.destroyed = true
      }
    },
  )
}

/** A tooltip above the function being called, with an example, what it does and how many arguments it takes. */
export function signatureHelp(load: () => Promise<FormulaFunction[]>) {
  return [
    signatureField,
    signaturePlugin(load),
    EditorView.focusChangeEffect.of((_, focusing) => setFocused.of(focusing)),
  ]
}
