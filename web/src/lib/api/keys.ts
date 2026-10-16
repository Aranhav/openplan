export const queryKeys = {
  setupStatus: ["setup-status"],
  me: ["me"],
  members: (id: string) => ["workspaces", id, "members"],
  models: (wsId: string) => ["workspaces", wsId, "models"],
  model: (id: string) => ["models", id],
  /** The structure document: lists with their items, subsets, versions, time ranges, modules and line items. */
  structure: (modelId: string) => ["models", modelId, "structure"],
  /** The items of one list. It sits under the structure's key, so a change to the structure reads it again too. */
  listItems: (modelId: string, listId: string) => [
    "models",
    modelId,
    "structure",
    "lists",
    listId,
    "items",
  ],
  /** Every query of a model starts with this key, so one invalidation reaches them all. */
  query: (modelId: string, ...rest: unknown[]) => ["models", modelId, "query", ...rest],
  users: ["users"],
} as const

/** Matches the members list of every workspace, for a change that shows on all of them. */
export function isMembersKey(queryKey: readonly unknown[]) {
  return queryKey[0] === "workspaces" && queryKey[2] === "members"
}
