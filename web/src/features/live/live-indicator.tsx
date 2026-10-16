import { Tooltip, TooltipContent, TooltipTrigger, TooltipProvider } from "@/components/ui/tooltip"
import { cn } from "@/lib/utils"
import { useLiveStatus } from "./live-status"
import type { LiveStatus } from "./use-model-live"

const STATES: Record<LiveStatus, { label: string; dot: string }> = {
  live: { label: "Live updates on", dot: "bg-green-600 dark:bg-green-500" },
  reconnecting: {
    label: "Reconnecting…",
    dot: "animate-pulse bg-amber-600 motion-reduce:animate-none dark:bg-amber-500",
  },
  // Hollow, so that the state shows without its colour.
  off: { label: "Live updates off", dot: "border-2 border-muted-foreground" },
}

/**
 * A dot that says whether other people's changes to the model show up by themselves: green when
 * they do, amber while the connection is being made again, and a muted ring when they do not. It
 * shows nothing outside a model's layout, which is what follows the changes.
 */
export function LiveIndicator() {
  const status = useLiveStatus()
  if (status === undefined) {
    return null
  }
  const { label, dot } = STATES[status]
  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <span
            role="img"
            aria-label={label}
            tabIndex={0}
            className="inline-flex size-6 items-center justify-center rounded-full outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
          >
            <span aria-hidden className={cn("size-2.5 rounded-full", dot)} />
          </span>
        </TooltipTrigger>
        <TooltipContent>{label}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  )
}
