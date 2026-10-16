import { Layers, ListPlus, Plus, Trash2, X } from "lucide-react"
import { useEffect, useMemo, useRef, useState } from "react"
import { toast } from "sonner"
import { DeleteDialog } from "@/components/delete-dialog"
import { EmptyState } from "@/components/empty-state"
import { ErrorState } from "@/components/error-state"
import { ProductionLock } from "@/components/production-lock"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Skeleton } from "@/components/ui/skeleton"
import type { StructureDto } from "@/features/structure/types"
import { useDeleteItems } from "@/features/structure/api"
import { useRestoreFocus } from "@/hooks/use-restore-focus"
import { errorDetail } from "@/lib/api/client"
import { BulkAddDialog } from "./bulk-add-dialog"
import { useListItems } from "./api"
import { blockedByChildren, blockedMessage } from "./hierarchy"
import { ItemsTable } from "./items-table"
import { SubsetsSheet } from "./subsets-sheet"
import { withIds } from "./selection"
import { buildRows } from "./tree"
import type { ItemDto, ListDto } from "./types"
import { countOf } from "@/lib/format"

interface ItemsTabProps {
  modelId: string
  list: ListDto
  structure: StructureDto
  canEdit: boolean
  locked: boolean
}

/** Tells the user a read of items that are on screen already has failed, which the screen otherwise would not show. */
function useRefetchFailureToast(query: {
  isRefetchError: boolean
  error: Error | null
  errorUpdatedAt: number
}) {
  const { isRefetchError, error, errorUpdatedAt } = query
  useEffect(() => {
    if (isRefetchError) {
      toast.error(errorDetail(error))
    }
  }, [isRefetchError, error, errorUpdatedAt])
}

/** The items of a list, and what can be done to them. */
export function ItemsTab({ modelId, list, structure, canEdit, locked }: ItemsTabProps) {
  const items = useListItems(modelId, list.id)
  const parentList = list.parent
    ? structure.lists.find((other) => other.id === list.parent)
    : undefined
  const parentItems = useListItems(modelId, parentList?.id)

  useRefetchFailureToast(items)
  useRefetchFailureToast(parentItems)

  // The error takes the place of the table only when there is no table to keep: a refresh that
  // fails behind items already on screen leaves them alone, and a toast says so.
  const failed = [items, parentItems].filter((query) => query.isError && query.data === undefined)
  if (failed.length > 0) {
    return (
      <ErrorState
        error={failed[0].error}
        onRetry={() => failed.forEach((query) => void query.refetch())}
      />
    )
  }
  if (!items.data || (parentList && !parentItems.data)) {
    return <ItemsSkeleton />
  }
  return (
    <LoadedItems
      modelId={modelId}
      list={list}
      parentList={parentList}
      structure={structure}
      items={items.data}
      parents={parentList ? parentItems.data : undefined}
      canEdit={canEdit}
      locked={locked}
    />
  )
}

interface LoadedItemsProps extends ItemsTabProps {
  parentList?: ListDto
  items: ItemDto[]
  parents?: ItemDto[]
}

function LoadedItems({
  modelId,
  list,
  parentList,
  structure,
  items,
  parents,
  canEdit,
  locked,
}: LoadedItemsProps) {
  const editable = canEdit && !locked
  const deleteItems = useDeleteItems(modelId)
  const [query, setQuery] = useState("")
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set())
  const [chosen, setChosen] = useState<ReadonlySet<string>>(new Set())
  const [adding, setAdding] = useState(false)
  const [bulkAdding, setBulkAdding] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [subsetsOpen, setSubsetsOpen] = useState(false)
  const addButton = useRef<HTMLButtonElement>(null)
  const newItemName = useRef<HTMLInputElement>(null)
  const selectAll = useRef<HTMLButtonElement>(null)
  const { ref: bulkRef, onCloseAutoFocus: restoreBulk } = useRestoreFocus<HTMLButtonElement>()
  const { ref: subsetsRef, onCloseAutoFocus: restoreSubsets } = useRestoreFocus<HTMLButtonElement>()

  const rows = useMemo(
    () => buildRows({ items, parents, collapsed, query }),
    [items, parents, collapsed, query],
  )
  const shownIds = useMemo(
    () => rows.flatMap((row) => (row.kind === "item" ? [row.item.id] : [])),
    [rows],
  )
  // What is chosen and still in the list: items deleted elsewhere drop out of the choice.
  const selected = useMemo(
    () => new Set(items.filter((item) => chosen.has(item.id)).map((item) => item.id)),
    [items, chosen],
  )
  const shownSelected = shownIds.filter((id) => selected.has(id)).length
  const allSelected =
    shownIds.length > 0 && shownSelected === shownIds.length
      ? true
      : shownSelected > 0
        ? "indeterminate"
        : false

  const subsets = structure.subsets.filter((subset) => subset.list === list.id)
  const names = useMemo(() => new Map(items.map((item) => [item.id, item.name])), [items])
  const blockers = useMemo(
    () => (selected.size > 0 ? blockedByChildren(structure, list.id, selected) : []),
    [structure, list.id, selected],
  )

  function toggle(id: string, checked: boolean) {
    setChosen((previous) => withIds(previous, [id], checked))
  }

  function toggleAll(checked: boolean) {
    setChosen((previous) => withIds(previous, shownIds, checked))
  }

  function toggleGroup(parentId: string) {
    setCollapsed((previous) => withIds(previous, [parentId], !previous.has(parentId)))
  }

  // The button to go back to may be a new one, in the message of an empty list, so focus waits
  // for the page to be drawn again.
  const focusAddAfterDraw = useRef(false)
  useEffect(() => {
    if (focusAddAfterDraw.current) {
      focusAddAfterDraw.current = false
      addButton.current?.focus()
    }
  })

  function stopAdding() {
    focusAddAfterDraw.current = true
    setAdding(false)
  }

  // The button that opened the dialog is gone once the items are, so focus goes to the table.
  function afterDelete(event: Event) {
    event.preventDefault()
    ;(selectAll.current ?? addButton.current)?.focus()
  }

  const empty = items.length === 0 && !adding
  const addControls = canEdit && (
    <>
      <ProductionLock locked={locked}>
        <Button
          ref={addButton}
          disabled={locked}
          onClick={() => (adding ? newItemName.current?.focus() : setAdding(true))}
        >
          <Plus />
          Add item
        </Button>
      </ProductionLock>
      <ProductionLock locked={locked}>
        <Button
          ref={bulkRef}
          variant="outline"
          disabled={locked}
          onClick={() => setBulkAdding(true)}
        >
          <ListPlus />
          Bulk add
        </Button>
      </ProductionLock>
    </>
  )
  const showSubsets = items.length > 0 || subsets.length > 0

  return (
    <div className="flex flex-col gap-3">
      {empty ? (
        <EmptyState
          icon={Layers}
          title="No items yet"
          description={
            canEdit
              ? "Add the first item, or paste a whole list of them at once."
              : "Nobody has added items to this list yet."
          }
          action={<div className="flex flex-wrap justify-center gap-2">{addControls}</div>}
          headingLevel={2}
        />
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-2">
            <Input
              type="search"
              aria-label="Filter items"
              placeholder="Filter items"
              autoComplete="off"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              className="min-w-0 basis-56 sm:max-w-xs"
            />
            <div className="ml-auto flex flex-wrap items-center gap-2">
              {addControls}
              {showSubsets && (
                <Button ref={subsetsRef} variant="outline" onClick={() => setSubsetsOpen(true)}>
                  <Layers />
                  Subsets
                </Button>
              )}
            </div>
          </div>
          {adding && (
            <p className="text-sm text-muted-foreground">
              Type the item, then press Enter to add it and start the next one. Press Escape to
              stop.
            </p>
          )}
          {editable && selected.size > 0 && (
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-md border bg-muted/40 px-3 py-2">
              <p role="status" className="text-sm font-medium">
                {countOf(selected.size, "item")} selected
              </p>
              <Button
                variant="outline"
                size="sm"
                className="text-destructive hover:text-destructive"
                disabled={blockers.length > 0}
                aria-describedby={blockers.length > 0 ? "delete-blocked" : undefined}
                onClick={() => setDeleting(true)}
              >
                <Trash2 />
                Delete selected
              </Button>
              <Button variant="ghost" size="sm" onClick={() => setChosen(new Set())}>
                <X />
                Clear selection
              </Button>
              {blockers.length > 0 && (
                <p id="delete-blocked" className="basis-full text-sm text-muted-foreground">
                  {blockedMessage(blockers, names)}
                </p>
              )}
            </div>
          )}
          {rows.length === 0 && !adding ? (
            <p className="rounded-lg border px-4 py-8 text-center text-sm text-muted-foreground">
              No item matches “{query.trim()}”.
            </p>
          ) : (
            <ItemsTable
              modelId={modelId}
              list={list}
              parentList={parentList}
              parents={parents}
              rows={rows}
              editable={editable}
              selected={selected}
              onToggle={toggle}
              allSelected={allSelected}
              onToggleAll={toggleAll}
              onToggleGroup={toggleGroup}
              adding={adding}
              onStopAdding={stopAdding}
              newItemNameRef={newItemName}
              selectAllRef={selectAll}
            />
          )}
          <p className="text-sm text-muted-foreground">
            {countOf(items.length, "item")}
            {query.trim() !== "" && `, ${shownIds.length.toLocaleString("en")} shown`}
            {list.top_level_name && ` · Top level: ${list.top_level_name}`}
          </p>
        </>
      )}
      {editable && (
        <BulkAddDialog
          modelId={modelId}
          list={list}
          existing={items}
          parents={parents}
          parentList={parentList?.name}
          open={bulkAdding}
          onOpenChange={setBulkAdding}
          onCloseAutoFocus={restoreBulk}
        />
      )}
      {editable && (
        <DeleteDialog
          title={
            selected.size === 1
              ? `Delete ${names.get([...selected][0]) ?? "this item"}?`
              : `Delete ${countOf(selected.size, "item")}?`
          }
          description={deleteDescription(selected, names)}
          action={selected.size === 1 ? "Delete item" : "Delete items"}
          done={selected.size === 1 ? "Item deleted" : "Items deleted"}
          onConfirm={async () => {
            await deleteItems.mutateAsync({ listId: list.id, ids: [...selected] })
            setChosen(new Set())
          }}
          open={deleting}
          onOpenChange={setDeleting}
          onCloseAutoFocus={afterDelete}
        />
      )}
      <SubsetsSheet
        modelId={modelId}
        list={list}
        subsets={subsets}
        items={items}
        canEdit={canEdit}
        locked={locked}
        open={subsetsOpen}
        onOpenChange={setSubsetsOpen}
        onCloseAutoFocus={restoreSubsets}
      />
    </div>
  )
}

/** The names of up to three of the items, and how many more there are. */
function deleteDescription(selected: ReadonlySet<string>, names: ReadonlyMap<string, string>) {
  const ids = [...selected]
  const named = ids.slice(0, 3).map((id) => names.get(id) ?? "an item")
  const rest = ids.length - named.length
  const who = new Intl.ListFormat("en", { type: "conjunction" }).format(
    rest > 0 ? [...named, countOf(rest, "more item")] : named,
  )
  return `${who} ${ids.length === 1 ? "is" : "are"} removed from the list and from its subsets, and the values entered for ${ids.length === 1 ? "it" : "them"} in modules are cleared.`
}

function ItemsSkeleton() {
  return (
    <div role="status" aria-label="Loading items" className="rounded-lg border">
      <div className="flex flex-col gap-4 p-4">
        {Array.from({ length: 6 }, (_, index) => (
          <div key={index} className="flex items-center gap-4">
            <Skeleton className="size-4" />
            <Skeleton className="h-5 w-48" />
            <Skeleton className="h-5 flex-1" />
          </div>
        ))}
      </div>
    </div>
  )
}
