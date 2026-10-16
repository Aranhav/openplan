import { queryOptions, useQuery } from "@tanstack/react-query"
import { api, unwrap } from "@/lib/api/client"
import { queryKeys } from "@/lib/api/keys"
import type { Member, ViewDim } from "../view-types"

/** `POST /models/{id}/members`: the members of a dimension of a module, in the order a view shows them. */
async function fetchMembers(
  modelId: string,
  moduleId: string,
  dim: ViewDim,
  showSummaries: boolean,
  signal?: AbortSignal,
): Promise<Member[]> {
  const result = await unwrap(
    api.POST("/models/{id}/members", {
      params: { path: { id: modelId } },
      body: { module_id: moduleId, dim, show_summaries: showSummaries },
      signal,
    }),
  )
  return result.members
}

/** The read of the members of a dimension, with the totals when the view shows them. */
export function membersOptions(
  modelId: string,
  moduleId: string,
  dim: ViewDim,
  showSummaries: boolean,
) {
  return queryOptions({
    queryKey: queryKeys.dimensionMembers(modelId, moduleId, dim, showSummaries),
    queryFn: ({ signal }) => fetchMembers(modelId, moduleId, dim, showSummaries, signal),
  })
}

/**
 * The members of a dimension. Page selectors, the show/hide list and the row headers of the grid
 * share one read of each dimension.
 */
export function useDimensionMembers(
  modelId: string,
  moduleId: string,
  dim: ViewDim,
  showSummaries: boolean,
) {
  return useQuery(membersOptions(modelId, moduleId, dim, showSummaries))
}
