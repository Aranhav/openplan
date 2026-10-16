import { Plus, Rows3 } from "lucide-react"
import { useId, useRef, useState } from "react"
import { toast } from "sonner"
import { DeleteDialog } from "@/components/delete-dialog"
import { EmptyState } from "@/components/empty-state"
import { ProductionLock } from "@/components/production-lock"
import { Button } from "@/components/ui/button"
import { useDeleteLineItem, useReorderLineItems } from "@/features/structure/api"
import { lineItemsOf } from "@/features/structure/modules"
import type { LineItemDto, ModuleDto, StructureDto } from "@/features/structure/types"
import { useRestoreFocus } from "@/hooks/use-restore-focus"
import { errorDetail } from "@/lib/api/client"
import { AddLineItemDialog } from "./add-line-item-dialog"
import { BlueprintTable } from "./blueprint-table"
import { FormulaBar } from "./formula-bar"
import { LineItemSheet } from "./line-item-sheet"

interface BlueprintProps {
  modelId: string
  module: ModuleDto
  structure: StructureDto
  /** The selected line item, from the address. */
  selectedId: string | undefined
  /** Selects a line item, or with none clears the selection. */
  onSelect: (id: string | undefined) => void
  /** Whether the signed-in user may add, reorder and delete line items. */
  canEdit: boolean
  /** Whether production mode switches those off. */
  locked: boolean
}

/** The line items of a module with their formats, formulas and settings, in the order of its grid. */
export function Blueprint({
  modelId,
  module,
  structure,
  selectedId,
  onSelect,
  canEdit,
  locked,
}: BlueprintProps) {
  const hintId = useId()
  const saved = lineItemsOf(structure, module.id)
  const reorder = useReorderLineItems(modelId)
  const deleteLineItem = useDeleteLineItem(modelId)
  // The order being saved, shown at once so that a dropped row does not jump back meanwhile.
  const [pendingOrder, setPendingOrder] = useState<string[]>()
  const [settingsFor, setSettingsFor] = useState<string>()
  const [settingsOpen, setSettingsOpen] = useState(false)
  // The line item in the dialog stays put as it closes; only `confirming` says whether it is shown.
  const [deletion, setDeletion] = useState<LineItemDto>()
  const [confirming, setConfirming] = useState(false)
  const [adding, setAdding] = useState(false)
  const tableRef = useRef<HTMLTableElement>(null)
  const { ref: addRef, onCloseAutoFocus: restoreAddFocus } = useRestoreFocus<HTMLButtonElement>()

  const byId = new Map(saved.map((item) => [item.id, item]))
  const lineItems = pendingOrder ? pendingOrder.flatMap((id) => byId.get(id) ?? []) : saved
  // A line item in the address that the module does not have selects nothing.
  const selected = selectedId !== undefined ? byId.get(selectedId) : undefined
  const settingsItem = settingsFor !== undefined ? byId.get(settingsFor) : undefined

  // Back to the table, where the arrow keys carry on from the selected row; if the last line
  // item has gone, to the button that adds the next.
  function focusTable(event: Event) {
    event.preventDefault()
    ;(tableRef.current ?? addRef.current ?? document.querySelector("h1"))?.focus()
  }

  function openSettings(id: string) {
    onSelect(id)
    setSettingsFor(id)
    setSettingsOpen(true)
  }

  async function saveOrder(ids: string[]) {
    setPendingOrder(ids)
    try {
      await reorder.mutateAsync({ module_id: module.id, ids })
    } catch (error) {
      toast.error(errorDetail(error))
    } finally {
      setPendingOrder(undefined)
    }
  }

  function askToDelete(id: string) {
    setDeletion(byId.get(id))
    setConfirming(true)
  }

  async function confirmDeletion(item: LineItemDto) {
    const position = lineItems.findIndex((candidate) => candidate.id === item.id)
    const neighbour = lineItems[position + 1] ?? lineItems[position - 1]
    await deleteLineItem.mutateAsync(item.id)
    if (item.id === selectedId) {
      onSelect(neighbour?.id)
    }
  }

  // The one button is in the toolbar of a list, and in the message of an empty one.
  const addButton = canEdit && (
    <ProductionLock locked={locked}>
      <Button ref={addRef} disabled={locked} onClick={() => setAdding(true)}>
        <Plus />
        Add line item
      </Button>
    </ProductionLock>
  )

  return (
    <div className="flex flex-col gap-4">
      {lineItems.length === 0 ? (
        <EmptyState
          icon={Rows3}
          title={canEdit ? "Add your first line item" : "No line items yet"}
          description="Line items are the rows of a module."
          action={addButton}
        />
      ) : (
        <>
          <FormulaBar modelId={modelId} lineItem={selected} canEdit={canEdit} locked={locked} />
          <div className="flex flex-wrap items-center justify-between gap-3">
            <p id={hintId} className="sr-only text-sm text-muted-foreground sm:not-sr-only">
              Select a line item and press Enter, or double-click it, to open its settings.
              {canEdit && " Drag the handle or use the actions menu to reorder."}
            </p>
            {addButton}
          </div>
          <BlueprintTable
            lineItems={lineItems}
            module={module}
            structure={structure}
            selectedId={selected?.id}
            onSelect={onSelect}
            onOpenSettings={openSettings}
            onReorder={(ids) => void saveOrder(ids)}
            onDelete={askToDelete}
            canEdit={canEdit}
            locked={locked}
            busy={pendingOrder !== undefined}
            hintId={hintId}
            tableRef={tableRef}
          />
        </>
      )}
      {canEdit && (
        <AddLineItemDialog
          modelId={modelId}
          moduleId={module.id}
          structure={structure}
          lineItems={lineItems}
          insertAfter={selected?.id}
          open={adding}
          onOpenChange={setAdding}
          onAdded={(lineItem) => onSelect(lineItem.id)}
          onCloseAutoFocus={restoreAddFocus}
        />
      )}
      {settingsItem && (
        <LineItemSheet
          modelId={modelId}
          structure={structure}
          module={module}
          lineItem={settingsItem}
          open={settingsOpen}
          onOpenChange={setSettingsOpen}
          canEdit={canEdit}
          locked={locked}
          onCloseAutoFocus={focusTable}
        />
      )}
      {canEdit && deletion && (
        <DeleteDialog
          title={`Delete ${deletion.name}?`}
          description="Formulas that reference it will show errors."
          action="Delete line item"
          done="Line item deleted"
          onConfirm={() => confirmDeletion(deletion)}
          open={confirming}
          onOpenChange={setConfirming}
          onCloseAutoFocus={focusTable}
        />
      )}
    </div>
  )
}
