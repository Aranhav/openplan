import type { ReactNode } from "react"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"

interface DisabledReasonProps {
  /** Why the control is disabled; without one the control is enabled and shown as it is. */
  reason: string | undefined
  /** How the wrapper is laid out: it shrinks to its control unless it is told otherwise (`flex`, for a menu item). */
  className?: string
  children: ReactNode
}

/**
 * Wraps a control that is disabled, so hovering it says why. A disabled control gets no pointer
 * events of its own, which is why the tooltip hangs on the wrapper.
 */
export function DisabledReason({ reason, className = "inline-flex", children }: DisabledReasonProps) {
  if (reason === undefined) {
    return children
  }
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className={className}>{children}</span>
      </TooltipTrigger>
      <TooltipContent>{reason}</TooltipContent>
    </Tooltip>
  )
}
