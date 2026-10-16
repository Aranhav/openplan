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
  /**
   * The saved views of a module. They sit under the structure's key, as the members below do: a
   * structure change prunes what a view names and changes who has children, so both are read again.
   */
  views: (modelId: string, moduleId: string) => [
    "models",
    modelId,
    "structure",
    "modules",
    moduleId,
    "views",
  ],
  /** The members of one dimension of a module, as a view lists them (with the totals or without). */
  dimensionMembers: (modelId: string, moduleId: string, dim: unknown, showSummaries: boolean) => [
    "models",
    modelId,
    "structure",
    "modules",
    moduleId,
    "members",
    dim,
    showSummaries,
  ],
  /** What the formula editor offers after a prefix. It sits under the structure's key, so a change to the structure makes it stale. */
  formulaCompletions: (modelId: string, lineItemId: string, prefix: string) => [
    "models",
    modelId,
    "structure",
    "formula-completions",
    lineItemId,
    prefix,
  ],
  /** The built-in functions of the formula language, which are the same for every model. */
  formulaFunctions: ["formula-functions"],
  /** Every query of a model starts with this key, so one invalidation reaches them all. */
  query: (modelId: string, ...rest: unknown[]) => ["models", modelId, "query", ...rest],
  users: ["users"],
} as const

/** What a model's deletion is run under, so that what follows the model can tell it was deleted. */
export const mutationKeys = {
  deleteModel: ["delete-model"],
} as const

/** The pivot a view's key holds: `queryKeys.query(modelId, pivot, block)` puts it right after the model's `query` key. */
export function pivotOfKey(queryKey: readonly unknown[]): unknown {
  return queryKey[queryKeys.query("").length]
}

/** Matches the members list of every workspace, for a change that shows on all of them. */
export function isMembersKey(queryKey: readonly unknown[]) {
  return queryKey[0] === "workspaces" && queryKey[2] === "members"
}
