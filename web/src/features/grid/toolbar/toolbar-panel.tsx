import type { ReactNode, RefObject } from "react"
import {
  Popover,
  PopoverAnchor,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover"
import { cn } from "@/lib/utils"

interface ToolbarPanelProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** The button that opens the panel. Without it the panel hangs from `anchor`, as in the More menu. */
  trigger?: ReactNode
  /** What the panel hangs from, and where focus goes when it closes, when it has no trigger. */
  anchor?: RefObject<HTMLElement | null>
  /** Names the panel for assistive technology. */
  label: string
  className?: string
  children: ReactNode
}

/**
 * A popover of the toolbar. Its state belongs to the toolbar, which opens one panel at a time,
 * so that a control that has moved into the More menu can still open its panel.
 */
export function ToolbarPanel({
  open,
  onOpenChange,
  trigger,
  anchor,
  label,
  className,
  children,
}: ToolbarPanelProps) {
  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      {trigger ? (
        <PopoverTrigger asChild>{trigger}</PopoverTrigger>
      ) : (
        <PopoverAnchor virtualRef={anchor} />
      )}
      <PopoverContent
        align="start"
        aria-label={label}
        className={cn("w-80 p-3", className)}
        onCloseAutoFocus={
          trigger
            ? undefined
            : (event) => {
                event.preventDefault()
                anchor?.current?.focus()
              }
        }
      >
        {children}
      </PopoverContent>
    </Popover>
  )
}
