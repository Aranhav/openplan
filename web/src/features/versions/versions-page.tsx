import { GitBranch, Plus } from "lucide-react"
import { useState } from "react"
import { EmptyState } from "@/components/empty-state"
import { ErrorState } from "@/components/error-state"
import { PageHeader } from "@/components/page-header"
import { ProductionLock, ProductionNotice } from "@/components/production-lock"
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
import type { StructureDto } from "@/features/structure/types"
import { LG_BREAKPOINT, useIsMobile } from "@/hooks/use-mobile"
import { useRestoreFocus } from "@/hooks/use-restore-focus"
import { useStructureAccess } from "@/hooks/use-structure-access"
import { AddVersionDialog } from "./add-version-dialog"
import { VersionsTable } from "./versions-table"

export function VersionsPage({ modelId }: { modelId: string }) {
  const structure = useStructure(modelId)
  const { canEdit, locked } = useStructureAccess(modelId)
  // The table is read where it is first drawn, so its layout is settled by the time it appears.
  const narrow = useIsMobile(LG_BREAKPOINT)
  const [adding, setAdding] = useState(false)
  const { ref: addRef, onCloseAutoFocus: restoreFocus } = useRestoreFocus<HTMLButtonElement>()
  // A model always has an actual and a current version, so without versions there is nothing to add to.
  const hasVersions = structure.data !== undefined && structure.data.versions.length > 0

  return (
    <div className="max-w-4xl">
      <PageHeader
        title="Versions"
        description="The scenarios you plan and compare."
        actions={
          canEdit &&
          hasVersions && (
            <ProductionLock locked={locked}>
              <Button ref={addRef} disabled={locked} onClick={() => setAdding(true)}>
                <Plus />
                Add version
              </Button>
            </ProductionLock>
          )
        }
      />
      {/* A refresh that fails in the background leaves the versions already on screen alone. */}
      {structure.data ? (
        <Versions
          modelId={modelId}
          structure={structure.data}
          canEdit={canEdit}
          locked={locked}
          narrow={narrow}
        />
      ) : structure.isError ? (
        <ErrorState error={structure.error} onRetry={() => void structure.refetch()} />
      ) : (
        <VersionsSkeleton />
      )}
      {canEdit && (
        <AddVersionDialog
          modelId={modelId}
          open={adding}
          onOpenChange={setAdding}
          onCloseAutoFocus={restoreFocus}
        />
      )}
    </div>
  )
}

interface VersionsProps {
  modelId: string
  structure: StructureDto
  canEdit: boolean
  locked: boolean
  narrow: boolean
}

function Versions({ modelId, structure, canEdit, locked, narrow }: VersionsProps) {
  if (structure.versions.length === 0) {
    return (
      <EmptyState
        icon={GitBranch}
        title="No versions yet"
        description="Versions are the scenarios you plan and compare."
      />
    )
  }
  return (
    <div className="flex flex-col gap-6">
      {locked && <ProductionNotice />}
      <VersionsTable
        modelId={modelId}
        structure={structure}
        canEdit={canEdit}
        locked={locked}
        narrow={narrow}
      />
      <p className="text-sm text-muted-foreground">
        Before its switchover month, a version shows the values of the actual version.
      </p>
    </div>
  )
}

function VersionsSkeleton() {
  return (
    <div role="status" aria-label="Loading versions" className="rounded-lg border">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead className="pl-4">Name</TableHead>
            <TableHead className="w-20 text-center">Actual</TableHead>
            <TableHead className="w-20 text-center">Current</TableHead>
            <TableHead className="pr-4">Switchover</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {Array.from({ length: 3 }, (_, index) => (
            <TableRow key={index}>
              <TableCell className="pl-4">
                <Skeleton className="h-5 w-32" />
              </TableCell>
              <TableCell>
                <Skeleton className="mx-auto size-4 rounded-full" />
              </TableCell>
              <TableCell>
                <Skeleton className="mx-auto size-4 rounded-full" />
              </TableCell>
              <TableCell className="pr-4">
                <Skeleton className="h-8 w-28" />
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  )
}
