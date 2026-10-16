import { skipToken, useQuery } from "@tanstack/react-query"
import { api, unwrap } from "@/lib/api/client"
import { queryKeys } from "@/lib/api/keys"

/**
 * The items of one list, in order. A change to the structure reads them again with the structure
 * document, whose key this one sits under. Without a list there is nothing to read.
 */
export function useListItems(modelId: string, listId: string | undefined) {
  return useQuery({
    queryKey: queryKeys.listItems(modelId, listId ?? ""),
    queryFn:
      listId === undefined
        ? skipToken
        : () =>
            unwrap(
              api.GET("/models/{id}/lists/{list_id}/items", {
                params: { path: { id: modelId, list_id: listId } },
              }),
            ),
  })
}
