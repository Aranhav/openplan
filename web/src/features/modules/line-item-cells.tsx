import { CircleAlert } from "lucide-react"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import type { FormulaError } from "@/features/grid/view-types"

/** Text cut short to one line, with all of it as the tooltip the browser gives. */
export function Truncated({ children }: { children: string }) {
  return (
    <span className="block truncate" title={children || undefined}>
      {children}
    </span>
  )
}

/**
 * What a line item has from its module, because it sets nothing of its own: shown muted, with the
 * tooltip saying where it is from (and a screen reader told, since a tooltip is for the pointer).
 */
export function Inherited({ children }: { children: string }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="block truncate text-muted-foreground">
          {children}
          <span className="sr-only"> (from the module)</span>
        </span>
      </TooltipTrigger>
      <TooltipContent>From the module</TooltipContent>
    </Tooltip>
  )
}

interface FormulaCellProps {
  formula: string | null | undefined
  /** What is wrong with the formula, as the model last read it. */
  errors: FormulaError[]
  /** For the error icon, which is a button the Tab key reaches only on the selected row. */
  tabIndex: number
  /** Opens the settings of the line item, where the problems are listed. */
  onOpen: () => void
}

/** A formula in a monospace font, cut short to one line with the whole of it in a tooltip. */
export function FormulaCell({ formula, errors, tabIndex, onOpen }: FormulaCellProps) {
  if (!formula) {
    return <span className="text-muted-foreground">Input</span>
  }
  return (
    <div className="flex items-center gap-1.5">
      {errors.length > 0 && (
        <FormulaErrorButton errors={errors} tabIndex={tabIndex} onOpen={onOpen} />
      )}
      <Tooltip>
        <TooltipTrigger asChild>
          <code className="block min-w-0 truncate font-mono text-xs">{formula}</code>
        </TooltipTrigger>
        <TooltipContent className="max-w-md font-mono text-xs break-words">
          {formula}
        </TooltipContent>
      </Tooltip>
    </div>
  )
}

interface FormulaErrorButtonProps {
  errors: FormulaError[]
  tabIndex: number
  onOpen: () => void
}

/** The icon of a formula with errors: the first one's message is its name, and the tooltip lists them all. */
function FormulaErrorButton({ errors, tabIndex, onOpen }: FormulaErrorButtonProps) {
  const label =
    errors.length === 1
      ? `Formula error: ${errors[0].message}`
      : `${errors.length} formula errors: ${errors[0].message}`
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          aria-label={label}
          tabIndex={tabIndex}
          className="inline-flex shrink-0 rounded-sm text-destructive outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
          onClick={onOpen}
        >
          <CircleAlert className="size-4" />
        </button>
      </TooltipTrigger>
      <TooltipContent className="max-w-sm">
        <ul className="flex flex-col gap-1">
          {errors.map((error, index) => (
            <li key={index}>{error.message}</li>
          ))}
        </ul>
      </TooltipContent>
    </Tooltip>
  )
}
