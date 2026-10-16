import { Link } from "@tanstack/react-router"
import { ArrowLeft, Grid3x3, Rows3 } from "lucide-react"
import { EmptyState } from "@/components/empty-state"
import { ErrorState } from "@/components/error-state"
import { PageHeader } from "@/components/page-header"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
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
import { axisLabel, formatLabel } from "@/features/structure/labels"
import { useDocumentTitle } from "@/hooks/use-document-title"
import type { components } from "@/lib/api/schema"

type Structure = components["schemas"]["StructureDto"]
type ModuleDto = components["schemas"]["ModuleDto"]

interface ModulePageProps {
  modelId: string
  moduleId: string
  /** The line item to mark, from the address. */
  selectedLineItemId?: string
}

export function ModulePage({ modelId, moduleId, selectedLineItemId }: ModulePageProps) {
  const structure = useStructure(modelId)
  const module = structure.data?.modules.find((candidate) => candidate.id === moduleId)

  if (module && structure.data) {
    return (
      <ModuleDetails module={module} structure={structure.data} selected={selectedLineItemId} />
    )
  }
  if (structure.data) {
    return <ModuleNotFound modelId={modelId} />
  }
  if (structure.isError) {
    return (
      <>
        <PageHeader title="Module" />
        <ErrorState error={structure.error} onRetry={() => void structure.refetch()} />
      </>
    )
  }
  return (
    <>
      <PageHeader title="Module" />
      <div role="status" aria-label="Loading module" className="rounded-lg border">
        <div className="flex flex-col gap-4 p-4">
          {Array.from({ length: 4 }, (_, index) => (
            <div key={index} className="flex items-center gap-4">
              <Skeleton className="h-5 w-32" />
              <Skeleton className="h-5 w-24" />
              <Skeleton className="h-5 flex-1" />
            </div>
          ))}
        </div>
      </div>
    </>
  )
}

function ModuleNotFound({ modelId }: { modelId: string }) {
  useDocumentTitle("Module not found · OpenPlan")
  return (
    <EmptyState
      icon={Grid3x3}
      title="Module not found"
      description="It may have been deleted."
      action={
        <Button asChild>
          <Link to="/m/$modelId/modules" params={{ modelId }}>
            <ArrowLeft />
            Back to modules
          </Link>
        </Button>
      }
      headingLevel={1}
    />
  )
}

interface ModuleDetailsProps {
  module: ModuleDto
  structure: Structure
  selected?: string
}

function ModuleDetails({ module, structure, selected }: ModuleDetailsProps) {
  const lineItems = structure.line_items
    .filter((item) => item.module === module.id)
    .sort((a, b) => a.ordinal - b.ordinal)

  return (
    <>
      <PageHeader
        title={module.name}
        description={
          <div className="flex flex-wrap items-center gap-1.5">
            {module.functional_area && <span>{module.functional_area}</span>}
            {module.axes.map((axis, index) => (
              <Badge key={index} variant="outline">
                {axisLabel(axis, structure)}
              </Badge>
            ))}
          </div>
        }
      />
      {lineItems.length === 0 ? (
        <EmptyState
          icon={Rows3}
          title="No line items yet"
          description="Line items are the rows of a module."
        />
      ) : (
        <div className="rounded-lg border">
          <Table aria-label="Line items">
            <TableHeader>
              <TableRow>
                <TableHead className="pl-4">Name</TableHead>
                <TableHead>Format</TableHead>
                <TableHead className="pr-4">Formula</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {lineItems.map((item) => {
                const isSelected = item.id === selected
                return (
                  <TableRow
                    key={item.id}
                    data-state={isSelected ? "selected" : undefined}
                    aria-current={isSelected ? "true" : undefined}
                  >
                    <TableCell className="pl-4 font-medium">{item.name}</TableCell>
                    <TableCell>{formatLabel(item.format, structure)}</TableCell>
                    <TableCell className="max-w-96 truncate pr-4" title={item.formula ?? undefined}>
                      {item.formula ? (
                        <code className="font-mono text-xs">{item.formula}</code>
                      ) : (
                        <span className="text-muted-foreground">Input</span>
                      )}
                    </TableCell>
                  </TableRow>
                )
              })}
            </TableBody>
          </Table>
        </div>
      )}
    </>
  )
}
