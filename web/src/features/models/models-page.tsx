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

export function ModelsPage() {
  const { workspace, isLoading } = useCurrentWorkspace()

  if (isLoading) {
    return (
      <>
        <PageHeader title="Models" />
        <ModelCardsSkeleton />
      </>
    )
  }
  // Without a current workspace, the address names one the user is not in.
  if (!workspace) {
    return <WorkspaceNotFound />
  }
  return <WorkspaceModels workspace={workspace} />
}

function WorkspaceModels({ workspace }: { workspace: components["schemas"]["WorkspaceSummary"] }) {
  const models = useModels(workspace.id)
  const [creating, setCreating] = useState(false)
  const { ref: newModelRef, onCloseAutoFocus: restoreFocus } = useRestoreFocus<HTMLButtonElement>()
  const canEdit = canEditModels(workspace.role)
  // A refresh that fails keeps the list on screen: only a list that never loaded is an error.
  const list = models.data

  const newModel = canEdit && (
    <Button ref={newModelRef} onClick={() => setCreating(true)}>
      <Plus />
      New model
    </Button>
  )

  return (
    <>
      {/* An empty list has the same button in its own message; one still loading has no button. */}
      <PageHeader
        title="Models"
        description={`Planning models in ${workspace.name}.`}
        actions={list !== undefined && list.length > 0 && newModel}
      />
      {models.isPending && <ModelCardsSkeleton />}
      {models.isError && !list && (
        <ErrorState
          error={models.error}
          isFetching={models.isFetching}
          onRetry={() => void models.refetch()}
        />
      )}
      {list?.length === 0 && (
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
      {list !== undefined && list.length > 0 && (
        <div className={GRID}>
          {list.map((model) => (
            <ModelCard
              key={model.id}
              model={model}
              canEdit={canEdit}
              fallbackFocus={() => newModelRef.current}
            />
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
