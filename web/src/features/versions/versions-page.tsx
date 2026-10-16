import { Plus } from "lucide-react"
import { useState } from "react"
import { ErrorState } from "@/components/error-state"
import { PageHeader } from "@/components/page-header"
import { ProductionLock, ProductionNotice } from "@/components/production-lock"
import { Button } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"
import { Table, TableBody, TableCell, TableRow } from "@/components/ui/table"
import { useStructure } from "@/features/structure/api"
import type { StructureDto } from "@/features/structure/types"
import { LG_BREAKPOINT, useIsMobile } from "@/hooks/use-mobile"
import { useRestoreFocus } from "@/hooks/use-restore-focus"
import { useStructureAccess } from "@/hooks/use-structure-access"
import { AddVersionDialog } from "./add-version-dialog"
import { VersionsHead, VersionsTable } from "./versions-table"

export function VersionsPage({ modelId }: { modelId: string }) {
  const structure = useStructure(modelId)
  const { canEdit, locked, isLoading } = useStructureAccess(modelId)
  // The table is read where it is first drawn, so its layout is settled by the time it appears.
  const narrow = useIsMobile(LG_BREAKPOINT)
  const [adding, setAdding] = useState(false)
  const { ref: addRef, onCloseAutoFocus: restoreFocus } = useRestoreFocus<HTMLButtonElement>()
  // The table, and the Add version button with it, wait for the versions and the user's role.
  const loaded = isLoading ? undefined : structure.data

  return (
    <div className="max-w-4xl">
      <PageHeader
        title="Versions"
        description={
          isLoading || canEdit
            ? "The scenarios you plan and compare."
            : "The scenarios you plan and compare. Only workspace admins and builders can change them."
        }
        actions={
          canEdit && loaded && (
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
      {loaded ? (
        <Versions
          modelId={modelId}
          structure={loaded}
          canEdit={canEdit}
          locked={locked}
          narrow={narrow}
        />
      ) : structure.isError ? (
        <ErrorState error={structure.error} onRetry={() => void structure.refetch()} />
      ) : (
        <VersionsSkeleton canEdit={canEdit} narrow={narrow} />
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
      <div className="grid gap-1 text-sm text-muted-foreground">
        <p>Before its switchover month, a version shows the values of the actual version.</p>
        {canEdit && <p>The actual and current versions can't be deleted.</p>}
      </div>
    </div>
  )
}

/** The table's own header over placeholder rows, so its columns do not move when the data arrives. */
function VersionsSkeleton({ canEdit, narrow }: { canEdit: boolean; narrow: boolean }) {
  return (
    <div role="status" aria-label="Loading versions" className="rounded-lg border">
      <Table className="table-fixed">
        <VersionsHead canEdit={canEdit} narrow={narrow} />
        <TableBody>
          {Array.from({ length: 3 }, (_, index) => (
            <TableRow key={index}>
              <TableCell className="pl-4">
                <Skeleton className="h-5 w-32 max-w-full" />
                {narrow && <Skeleton className="mt-3 h-8 w-full max-w-40" />}
              </TableCell>
              <TableCell className={narrow ? "px-1" : undefined}>
                <Skeleton className="mx-auto size-5 rounded-full" />
              </TableCell>
              <TableCell className={narrow ? "px-1" : undefined}>
                <Skeleton className="mx-auto size-5 rounded-full" />
              </TableCell>
              {!narrow && (
                <TableCell className={canEdit ? undefined : "pr-4"}>
                  <Skeleton className="h-8 w-28" />
                </TableCell>
              )}
              {canEdit && (
                <TableCell className="pr-4">
                  <Skeleton className="ml-auto size-8" />
                </TableCell>
              )}
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  )
}
