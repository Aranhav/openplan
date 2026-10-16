import {
  type Announcements,
  DndContext,
  type DragEndEvent,
  KeyboardSensor,
  type Modifier,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
} from "@dnd-kit/core"
import {
  SortableContext,
  arrayMove,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable"
import { CSS } from "@dnd-kit/utilities"
import { ArrowDown, ArrowUp, GripVertical, MoreHorizontal, Settings2, Trash2 } from "lucide-react"
import { type KeyboardEvent, type Ref, useEffect, useId, useState } from "react"
import { ProductionLock } from "@/components/production-lock"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import type { FormulaError } from "@/features/grid/view-types"
import {
  dimsLabel,
  formatLabel,
  summaryLabel,
  timeLevelLabel,
  timeScaleLabel,
  versionsLabel,
} from "@/features/structure/labels"
import type { LineItemDto, ModuleDto, StructureDto } from "@/features/structure/types"
import { cn } from "@/lib/utils"
import { FormulaCell, Inherited, Truncated } from "./line-item-cells"

/** The dragged row follows the pointer up and down, not sideways. */
const verticalOnly: Modifier = ({ transform }) => ({ ...transform, x: 0 })

const SORT_INSTRUCTIONS =
  "To reorder, press space to pick up the line item, the up and down arrow keys to move it, and space to drop it. Press escape to cancel."

interface BlueprintTableProps {
  lineItems: LineItemDto[]
  module: ModuleDto
  structure: StructureDto
  /** What is wrong with the formulas, by line item. */
  errors: ReadonlyMap<string, FormulaError[]>
  selectedId: string | undefined
  onSelect: (id: string) => void
  onOpenSettings: (id: string) => void
  /** Puts the line items in this order. */
  onReorder: (ids: string[]) => void
  onDelete: (id: string) => void
  /** Whether the signed-in user may reorder and delete line items. */
  canEdit: boolean
  /** Whether production mode switches reordering and deleting off. */
  locked: boolean
  /** A new order is being saved. */
  busy: boolean
  /** Describes how to use the table; the table points to it. */
  hintId: string
  tableRef: Ref<HTMLTableElement>
}

/**
 * The line items of a module, one to a row. It is a grid in the sense of ARIA: the table takes
 * the focus, the arrow keys move the selected row, Enter opens its settings, and the controls of
 * the selected row are the ones the Tab key reaches.
 */
export function BlueprintTable({
  lineItems,
  module,
  structure,
  errors,
  selectedId,
  onSelect,
  onOpenSettings,
  onReorder,
  onDelete,
  canEdit,
  locked,
  busy,
  hintId,
  tableRef,
}: BlueprintTableProps) {
  const gridId = useId()
  const inherited = inheritedValues(module, structure)
  const rowId = (id: string) => `${gridId}-${id}`
  const ids = lineItems.map((item) => item.id)
  const selectedIndex = selectedId === undefined ? -1 : ids.indexOf(selectedId)
  const [announcement, setAnnouncement] = useState("")
  const sensors = useSensors(
    // A few pixels of movement start a drag, so that a click or a double click still selects.
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  )

  // Keeps the selected row in view as the arrow keys move it, below the sticky header.
  useEffect(() => {
    if (selectedId !== undefined) {
      document.getElementById(`${gridId}-${selectedId}`)?.scrollIntoView({ block: "nearest" })
    }
  }, [gridId, selectedId])

  const nameOf = (id: string | number) =>
    lineItems.find((item) => item.id === id)?.name ?? "The line item"
  const positionOf = (id: string | number) => `${ids.indexOf(String(id)) + 1} of ${ids.length}`
  const announcements: Announcements = {
    onDragStart: ({ active }) =>
      `Picked up ${nameOf(active.id)}, at position ${positionOf(active.id)}.`,
    onDragOver: ({ active, over }) =>
      over ? `${nameOf(active.id)} is over position ${positionOf(over.id)}.` : undefined,
    onDragEnd: ({ active, over }) =>
      over
        ? `Dropped ${nameOf(active.id)} at position ${positionOf(over.id)}.`
        : `Dropped ${nameOf(active.id)}.`,
    onDragCancel: ({ active }) =>
      `Cancelled. ${nameOf(active.id)} is back at position ${positionOf(active.id)}.`,
  }

  function onDragEnd({ active, over }: DragEndEvent) {
    if (over && active.id !== over.id) {
      onReorder(arrayMove(ids, ids.indexOf(String(active.id)), ids.indexOf(String(over.id))))
    }
  }

  function move(id: string, by: -1 | 1) {
    const from = ids.indexOf(id)
    const to = from + by
    if (to < 0 || to >= ids.length) {
      return
    }
    onReorder(arrayMove(ids, from, to))
    setAnnouncement(`Moved ${nameOf(id)} to position ${to + 1} of ${ids.length}.`)
  }

  function onKeyDown(event: KeyboardEvent<HTMLTableElement>) {
    // The controls inside the rows have their own keys.
    if (event.target !== event.currentTarget || event.ctrlKey || event.altKey || event.metaKey) {
      return
    }
    const last = ids.length - 1
    let next: number | undefined
    switch (event.key) {
      case "ArrowDown":
        next = selectedIndex < 0 ? 0 : Math.min(selectedIndex + 1, last)
        break
      case "ArrowUp":
        next = selectedIndex < 0 ? last : Math.max(selectedIndex - 1, 0)
        break
      case "Home":
        next = 0
        break
      case "End":
        next = last
        break
      case "Enter":
        if (selectedIndex < 0) {
          return
        }
        onOpenSettings(ids[selectedIndex])
        event.preventDefault()
        return
      default:
        return
    }
    event.preventDefault()
    onSelect(ids[next])
  }

  return (
    <div className="rounded-lg border">
      <DndContext
        sensors={sensors}
        collisionDetection={closestCenter}
        modifiers={[verticalOnly]}
        onDragEnd={onDragEnd}
        accessibility={{
          announcements,
          screenReaderInstructions: { draggable: SORT_INSTRUCTIONS },
        }}
      >
        <SortableContext items={ids} strategy={verticalListSortingStrategy}>
          <Table
            ref={tableRef}
            role="grid"
            aria-label="Line items"
            aria-describedby={hintId}
            aria-busy={busy || undefined}
            aria-activedescendant={selectedIndex < 0 ? undefined : rowId(ids[selectedIndex])}
            tabIndex={0}
            onKeyDown={onKeyDown}
            className="min-w-[960px] table-fixed outline-none focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring"
          >
            <TableHeader>
              <TableRow className="hover:bg-background [&>th]:h-9">
                {canEdit && (
                  <TableHead className="sticky left-0 z-[2] w-8 bg-background px-0">
                    <span className="sr-only">Reorder</span>
                  </TableHead>
                )}
                <TableHead
                  className={cn(
                    "sticky z-[2] w-36 bg-background",
                    canEdit ? "left-8" : "left-0 w-40 pl-4",
                  )}
                >
                  Name
                </TableHead>
                <TableHead className="w-32">Format</TableHead>
                <TableHead>Formula</TableHead>
                <TableHead className="w-24">Applies to</TableHead>
                <TableHead className="w-20">Time scale</TableHead>
                <TableHead className="w-26">Versions</TableHead>
                <TableHead className="w-20">Summary</TableHead>
                <TableHead className="w-20">Notes</TableHead>
                <TableHead className="sticky right-0 z-[2] w-10 bg-background px-1 shadow-[inset_1px_0_0_0_var(--border)]">
                  <span className="sr-only">Actions</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {lineItems.map((item, index) => (
                <BlueprintRow
                  key={item.id}
                  id={rowId(item.id)}
                  item={item}
                  structure={structure}
                  inherited={inherited}
                  errors={errors.get(item.id) ?? NO_ERRORS}
                  first={index === 0}
                  last={index === lineItems.length - 1}
                  selected={item.id === selectedId}
                  onSelect={onSelect}
                  onOpenSettings={onOpenSettings}
                  onMove={move}
                  onDelete={onDelete}
                  canEdit={canEdit}
                  locked={locked}
                  busy={busy}
                />
              ))}
            </TableBody>
          </Table>
        </SortableContext>
      </DndContext>
      <div role="status" className="sr-only">
        {announcement}
      </div>
    </div>
  )
}

const NO_ERRORS: FormulaError[] = []

/**
 * What assistive technology reads out as the arrow keys reach a row, in place of every cell of it.
 * A formula with errors says what is wrong, since the icon's tooltip is for the pointer.
 */
function rowLabel(item: LineItemDto, structure: StructureDto, errors: FormulaError[]) {
  return [
    item.name,
    formatLabel(item.format, structure),
    item.formula ? "calculated" : "input",
    ...(errors.length > 0 ? [`formula has errors: ${errors[0].message}`] : []),
  ].join(", ")
}

/** What a line item that sets nothing of its own has, from its module. */
interface Inheritance {
  appliesTo: string
  timeScale: string
  versions: string
}

function inheritedValues(module: ModuleDto, structure: StructureDto): Inheritance {
  const time = module.axes.find((axis) => axis.kind === "time")
  return {
    appliesTo: dimsLabel(
      module.axes.filter((axis) => axis.kind === "list" || axis.kind === "subset"),
      structure,
    ),
    timeScale: time ? timeLevelLabel(time.level) : "None",
    versions: module.axes.some((axis) => axis.kind === "versions") ? "All versions" : "None",
  }
}

interface BlueprintRowProps {
  id: string
  item: LineItemDto
  structure: StructureDto
  inherited: Inheritance
  errors: FormulaError[]
  first: boolean
  last: boolean
  selected: boolean
  onSelect: (id: string) => void
  onOpenSettings: (id: string) => void
  onMove: (id: string, by: -1 | 1) => void
  onDelete: (id: string) => void
  canEdit: boolean
  locked: boolean
  busy: boolean
}

function BlueprintRow({
  id,
  item,
  structure,
  inherited,
  errors,
  first,
  last,
  selected,
  onSelect,
  onOpenSettings,
  onMove,
  onDelete,
  canEdit,
  locked,
  busy,
}: BlueprintRowProps) {
  const frozen = locked || busy
  const {
    attributes,
    listeners,
    setNodeRef,
    setActivatorNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: item.id, disabled: !canEdit || frozen })
  // Only the selected row's controls are on the Tab key's path; the arrow keys reach the others.
  const tabIndex = selected ? 0 : -1

  return (
    <TableRow
      ref={setNodeRef}
      id={id}
      aria-selected={selected}
      aria-label={rowLabel(item, structure, errors)}
      data-state={selected ? "selected" : undefined}
      style={{ transform: CSS.Translate.toString(transform), transition }}
      className={cn(
        "scroll-mt-20 bg-background [&>td]:py-1 hover:bg-[color-mix(in_oklab,var(--muted)_50%,var(--background))] data-[state=selected]:bg-muted data-[state=selected]:[&>td:first-child]:shadow-[inset_2px_0_0_0_var(--primary)]",
        isDragging && "relative z-10 bg-muted shadow-md",
      )}
      onClick={() => onSelect(item.id)}
      onDoubleClick={() => onOpenSettings(item.id)}
    >
      {canEdit && (
        <TableCell className="sticky left-0 z-[1] bg-inherit px-0 text-center">
          <ProductionLock locked={locked}>
            <Button
              ref={setActivatorNodeRef}
              type="button"
              variant="ghost"
              size="icon-xs"
              {...attributes}
              {...listeners}
              tabIndex={tabIndex}
              aria-label={`Reorder ${item.name}`}
              disabled={frozen}
              className="cursor-grab touch-none text-muted-foreground hover:text-foreground active:cursor-grabbing"
            >
              <GripVertical className="size-4" />
            </Button>
          </ProductionLock>
        </TableCell>
      )}
      <TableCell
        className={cn(
          "sticky z-[1] truncate bg-inherit font-medium",
          canEdit ? "left-8" : "left-0 pl-4",
        )}
      >
        <Truncated>{item.name}</Truncated>
      </TableCell>
      <TableCell className="truncate">
        <Truncated>{formatLabel(item.format, structure)}</Truncated>
      </TableCell>
      <TableCell className="truncate">
        <FormulaCell
          formula={item.formula}
          errors={errors}
          tabIndex={tabIndex}
          onOpen={() => onOpenSettings(item.id)}
        />
      </TableCell>
      <TableCell className="truncate">
        {item.applies_to ? (
          <Truncated>{dimsLabel(item.applies_to, structure)}</Truncated>
        ) : (
          <Inherited>{inherited.appliesTo}</Inherited>
        )}
      </TableCell>
      <TableCell className="truncate">
        {item.time_scale === "module" ? (
          <Inherited>{inherited.timeScale}</Inherited>
        ) : (
          <Truncated>{timeScaleLabel(item.time_scale)}</Truncated>
        )}
      </TableCell>
      <TableCell className="truncate">
        {item.versions === "module" ? (
          <Inherited>{inherited.versions}</Inherited>
        ) : (
          <Truncated>{versionsLabel(item.versions, structure)}</Truncated>
        )}
      </TableCell>
      <TableCell className="truncate">
        <Truncated>{summaryLabel(item.summary)}</Truncated>
      </TableCell>
      <TableCell className="truncate text-muted-foreground">
        <Truncated>{item.notes}</Truncated>
      </TableCell>
      <TableCell className="sticky right-0 z-[1] bg-inherit px-1 text-right shadow-[inset_1px_0_0_0_var(--border)]">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              className="size-7"
              tabIndex={tabIndex}
              aria-label={`Actions for ${item.name}`}
            >
              <MoreHorizontal />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onSelect={() => onOpenSettings(item.id)}>
              <Settings2 />
              Line item settings
            </DropdownMenuItem>
            {canEdit && (
              <>
                <DropdownMenuItem disabled={frozen || first} onSelect={() => onMove(item.id, -1)}>
                  <ArrowUp />
                  Move up
                </DropdownMenuItem>
                <DropdownMenuItem disabled={frozen || last} onSelect={() => onMove(item.id, 1)}>
                  <ArrowDown />
                  Move down
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  variant="destructive"
                  disabled={locked}
                  onSelect={() => onDelete(item.id)}
                >
                  <Trash2 />
                  Delete line item
                </DropdownMenuItem>
              </>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      </TableCell>
    </TableRow>
  )
}
