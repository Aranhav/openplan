import {
  type Announcements,
  DndContext,
  type DragEndEvent,
  DragOverlay,
  KeyboardSensor,
  PointerSensor,
  closestCorners,
  useDroppable,
  useSensor,
  useSensors,
} from "@dnd-kit/core"
import {
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable"
import { CSS } from "@dnd-kit/utilities"
import {
  ArrowLeftRight,
  Columns3,
  GripVertical,
  MoreHorizontal,
  MoveDown,
  MoveUp,
} from "lucide-react"
import { useEffect, useRef, useState } from "react"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import type { ModuleDto, StructureDto } from "@/features/structure/types"
import { useElementMap } from "@/hooks/use-element-map"
import { cn } from "@/lib/utils"
import type { ViewDefinition, ViewDim } from "../view-types"
import { dimLabel } from "./dim-labels"
import { ZONES, type Zones, dropTarget } from "./pivot-drop"
import { ToolbarPanel } from "./toolbar-panel"
import { type ViewAction, type Zone, dimKey, reduceView } from "./view-state"

const ZONE_NAMES: Record<Zone, string> = { rows: "Rows", columns: "Columns", pages: "Pages" }

/** The dimensions of each zone of a view, in order. */
function dimsByZone(view: ViewDefinition): Record<Zone, ViewDim[]> {
  return { rows: view.rows, columns: view.columns, pages: (view.pages ?? []).map((page) => page.dim) }
}

interface PivotPopoverProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  module: ModuleDto
  structure: StructureDto
  view: ViewDefinition
  dispatch: (action: ViewAction) => void
}

/**
 * Where the dimensions of the module are: down the rows, across the columns or on a page. A
 * dimension is dragged to another place, or moved from the menu on its chip, which is the way
 * for a keyboard; every change applies at once.
 */
export function PivotPopover({
  open,
  onOpenChange,
  module,
  structure,
  view,
  dispatch,
}: PivotPopoverProps) {
  const dims = dimsByZone(view)
  const zones: Zones = {
    rows: dims.rows.map(dimKey),
    columns: dims.columns.map(dimKey),
    pages: dims.pages.map(dimKey),
  }
  const all = [...dims.rows, ...dims.columns, ...dims.pages]
  const labelOf = (id: string | number) => {
    const dim = all.find((candidate) => dimKey(candidate) === id)
    return dim ? dimLabel(dim, module, structure) : ZONE_NAMES[id as Zone]
  }
  const [dragging, setDragging] = useState<string>()
  const [announcement, setAnnouncement] = useState("")
  // The chip's menu button keeps focus when the chip lands in another zone, where it is drawn anew.
  const menus = useElementMap<HTMLButtonElement>()
  const moved = useRef<string>(undefined)
  useEffect(() => {
    if (moved.current !== undefined) {
      menus.get(moved.current)?.focus()
      moved.current = undefined
    }
  })

  const sensors = useSensors(
    // A few pixels of movement start a drag, so that a click on a chip is still a click.
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  )
  const announcements: Announcements = {
    onDragStart: ({ active }) => `Picked up ${labelOf(active.id)}.`,
    onDragOver: ({ active, over }) =>
      over ? `${labelOf(active.id)} is over ${labelOf(over.id)}.` : undefined,
    onDragEnd: ({ active, over }) => {
      const target = dropTarget(zones, String(active.id), over ? String(over.id) : undefined)
      const dim = all.find((candidate) => dimKey(candidate) === active.id)
      if (!target || !dim) {
        return `Dropped ${labelOf(active.id)}.`
      }
      return movesDim(dim, target.to, target.index)
        ? `Dropped ${labelOf(active.id)} in ${ZONE_NAMES[target.to]}, position ${target.index + 1}.`
        : `Dropped ${labelOf(active.id)}. It stays where it is.`
    },
    onDragCancel: ({ active }) => `Cancelled. ${labelOf(active.id)} has not moved.`,
  }

  /** Whether the dimension ends up somewhere else: not when it is dropped where it is, or is the last of the rows. */
  function movesDim(dim: ViewDim, to: Zone, index?: number) {
    return reduceView(view, { type: "move", dim, to, index }) !== view
  }

  function moveDim(dim: ViewDim, to: Zone, index?: number) {
    const name = dimLabel(dim, module, structure)
    if (!movesDim(dim, to, index)) {
      setAnnouncement(`${name} stays where it is.`)
      return
    }
    moved.current = dimKey(dim)
    dispatch({ type: "move", dim, to, index })
    setAnnouncement(`Moved ${name} to ${ZONE_NAMES[to]}.`)
  }

  function onDragEnd({ active, over }: DragEndEvent) {
    setDragging(undefined)
    const target = dropTarget(zones, String(active.id), over ? String(over.id) : undefined)
    const dim = all.find((candidate) => dimKey(candidate) === active.id)
    if (target && dim) {
      moveDim(dim, target.to, target.index)
    }
  }

  const trigger = (
    <Button variant="ghost" size="sm" className="gap-1.5 px-2">
      <Columns3 />
      Pivot
    </Button>
  )

  return (
    <ToolbarPanel
      open={open}
      onOpenChange={onOpenChange}
      trigger={trigger}
      label="Pivot"
      className="w-72"
    >
      <div className="flex items-center justify-between gap-2 pb-2">
        <h2 className="text-sm font-medium">Pivot</h2>
        <Button
          variant="outline"
          size="sm"
          disabled={view.columns.length === 0}
          onClick={() => {
            dispatch({ type: "swap" })
            setAnnouncement("Swapped rows and columns.")
          }}
        >
          <ArrowLeftRight />
          Swap rows and columns
        </Button>
      </div>
      <DndContext
        sensors={sensors}
        collisionDetection={closestCorners}
        onDragStart={({ active }) => setDragging(String(active.id))}
        onDragEnd={onDragEnd}
        onDragCancel={() => setDragging(undefined)}
        accessibility={{ announcements }}
      >
        <div className="flex flex-col gap-2">
          {ZONES.map((zone) => (
            <PivotZone
              key={zone}
              zone={zone}
              dims={dims[zone]}
              onlyRow={zone === "rows" && dims.rows.length === 1}
              label={(dim) => dimLabel(dim, module, structure)}
              menuRef={menus.refFor}
              onMove={moveDim}
            />
          ))}
        </div>
        <DragOverlay>
          {dragging !== undefined && (
            <div className="flex items-center gap-1.5 rounded-md border bg-popover px-2 py-1.5 text-sm shadow-md">
              <GripVertical className="size-4 text-muted-foreground" />
              {labelOf(dragging)}
            </div>
          )}
        </DragOverlay>
      </DndContext>
      <div role="status" className="sr-only">
        {announcement}
      </div>
    </ToolbarPanel>
  )
}

interface PivotZoneProps {
  zone: Zone
  dims: ViewDim[]
  /** The rows have only one dimension, which stays there. */
  onlyRow: boolean
  label: (dim: ViewDim) => string
  menuRef: (id: string) => (element: HTMLButtonElement | null) => void
  onMove: (dim: ViewDim, to: Zone, index?: number) => void
}

function PivotZone({ zone, dims, onlyRow, label, menuRef, onMove }: PivotZoneProps) {
  const { setNodeRef, isOver } = useDroppable({ id: zone })
  const headingId = `pivot-zone-${zone}`
  return (
    <section aria-labelledby={headingId}>
      <h3 id={headingId} className="pb-1 text-xs font-medium text-muted-foreground">
        {ZONE_NAMES[zone]}
      </h3>
      <ul
        ref={setNodeRef}
        className={cn(
          "flex min-h-10 flex-col gap-1 rounded-md border border-dashed p-1 transition-colors",
          isOver && "border-primary bg-accent",
        )}
      >
        <SortableContext items={dims.map(dimKey)} strategy={verticalListSortingStrategy}>
          {dims.map((dim, index) => (
            <PivotChip
              key={dimKey(dim)}
              dim={dim}
              name={label(dim)}
              zone={zone}
              index={index}
              count={dims.length}
              onlyRow={onlyRow}
              menuRef={menuRef(dimKey(dim))}
              onMove={onMove}
            />
          ))}
        </SortableContext>
        {dims.length === 0 && (
          <li className="px-2 py-1.5 text-xs text-muted-foreground">Drop a dimension here</li>
        )}
      </ul>
      {onlyRow && (
        <p className="pt-1 text-xs text-muted-foreground">One dimension stays on the rows.</p>
      )}
    </section>
  )
}

interface PivotChipProps {
  dim: ViewDim
  name: string
  zone: Zone
  index: number
  count: number
  onlyRow: boolean
  menuRef: (element: HTMLButtonElement | null) => void
  onMove: (dim: ViewDim, to: Zone, index?: number) => void
}

function PivotChip({
  dim,
  name,
  zone,
  index,
  count,
  onlyRow,
  menuRef,
  onMove,
}: PivotChipProps) {
  const leavesRowsEmpty = zone === "rows" && onlyRow
  // The one dimension of the rows stays there, so there is nothing to pick up.
  const { attributes, listeners, setNodeRef, setActivatorNodeRef, transform, transition, isDragging } =
    useSortable({ id: dimKey(dim), disabled: leavesRowsEmpty })
  return (
    <li
      ref={setNodeRef}
      style={{ transform: CSS.Translate.toString(transform), transition }}
      className={cn(
        "flex items-center gap-1 rounded-md border bg-background py-0.5 pr-0.5 pl-0.5 text-sm",
        isDragging && "relative z-10 opacity-60 shadow-md",
      )}
    >
      <Button
        ref={setActivatorNodeRef}
        type="button"
        variant="ghost"
        size="icon-xs"
        {...attributes}
        {...listeners}
        aria-label={`Drag ${name}`}
        disabled={leavesRowsEmpty}
        className="cursor-grab touch-none text-muted-foreground hover:text-foreground active:cursor-grabbing"
      >
        <GripVertical />
      </Button>
      <span className="min-w-0 flex-1 truncate">{name}</span>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            ref={menuRef}
            type="button"
            variant="ghost"
            size="icon-xs"
            aria-label={`Move ${name}`}
          >
            <MoreHorizontal />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          {(["rows", "columns", "pages"] as const).map((to) => (
            <DropdownMenuItem
              key={to}
              disabled={to === zone || leavesRowsEmpty}
              onSelect={() => onMove(dim, to)}
            >
              Move to {ZONE_NAMES[to]}
            </DropdownMenuItem>
          ))}
          <DropdownMenuSeparator />
          <DropdownMenuItem disabled={index === 0} onSelect={() => onMove(dim, zone, index - 1)}>
            <MoveUp />
            Move earlier
          </DropdownMenuItem>
          <DropdownMenuItem
            disabled={index === count - 1}
            onSelect={() => onMove(dim, zone, index + 1)}
          >
            <MoveDown />
            Move later
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </li>
  )
}
