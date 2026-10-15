import { Check, Lock } from "lucide-react"
import { type ReactNode, memo } from "react"
import { Skeleton } from "@/components/ui/skeleton"
import { conditionalStyle, styleClassName } from "./conditional-format"
import { cellId, errorNoteId, switchoverNoteId } from "./cell-notes"
import { formatValue } from "./core/format-value"
import type { Format } from "./core/types"
import { measureTextWidth } from "./measure-text"
import type { Cell, CellFlag, ConditionalFormat, LineItemInfo } from "./view-types"

// Cells are built by the hundred as the grid scrolls, so their classes are joined from parts that
// never conflict instead of being merged.
const BASE =
  "group/cell absolute top-0 box-border flex h-full select-none items-center border-r border-b text-sm"

// The horizontal padding of a cell (px-2) and its right border.
const CELL_PADDING = 17

const TEXT_FORMAT: Format = { type: "text" }

// A diagonal hatch in the border colour of the theme: "not applicable", unlike an empty value.
const HATCH =
  "bg-[repeating-linear-gradient(135deg,color-mix(in_oklab,var(--muted-foreground)_18%,transparent)_0_1px,transparent_1px_6px)]"

function has(flags: readonly CellFlag[], flag: CellFlag): boolean {
  return flags.includes(flag)
}

function surfaceClass(flags: readonly CellFlag[]): string {
  if (has(flags, "na")) {
    return HATCH
  }
  if (has(flags, "summary")) {
    return "bg-muted font-semibold"
  }
  if (has(flags, "calculated") || has(flags, "switchover") || has(flags, "error")) {
    return "bg-muted/60"
  }
  return "bg-background"
}

// The look of components/ui/checkbox.tsx, drawn as a span: a Radix Checkbox per cell is too heavy
// for the hundreds of cells of a screen. Keep the two in step when the shadcn one changes.
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
  /** Makes the ids of the cell and of the notes it points to. */
  gridId: string
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
  gridId,
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
    id: cellId(gridId, row, col),
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
  const error = has(flags, "error")
  const readonly = na || has(flags, "readonly")
  const blank = na || error
  const format = lineItem?.format ?? TEXT_FORMAT
  const style = lineItem && !blank ? conditionalStyle(rules, lineItem, cell) : undefined
  const bold = style ? style.bold : has(flags, "summary")

  const rightAligned = format.type === "number"
  const align = rightAligned
    ? "justify-end tabular-nums"
    : format.type === "boolean"
      ? "justify-center"
      : "justify-start"
  const cursor = na ? "cursor-default" : readonly ? "cursor-not-allowed" : "cursor-cell"
  const surface = style
    ? `${styleClassName(style)}${has(flags, "summary") && !style.bold ? " font-semibold" : ""}`
    : `${surfaceClass(flags)} text-foreground`

  const note = error
    ? lineItem && errorNoteId(gridId, lineItem.id)
    : has(flags, "switchover")
      ? switchoverNoteId(gridId)
      : undefined

  let content: ReactNode
  let full: string | undefined
  if (na) {
    content = <span className="sr-only">Not applicable</span>
  } else if (error) {
    content = <span className="sr-only">Error</span>
  } else if (format.type === "boolean" && cell.value.t === "boolean") {
    content = (
      <>
        <CheckGlyph checked={cell.value.v} toggles={!readonly && !gridReadOnly} />
        <span className="sr-only">{cell.value.v ? "Checked" : "Not checked"}</span>
      </>
    )
  } else {
    const text = formatValue(cell.value, format, cell.text)
    // A number that is cut off reads as another number, so a column too narrow for it shows ###,
    // like a spreadsheet, and the number itself is the label and the title.
    const fits = !rightAligned || measureTextWidth(text, bold) <= width - CELL_PADDING
    full = fits ? undefined : text
    content = <span className="truncate">{fits ? text : "###"}</span>
  }

  return (
    <div
      {...position}
      data-note={error ? "error" : has(flags, "switchover") ? "switchover" : undefined}
      aria-readonly={readonly || undefined}
      aria-describedby={note}
      aria-label={full}
      title={full}
      className={`${BASE} ${align} ${cursor} ${surface} px-2`}
    >
      {readonly && !na && (
        <Lock
          aria-hidden
          className={`absolute size-3 text-muted-foreground opacity-0 group-hover/cell:opacity-100 ${
            rightAligned ? "left-1.5" : "right-1.5"
          }`}
        />
      )}
      {content}
    </div>
  )
})
