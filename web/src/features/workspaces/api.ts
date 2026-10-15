import { type QueryClient, useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { useNavigate } from "@tanstack/react-router"
import { meQuery } from "@/features/auth/api"
import { api, unwrap } from "@/lib/api/client"
import { queryKeys } from "@/lib/api/keys"
import type { components } from "@/lib/api/schema"
import { pickWorkspace } from "@/lib/last-workspace"
import type { WorkspaceRole } from "./roles"

type WorkspaceNameRequest = components["schemas"]["WorkspaceNameRequest"]
type AddMemberRequest = components["schemas"]["AddMemberRequest"]
type MeResponse = components["schemas"]["MeResponse"]

/** The workspace list is part of the signed-in user, so a change to a workspace refreshes that. */
function refreshWorkspaces(queryClient: QueryClient) {
  return queryClient.invalidateQueries({ queryKey: queryKeys.me })
}

/**
 * The signed-in user's workspaces. `GET /workspaces` returns the same list as `me`, which the
 * route guard has already loaded, so this reads it from there: one cache, one request per refresh.
 */
export function useWorkspaces() {
  return useQuery({ ...meQuery, select: (me) => me.workspaces })
}

export function useCreateWorkspace() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (body: WorkspaceNameRequest) => unwrap(api.POST("/workspaces", { body })),
    onSuccess: () => refreshWorkspaces(queryClient),
  })
}

export function useRenameWorkspace() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ id, name }: { id: string; name: string }) =>
      unwrap(api.PATCH("/workspaces/{id}", { params: { path: { id } }, body: { name } })),
    onSuccess: () => refreshWorkspaces(queryClient),
  })
}

export function useMembers(wsId: string) {
  return useQuery({
    queryKey: queryKeys.members(wsId),
    queryFn: () => unwrap(api.GET("/workspaces/{id}/members", { params: { path: { id: wsId } } })),
  })
}

export function useAddMember(wsId: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (body: AddMemberRequest) =>
      unwrap(api.POST("/workspaces/{id}/members", { params: { path: { id: wsId } }, body })),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.members(wsId) }),
  })
}

// Changing or removing a member can change the signed-in user's own role, so the list refreshes too.
export function useUpdateMember(wsId: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ userId, role }: { userId: string; role: WorkspaceRole }) =>
      unwrap(
        api.PATCH("/workspaces/{id}/members/{user_id}", {
          params: { path: { id: wsId, user_id: userId } },
          body: { role },
        }),
      ),
    onSuccess: () =>
      Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.members(wsId) }),
        refreshWorkspaces(queryClient),
      ]),
  })
}

export function useRemoveMember(wsId: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (userId: string) =>
      unwrap(
        api.DELETE("/workspaces/{id}/members/{user_id}", {
          params: { path: { id: wsId, user_id: userId } },
        }),
      ),
    onSuccess: () =>
      Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.members(wsId) }),
        refreshWorkspaces(queryClient),
      ]),
  })
}

/**
 * The signed-in user removes themselves from a workspace. They can no longer open its pages, so
 * they move on before the workspace list is refreshed: refreshing first would turn the page they
 * are looking at into "not found" for a moment. Nor is the members list asked for again; they
 * could no longer read it.
 */
export function useLeaveWorkspace(wsId: string) {
  const queryClient = useQueryClient()
  const navigate = useNavigate()
  return useMutation({
    mutationFn: (userId: string) =>
      unwrap(
        api.DELETE("/workspaces/{id}/members/{user_id}", {
          params: { path: { id: wsId, user_id: userId } },
        }),
      ),
    onSuccess: async () => {
      const remaining = queryClient
        .getQueryData<MeResponse>(queryKeys.me)
        ?.workspaces.filter((workspace) => workspace.id !== wsId)
      const next = pickWorkspace(remaining ?? [])
      if (next) {
        await navigate({ to: "/w/$workspaceId", params: { workspaceId: next.id } })
      }
      void queryClient.invalidateQueries({ queryKey: queryKeys.members(wsId), refetchType: "none" })
      await refreshWorkspaces(queryClient)
      // With no workspace left, home is the "not in any workspace" page, which needs the fresh list.
      if (!next) {
        await navigate({ to: "/" })
      }
    },
  })
}
