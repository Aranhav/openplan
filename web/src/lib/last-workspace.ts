const LAST_WORKSPACE_KEY = "openplan.lastWorkspace"

function readLastWorkspace(): string | null {
  try {
    return window.localStorage.getItem(LAST_WORKSPACE_KEY)
  } catch {
    return null
  }
}

export function setLastWorkspace(id: string) {
  try {
    window.localStorage.setItem(LAST_WORKSPACE_KEY, id)
  } catch {
    // Storage can be unavailable (private mode); the choice then only lasts until the next visit.
  }
}

/** The workspace used last, if the user can still open it, else the first one. */
export function pickWorkspace<T extends { id: string }>(workspaces: readonly T[]): T | undefined {
  const lastId = readLastWorkspace()
  return workspaces.find((workspace) => workspace.id === lastId) ?? workspaces[0]
}
