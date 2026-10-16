import { QueryClientProvider } from "@tanstack/react-query"
import { RouterProvider, createMemoryHistory } from "@tanstack/react-router"
import { render } from "@testing-library/react"
import { HttpResponse, http } from "msw"
import { ThemeProvider } from "@/components/theme-provider"
import type { components } from "@/lib/api/schema"
import { createAppRouter } from "@/router"
import { problem } from "./problem"
import { createTestQueryClient } from "./render"
import { server } from "./server"
import type { StructureDto } from "@/features/structure/types"
import { makeStructure } from "./structure"

type MeResponse = components["schemas"]["MeResponse"]
type ModelDto = components["schemas"]["ModelDto"]
type WorkspaceSummary = components["schemas"]["WorkspaceSummary"]

export const user = {
  id: "0192f3a0-0000-7000-8000-000000000001",
  email: "ada@example.com",
  name: "Ada Lovelace",
  is_instance_admin: true,
}
export const workspace: WorkspaceSummary = {
  id: "0192f3a0-0000-7000-8000-000000000002",
  name: "Acme Corp",
  role: "admin",
}
/** A second workspace, where the signed-in user is only a viewer. */
export const globex: WorkspaceSummary = {
  id: "0192f3a0-0000-7000-8000-000000000003",
  name: "Globex",
  role: "viewer",
}
export const me: MeResponse = { user, workspaces: [workspace] }
/** `me` with both workspaces, for tests that switch between them. */
export const meInTwoWorkspaces: MeResponse = { user, workspaces: [workspace, globex] }

/** A model of `workspace`; override any field to describe a different one. */
export function makeModel(overrides: Partial<ModelDto> = {}): ModelDto {
  return {
    id: "0192f3a0-0000-7000-8000-000000000010",
    workspace_id: workspace.id,
    name: "Revenue plan",
    description: "",
    mode: "dev",
    calendar: { first_year: 2026, fiscal_year_start_month: 1, years: 3 },
    created_at: "2026-10-01T09:00:00Z",
    updated_at: "2026-10-01T09:00:00Z",
    created_by: user.id,
    ...overrides,
  }
}

export interface Session {
  needsSetup: boolean
  signedIn: boolean
  /** What the me endpoint returns for a signed-in user, workspaces included. */
  me: MeResponse
  /** How many times the me endpoint has been asked. */
  meRequests: number
}

/**
 * Answers the setup-status and me endpoints from `state`, which a test can change mid-flight.
 * Every workspace is empty of models until a test calls `serveModels`, and every model empty of
 * structure until it calls `serveStructure`.
 */
export function mockSession(initial: Partial<Session> = {}): Session {
  const state: Session = { needsSetup: false, signedIn: true, me, meRequests: 0, ...initial }
  server.use(
    http.get("/api/v1/setup/status", () => HttpResponse.json({ needs_setup: state.needsSetup })),
    http.get("/api/v1/auth/me", () => {
      state.meRequests += 1
      return state.signedIn
        ? HttpResponse.json(state.me)
        : problem(401, "auth.unauthenticated", "Sign in to continue.")
    }),
    http.get("/api/v1/workspaces/:id/models", () => HttpResponse.json([])),
    http.get("/api/v1/models/:id/structure", () => HttpResponse.json(makeStructure())),
  )
  return state
}

/** Serves `structure` as the structure of every model; call it after `mockSession`. */
export function serveStructure(structure: StructureDto) {
  server.use(http.get("/api/v1/models/:id/structure", () => HttpResponse.json(structure)))
}

export interface ModelStore {
  models: ModelDto[]
}

/**
 * Serves the model endpoints from `store.models`, which a test can change mid-flight. Renaming
 * and deleting change it the way the server would; call it after `mockSession`.
 */
export function serveModels(models: ModelDto[]): ModelStore {
  const store: ModelStore = { models }
  const find = (id: unknown) => store.models.find((model) => model.id === id)
  server.use(
    http.get("/api/v1/workspaces/:id/models", ({ params }) =>
      HttpResponse.json(store.models.filter((model) => model.workspace_id === params.id)),
    ),
    http.get("/api/v1/models/:id", ({ params }) => {
      const model = find(params.id)
      return model ? HttpResponse.json(model) : problem(404, "not_found", "Not found.")
    }),
    http.patch("/api/v1/models/:id", async ({ params, request }) => {
      const model = find(params.id)
      if (!model) {
        return problem(404, "not_found", "Not found.")
      }
      const updated = {
        ...model,
        ...((await request.json()) as Partial<ModelDto>),
        updated_at: new Date().toISOString(),
      }
      store.models = store.models.map((m) => (m.id === model.id ? updated : m))
      return HttpResponse.json(updated)
    }),
    http.delete("/api/v1/models/:id", ({ params }) => {
      if (!find(params.id)) {
        return problem(404, "not_found", "Not found.")
      }
      store.models = store.models.filter((model) => model.id !== params.id)
      return new HttpResponse(null, { status: 204 })
    }),
  )
  return store
}

/** Renders the real route tree, starting at `path`, against the mocked server. */
export function renderApp(path: string) {
  const queryClient = createTestQueryClient()
  const router = createAppRouter(queryClient, createMemoryHistory({ initialEntries: [path] }))
  render(
    <ThemeProvider>
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>
    </ThemeProvider>,
  )
  return { queryClient, router }
}
