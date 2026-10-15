/**
 * For a dialog that runs a request. Escape, a click outside and the close button all end up in
 * `onOpenChange`, and none of them may hide a request that is still running: wrap the handler in
 * this. Give the dialog content `showCloseButton={!busy}` too, so no inert close button is left.
 */
export function closeUnlessBusy(busy: boolean, onOpenChange: (open: boolean) => void) {
  return (open: boolean) => {
    if (!busy) {
      onOpenChange(open)
    }
  }
}
