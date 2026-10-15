import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { api, unwrap } from "@/lib/api/client"
import { queryKeys } from "@/lib/api/keys"
import type { components } from "@/lib/api/schema"

type CreateUserRequest = components["schemas"]["CreateUserRequest"]
type UpdateUserRequest = components["schemas"]["UpdateUserRequest"]
type UpdateProfileRequest = components["schemas"]["UpdateProfileRequest"]
type ChangePasswordRequest = components["schemas"]["ChangePasswordRequest"]
type MeResponse = components["schemas"]["MeResponse"]

export function useUsers() {
  return useQuery({
    queryKey: queryKeys.users,
    queryFn: () => unwrap(api.GET("/users")),
  })
}

export function useCreateUser() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (body: CreateUserRequest) => unwrap(api.POST("/users", { body })),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.users }),
  })
}

export function useUpdateUser() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ id, ...body }: UpdateUserRequest & { id: string }) =>
      unwrap(api.PATCH("/users/{id}", { params: { path: { id } }, body })),
    onSuccess: (updated) => {
      // An admin who edits their own account sees the change in the sidebar too.
      const signedInId = queryClient.getQueryData<MeResponse>(queryKeys.me)?.user.id
      return Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.users }),
        updated.id === signedInId && queryClient.invalidateQueries({ queryKey: queryKeys.me }),
      ])
    },
  })
}

export function useUpdateProfile() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (body: UpdateProfileRequest) => unwrap(api.PATCH("/auth/me", { body })),
    onSuccess: (user) => {
      queryClient.setQueryData<MeResponse>(queryKeys.me, (me) => me && { ...me, user })
      return queryClient.invalidateQueries({ queryKey: queryKeys.users })
    },
  })
}

export function useChangePassword() {
  return useMutation({
    mutationFn: (body: ChangePasswordRequest) => unwrap(api.POST("/auth/me/password", { body })),
  })
}
