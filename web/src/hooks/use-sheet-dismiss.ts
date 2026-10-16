import { useRef, useState } from "react"

/**
 * What a sheet with a form does when it is dismissed: Escape, a click outside and the close
 * button end up in `dismiss`, which asks before it loses edits (the form says whether it has
 * any through `dirty`) and does nothing while a request runs (`busy`). Cancel does not ask: it
 * closes through `onOpenChange`. Spread `discard` on a `DiscardChangesDialog`.
 */
export function useSheetDismiss(onOpenChange: (open: boolean) => void, busy: boolean) {
  const dirtyRef = useRef(false)
  const [discarding, setDiscarding] = useState(false)

  function dismiss(next: boolean) {
    if (busy) {
      return
    }
    if (!next && dirtyRef.current) {
      setDiscarding(true)
    } else {
      onOpenChange(next)
    }
  }

  return {
    dirtyRef,
    dismiss,
    discard: {
      open: discarding,
      onOpenChange: setDiscarding,
      onDiscard: () => {
        setDiscarding(false)
        onOpenChange(false)
      },
    },
  }
}
