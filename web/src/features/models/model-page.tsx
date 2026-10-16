import { useNavigate } from "@tanstack/react-router"
import { useState } from "react"
import { ErrorState } from "@/components/error-state"
import { PageHeader } from "@/components/page-header"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Skeleton } from "@/components/ui/skeleton"
import { canEditModels } from "@/features/workspaces/roles"
import { useCurrentWorkspace } from "@/hooks/use-current-workspace"
import { useRestoreFocus } from "@/hooks/use-restore-focus"
import type { components } from "@/lib/api/schema"
import { useModel } from "./api"
import { DeleteModelDialog } from "./delete-model-dialog"
import { ModeBadge } from "./mode-badge"
import { ModelSettingsForm } from "./model-settings-form"

export function ModelPage({ modelId }: { modelId: string }) {
  const model = useModel(modelId)

  // A failure to refresh leaves the page as it is, so a form with unsaved changes is never unmounted.
  if (model.data) {
    return <ModelDetails model={model.data} />
  }
  if (model.isError) {
    return (
      <>
        <PageHeader title="Model" />
        <ErrorState error={model.error} onRetry={() => void model.refetch()} />
      </>
    )
  }
  return (
    <>
      <PageHeader title="Model" />
      <div role="status" aria-label="Loading model" className="max-w-2xl">
        <Card>
          <CardHeader>
            <Skeleton className="h-5 w-36" />
          </CardHeader>
          <CardContent className="grid gap-4">
            <Skeleton className="h-9 w-full" />
            <Skeleton className="h-16 w-full" />
            <Skeleton className="h-18 w-full" />
          </CardContent>
        </Card>
      </div>
    </>
  )
}

function ModelDetails({ model }: { model: components["schemas"]["ModelDto"] }) {
  const { workspace } = useCurrentWorkspace()
  const navigate = useNavigate()
  const [deleting, setDeleting] = useState(false)
  const { ref: deleteRef, onCloseAutoFocus: restoreFocus } = useRestoreFocus<HTMLButtonElement>()
  const canEdit = workspace !== undefined && canEditModels(workspace.role)

  return (
    <>
      <PageHeader title={model.name} description={<ModeBadge mode={model.mode} />} />
      <div className="flex max-w-2xl flex-col gap-6">
        <Card>
          <CardHeader>
            <CardTitle role="heading" aria-level={2}>
              Model settings
            </CardTitle>
            <CardDescription>
              {canEdit
                ? "Change the name, description and mode of this model."
                : "Only workspace admins and builders can change these settings."}
            </CardDescription>
          </CardHeader>
          <ModelSettingsForm model={model} canEdit={canEdit} />
        </Card>
        {canEdit && (
          <Card className="border-destructive/50">
            <CardHeader>
              <CardTitle role="heading" aria-level={2}>
                Danger zone
              </CardTitle>
              <CardDescription>
                Deleting a model removes it and all its data for good.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <Button ref={deleteRef} variant="destructive" onClick={() => setDeleting(true)}>
                Delete model
              </Button>
            </CardContent>
          </Card>
        )}
      </div>
      {canEdit && (
        <DeleteModelDialog
          model={model}
          open={deleting}
          onOpenChange={setDeleting}
          onCloseAutoFocus={restoreFocus}
          focusAfterDelete={() => document.querySelector("h1")}
          onDeleted={() =>
            navigate({ to: "/w/$workspaceId", params: { workspaceId: model.workspace_id } })
          }
        />
      )}
    </>
  )
}
