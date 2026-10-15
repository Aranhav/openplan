import { QueryClientProvider } from "@tanstack/react-query"
import { RouterProvider, createMemoryHistory } from "@tanstack/react-router"
import { render } from "@testing-library/react"
import { HttpResponse, http } from "msw"
import { createAppRouter } from "@/router"
import { problem } from "./problem"
import { createTestQueryClient } from "./render"
import { server } from "./server"

export const user = {
  id: "0192f3a0-0000-7000-8000-000000000001",
  email: "ada@example.com",
  name: "Ada Lovelace",
  is_instance_admin: true,
}
export const workspace = {
  id: "0192f3a0-0000-7000-8000-000000000002",
  name: "Acme Corp",
  role: "admin",
}
export const me = { user, workspaces: [workspace] }

export interface Session {
  needsSetup: boolean
  signedIn: boolean
}

/** Answers the setup-status and me endpoints from `state`, which a test can change mid-flight. */
export function mockSession(initial: Partial<Session> = {}): Session {
  const state: Session = { needsSetup: false, signedIn: true, ...initial }
  server.use(
    http.get("/api/v1/setup/status", () => HttpResponse.json({ needs_setup: state.needsSetup })),
    http.get("/api/v1/auth/me", () =>
      state.signedIn
        ? HttpResponse.json(me)
        : problem(401, "auth.unauthenticated", "Sign in to continue."),
    ),
  )
  return state
}

/** Renders the real route tree, starting at `path`, against the mocked server. */
export function renderApp(path: string) {
  const queryClient = createTestQueryClient()
  const router = createAppRouter(queryClient, createMemoryHistory({ initialEntries: [path] }))
  render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  )
  return { queryClient, router }
}
