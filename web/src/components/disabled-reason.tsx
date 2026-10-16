import type { ReactNode } from "react"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"

interface DisabledReasonProps {
  /** Why the control is disabled; without one the control is enabled and shown as it is. */
  reason: string | undefined
  children: ReactNode
}

/**
 * Wraps a control that is disabled, so hovering it says why. A disabled control gets no pointer
 * events of its own, which is why the tooltip hangs on the wrapper.
 */
export function DisabledReason({ reason, children }: DisabledReasonProps) {
  if (reason === undefined) {
    return children
  }
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="inline-flex">{children}</span>
      </TooltipTrigger>
      <TooltipContent>{reason}</TooltipContent>
    </Tooltip>
  )
}
