import { HttpResponse, http } from "msw"
import type { Member, SavedView, ViewDefinition, ViewDim } from "@/features/grid/view-types"
import type { components } from "@/lib/api/schema"
import { problem } from "./problem"
import { server } from "./server"

type Schemas = components["schemas"]

/** The line items down the rows and a column dimension across, which a test names for itself. */
export const simpleDefinition: ViewDefinition = {
  rows: [{ kind: "line_items" }],
  columns: [{ kind: "time" }],
  pages: [],
}

/** A saved view of a module; override any field to describe another. */
export function makeView(overrides: Partial<SavedView> = {}): SavedView {
  return {
    id: "0192f3a0-0000-7000-8000-000000000a01",
    module_id: "0192f3a0-0000-7000-8000-000000000303",
    name: "Quarterly review",
    definition: simpleDefinition,
    is_default: false,
    pruned: false,
    created_by: "0192f3a0-0000-7000-8000-000000000001",
    updated_at: "2026-10-01T09:00:00Z",
    ...overrides,
  }
}

export interface ViewStore {
  /** The saved views, which creating, changing and deleting change as the server would. */
  views: SavedView[]
  /** What was sent to change them, by what it did. */
  requests: { action: "create" | "update" | "delete"; id?: string; body?: unknown }[]
}

let counter = 0

/**
 * Serves the saved views of every module from `store.views`: listing them (the default first,
 * then by name), saving one, changing one and deleting one, with the refusals of the server for
 * a name that is taken.
 */
export function serveViews(views: SavedView[] = []): ViewStore {
  const store: ViewStore = { views, requests: [] }
  const taken = (moduleId: string, name: string, except?: string) =>
    store.views.some(
      (view) =>
        view.module_id === moduleId &&
        view.id !== except &&
        view.name.toLowerCase() === name.toLowerCase(),
    )
  const clearDefault = (moduleId: string, except: string) => {
    store.views = store.views.map((view) =>
      view.module_id === moduleId && view.id !== except ? { ...view, is_default: false } : view,
    )
  }
  server.use(
    http.get("/api/v1/models/:id/modules/:moduleId/views", ({ params }) =>
      HttpResponse.json(
        store.views
          .filter((view) => view.module_id === params.moduleId)
          .toSorted(
            (a, b) =>
              Number(b.is_default) - Number(a.is_default) || a.name.localeCompare(b.name),
          ),
      ),
    ),
    http.post("/api/v1/models/:id/modules/:moduleId/views", async ({ params, request }) => {
      const body = (await request.json()) as Schemas["CreateViewRequest"]
      store.requests.push({ action: "create", body })
      const moduleId = String(params.moduleId)
      if (taken(moduleId, body.name)) {
        return problem(409, "structure.name_taken", "A view with that name already exists.")
      }
      counter += 1
      const view: SavedView = {
        id: `0192f3a0-0000-7000-8000-0000000000${String(counter).padStart(2, "0")}b1`,
        module_id: moduleId,
        name: body.name,
        definition: body.definition,
        is_default: body.is_default ?? false,
        pruned: false,
        created_by: "0192f3a0-0000-7000-8000-000000000001",
        updated_at: "2026-10-02T09:00:00Z",
      }
      if (view.is_default) {
        clearDefault(moduleId, view.id)
      }
      store.views = [...store.views, view]
      return HttpResponse.json(view, { status: 201 })
    }),
    http.patch("/api/v1/models/:id/views/:viewId", async ({ params, request }) => {
      const body = (await request.json()) as Schemas["UpdateViewRequest"]
      store.requests.push({ action: "update", id: String(params.viewId), body })
      const view = store.views.find((candidate) => candidate.id === params.viewId)
      if (!view) {
        return problem(404, "not_found", "Not found.")
      }
      if (body.name && taken(view.module_id, body.name, view.id)) {
        return problem(409, "structure.name_taken", "A view with that name already exists.")
      }
      const updated: SavedView = {
        ...view,
        ...(body.name != null && { name: body.name }),
        ...(body.definition != null && { definition: body.definition }),
        ...(body.is_default != null && { is_default: body.is_default }),
        pruned: false,
      }
      if (updated.is_default) {
        clearDefault(view.module_id, view.id)
      }
      store.views = store.views.map((candidate) => (candidate.id === view.id ? updated : candidate))
      return HttpResponse.json(updated)
    }),
    http.delete("/api/v1/models/:id/views/:viewId", ({ params }) => {
      store.requests.push({ action: "delete", id: String(params.viewId) })
      if (!store.views.some((view) => view.id === params.viewId)) {
        return problem(404, "not_found", "Not found.")
      }
      store.views = store.views.filter((view) => view.id !== params.viewId)
      return new HttpResponse(null, { status: 204 })
    }),
  )
  return store
}

/** A member of a dimension as the members endpoint lists it. */
export function memberOf(key: string, label: string, overrides: Partial<Member> = {}): Member {
  return {
    key,
    label,
    depth: 0,
    is_summary: false,
    has_children: false,
    collapsed: false,
    ...overrides,
  }
}

export interface MembersStore {
  /** The body of every request, in order. */
  requests: Schemas["MembersRequest"][]
}

/**
 * Serves `POST /models/{id}/members` from `membersOf`, which gives the members of a dimension
 * (none by default), and records what was asked.
 */
export function serveMembers(membersOf: (dim: ViewDim) => Member[]): MembersStore {
  const store: MembersStore = { requests: [] }
  server.use(
    http.post("/api/v1/models/:id/members", async ({ request }) => {
      const body = (await request.json()) as Schemas["MembersRequest"]
      store.requests.push(body)
      return HttpResponse.json({ members: membersOf(body.dim) })
    }),
  )
  return store
}
