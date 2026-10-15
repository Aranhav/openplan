import { useParams } from "@tanstack/react-router"
import { useEffect } from "react"
import { useModel } from "@/features/models/api"
import { useWorkspaces } from "@/features/workspaces/api"

const LAST_WORKSPACE_KEY = "openplan.lastWorkspace"

function readLastWorkspace(): string | null {
  try {
    return window.localStorage.getItem(LAST_WORKSPACE_KEY)
  } catch {
    return null
  }
}

function setLastWorkspace(id: string) {
  try {
    window.localStorage.setItem(LAST_WORKSPACE_KEY, id)
  } catch {
    // Storage can be unavailable (private mode); the choice then only lasts until the next visit.
  }
}

/**
 * The workspace the user is working in: the one in the address, else the one that owns the model
 * being viewed, else the one they used last, else the first they belong to. A workspace found in
 * the address is remembered for next time.
 */
export function useCurrentWorkspace() {
  const { workspaceId, modelId } = useParams({ strict: false })
  const { data: workspaces } = useWorkspaces()
  const model = useModel(modelId)

  const routeWorkspaceId = workspaceId ?? model.data?.workspace_id
  const fromRoute = workspaces?.find((workspace) => workspace.id === routeWorkspaceId)
  // On a model's page the workspace is unknown until the model arrives; guessing would flash another.
  const awaitingModel = modelId !== undefined && model.isPending
  const lastUsed = workspaces?.find((workspace) => workspace.id === readLastWorkspace())
  const workspace = fromRoute ?? (awaitingModel ? undefined : (lastUsed ?? workspaces?.[0]))

  const rememberedId = fromRoute?.id
  useEffect(() => {
    if (rememberedId) {
      setLastWorkspace(rememberedId)
    }
  }, [rememberedId])

  return { workspace, isLoading: !workspaces || awaitingModel, setLastWorkspace }
}
