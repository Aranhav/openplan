import { closeCompletion, completionStatus } from "@codemirror/autocomplete"
import { closeLintPanel } from "@codemirror/lint"
import { EditorView } from "@codemirror/view"

/**
 * Closes what a formula editor has open that an Escape key press belongs to, and says whether
 * there was one: its list of completions, or its panel of problems (Ctrl+Shift+M) when the key is
 * pressed in the panel. A sheet or dialog around the editor leaves the key to that instead of
 * closing itself: it ignores the key when this returns true. The popup is closed here because the
 * key is stopped from reaching the editor, which a layer that ignores it must do.
 */
export function closeEditorPopupOnEscape(event: KeyboardEvent) {
  const target = event.target instanceof Element ? event.target : null
  const editor = target?.closest<HTMLElement>(".cm-editor")
  const view = editor ? EditorView.findFromDOM(editor) : null
  if (!view) {
    return false
  }
  if (target?.closest(".cm-panel-lint")) {
    if (!closeLintPanel(view)) {
      return false
    }
    // The focus was in the panel, which is gone.
    view.focus()
    return true
  }
  if (completionStatus(view.state) === null) {
    return false
  }
  closeCompletion(view)
  return true
}
