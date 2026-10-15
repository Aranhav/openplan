import { ChevronDown, ChevronRight, CircleAlert } from "lucide-react"
import { Fragment, memo, useRef } from "react"
import { Button } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import {
  HEADER_ROW_HEIGHT,
  INDENT,
  clampWidth,
  columnKey,
  columnSpans,
  startsRowGroup,
} from "./grid-layout"
import type { Header, LineItemInfo, Member, MemberRef, ViewDim } from "./view-types"

const CELL = "box-border flex h-full items-center border-r border-b border-border bg-muted text-sm"

export type HeaderCallbacks = {
  /** Absent when the grid cannot collapse members; then no chevron is drawn. */
  onToggleCollapse?: (member: MemberRef) => void
  /** Absent when the columns cannot be resized; then their edges have no handles. */
  columns?: {
    onResize: (key: string, width: number) => void
    onResizeEnd: (key: string, width: number) => void
    onReset: (key: string) => void
  }
  onRowHeaderResize: (level: number, width: number) => void
  onRowHeaderResizeReset: (level: number) => void
}

type ResizeHandleProps = {
  label: string
  width: number
  onResize: (width: number) => void
  onResizeEnd?: (width: number) => void
  onReset: () => void
  /** Where the edge is, from the left of its row; without it the handle sits on its parent's right edge. */
  at?: number
}

/** The edge a header is dragged by: it widens live, and double click puts it back. */
function ResizeHandle({ label, width, onResize, onResizeEnd, onReset, at }: ResizeHandleProps) {
  const drag = useRef<{ startX: number; startWidth: number; moved: boolean } | null>(null)
  const widthAt = (clientX: number, start: { startX: number; startWidth: number }) =>
    clampWidth(start.startWidth + clientX - start.startX)

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      className="absolute top-0 h-full w-2 cursor-col-resize touch-none transition-colors hover:bg-primary/30 active:bg-primary/50"
      style={at === undefined ? { right: -4 } : { left: at - 4 }}
      onPointerDown={(event) => {
        event.preventDefault()
        event.stopPropagation()
        event.currentTarget.setPointerCapture(event.pointerId)
        drag.current = { startX: event.clientX, startWidth: width, moved: false }
      }}
      onPointerMove={(event) => {
        const start = drag.current
        if (start) {
          start.moved = true
          onResize(widthAt(event.clientX, start))
        }
      }}
      onPointerUp={(event) => {
        const start = drag.current
        drag.current = null
        if (start?.moved) {
          onResizeEnd?.(widthAt(event.clientX, start))
        }
      }}
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

type MemberLabelProps = {
  member: Member
  dim: ViewDim | undefined
  lineItems: ReadonlyMap<string, LineItemInfo>
  onToggleCollapse?: (member: MemberRef) => void
  /** A repeat of a label shown above: the chevron is left for the first of them. */
  repeated?: boolean
}

/** A member's name with a chevron when it has children, and a mark when its line item is in error. */
function MemberLabel({ member, dim, lineItems, onToggleCollapse, repeated }: MemberLabelProps) {
  const error = dim?.kind === "line_items" ? lineItems.get(member.key)?.errors[0] : undefined
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
          onClick={() => onToggleCollapse({ dim, key: member.key })}
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
  header: Header | undefined
  /** The header of the row above, to tell the first row of a group from the rest. */
  previous: Header | undefined
  rowDims: readonly ViewDim[]
  /** The width of each row dimension's column. */
  widths: readonly number[]
  lineItems: ReadonlyMap<string, LineItemInfo>
  onToggleCollapse?: (member: MemberRef) => void
}

/** The sticky headers at the start of a body row, one cell for each row dimension. */
export const RowHeaders = memo(function RowHeaders({
  header,
  previous,
  rowDims,
  widths,
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
              className={`${CELL} px-2`}
              style={{ width }}
            >
              <Skeleton className="h-3 w-3/5" />
            </div>
          )
        }
        // Outer dimensions repeat on every row; only the first row of a group stands out.
        const muted = level < rowDims.length - 1 && !startsRowGroup(previous, header, level)
        return (
          <div
            key={level}
            role="rowheader"
            aria-colindex={level + 1}
            aria-label={member.label}
            className={`${CELL} gap-0.5 pr-2 ${muted ? "text-muted-foreground" : "text-foreground"} ${
              member.is_summary ? "font-semibold" : ""
            }`}
            style={{ width, paddingLeft: 8 + member.depth * INDENT }}
          >
            <MemberLabel
              member={member}
              dim={dim}
              lineItems={lineItems}
              onToggleCollapse={onToggleCollapse}
              repeated={muted}
            />
          </div>
        )
      })}
    </div>
  )
})

type ColumnHeadersProps = {
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
            className="sticky left-0 z-10 flex h-full bg-background"
            style={{ width: rowHeaderWidth }}
          >
            {rowHeaderWidths.map((width, rowLevel) => (
              <div key={rowLevel} className={`${CELL} relative`} style={{ width }}>
                {level === lastLevel && (
                  <ResizeHandle
                    label="Resize row headers"
                    width={width}
                    onResize={(next) => callbacks.onRowHeaderResize(rowLevel, next)}
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
            return (
              <Fragment key={span.start}>
                <div
                  role="columnheader"
                  aria-colindex={rowHeaderWidths.length + span.start + 1}
                  aria-colspan={span.end > span.start ? span.end - span.start + 1 : undefined}
                  aria-label={member?.label}
                  aria-busy={member ? undefined : "true"}
                  className={`${CELL} absolute top-0 text-foreground ${
                    member?.is_summary ? "font-semibold" : "font-medium"
                  }`}
                  style={{ left, width }}
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
                    label="Resize column"
                    at={left + width}
                    width={width}
                    onResize={(next) => callbacks.columns?.onResize(key, next)}
                    onResizeEnd={(next) => callbacks.columns?.onResizeEnd(key, next)}
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
