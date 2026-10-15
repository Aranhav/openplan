import { Boxes, Plus } from "lucide-react"
import { useState } from "react"
import { EmptyState } from "@/components/empty-state"
import { ErrorState } from "@/components/error-state"
import { PageHeader } from "@/components/page-header"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardFooter, CardHeader } from "@/components/ui/card"
import { Skeleton } from "@/components/ui/skeleton"
import { canEditModels } from "@/features/workspaces/roles"
import { WorkspaceNotFound } from "@/features/workspaces/workspace-not-found"
import { useCurrentWorkspace } from "@/hooks/use-current-workspace"
import { useRestoreFocus } from "@/hooks/use-restore-focus"
import type { components } from "@/lib/api/schema"
import { useModels } from "./api"
import { CreateModelDialog } from "./create-model-dialog"
import { ModelCard } from "./model-card"

const GRID = "grid gap-4 sm:grid-cols-2 xl:grid-cols-3"

export function ModelsPage({ workspaceId }: { workspaceId: string }) {
  const { workspace, isLoading } = useCurrentWorkspace()

  if (isLoading) {
    return (
      <>
        <PageHeader title="Models" />
        <ModelCardsSkeleton />
      </>
    )
  }
  // The current workspace falls back to another one when the address names none the user is in.
  if (workspace?.id !== workspaceId) {
    return <WorkspaceNotFound />
  }
  return <WorkspaceModels workspace={workspace} />
}

function WorkspaceModels({ workspace }: { workspace: components["schemas"]["WorkspaceSummary"] }) {
  const models = useModels(workspace.id)
  const [creating, setCreating] = useState(false)
  const { ref: newModelRef, onCloseAutoFocus: restoreFocus } = useRestoreFocus<HTMLButtonElement>()
  const canEdit = canEditModels(workspace.role)
  const isEmpty = models.isSuccess && models.data.length === 0

  const newModel = canEdit && (
    <Button ref={newModelRef} onClick={() => setCreating(true)}>
      <Plus />
      New model
    </Button>
  )

  return (
    <>
      {/* An empty list has the same button in its own message, so the header leaves it out. */}
      <PageHeader
        title="Models"
        description={`Planning models in ${workspace.name}.`}
        actions={!isEmpty && newModel}
      />
      {models.isPending && <ModelCardsSkeleton />}
      {models.isError && <ErrorState error={models.error} onRetry={() => void models.refetch()} />}
      {isEmpty && (
        <EmptyState
          icon={Boxes}
          title="No models yet"
          description={
            canEdit
              ? "Create a model to start planning."
              : "Ask a workspace admin or builder to create one."
          }
          action={newModel}
        />
      )}
      {models.isSuccess && !isEmpty && (
        <div className={GRID}>
          {models.data.map((model) => (
            <ModelCard key={model.id} model={model} canEdit={canEdit} />
          ))}
        </div>
      )}
      {canEdit && (
        <CreateModelDialog
          workspaceId={workspace.id}
          open={creating}
          onOpenChange={setCreating}
          onCloseAutoFocus={restoreFocus}
        />
      )}
    </>
  )
}

function ModelCardsSkeleton() {
  return (
    <div role="status" aria-label="Loading models" className={GRID}>
      {Array.from({ length: 6 }, (_, index) => (
        <Card key={index} className="gap-4 py-5">
          <CardHeader className="px-5">
            <Skeleton className="h-4 w-2/3" />
          </CardHeader>
          <CardContent className="grid gap-2 px-5">
            <Skeleton className="h-3.5 w-full" />
            <Skeleton className="h-3.5 w-4/5" />
          </CardContent>
          <CardFooter className="justify-between px-5">
            <Skeleton className="h-5 w-12 rounded-full" />
            <Skeleton className="h-3.5 w-24" />
          </CardFooter>
        </Card>
      ))}
    </div>
  )
}
