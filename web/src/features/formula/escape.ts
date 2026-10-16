import { closeCompletion, completionStatus } from "@codemirror/autocomplete"
import { EditorView } from "@codemirror/view"

/**
 * Closes the list of completions of the formula editor that an Escape key press is in, and says
 * whether there was one. A sheet or dialog around the editor leaves the key to the list then,
 * instead of closing itself: it ignores the key when this returns true. The list is closed here
 * because the key is stopped from reaching the editor, which a layer that ignores it must do.
 */
export function closeCompletionsOnEscape(event: KeyboardEvent) {
  const editor =
    event.target instanceof Element ? event.target.closest<HTMLElement>(".cm-editor") : null
  const view = editor ? EditorView.findFromDOM(editor) : null
  if (!view || completionStatus(view.state) === null) {
    return false
  }
  closeCompletion(view)
  return true
}
