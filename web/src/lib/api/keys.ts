export const queryKeys = {
  setupStatus: ["setup-status"],
  me: ["me"],
  members: (id: string) => ["workspaces", id, "members"],
  models: (wsId: string) => ["workspaces", wsId, "models"],
  model: (id: string) => ["models", id],
  users: ["users"],
} as const
