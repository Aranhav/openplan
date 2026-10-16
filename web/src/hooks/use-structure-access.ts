import { useModel } from "@/features/models/api"
import { canEditModels } from "@/features/workspaces/roles"
import { useCurrentWorkspace } from "@/hooks/use-current-workspace"

/**
 * What the signed-in user may do to the structure of a model. Only builders and admins change it
 * (`canEdit`); the others are shown plain text. A model in production mode keeps its controls
 * on screen but switched off (`locked`), because its structure changes only through ALM sync.
 * Until the user's role in the model's workspace is known (`isLoading`) nothing is allowed, so a
 * screen that shows its controls to builders waits for it rather than showing them as text first.
 */
export function useStructureAccess(modelId: string) {
  const { workspace, isLoading } = useCurrentWorkspace()
  const model = useModel(modelId)
  const canEdit = workspace !== undefined && canEditModels(workspace.role)
  return { canEdit, locked: canEdit && model.data?.mode === "prod", isLoading }
}
