import { useEffect, useRef } from "react"
import { useElementMap } from "@/hooks/use-element-map"
import { useHeadingFocus } from "@/hooks/use-heading-focus"

/**
 * For a list whose rows each have a button that opens a dialog to remove the row. When the dialog
 * closes, focus goes back to that row's button, or if the row is gone to the button of the row
 * that took its place (else the one before), or if no row has a usable button to the heading of
 * the page (`useHeadingFocus`).
 *
 * Put `refFor(id)` on each row's button, call `remember(id)` as one opens the dialog, and give
 * `onCloseAutoFocus` to the dialog.
 */
export function useRemovalFocus(ids: string[]) {
  const buttons = useElementMap<HTMLButtonElement>()
  const heading = useHeadingFocus()
  const opener = useRef<{ id: string; index: number }>(undefined)

  // Radix keeps the handler from the dialog's last render, which also drops the removed row, so
  // the rows are read through a ref that is up to date by the time Radix asks.
  const latest = useRef(ids)
  useEffect(() => {
    latest.current = ids
  })

  function onCloseAutoFocus(event: Event) {
    event.preventDefault()
    if (!opener.current) {
      return
    }
    const { id, index } = opener.current
    const listed = latest.current
    const candidates = listed.includes(id)
      ? [id]
      : [...listed.slice(index), ...listed.slice(0, index).reverse()]
    const target = candidates
      .map((candidate) => buttons.get(candidate))
      .find((button) => button && !button.disabled)
    ;(target ?? heading())?.focus()
  }

  return {
    refFor: buttons.refFor,
    remember: (id: string) => {
      opener.current = { id, index: ids.indexOf(id) }
    },
    onCloseAutoFocus,
  }
}
