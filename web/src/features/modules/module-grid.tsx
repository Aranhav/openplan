import { Rows3 } from "lucide-react"
import { useMemo, useState } from "react"
import { EmptyState } from "@/components/empty-state"
import { Button } from "@/components/ui/button"
import { Grid } from "@/features/grid/grid"
import { lineItemsOf } from "@/features/structure/modules"
import type { ModuleDto, StructureDto } from "@/features/structure/types"
import { useFillViewport } from "@/hooks/use-fill-viewport"
import { defaultPivot } from "./default-view"
import { FormulaBar } from "./formula-bar"
import { gridReference } from "./grid-reference"

/** The least the grid is tall, and the padding the page keeps below it, in pixels. */
const MIN_HEIGHT = 384
const PAGE_PADDING = 24

interface ModuleGridProps {
  modelId: string
  module: ModuleDto
  structure: StructureDto
  /** The user may not enter values (a viewer): copying still works. */
  readOnly: boolean
  /** The user may change formulas (a builder or admin). */
  canEditFormulas: boolean
  /** Production mode switches changing formulas off. */
  locked: boolean
  /** Goes to the Blueprint, where the line items are added. */
  onOpenBlueprint: () => void
}

/** The module's values, in the grid, laid out as its default pivot. */
export function ModuleGrid({
  modelId,
  module,
  structure,
  readOnly,
  canEditFormulas,
  locked,
  onOpenBlueprint,
}: ModuleGridProps) {
  const { ref, height } = useFillViewport(MIN_HEIGHT, PAGE_PADDING)
  // The line item of the active cell is the one whose formula the bar shows.
  const [activeId, setActiveId] = useState<string>()
  const query = useMemo(() => defaultPivot(module), [module])
  const { lists, calendar, month_labels } = structure
  const reference = useMemo(
    () => gridReference({ lists, calendar, month_labels }),
    [lists, calendar, month_labels],
  )

  const lineItems = lineItemsOf(structure, module.id)
  if (lineItems.length === 0) {
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
    <div className="flex flex-col gap-3">
      <FormulaBar
        modelId={modelId}
        lineItem={lineItems.find((item) => item.id === activeId)}
        canEdit={canEditFormulas}
        locked={locked}
      />
      {/* The grid scrolls inside the room the page leaves below the module's title, tabs and bar. */}
      <div ref={ref} style={{ height }} className="min-h-96">
        <Grid
          modelId={modelId}
          query={query}
          label={`${module.name} grid`}
          readOnly={readOnly}
          reference={reference}
          onSelectLineItem={setActiveId}
        />
      </div>
    </div>
  )
}
