import { type QueryClient, useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { meQuery } from "@/features/auth/api"
import { api, unwrap } from "@/lib/api/client"
import { queryKeys } from "@/lib/api/keys"
import type { components } from "@/lib/api/schema"
import type { WorkspaceRole } from "./roles"

type WorkspaceNameRequest = components["schemas"]["WorkspaceNameRequest"]
type AddMemberRequest = components["schemas"]["AddMemberRequest"]

/** The list sits in two caches (this one and `me`), so a change to a workspace refreshes both. */
function refreshWorkspaces(queryClient: QueryClient) {
  return Promise.all([
    queryClient.invalidateQueries({ queryKey: queryKeys.workspaces, exact: true }),
    queryClient.invalidateQueries({ queryKey: queryKeys.me }),
  ])
}

export function useWorkspaces() {
  const queryClient = useQueryClient()
  return useQuery({
    queryKey: queryKeys.workspaces,
    queryFn: () => unwrap(api.GET("/workspaces")),
    // The route guard has already loaded `me`, which carries the same list.
    initialData: () => queryClient.getQueryData(meQuery.queryKey)?.workspaces,
    initialDataUpdatedAt: () => queryClient.getQueryState(meQuery.queryKey)?.dataUpdatedAt,
  })
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
