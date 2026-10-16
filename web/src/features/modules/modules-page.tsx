import { Link } from "@tanstack/react-router"
import { ChevronRight, Grid3x3, Plus } from "lucide-react"
import { type ReactNode, useState } from "react"
import { EmptyState } from "@/components/empty-state"
import { ErrorState } from "@/components/error-state"
import { PageHeader } from "@/components/page-header"
import { ProductionLock, ProductionNotice } from "@/components/production-lock"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import { Skeleton } from "@/components/ui/skeleton"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { useStructure } from "@/features/structure/api"
import { axisLabel } from "@/features/structure/labels"
import { groupModules, lineItemCounts } from "@/features/structure/modules"
import type { ModuleDto, StructureDto } from "@/features/structure/types"
import { useRestoreFocus } from "@/hooks/use-restore-focus"
import { useStructureAccess } from "@/hooks/use-structure-access"
import { NewModuleDialog } from "./new-module-dialog"

export function ModulesPage({ modelId }: { modelId: string }) {
  const structure = useStructure(modelId)
  const { canEdit, locked, isLoading } = useStructureAccess(modelId)
  const [creating, setCreating] = useState(false)
  // The modules, and the button that adds one with them, wait for the user's role.
  const loaded = isLoading ? undefined : structure.data
  const { ref: newRef, onCloseAutoFocus: restoreFocus } = useRestoreFocus<HTMLButtonElement>()

  // The one button is in the header of a list of modules, and in the message of an empty list.
  const newButton = canEdit && (
    <ProductionLock locked={locked}>
      <Button ref={newRef} disabled={locked} onClick={() => setCreating(true)}>
        <Plus />
        New module
      </Button>
    </ProductionLock>
  )
  const empty = loaded?.modules.length === 0

  return (
    <>
      <PageHeader
        title="Modules"
        description="Grids of line items over shared dimensions."
        actions={!empty && newButton}
      />
      {locked && (
        <div className="mb-6">
          <ProductionNotice />
        </div>
      )}
      {/* A refresh that fails in the background leaves the modules already on screen alone. */}
      {loaded ? (
        <Modules modelId={modelId} structure={loaded} action={newButton} />
      ) : structure.isError ? (
        <ErrorState error={structure.error} onRetry={() => void structure.refetch()} />
      ) : (
        <ModulesSkeleton />
      )}
      {canEdit && loaded && (
        <NewModuleDialog
          modelId={modelId}
          structure={loaded}
          areas={groupModules(loaded.modules).areas.map((area) => area.name)}
          open={creating}
          onOpenChange={setCreating}
          onCloseAutoFocus={restoreFocus}
        />
      )}
    </>
  )
}

interface ModulesProps {
  modelId: string
  structure: StructureDto
  /** The button that creates a module, if the user may; shown in the message of an empty list. */
  action: ReactNode
}

function Modules({ modelId, structure, action }: ModulesProps) {
  if (structure.modules.length === 0) {
    return (
      <EmptyState
        icon={Grid3x3}
        title="No modules yet"
        description="Modules hold the line items you plan with."
        action={action}
      />
    )
  }
  const { ungrouped, areas } = groupModules(structure.modules)
  const headed = areas.length > 0
  const counts = lineItemCounts(structure)
  const sections = [
    ...(ungrouped.length > 0
      ? [{ name: headed ? "No functional area" : "Modules", modules: ungrouped }]
      : []),
    ...areas,
  ]

  return (
    <div className="flex flex-col gap-6">
      {sections.map(({ name, modules }) => {
        const table = { name, modules, modelId, structure, counts }
        return headed ? (
          <AreaSection key={name} {...table} />
        ) : (
          <ModulesTable key={name} {...table} />
        )
      })}
    </div>
  )
}

interface TableProps {
  name: string
  modules: ModuleDto[]
  modelId: string
  structure: StructureDto
  counts: Map<string, number>
}

/** The modules of one functional area, which fold away under the area's name. */
function AreaSection(props: TableProps) {
  const { name, modules } = props
  return (
    <Collapsible defaultOpen asChild>
      <section>
        <h2 className="mb-2 text-sm font-medium">
          <CollapsibleTrigger className="group flex items-center gap-1.5 rounded-sm py-1 pr-2 text-muted-foreground outline-none hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50">
            <ChevronRight className="size-4 transition-transform group-data-[state=open]:rotate-90" />
            {name}
            <Badge variant="secondary">
              {modules.length}
              <span className="sr-only">{modules.length === 1 ? " module" : " modules"}</span>
            </Badge>
          </CollapsibleTrigger>
        </h2>
        <CollapsibleContent>
          <ModulesTable {...props} />
        </CollapsibleContent>
      </section>
    </Collapsible>
  )
}

function ModulesTable({ name, modules, modelId, structure, counts }: TableProps) {
  return (
    <div className="rounded-lg border">
      {/* Fixed columns line up the tables of the functional areas one above the other. */}
      <Table aria-label={name} className="table-fixed">
        <TableHeader>
          <TableRow>
            <TableHead className="w-32 pl-4 md:w-56">Name</TableHead>
            <TableHead>Dimensions</TableHead>
            <TableHead className="w-20 pr-4 text-right md:w-28">Line items</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {modules.map((module) => (
            <TableRow key={module.id}>
              <TableCell className="pl-4 font-medium break-words whitespace-normal">
                <Link
                  to="/m/$modelId/modules/$moduleId"
                  params={{ modelId, moduleId: module.id }}
                  className="rounded-sm underline-offset-4 outline-none hover:underline focus-visible:ring-[3px] focus-visible:ring-ring/50"
                >
                  {module.name}
                </Link>
              </TableCell>
              <TableCell className="whitespace-normal">
                {module.axes.length === 0 ? (
                  <span className="text-muted-foreground">None</span>
                ) : (
                  <div className="flex flex-wrap gap-1">
                    {module.axes.map((axis, index) => (
                      <Badge key={index} variant="outline">
                        {axisLabel(axis, structure)}
                      </Badge>
                    ))}
                  </div>
                )}
              </TableCell>
              <TableCell className="pr-4 text-right tabular-nums">
                {counts.get(module.id) ?? 0}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  )
}

function ModulesSkeleton() {
  return (
    <div role="status" aria-label="Loading modules" className="rounded-lg border">
      <div className="flex flex-col gap-4 p-4">
        {Array.from({ length: 4 }, (_, index) => (
          <div key={index} className="flex items-center gap-4">
            <Skeleton className="h-5 w-32" />
            <Skeleton className="h-5 flex-1" />
            <Skeleton className="h-5 w-8" />
          </div>
        ))}
      </div>
    </div>
  )
}
