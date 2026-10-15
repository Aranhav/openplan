import { Check, Lock } from "lucide-react"
import { memo } from "react"
import { Skeleton } from "@/components/ui/skeleton"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { conditionalStyle, styleClassName } from "./conditional-format"
import { formatValue } from "./core/format-value"
import type { Format } from "./core/types"
import type { Cell, CellFlag, ConditionalFormat, LineItemInfo } from "./view-types"

// Cells are built by the hundred as the grid scrolls, so their classes are joined from parts that
// never conflict instead of being merged.
const BASE =
  "group/cell absolute top-0 box-border flex h-full select-none items-center border-r border-b text-sm"

const TEXT_FORMAT: Format = { type: "text" }

function has(flags: readonly CellFlag[], flag: CellFlag): boolean {
  return flags.includes(flag)
}

function surfaceClass(flags: readonly CellFlag[]): string {
  if (has(flags, "na")) {
    return "bg-muted/60"
  }
  if (has(flags, "summary")) {
    return "bg-muted/40 font-semibold"
  }
  if (has(flags, "calculated") || has(flags, "switchover") || has(flags, "error")) {
    return "bg-muted/30"
  }
  return "bg-background"
}

function CheckGlyph({ checked, toggles }: { checked: boolean; toggles: boolean }) {
  return (
    <span
      aria-hidden
      data-toggle={toggles ? "" : undefined}
      className={
        checked
          ? "grid size-4 place-content-center rounded-[4px] border border-primary bg-primary text-primary-foreground shadow-xs"
          : "grid size-4 place-content-center rounded-[4px] border border-input shadow-xs dark:bg-input/30"
      }
    >
      {checked && <Check className="size-3.5" />}
    </span>
  )
}

type GridCellProps = {
  id: string
  row: number
  col: number
  /** The column's 1-based number in the grid, the row headers' columns included. */
  colIndex: number
  left: number
  width: number
  /** `undefined` while the block that holds the cell loads. */
  cell: Cell | undefined
  lineItem: LineItemInfo | undefined
  rules: readonly ConditionalFormat[]
  selected: boolean
  /** No cell of the grid can be changed, whatever its flags say. */
  gridReadOnly: boolean
}

/**
 * One cell of the body. Selection is drawn by an overlay, not by the cell, so it re-renders only
 * when its own value, style or selected state changes.
 */
export const GridCell = memo(function GridCell({
  id,
  row,
  col,
  colIndex,
  left,
  width,
  cell,
  lineItem,
  rules,
  selected,
  gridReadOnly,
}: GridCellProps) {
  const position = {
    id,
    role: "gridcell",
    "data-row": row,
    "data-col": col,
    "aria-colindex": colIndex,
    "aria-selected": selected,
    style: { left, width },
  } as const

  if (!cell) {
    return (
      <div {...position} aria-busy="true" className={`${BASE} cursor-default bg-background px-2`}>
        <Skeleton className="h-3 w-3/5" />
      </div>
    )
  }

  const { flags } = cell
  const na = has(flags, "na")
  const readonly = na || has(flags, "readonly")
  const blank = na || has(flags, "error")
  const format = lineItem?.format ?? TEXT_FORMAT
  const style = lineItem && !blank ? conditionalStyle(rules, lineItem, cell) : undefined

  const align =
    format.type === "number"
      ? "justify-end tabular-nums"
      : format.type === "boolean"
        ? "justify-center"
        : "justify-start"
  const cursor = na ? "cursor-default" : readonly ? "cursor-not-allowed" : "cursor-cell"
  const surface = style
    ? `${styleClassName(style)}${has(flags, "summary") && !style.bold ? " font-semibold" : ""}`
    : `${surfaceClass(flags)} text-foreground`

  const isBoolean = format.type === "boolean" && cell.value.t === "boolean" && !blank
  const content = isBoolean ? (
    <CheckGlyph
      checked={cell.value.t === "boolean" && cell.value.v}
      toggles={!readonly && !gridReadOnly}
    />
  ) : blank ? null : (
    <span className="truncate">{formatValue(cell.value, format, cell.text)}</span>
  )

  const element = (
    <div
      {...position}
      aria-readonly={readonly || undefined}
      aria-checked={isBoolean && cell.value.t === "boolean" ? cell.value.v : undefined}
      className={`${BASE} ${align} ${cursor} ${surface} px-2`}
    >
      {readonly && !na && (
        <Lock
          aria-hidden
          className="absolute left-1.5 size-3 text-muted-foreground opacity-0 group-hover/cell:opacity-100"
        />
      )}
      {content}
    </div>
  )

  if (!has(flags, "switchover")) {
    return element
  }
  return (
    <Tooltip>
      <TooltipTrigger asChild>{element}</TooltipTrigger>
      <TooltipContent>Before the switchover: showing Actual.</TooltipContent>
    </Tooltip>
  )
})
