import type { ModuleDto } from "@/features/structure/types"
import type { ViewDefinition } from "../view-types"
import { fitsModule } from "./view-state"

/** What stands for the module's own default pivot, which no saved view holds, in a draft's key. */
export const DEFAULT_VIEW_KEY = "default"

function storageKey(moduleId: string, viewKey: string) {
  return `openplan.view-draft.${moduleId}.${viewKey}`
}

function isDefinition(value: unknown): value is ViewDefinition {
  if (typeof value !== "object" || value === null) {
    return false
  }
  const { rows, columns, pages } = value as Partial<ViewDefinition>
  return (
    Array.isArray(rows) && Array.isArray(columns) && (pages === undefined || Array.isArray(pages))
  )
}

/**
 * The unsaved changes of a view, kept for the browser session so that reloading the page or going
 * to the Blueprint and back does not lose them. Anything that is not a view of this module (it
 * was changed since) or cannot be read is as if nothing was kept.
 */
export function readDraft(module: ModuleDto, viewKey: string): ViewDefinition | undefined {
  try {
    const text = sessionStorage.getItem(storageKey(module.id, viewKey))
    const draft: unknown = text === null ? undefined : JSON.parse(text)
    return isDefinition(draft) && fitsModule(draft, module) ? draft : undefined
  } catch {
    return undefined
  }
}

export function writeDraft(moduleId: string, viewKey: string, view: ViewDefinition) {
  try {
    sessionStorage.setItem(storageKey(moduleId, viewKey), JSON.stringify(view))
  } catch {
    // The view still works; only a reload loses what was changed.
  }
}

export function clearDraft(moduleId: string, viewKey: string) {
  try {
    sessionStorage.removeItem(storageKey(moduleId, viewKey))
  } catch {
    // Nothing was kept that could be read again.
  }
}
