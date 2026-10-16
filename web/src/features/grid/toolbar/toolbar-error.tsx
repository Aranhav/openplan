import { CircleAlert } from "lucide-react"
import { ErrorState } from "@/components/error-state"
import { Button } from "@/components/ui/button"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"

interface ToolbarErrorProps {
  /** What could not be read, in the words of the button that stands in its place. */
  label: string
  error: unknown
  onRetry: () => void
}

/**
 * What takes the place of a control whose data could not be read: a button that says so, and
 * opens the cause with Retry, since the row has no room for the error state itself.
 */
export function ToolbarError({ label, error, onRetry }: ToolbarErrorProps) {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button variant="outline" size="sm" className="shrink-0 text-destructive">
          <CircleAlert />
          {label}
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        aria-label={label}
        className="w-72 border-0 bg-transparent p-0 shadow-none"
      >
        <ErrorState error={error} onRetry={onRetry} />
      </PopoverContent>
    </Popover>
  )
}
