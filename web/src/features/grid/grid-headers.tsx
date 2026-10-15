import { ChevronDown, ChevronRight, CircleAlert } from "lucide-react"
import { Fragment, type MouseEvent, memo, useEffect, useRef } from "react"
import { Button } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { errorNoteId } from "./cell-notes"
import {
  HEADER_ROW_HEIGHT,
  INDENT,
  clampWidth,
  columnKey,
  columnSpans,
  startsRowGroup,
} from "./grid-layout"
import type { Header, LineItemInfo, Member, ViewDim } from "./view-types"

// Headers sit on the page background, apart from the summary ones, which share the surface of the
// summary cells so that a summary row or column reads as one band from its header on.
const CELL = "box-border flex h-full items-center border-r border-b border-border text-sm"

function headerSurface(member: Member | undefined): string {
  return member?.is_summary ? "bg-muted font-semibold" : "bg-background font-medium"
}

// A repeated label is muted. On the muted surface of a summary, the muted text colour is below
// the 4.5:1 that text needs, so a summary's repeats are the text colour toned down instead.
function repeatedColor(member: Member, repeated: boolean): string {
  if (!repeated) {
    return "text-foreground"
  }
  return member.is_summary ? "text-foreground/70" : "text-muted-foreground"
}

// Something that is not a cell or a header with data, such as a corner or a header that has not
// loaded, has no menu of ours, and its right click is left to the browser.
const stopMenu = (event: MouseEvent) => event.stopPropagation()

/**
 * How far a member is indented: a list by its depth, how far below the top it is. Time counts
 * its depth as the height above the periods, and lists its summaries after their periods, so a
 * time row is indented by how far it is below the top, which is the greatest depth.
 */
function indentOf(dim: ViewDim, member: Member, maxDepth: number | undefined): number {
  return dim.kind === "time" ? Math.max((maxDepth ?? member.depth) - member.depth, 0) : member.depth
}

export type HeaderCallbacks = {
  /** Absent when the grid cannot collapse members; then no chevron is drawn. */
  onToggleCollapse?: (dim: ViewDim, member: Member) => void
  /** Absent when the columns cannot be resized; then their edges have no handles. */
  columns?: {
    onResize: (key: string, width: number) => void
    onResizeEnd: (key: string, width: number) => void
    onResizeCancel: () => void
    onReset: (key: string) => void
  }
  onRowHeaderResize: (level: number, width: number) => void
  onRowHeaderResizeReset: (level: number) => void
}

type ResizeHandleProps = {
  kind: "column" | "row-header"
  width: number
  onResize: (width: number) => void
  onResizeEnd?: (width: number) => void
  /** The drag was abandoned; `startWidth` is what the header was before it. */
  onCancel: (startWidth: number) => void
  onReset: () => void
  /** Where the edge is, from the left of its row; without it the handle sits on its parent's right edge. */
  at?: number
}

type Drag = { startX: number; startWidth: number; moved: boolean; abort: AbortController }

/**
 * The edge a header is dragged by: it widens live, double click puts it back, and Escape, or a
 * pointer the browser takes away, gives up the drag. A mouse control only, so it is hidden from
 * assistive technology rather than offered without a way to operate it.
 */
function ResizeHandle({
  kind,
  width,
  onResize,
  onResizeEnd,
  onCancel,
  onReset,
  at,
}: ResizeHandleProps) {
  const drag = useRef<Drag | null>(null)
  const widthAt = (clientX: number, start: Drag) =>
    clampWidth(start.startWidth + clientX - start.startX)

  useEffect(() => () => drag.current?.abort.abort(), [])

  function finish() {
    const current = drag.current
    drag.current = null
    current?.abort.abort()
    return current
  }

  function cancel() {
    const current = finish()
    if (current?.moved) {
      onCancel(current.startWidth)
    }
  }

  return (
    <div
      aria-hidden
      data-resize={kind}
      className="absolute top-0 h-full w-2 cursor-col-resize touch-none transition-colors hover:bg-primary/30 active:bg-primary/50"
      style={at === undefined ? { right: -4 } : { left: at - 4 }}
      onPointerDown={(event) => {
        event.preventDefault()
        event.stopPropagation()
        event.currentTarget.setPointerCapture(event.pointerId)
        const abort = new AbortController()
        window.addEventListener(
          "keydown",
          (key) => {
            if (key.key === "Escape") {
              cancel()
            }
          },
          { signal: abort.signal },
        )
        drag.current = { startX: event.clientX, startWidth: width, moved: false, abort }
      }}
      onPointerMove={(event) => {
        const start = drag.current
        if (start) {
          start.moved = true
          onResize(widthAt(event.clientX, start))
        }
      }}
      onPointerUp={(event) => {
        const start = finish()
        if (start?.moved) {
          onResizeEnd?.(widthAt(event.clientX, start))
        }
      }}
      onPointerCancel={cancel}
      onLostPointerCapture={cancel}
      onDoubleClick={onReset}
    />
  )
}

function ErrorMark({ message }: { message: string }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <CircleAlert
          role="img"
          aria-label={message}
          className="size-3.5 shrink-0 text-destructive"
        />
      </TooltipTrigger>
      <TooltipContent>{message}</TooltipContent>
    </Tooltip>
  )
}

/** The first error of the line item a header names, if it is a line item in error. */
function errorOf(
  dim: ViewDim | undefined,
  member: Member,
  lineItems: ReadonlyMap<string, LineItemInfo>,
) {
  return dim?.kind === "line_items" ? lineItems.get(member.key)?.errors[0] : undefined
}

type MemberLabelProps = {
  member: Member
  dim: ViewDim | undefined
  lineItems: ReadonlyMap<string, LineItemInfo>
  onToggleCollapse?: (dim: ViewDim, member: Member) => void
  /** A repeat of a label shown above: the chevron is left for the first of them. */
  repeated?: boolean
}

/** A member's name with a chevron when it has children, and a mark when its line item is in error. */
function MemberLabel({ member, dim, lineItems, onToggleCollapse, repeated }: MemberLabelProps) {
  const error = errorOf(dim, member, lineItems)
  const toggle = member.has_children && dim && onToggleCollapse
  return (
    <>
      {toggle && repeated ? <span aria-hidden className="size-6 shrink-0" /> : null}
      {toggle && !repeated ? (
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          tabIndex={-1}
          aria-label={`${member.collapsed ? "Expand" : "Collapse"} ${member.label}`}
          aria-expanded={!member.collapsed}
          className="shrink-0"
          // Keep the focus on the grid, which the keyboard works through.
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => onToggleCollapse(dim, member)}
        >
          {member.collapsed ? <ChevronRight /> : <ChevronDown />}
        </Button>
      ) : null}
      <span className="truncate">{member.label}</span>
      {error && <ErrorMark message={error.message} />}
    </>
  )
}

type RowHeadersProps = {
  /** Makes the id of the note that describes a line item in error. */
  gridId: string
  header: Header | undefined
  /** The header of the row above, to tell the first row of a group from the rest. */
  previous: Header | undefined
  rowDims: readonly ViewDim[]
  /** The width of each row dimension's column. */
  widths: readonly number[]
  /** The greatest depth of the loaded members of each row dimension, which time rows hang from. */
  maxDepths: readonly number[]
  lineItems: ReadonlyMap<string, LineItemInfo>
  onToggleCollapse?: (dim: ViewDim, member: Member) => void
}

/** The sticky headers at the start of a body row, one cell for each row dimension. */
export const RowHeaders = memo(function RowHeaders({
  gridId,
  header,
  previous,
  rowDims,
  widths,
  maxDepths,
  lineItems,
  onToggleCollapse,
}: RowHeadersProps) {
  return (
    <div className="sticky left-0 z-10 flex h-full w-fit bg-background">
      {rowDims.map((dim, level) => {
        const member = header?.members[level]
        const width = widths[level]
        if (!header || !member) {
          return (
            <div
              key={level}
              role="rowheader"
              aria-colindex={level + 1}
              aria-busy="true"
              className={`${CELL} bg-background px-2`}
              style={{ width }}
              onContextMenu={stopMenu}
            >
              <Skeleton className="h-3 w-3/5" />
            </div>
          )
        }
        // Outer dimensions repeat on every row; only the first row of a group stands out.
        const repeated = level < rowDims.length - 1 && !startsRowGroup(previous, header, level)
        const error = errorOf(dim, member, lineItems)
        return (
          <div
            key={level}
            role="rowheader"
            data-header-axis="row"
            data-header-level={level}
            aria-colindex={level + 1}
            aria-label={member.label}
            aria-expanded={member.has_children ? !member.collapsed : undefined}
            aria-describedby={error ? errorNoteId(gridId, member.key) : undefined}
            className={`${CELL} gap-0.5 pr-2 ${headerSurface(member)} ${repeatedColor(member, repeated)}`}
            style={{ width, paddingLeft: 8 + indentOf(dim, member, maxDepths[level]) * INDENT }}
          >
            <MemberLabel
              member={member}
              dim={dim}
              lineItems={lineItems}
              onToggleCollapse={onToggleCollapse}
              repeated={repeated}
            />
          </div>
        )
      })}
    </div>
  )
})

type ColumnHeadersProps = {
  gridId: string
  columnDims: readonly ViewDim[]
  /** The rendered columns, ascending. */
  cols: readonly number[]
  /** Where each column starts, from the left edge of the body, and the total last. */
  colStarts: readonly number[]
  rowHeaderWidths: readonly number[]
  headerAt: (col: number) => Header | undefined
  lineItems: ReadonlyMap<string, LineItemInfo>
  callbacks: HeaderCallbacks
  contentWidth: number
}

/**
 * The sticky header rows above the body, one row for each column dimension. Columns that share
 * a member under the same parents share a cell, whose label stays in view while any of it is.
 */
export function ColumnHeaders({
  gridId,
  columnDims,
  cols,
  colStarts,
  rowHeaderWidths,
  headerAt,
  lineItems,
  callbacks,
  contentWidth,
}: ColumnHeadersProps) {
  const rowHeaderWidth = rowHeaderWidths.reduce((sum, width) => sum + width, 0)
  const lastLevel = columnDims.length - 1

  return (
    <div
      role="rowgroup"
      className="sticky top-0 z-20 bg-background"
      style={{ width: contentWidth, height: columnDims.length * HEADER_ROW_HEIGHT }}
    >
      {columnDims.map((dim, level) => (
        <div
          key={level}
          role="row"
          aria-rowindex={level + 1}
          className="relative"
          style={{ width: contentWidth, height: HEADER_ROW_HEIGHT }}
        >
          <div
            data-corner
            className="sticky left-0 z-10 flex h-full bg-background"
            style={{ width: rowHeaderWidth }}
            onContextMenu={stopMenu}
          >
            {rowHeaderWidths.map((width, rowLevel) => (
              <div key={rowLevel} className={`${CELL} relative bg-background`} style={{ width }}>
                {level === lastLevel && (
                  <ResizeHandle
                    kind="row-header"
                    width={width}
                    onResize={(next) => callbacks.onRowHeaderResize(rowLevel, next)}
                    onCancel={(start) => callbacks.onRowHeaderResize(rowLevel, start)}
                    onReset={() => callbacks.onRowHeaderResizeReset(rowLevel)}
                  />
                )}
              </div>
            ))}
          </div>
          {columnSpans(cols, headerAt, level).map((span) => {
            const left = rowHeaderWidth + colStarts[span.start]
            const width = colStarts[span.end + 1] - colStarts[span.start]
            const { member } = span
            const leaf = level === lastLevel
            const header = leaf ? headerAt(span.start) : undefined
            const key = callbacks.columns && header ? columnKey(header) : undefined
            const error = member && errorOf(dim, member, lineItems)
            return (
              <Fragment key={span.start}>
                <div
                  role="columnheader"
                  data-header-axis={member ? "column" : undefined}
                  data-header-level={member ? level : undefined}
                  data-header-index={member ? span.start : undefined}
                  aria-colindex={rowHeaderWidths.length + span.start + 1}
                  aria-colspan={span.end > span.start ? span.end - span.start + 1 : undefined}
                  aria-label={member?.label}
                  aria-expanded={member?.has_children ? !member.collapsed : undefined}
                  aria-describedby={member && error ? errorNoteId(gridId, member.key) : undefined}
                  aria-busy={member ? undefined : "true"}
                  className={`${CELL} absolute top-0 ${headerSurface(member)} ${
                    member?.is_summary ? "text-foreground" : "text-muted-foreground"
                  }`}
                  style={{ left, width }}
                  onContextMenu={member ? undefined : stopMenu}
                >
                  {member ? (
                    <div
                      className="sticky mx-auto flex w-fit max-w-full min-w-0 items-center gap-0.5 px-2"
                      style={{ left: rowHeaderWidth, right: 0 }}
                    >
                      <MemberLabel
                        member={member}
                        dim={dim}
                        lineItems={lineItems}
                        onToggleCollapse={callbacks.onToggleCollapse}
                      />
                    </div>
                  ) : (
                    <Skeleton className="mx-auto h-3 w-3/5" />
                  )}
                </div>
                {key !== undefined && (
                  <ResizeHandle
                    kind="column"
                    at={left + width}
                    width={width}
                    onResize={(next) => callbacks.columns?.onResize(key, next)}
                    onResizeEnd={(next) => callbacks.columns?.onResizeEnd(key, next)}
                    onCancel={() => callbacks.columns?.onResizeCancel()}
                    onReset={() => callbacks.columns?.onReset(key)}
                  />
                )}
              </Fragment>
            )
          })}
        </div>
      ))}
    </div>
  )
}
