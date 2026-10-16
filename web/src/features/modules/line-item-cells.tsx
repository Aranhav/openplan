import { CircleAlert } from "lucide-react"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import type { FormulaError } from "@/features/grid/view-types"

/** What a column says of a line item that has nothing of its own to say: the module's choice stands. */
export function Inherited({ children }: { children: string }) {
  return <span className="text-muted-foreground">{children}</span>
}

interface FormulaCellProps {
  formula: string | null | undefined
  /** What is wrong with the formula, as the model last read it. */
  errors: FormulaError[]
}

/** A formula in a monospace font, cut short to one line with the whole of it in a tooltip. */
export function FormulaCell({ formula, errors }: FormulaCellProps) {
  if (!formula) {
    return <Inherited>Input</Inherited>
  }
  return (
    <div className="flex items-center gap-1.5">
      {errors.length > 0 && <FormulaErrorIcon errors={errors} />}
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

function FormulaErrorIcon({ errors }: { errors: FormulaError[] }) {
  const label =
    errors.length === 1
      ? `Formula error: ${errors[0].message}`
      : `${errors.length} formula errors: ${errors[0].message}`
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span role="img" aria-label={label} className="inline-flex shrink-0 text-destructive">
          <CircleAlert className="size-4" />
        </span>
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
