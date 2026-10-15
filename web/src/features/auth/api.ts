import { queryOptions, useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { useNavigate } from "@tanstack/react-router"
import { ApiError, api, unwrap } from "@/lib/api/client"
import { queryKeys } from "@/lib/api/keys"
import type { components } from "@/lib/api/schema"

type LoginRequest = components["schemas"]["LoginRequest"]
type SetupRequest = components["schemas"]["SetupRequest"]

export const setupStatusQuery = queryOptions({
  queryKey: queryKeys.setupStatus,
  queryFn: () => unwrap(api.GET("/setup/status")),
})

export const meQuery = queryOptions({
  queryKey: queryKeys.me,
  queryFn: () => unwrap(api.GET("/auth/me")),
})

export function useMe() {
  return useQuery(meQuery)
}

export function useSetup() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (body: SetupRequest) => unwrap(api.POST("/setup", { body })),
    onSuccess: ({ user, workspace }) => {
      queryClient.setQueryData(setupStatusQuery.queryKey, { needs_setup: false })
      queryClient.setQueryData(meQuery.queryKey, { user, workspaces: [workspace] })
    },
    onError: (error) => {
      // Someone else finished setup first; don't let /login send the user back to /setup.
      if (error instanceof ApiError && error.code === "setup.already_done") {
        queryClient.setQueryData(setupStatusQuery.queryKey, { needs_setup: false })
      }
    },
  })
}

export function useLogin() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (body: LoginRequest) => unwrap(api.POST("/auth/login", { body })),
    // The login response has no workspaces, so let the route guard fetch `me`
    // fresh, and drop anything cached for a previous session.
    onSuccess: () => queryClient.removeQueries(),
  })
}

export function useLogout() {
  const queryClient = useQueryClient()
  const navigate = useNavigate()
  return useMutation({
    mutationFn: () => unwrap(api.POST("/auth/logout")),
    // Clear first: /login treats a cached `me` as proof that the user is still signed in.
    onSuccess: () => {
      queryClient.removeQueries()
      return navigate({ to: "/login", replace: true })
    },
  })
}
