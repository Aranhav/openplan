import { type QueryClient, useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { api, unwrap } from "@/lib/api/client"
import { queryKeys } from "@/lib/api/keys"
import type { components } from "@/lib/api/schema"

type Schemas = components["schemas"]

/**
 * The structure document of a model: calendar, lists with their items, subsets, versions, time
 * ranges, modules and line items. Its field names are the engine's (`parent`, `list`, `items`),
 * and months are indices from the start of the calendar; the endpoints below take and return the
 * `Dto` shapes instead (`parent_list_id`, `list_id`, `item_ids`, month labels).
 */
export function useStructure(modelId: string) {
  return useQuery({
    queryKey: queryKeys.structure(modelId),
    queryFn: () => unwrap(api.GET("/models/{id}/structure", { params: { path: { id: modelId } } })),
  })
}

/** A change to the structure can change what every view of the model shows, so both are read again. */
function refreshStructure(queryClient: QueryClient, modelId: string) {
  return Promise.all([
    queryClient.invalidateQueries({ queryKey: queryKeys.structure(modelId) }),
    queryClient.invalidateQueries({ queryKey: queryKeys.query(modelId) }),
  ])
}

/**
 * A mutation of the structure. It settles once the structure and the views have been read again,
 * so a caller that waits for it (to open the module it just created) finds the new structure.
 */
function useStructureMutation<TVariables, TData>(
  modelId: string,
  mutationFn: (variables: TVariables) => Promise<TData>,
) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn,
    onSuccess: () => refreshStructure(queryClient, modelId),
  })
}

export function useCreateList(modelId: string) {
  return useStructureMutation(modelId, (body: Schemas["CreateListRequest"]) =>
    unwrap(api.POST("/models/{id}/lists", { params: { path: { id: modelId } }, body })),
  )
}

export function useUpdateList(modelId: string) {
  return useStructureMutation(
    modelId,
    ({ listId, body }: { listId: string; body: Schemas["UpdateListRequest"] }) =>
      unwrap(
        api.PATCH("/models/{id}/lists/{list_id}", {
          params: { path: { id: modelId, list_id: listId } },
          body,
        }),
      ),
  )
}

export function useDeleteList(modelId: string) {
  return useStructureMutation(modelId, (listId: string) =>
    unwrap(
      api.DELETE("/models/{id}/lists/{list_id}", {
        params: { path: { id: modelId, list_id: listId } },
      }),
    ),
  )
}

export function useCreateItems(modelId: string) {
  return useStructureMutation(
    modelId,
    ({ listId, items }: { listId: string; items: Schemas["ItemInput"][] }) =>
      unwrap(
        api.POST("/models/{id}/lists/{list_id}/items", {
          params: { path: { id: modelId, list_id: listId } },
          body: { items },
        }),
      ),
  )
}

export function useUpdateItem(modelId: string) {
  return useStructureMutation(
    modelId,
    ({
      listId,
      itemId,
      body,
    }: {
      listId: string
      itemId: string
      body: Schemas["UpdateItemRequest"]
    }) =>
      unwrap(
        api.PATCH("/models/{id}/lists/{list_id}/items/{item_id}", {
          params: { path: { id: modelId, list_id: listId, item_id: itemId } },
          body,
        }),
      ),
  )
}

export function useDeleteItems(modelId: string) {
  return useStructureMutation(modelId, ({ listId, ids }: { listId: string; ids: string[] }) =>
    unwrap(
      api.POST("/models/{id}/lists/{list_id}/items/delete", {
        params: { path: { id: modelId, list_id: listId } },
        body: { ids },
      }),
    ),
  )
}

export function useCreateSubset(modelId: string) {
  return useStructureMutation(modelId, (body: Schemas["CreateSubsetRequest"]) =>
    unwrap(api.POST("/models/{id}/subsets", { params: { path: { id: modelId } }, body })),
  )
}

export function useUpdateSubset(modelId: string) {
  return useStructureMutation(
    modelId,
    ({ subsetId, body }: { subsetId: string; body: Schemas["UpdateSubsetRequest"] }) =>
      unwrap(
        api.PATCH("/models/{id}/subsets/{subset_id}", {
          params: { path: { id: modelId, subset_id: subsetId } },
          body,
        }),
      ),
  )
}

export function useDeleteSubset(modelId: string) {
  return useStructureMutation(modelId, (subsetId: string) =>
    unwrap(
      api.DELETE("/models/{id}/subsets/{subset_id}", {
        params: { path: { id: modelId, subset_id: subsetId } },
      }),
    ),
  )
}

export function useCreateVersion(modelId: string) {
  return useStructureMutation(modelId, (body: Schemas["VersionRequest"]) =>
    unwrap(api.POST("/models/{id}/versions", { params: { path: { id: modelId } }, body })),
  )
}

/** Replaces the whole version, so `body` carries every field. */
export function useUpdateVersion(modelId: string) {
  return useStructureMutation(
    modelId,
    ({ versionId, body }: { versionId: string; body: Schemas["VersionRequest"] }) =>
      unwrap(
        api.PUT("/models/{id}/versions/{version_id}", {
          params: { path: { id: modelId, version_id: versionId } },
          body,
        }),
      ),
  )
}

export function useDeleteVersion(modelId: string) {
  return useStructureMutation(modelId, (versionId: string) =>
    unwrap(
      api.DELETE("/models/{id}/versions/{version_id}", {
        params: { path: { id: modelId, version_id: versionId } },
      }),
    ),
  )
}

export function useUpdateCalendar(modelId: string) {
  return useStructureMutation(modelId, (body: Schemas["CalendarDto"]) =>
    unwrap(api.PUT("/models/{id}/calendar", { params: { path: { id: modelId } }, body })),
  )
}

export function useCreateTimeRange(modelId: string) {
  return useStructureMutation(modelId, (body: Schemas["CreateTimeRangeRequest"]) =>
    unwrap(api.POST("/models/{id}/time-ranges", { params: { path: { id: modelId } }, body })),
  )
}

export function useDeleteTimeRange(modelId: string) {
  return useStructureMutation(modelId, (rangeId: string) =>
    unwrap(
      api.DELETE("/models/{id}/time-ranges/{range_id}", {
        params: { path: { id: modelId, range_id: rangeId } },
      }),
    ),
  )
}

export function useCreateModule(modelId: string) {
  return useStructureMutation(modelId, (body: Schemas["CreateModuleRequest"]) =>
    unwrap(api.POST("/models/{id}/modules", { params: { path: { id: modelId } }, body })),
  )
}

export function useUpdateModule(modelId: string) {
  return useStructureMutation(
    modelId,
    ({ moduleId, body }: { moduleId: string; body: Schemas["UpdateModuleRequest"] }) =>
      unwrap(
        api.PATCH("/models/{id}/modules/{module_id}", {
          params: { path: { id: modelId, module_id: moduleId } },
          body,
        }),
      ),
  )
}

export function useDeleteModule(modelId: string) {
  return useStructureMutation(modelId, (moduleId: string) =>
    unwrap(
      api.DELETE("/models/{id}/modules/{module_id}", {
        params: { path: { id: modelId, module_id: moduleId } },
      }),
    ),
  )
}

export function useCreateLineItem(modelId: string) {
  return useStructureMutation(
    modelId,
    ({ moduleId, body }: { moduleId: string; body: Schemas["CreateLineItemRequest"] }) =>
      unwrap(
        api.POST("/models/{id}/modules/{module_id}/line-items", {
          params: { path: { id: modelId, module_id: moduleId } },
          body,
        }),
      ),
  )
}

export function useUpdateLineItem(modelId: string) {
  return useStructureMutation(
    modelId,
    ({ lineItemId, body }: { lineItemId: string; body: Schemas["UpdateLineItemRequest"] }) =>
      unwrap(
        api.PATCH("/models/{id}/line-items/{line_item_id}", {
          params: { path: { id: modelId, line_item_id: lineItemId } },
          body,
        }),
      ),
  )
}

export function useDeleteLineItem(modelId: string) {
  return useStructureMutation(modelId, (lineItemId: string) =>
    unwrap(
      api.DELETE("/models/{id}/line-items/{line_item_id}", {
        params: { path: { id: modelId, line_item_id: lineItemId } },
      }),
    ),
  )
}

export function useReorderLineItems(modelId: string) {
  return useStructureMutation(modelId, (body: Schemas["ReorderLineItemsRequest"]) =>
    unwrap(
      api.POST("/models/{id}/line-items/reorder", { params: { path: { id: modelId } }, body }),
    ),
  )
}
