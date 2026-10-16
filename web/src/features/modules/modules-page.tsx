import { Link } from "@tanstack/react-router"
import { Grid3x3 } from "lucide-react"
import { EmptyState } from "@/components/empty-state"
import { ErrorState } from "@/components/error-state"
import { PageHeader } from "@/components/page-header"
import { Badge } from "@/components/ui/badge"
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
import { groupModules } from "@/features/structure/modules"
import type { ModuleDto, StructureDto } from "@/features/structure/types"

export function ModulesPage({ modelId }: { modelId: string }) {
  const structure = useStructure(modelId)

  return (
    <>
      <PageHeader title="Modules" description="Grids of line items over shared dimensions." />
      {/* A refresh that fails in the background leaves the modules already on screen alone. */}
      {structure.data ? (
        <Modules modelId={modelId} structure={structure.data} />
      ) : structure.isError ? (
        <ErrorState error={structure.error} onRetry={() => void structure.refetch()} />
      ) : (
        <ModulesSkeleton />
      )}
    </>
  )
}

function Modules({ modelId, structure }: { modelId: string; structure: StructureDto }) {
  if (structure.modules.length === 0) {
    return (
      <EmptyState
        icon={Grid3x3}
        title="No modules yet"
        description="Modules hold the line items you plan with."
      />
    )
  }
  const { ungrouped, areas } = groupModules(structure.modules)
  const headed = areas.length > 0
  const sections = [
    ...(ungrouped.length > 0
      ? [{ name: headed ? "No functional area" : "Modules", modules: ungrouped }]
      : []),
    ...areas,
  ]

  return (
    <div className="flex flex-col gap-6">
      {sections.map(({ name, modules }) => (
        <section key={name}>
          {headed && <h2 className="mb-2 text-sm font-medium text-muted-foreground">{name}</h2>}
          <ModulesTable name={name} modules={modules} modelId={modelId} structure={structure} />
        </section>
      ))}
    </div>
  )
}

interface ModulesTableProps {
  name: string
  modules: ModuleDto[]
  modelId: string
  structure: StructureDto
}

function ModulesTable({ name, modules, modelId, structure }: ModulesTableProps) {
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
                <div className="flex flex-wrap gap-1">
                  {module.axes.map((axis, index) => (
                    <Badge key={index} variant="outline">
                      {axisLabel(axis, structure)}
                    </Badge>
                  ))}
                </div>
              </TableCell>
              <TableCell className="pr-4 text-right tabular-nums">
                {structure.line_items.filter((item) => item.module === module.id).length}
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
