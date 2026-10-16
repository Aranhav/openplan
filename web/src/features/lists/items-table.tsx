import { useVirtualizer } from "@tanstack/react-virtual"
import { ChevronRight } from "lucide-react"
import { type Ref, useMemo, useRef } from "react"
import { toast } from "sonner"
import { z } from "zod"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { useUpdateItem } from "@/features/structure/api"
import { errorDetail } from "@/lib/api/client"
import type { components } from "@/lib/api/schema"
import { cn } from "@/lib/utils"
import { structureNameSchema } from "@/lib/validation"
import { InlineText } from "@/components/inline-text"
import { NewItemRow } from "./new-item-row"
import { ParentPicker } from "./parent-picker"
import type { TreeRow } from "./tree"
import type { ItemDto, ListDto } from "./types"
import { VIRTUALIZE_ABOVE } from "./virtual"
import { countOf } from "@/lib/format"

/** A row's height: 40px that every cell is held to, and 1px of border. The windowing counts on it. */
const ROW_HEIGHT = 41
const OVERSCAN = 12

/** The shadcn checkbox draws a tick for the mixed state too; this draws the dash it should. */
const MIXED =
  "data-[state=indeterminate]:flex data-[state=indeterminate]:items-center data-[state=indeterminate]:justify-center data-[state=indeterminate]:border-primary data-[state=indeterminate]:bg-primary data-[state=indeterminate]:*:hidden data-[state=indeterminate]:after:block data-[state=indeterminate]:after:h-0.5 data-[state=indeterminate]:after:w-2 data-[state=indeterminate]:after:bg-primary-foreground"

const codeSchema = z.string().trim()

type UpdateItemRequest = components["schemas"]["UpdateItemRequest"]

interface ItemsTableProps {
  modelId: string
  list: ListDto
  /** The list above this one, whose items the rows are grouped under. */
  parentList?: ListDto
  /** The items of the parent list, which an item can be moved between. */
  parents?: ItemDto[]
  rows: TreeRow[]
  /** Whether the user may change the items now: a builder, outside production mode. */
  editable: boolean
  selected: ReadonlySet<string>
  onToggle: (id: string, checked: boolean) => void
  allSelected: boolean | "indeterminate"
  onToggleAll: (checked: boolean) => void
  onToggleGroup: (parentId: string) => void
  /** Whether the row for typing in a new item is shown. */
  adding: boolean
  onStopAdding: () => void
  /** The input of the new item's name, for the button that starts adding to put focus in. */
  newItemNameRef?: Ref<HTMLInputElement>
  selectAllRef?: Ref<HTMLButtonElement>
}

/** The items of a list as a table: groups of a parent list fold, items edit in place, and a long table is windowed. */
export function ItemsTable({
  modelId,
  list,
  parentList,
  parents,
  rows,
  editable,
  selected,
  onToggle,
  allSelected,
  onToggleAll,
  onToggleGroup,
  adding,
  onStopAdding,
  newItemNameRef,
  selectAllRef,
}: ItemsTableProps) {
  const updateItem = useUpdateItem(modelId)
  const frame = useRef<HTMLDivElement>(null)
  const windowed = rows.length > VIRTUALIZE_ABOVE
  const hasParent = parents !== undefined
  const columns = (editable ? 1 : 0) + 2 + (hasParent ? 1 : 0)

  // eslint-disable-next-line react-hooks/incompatible-library -- the table only reads from it
  const virtualizer = useVirtualizer({
    count: rows.length,
    // The table's own container is what scrolls, so that its header can stay in view.
    getScrollElement: () =>
      frame.current?.querySelector<HTMLElement>("[data-slot='table-container']") ?? null,
    estimateSize: () => ROW_HEIGHT,
    overscan: OVERSCAN,
    enabled: windowed,
  })
  const shown = windowed ? virtualizer.getVirtualItems() : undefined
  const indexes = shown ? shown.map((item) => item.index) : rows.map((_, index) => index)
  const before = shown?.length ? shown[0].start : 0
  const after = shown?.length ? virtualizer.getTotalSize() - shown[shown.length - 1].end : 0

  const parentsById = useMemo(
    () => new Map(parents?.map((parent) => [parent.id, parent])),
    [parents],
  )

  // The item being saved: a name, a code or a parent of it changes, and the others wait.
  const savingId = updateItem.isPending ? updateItem.variables?.itemId : undefined

  async function saveItem(item: ItemDto, body: UpdateItemRequest) {
    await updateItem.mutateAsync({ listId: list.id, itemId: item.id, body })
  }

  return (
    <div
      ref={frame}
      className={cn(
        "rounded-lg border",
        windowed &&
          "[&_[data-slot='table-container']]:max-h-[70svh] [&_[data-slot='table-container']]:overflow-y-auto",
      )}
    >
      <Table
        aria-label={`Items of ${list.name}`}
        aria-rowcount={windowed ? rows.length + 1 : undefined}
        className="min-w-[32rem]"
      >
        <TableHeader className="sticky top-0 z-10 bg-background shadow-[0_1px_0_0_var(--border)]">
          <TableRow>
            {editable && (
              <TableHead className="w-10 pl-4">
                <Checkbox
                  ref={selectAllRef}
                  aria-label="Select all items"
                  className={MIXED}
                  checked={allSelected}
                  onCheckedChange={(checked) => onToggleAll(checked === true)}
                />
              </TableHead>
            )}
            <TableHead className={cn("w-full min-w-48", hasParent ? "pl-8" : !editable && "pl-4")}>
              Name
            </TableHead>
            <TableHead className={hasParent ? "min-w-36" : "min-w-72 pr-4"}>Code</TableHead>
            {hasParent && <TableHead className="min-w-52 pr-4">Parent</TableHead>}
          </TableRow>
        </TableHeader>
        <TableBody>
          {editable && adding && (
            <NewItemRow
              modelId={modelId}
              listId={list.id}
              parents={parents}
              parentList={parentList?.name}
              nameRef={newItemNameRef}
              onClose={onStopAdding}
            />
          )}
          {before > 0 && <Spacer height={before} columns={columns} />}
          {indexes.map((index) => {
            const row = rows[index]
            const rowProps = { "aria-rowindex": index + 2 }
            if (row.kind === "group") {
              return (
                <TableRow key={row.key} className="bg-muted/40 hover:bg-muted/40" {...rowProps}>
                  <TableCell colSpan={columns} className="h-10 py-1 pl-2">
                    <Button
                      variant="ghost"
                      size="sm"
                      aria-expanded={!row.collapsed}
                      aria-label={`${row.parent.name}, ${countOf(row.count, "item")}`}
                      className="max-w-full gap-2 font-semibold"
                      onClick={() => onToggleGroup(row.parent.id)}
                    >
                      <ChevronRight
                        className={cn("transition-transform", !row.collapsed && "rotate-90")}
                      />
                      <span className="truncate">{row.parent.name}</span>
                      {/* The space keeps the text of the button, "EMEA 2", in its name. */}
                      {" "}
                      <Badge variant="secondary">{row.count.toLocaleString("en")}</Badge>
                    </Button>
                  </TableCell>
                </TableRow>
              )
            }
            const { item } = row
            const parent = item.parent_id ? parentsById.get(item.parent_id) : undefined
            return (
              <TableRow
                key={row.key}
                data-state={selected.has(item.id) ? "selected" : undefined}
                {...rowProps}
              >
                {editable && (
                  <TableCell className="h-10 w-10 py-1 pl-4">
                    <Checkbox
                      aria-label={`Select ${item.name}`}
                      checked={selected.has(item.id)}
                      onCheckedChange={(checked) => onToggle(item.id, checked === true)}
                    />
                  </TableCell>
                )}
                <TableCell
                  className={cn(
                    "h-10 w-full max-w-0 min-w-48 py-1",
                    hasParent ? "pl-8" : !editable && "pl-4",
                  )}
                >
                  {editable ? (
                    <InlineText
                      value={item.name}
                      label={`Rename ${item.name}`}
                      inputLabel={`Name of ${item.name}`}
                      schema={structureNameSchema}
                      onSave={async (name) => {
                        await saveItem(item, { name })
                        toast.success("Item renamed")
                      }}
                    />
                  ) : (
                    <span className="block truncate" title={item.name}>
                      {item.name}
                    </span>
                  )}
                </TableCell>
                <TableCell className={cn("h-10 py-1", !hasParent && "pr-4")}>
                  {editable ? (
                    <InlineText
                      value={item.code ?? ""}
                      label={
                        item.code
                          ? `Edit the code of ${item.name}, ${item.code}`
                          : `Add code for ${item.name}`
                      }
                      inputLabel={`Code of ${item.name}`}
                      schema={codeSchema}
                      placeholder="Add code"
                      onSave={async (code) => {
                        await saveItem(item, { code: code || null })
                        toast.success("Code saved")
                      }}
                    />
                  ) : (
                    <span className="text-muted-foreground">{item.code}</span>
                  )}
                </TableCell>
                {hasParent && (
                  <TableCell className="h-10 py-1 pr-4">
                    {editable ? (
                      <ParentPicker
                        parents={parents}
                        parentList={parentList?.name ?? "the parent list"}
                        selected={parent}
                        label={`Parent of ${item.name}`}
                        pending={savingId === item.id}
                        onChange={(parentId) =>
                          void saveItem(item, { parent_id: parentId }).then(
                            () =>
                              toast.success(
                                `Moved ${item.name} to ${parentsById.get(parentId)?.name ?? "the new parent"}`,
                              ),
                            (error) => toast.error(errorDetail(error)),
                          )
                        }
                      />
                    ) : (
                      parent?.name
                    )}
                  </TableCell>
                )}
              </TableRow>
            )
          })}
          {after > 0 && <Spacer height={after} columns={columns} />}
        </TableBody>
      </Table>
    </div>
  )
}

function Spacer({ height, columns }: { height: number; columns: number }) {
  return (
    <tr aria-hidden="true">
      <td colSpan={columns} style={{ height }} />
    </tr>
  )
}
