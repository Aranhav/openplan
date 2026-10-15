import { useParams } from "@tanstack/react-router"
import { useEffect } from "react"
import { useModel } from "@/features/models/api"
import { useWorkspaces } from "@/features/workspaces/api"
import { pickWorkspace, setLastWorkspace } from "@/lib/last-workspace"

/**
 * The workspace the user is working in: the one in the address, else the one that owns the model
 * being viewed, else the one they used last, else the first they belong to. A workspace found in
 * the address is remembered for next time. An address that names a workspace the user is not in
 * has no current workspace, rather than another one shown in its place.
 */
export function useCurrentWorkspace() {
  const { workspaceId, modelId } = useParams({ strict: false })
  const { data: workspaces } = useWorkspaces()
  const model = useModel(modelId)

  const routeWorkspaceId = workspaceId ?? model.data?.workspace_id
  const fromRoute = workspaces?.find((workspace) => workspace.id === routeWorkspaceId)
  // On a model's page the workspace is unknown until the model arrives; guessing would flash another.
  const awaitingModel = modelId !== undefined && model.isPending
  const workspace =
    fromRoute ??
    (awaitingModel || workspaceId !== undefined ? undefined : pickWorkspace(workspaces ?? []))

  const rememberedId = fromRoute?.id
  useEffect(() => {
    if (rememberedId) {
      setLastWorkspace(rememberedId)
    }
  }, [rememberedId])

  return { workspace, isLoading: !workspaces || awaitingModel }
}
