import { skipToken, useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { ApiError, api, unwrap } from "@/lib/api/client"
import { queryKeys } from "@/lib/api/keys"
import type { components } from "@/lib/api/schema"

type CreateModelRequest = components["schemas"]["CreateModelRequest"]
type UpdateModelRequest = components["schemas"]["UpdateModelRequest"]
type ModelDto = components["schemas"]["ModelDto"]

export function useModels(wsId: string) {
  return useQuery({
    queryKey: queryKeys.models(wsId),
    queryFn: () => unwrap(api.GET("/workspaces/{id}/models", { params: { path: { id: wsId } } })),
  })
}

/** Without an id nothing is fetched, so callers on routes with no model can still call it. */
export function useModel(id: string | undefined) {
  return useQuery({
    queryKey: queryKeys.model(id ?? ""),
    queryFn:
      id === undefined
        ? skipToken
        : () => unwrap(api.GET("/models/{id}", { params: { path: { id } } })),
  })
}

/** A 404 means the model is gone, even while a copy of it is still cached. */
export function useModelNotFound(id: string | undefined) {
  const { error } = useModel(id)
  return error instanceof ApiError && error.status === 404
}

export function useCreateModel(wsId: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (body: CreateModelRequest) =>
      unwrap(api.POST("/workspaces/{id}/models", { params: { path: { id: wsId } }, body })),
    onSuccess: (model) => {
      queryClient.setQueryData(queryKeys.model(model.id), model)
      return queryClient.invalidateQueries({ queryKey: queryKeys.models(wsId) })
    },
  })
}

export function useUpdateModel(id: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (body: UpdateModelRequest) =>
      unwrap(api.PATCH("/models/{id}", { params: { path: { id } }, body })),
    onSuccess: (model) => {
      queryClient.setQueryData(queryKeys.model(id), model)
      return queryClient.invalidateQueries({ queryKey: queryKeys.models(model.workspace_id) })
    },
  })
}

export function useDeleteModel() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ id }: Pick<ModelDto, "id" | "workspace_id">) =>
      unwrap(api.DELETE("/models/{id}", { params: { path: { id } } })),
    onSuccess: (_, { id, workspace_id }) => {
      // The model's page is still mounted until the caller navigates away, and a refetch of a
      // deleted model would only 404. So mark its copy out of date without fetching it: anyone who
      // opens it later asks the server and gets the 404.
      queryClient.invalidateQueries({ queryKey: queryKeys.model(id), refetchType: "none" })
      return queryClient.invalidateQueries({ queryKey: queryKeys.models(workspace_id) })
    },
  })
}
