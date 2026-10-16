import { type QueryClient, useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { ApiError, api, unwrap } from "@/lib/api/client"
import { queryKeys } from "@/lib/api/keys"
import type { components } from "@/lib/api/schema"
import type { SavedView } from "../view-types"

type Schemas = components["schemas"]

// The client's response types turn the tuple of a period value in a filter into an array of its
// parts; a view has the schema's own shape.
const asViews = (views: unknown) => views as SavedView[]
const asView = (view: unknown) => view as SavedView

/** The saved views of a module: the default one first, then by name. */
export function useSavedViews(modelId: string, moduleId: string) {
  return useQuery({
    queryKey: queryKeys.views(modelId, moduleId),
    queryFn: async () =>
      asViews(
        await unwrap(
          api.GET("/models/{id}/modules/{module_id}/views", {
            params: { path: { id: modelId, module_id: moduleId } },
          }),
        ),
      ),
  })
}

/**
 * Puts a view that was just saved in the list at once, so the screen compares with what it
 * saved, and reads the list again, since making a view the default takes the mark off another.
 */
async function refreshViews(
  queryClient: QueryClient,
  modelId: string,
  moduleId: string,
  change: (views: SavedView[]) => SavedView[],
) {
  const key = queryKeys.views(modelId, moduleId)
  queryClient.setQueryData<SavedView[]>(key, (views) => change(views ?? []))
  await queryClient.invalidateQueries({ queryKey: key })
}

/**
 * Another view became the default while this one was being saved as it: the list is read again,
 * so that the screen shows which one it is before the user tries once more.
 */
function readAgainOnDefaultConflict(queryClient: QueryClient, modelId: string, moduleId: string) {
  return (error: unknown) => {
    if (error instanceof ApiError && error.code === "view.default_conflict") {
      void queryClient.invalidateQueries({ queryKey: queryKeys.views(modelId, moduleId) })
    }
  }
}

export function useCreateView(modelId: string, moduleId: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async (body: Schemas["CreateViewRequest"]) =>
      asView(
        await unwrap(
          api.POST("/models/{id}/modules/{module_id}/views", {
            params: { path: { id: modelId, module_id: moduleId } },
            body,
          }),
        ),
      ),
    onSuccess: (view) =>
      refreshViews(queryClient, modelId, moduleId, (views) => [
        ...views.map((other) => (view.is_default ? { ...other, is_default: false } : other)),
        view,
      ]),
    onError: readAgainOnDefaultConflict(queryClient, modelId, moduleId),
  })
}

export function useUpdateView(modelId: string, moduleId: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async ({
      viewId,
      body,
    }: { viewId: string; body: Schemas["UpdateViewRequest"] }) =>
      asView(
        await unwrap(
          api.PATCH("/models/{id}/views/{view_id}", {
            params: { path: { id: modelId, view_id: viewId } },
            body,
          }),
        ),
      ),
    onSuccess: (view) =>
      refreshViews(queryClient, modelId, moduleId, (views) =>
        views.map((other) =>
          other.id === view.id
            ? view
            : view.is_default
              ? { ...other, is_default: false }
              : other,
        ),
      ),
    onError: readAgainOnDefaultConflict(queryClient, modelId, moduleId),
  })
}

export function useDeleteView(modelId: string, moduleId: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (viewId: string) =>
      unwrap(
        api.DELETE("/models/{id}/views/{view_id}", {
          params: { path: { id: modelId, view_id: viewId } },
        }),
      ).then(() => viewId),
    onSuccess: (viewId) =>
      refreshViews(queryClient, modelId, moduleId, (views) =>
        views.filter((view) => view.id !== viewId),
      ),
  })
}
