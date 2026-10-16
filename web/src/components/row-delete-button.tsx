import { Trash2 } from "lucide-react"
import { type Ref, useId } from "react"
import { DisabledReason } from "@/components/disabled-reason"
import { ProductionLock } from "@/components/production-lock"
import { Button } from "@/components/ui/button"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"

interface RowDeleteButtonProps {
  /** What the button is called to assistive technology: "Delete Forecast". */
  label: string
  /** What the tooltip says of an enabled button: "Delete version". */
  tooltip: string
  onClick: () => void
  buttonRef?: Ref<HTMLButtonElement>
  /** Production mode switches the button off; the tooltip says so. */
  locked: boolean
  /** Why this row can never be deleted, if it can't. */
  cannotDelete?: string
}

/** The icon button at the end of a table row that opens the dialog for deleting the row. */
export function RowDeleteButton({
  label,
  tooltip,
  onClick,
  buttonRef,
  locked,
  cannotDelete,
}: RowDeleteButtonProps) {
  const reasonId = useId()
  const button = (
    <Button
      ref={buttonRef}
      variant="ghost"
      size="icon-sm"
      aria-label={label}
      aria-describedby={!locked && cannotDelete ? reasonId : undefined}
      disabled={locked || cannotDelete !== undefined}
      onClick={onClick}
    >
      <Trash2 />
    </Button>
  )

  if (locked) {
    return <ProductionLock locked>{button}</ProductionLock>
  }
  if (cannotDelete) {
    return (
      <DisabledReason reason={cannotDelete}>
        {button}
        <span id={reasonId} className="sr-only">
          {cannotDelete}
        </span>
      </DisabledReason>
    )
  }
  return (
    <Tooltip>
      <TooltipTrigger asChild>{button}</TooltipTrigger>
      <TooltipContent side="left">{tooltip}</TooltipContent>
    </Tooltip>
  )
}
