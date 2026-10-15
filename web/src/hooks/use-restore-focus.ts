import { useRef } from "react"

/**
 * For a dialog opened from a button without being wrapped in a trigger, which leaves Radix no
 * element to give focus back to. Put `ref` on the button and `onCloseAutoFocus` on the dialog.
 */
export function useRestoreFocus<T extends HTMLElement>() {
  const ref = useRef<T>(null)
  function onCloseAutoFocus(event: Event) {
    event.preventDefault()
    ref.current?.focus()
  }
  return { ref, onCloseAutoFocus }
}
