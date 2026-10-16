import { Link } from "@tanstack/react-router"
import { Plus, Tags } from "lucide-react"
import { useMemo, useState } from "react"
import { EmptyState } from "@/components/empty-state"
import { ProductionLock } from "@/components/production-lock"
import { Button } from "@/components/ui/button"
import { Grid } from "@/features/grid/grid"
import type { GridQuery } from "@/features/grid/view-types"
import { AddLineItemDialog } from "@/features/modules/add-line-item-dialog"
import { gridReference } from "@/features/modules/grid-reference"
import { lineItemsOf } from "@/features/structure/modules"
import type { StructureDto } from "@/features/structure/types"
import { canEditCells } from "@/features/workspaces/roles"
import { useCurrentWorkspace } from "@/hooks/use-current-workspace"
import { useRestoreFocus } from "@/hooks/use-restore-focus"
import type { ListDto } from "./types"

interface PropertiesTabProps {
  modelId: string
  list: ListDto
  structure: StructureDto
  canEdit: boolean
  locked: boolean
}

/**
 * The properties of a list: the values each of its items has, laid out with the items down the
 * rows and the properties across. They are the line items of the list's own system module, whose
 * id is the list's and which exists from the first property on.
 */
export function PropertiesTab({ modelId, list, structure, canEdit, locked }: PropertiesTabProps) {
  const { workspace } = useCurrentWorkspace()
  const properties = lineItemsOf(structure, list.id)
  const [adding, setAdding] = useState(false)
  const { ref: addRef, onCloseAutoFocus: restoreFocus } = useRestoreFocus<HTMLButtonElement>()
  const query = useMemo<GridQuery>(
    () => ({
      module: list.id,
      rows: [{ kind: "list", list: list.id }],
      columns: [{ kind: "line_items" }],
      pages: [],
    }),
    [list.id],
  )
  const { lists, calendar, month_labels } = structure
  const reference = useMemo(
    () => gridReference({ lists, calendar, month_labels }),
    [lists, calendar, month_labels],
  )

  const addButton = canEdit && (
    <ProductionLock locked={locked}>
      <Button ref={addRef} disabled={locked} onClick={() => setAdding(true)}>
        <Plus />
        Add property
      </Button>
    </ProductionLock>
  )

  return (
    <div className="flex flex-col gap-3">
      {properties.length === 0 ? (
        <EmptyState
          icon={Tags}
          title="No properties yet"
          description={`Properties hold a value for each item of ${list.name}, such as a region's currency or a product's launch date.`}
          action={addButton}
        />
      ) : (
        <>
          <div className="flex flex-wrap items-center justify-end gap-2">
            {addButton}
            <Button variant="outline" asChild>
              <Link
                to="/m/$modelId/modules/$moduleId"
                params={{ modelId, moduleId: list.id }}
                search={{ tab: "blueprint" }}
              >
                Open Blueprint
              </Link>
            </Button>
          </div>
          {/* The grid scrolls inside the room the page leaves: its header, the tabs and the toolbar. */}
          <div className="h-[max(24rem,calc(100svh-24rem))] md:h-[max(24rem,calc(100svh-18rem))]">
            <Grid
              modelId={modelId}
              query={query}
              label={`${list.name} properties grid`}
              readOnly={workspace === undefined || !canEditCells(workspace.role)}
              reference={reference}
            />
          </div>
        </>
      )}
      {canEdit && (
        <AddLineItemDialog
          modelId={modelId}
          moduleId={list.id}
          structure={structure}
          lineItems={properties}
          open={adding}
          onOpenChange={setAdding}
          onCloseAutoFocus={restoreFocus}
        />
      )}
    </div>
  )
}
