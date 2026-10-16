import { Rows3 } from "lucide-react"
import { useMemo } from "react"
import { EmptyState } from "@/components/empty-state"
import { Button } from "@/components/ui/button"
import { Grid } from "@/features/grid/grid"
import { lineItemsOf } from "@/features/structure/modules"
import type { ModuleDto, StructureDto } from "@/features/structure/types"
import { defaultPivot } from "./default-view"
import { gridReference } from "./grid-reference"

interface ModuleGridProps {
  modelId: string
  module: ModuleDto
  structure: StructureDto
  /** The user may not enter values (a viewer): copying still works. */
  readOnly: boolean
  /** Goes to the Blueprint, where the line items are added. */
  onOpenBlueprint: () => void
}

/** The module's values, in the grid, laid out as its default pivot. */
export function ModuleGrid({
  modelId,
  module,
  structure,
  readOnly,
  onOpenBlueprint,
}: ModuleGridProps) {
  const query = useMemo(() => defaultPivot(module), [module])
  const { lists, calendar, month_labels } = structure
  const reference = useMemo(
    () => gridReference({ lists, calendar, month_labels }),
    [lists, calendar, month_labels],
  )

  if (lineItemsOf(structure, module.id).length === 0) {
    return (
      <EmptyState
        icon={Rows3}
        title="No line items yet"
        description="Add line items in the Blueprint, and their values appear here."
        action={<Button onClick={onOpenBlueprint}>Open Blueprint</Button>}
      />
    )
  }
  return (
    // The grid scrolls inside the room the page leaves: its header, the module's title and tabs.
    <div className="h-[max(24rem,calc(100svh-21rem))] md:h-[max(24rem,calc(100svh-15rem))]">
      <Grid
        modelId={modelId}
        query={query}
        label={`${module.name} grid`}
        readOnly={readOnly}
        reference={reference}
      />
    </div>
  )
}
