import { Lock } from "lucide-react"
import type { ReactNode } from "react"
import { DisabledReason } from "@/components/disabled-reason"
import { Alert, AlertDescription } from "@/components/ui/alert"

const PRODUCTION_LOCKED_MESSAGE =
  "This model is in production mode. Structural changes arrive through ALM sync."

/**
 * What a screen of the structure says to someone who could change it if the model were not in
 * production mode. A tooltip only reaches a pointer, so the screen says it in plain view as well.
 */
export function ProductionNotice() {
  return (
    <Alert role="status">
      <Lock />
      <AlertDescription>
        <p>{PRODUCTION_LOCKED_MESSAGE}</p>
      </AlertDescription>
    </Alert>
  )
}

interface ProductionLockProps {
  locked: boolean
  /** How the wrapper is laid out, as `DisabledReason` has it. */
  className?: string
  children: ReactNode
}

/** Wraps a control that production mode disables, so hovering it says why. */
export function ProductionLock({ locked, className, children }: ProductionLockProps) {
  return (
    <DisabledReason reason={locked ? PRODUCTION_LOCKED_MESSAGE : undefined} className={className}>
      {children}
    </DisabledReason>
  )
}
