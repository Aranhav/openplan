import { type RefObject, useEffect, useRef } from "react"
import type { FieldValues, Path, UseFormReturn } from "react-hook-form"
import { useRestoreFocus } from "@/hooks/use-restore-focus"

/**
 * What the form of a sheet shares with the other: the save button, which a confirmation dialog
 * hands focus back to; the note that the form was saved, after which the sheet closing takes the
 * focus where it belongs; and a way to tell the sheet whether the form has unsaved edits.
 *
 * `dirtyRef` is the sheet's: it is set here as the form changes and read when the sheet is dismissed.
 */
export function useSheetForm<T extends FieldValues>(
  form: UseFormReturn<T>,
  dirtyRef: RefObject<boolean>,
) {
  const { ref: saveRef, onCloseAutoFocus: restoreFocus } = useRestoreFocus<HTMLButtonElement>()
  const saved = useRef(false)
  const { isDirty } = form.formState

  useEffect(() => {
    dirtyRef.current = isDirty
    return () => {
      dirtyRef.current = false
    }
  }, [dirtyRef, isDirty])

  /** The form is saved; whatever closes the sheet next is not a dismissal. */
  function markSaved() {
    saved.current = true
  }

  /**
   * For a confirmation dialog's `onCloseAutoFocus`: back to the save button, or if the server
   * refused a field to that field, which is on screen again once the dialog is gone.
   */
  function afterConfirmation(event: Event) {
    if (saved.current) {
      event.preventDefault()
      return
    }
    const refused = Object.keys(form.formState.errors)[0] as Path<T> | undefined
    if (refused) {
      event.preventDefault()
      form.setFocus(refused)
    } else {
      restoreFocus(event)
    }
  }

  return { saveRef, markSaved, afterConfirmation }
}
