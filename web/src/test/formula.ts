import { EditorView } from "@codemirror/view"
import { act } from "@testing-library/react"

/** The editor behind the element a formula editor is labelled by. */
export function formulaView(input: HTMLElement) {
  const editor = input.closest<HTMLElement>(".cm-editor")
  const view = editor && EditorView.findFromDOM(editor)
  if (!view) {
    throw new Error("the element is not in a formula editor")
  }
  return view
}

/** Replaces the formula in the editor as a person typing it would, and moves the cursor to its end. */
export function setFormula(input: HTMLElement, text: string) {
  const view = formulaView(input)
  act(() => {
    view.dispatch({
      changes: { from: 0, to: view.state.doc.length, insert: text },
      selection: { anchor: text.length },
      userEvent: "input.type",
    })
  })
}

/** The text of the formula in the editor. */
export function formulaText(input: HTMLElement) {
  return formulaView(input).state.doc.toString()
}
