import { CircleOff, Loader2, RefreshCw } from "lucide-react"
import { type ReactNode, useState } from "react"
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip"
import { useLiveStatus } from "./live-status"
import type { LiveStatus } from "./use-model-live"

// Each state has a shape of its own, so that they tell apart without their colour or motion.
const STATES: Record<LiveStatus, { label: string; icon: ReactNode }> = {
  connecting: {
    label: "Connecting…",
    icon: (
      <Loader2 className="size-3.5 animate-spin text-muted-foreground motion-reduce:animate-none" />
    ),
  },
  live: {
    label: "Live updates on",
    icon: <span className="size-2.5 rounded-full bg-green-600 dark:bg-green-500" />,
  },
  reconnecting: {
    label: "Reconnecting…",
    icon: <RefreshCw className="size-3.5 text-amber-600 dark:text-amber-500" />,
  },
  off: {
    label: "Live updates off",
    icon: <CircleOff className="size-3.5 text-muted-foreground" />,
  },
}

/**
 * What a screen reader is told when the state changes. The first connection is not announced, nor
 * is the one that follows from it: only a connection that is lost, one that is back, and one that
 * is given up on.
 */
function announcement(from: LiveStatus, to: LiveStatus): string {
  if (to === "connecting" || (from === "connecting" && to === "live")) {
    return ""
  }
  return STATES[to].label
}

/** The words to announce for the change to `status`, kept until the next change. */
function useAnnouncement(status: LiveStatus | undefined): string {
  const [seen, setSeen] = useState<{ status: LiveStatus | undefined; said: string }>({
    status,
    said: "",
  })
  if (seen.status !== status) {
    setSeen({
      status,
      said:
        status !== undefined && seen.status !== undefined ? announcement(seen.status, status) : "",
    })
  }
  return seen.said
}

/**
 * A mark that says whether other people's changes to the model show up by themselves: a green dot
 * when they do, a spinner while the first connection is made, arrows in amber while it is made
 * again, and a crossed circle when they do not. It shows nothing outside a model's layout, which
 * is what follows the changes.
 */
export function LiveIndicator() {
  const status = useLiveStatus()
  const said = useAnnouncement(status)
  if (status === undefined) {
    return null
  }
  const { label, icon } = STATES[status]
  return (
    <>
      <TooltipProvider>
        <Tooltip>
          <TooltipTrigger asChild>
            <span
              role="img"
              aria-label={label}
              tabIndex={0}
              className="inline-flex size-6 items-center justify-center rounded-full outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
            >
              <span aria-hidden className="inline-flex">
                {icon}
              </span>
            </span>
          </TooltipTrigger>
          <TooltipContent>{label}</TooltipContent>
        </Tooltip>
      </TooltipProvider>
      <span role="status" className="sr-only">
        {said}
      </span>
    </>
  )
}
