import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { RouterContextProvider, RouterProvider, createMemoryHistory } from "@tanstack/react-router"
import { render, renderHook, screen, waitFor } from "@testing-library/react"
import { HttpResponse, http } from "msw"
import type { ReactNode } from "react"
import { describe, expect, it, vi } from "vitest"
import { createAppRouter } from "@/router"
import { createTestQueryClient } from "@/test/render"
import { problem } from "@/test/problem"
import { server } from "@/test/server"
import { useLogout } from "./api"

const user = {
  id: "0192f3a0-0000-7000-8000-000000000001",
  email: "ada@example.com",
  name: "Ada Lovelace",
  is_instance_admin: true,
}
const workspace = { id: "0192f3a0-0000-7000-8000-000000000002", name: "Acme Corp", role: "admin" }
const me = { user, workspaces: [workspace] }

function serverState({ needsSetup, signedIn }: { needsSetup: boolean; signedIn: boolean }) {
  server.use(
    http.get("/api/v1/setup/status", () => HttpResponse.json({ needs_setup: needsSetup })),
    http.get("/api/v1/auth/me", () =>
      signedIn
        ? HttpResponse.json(me)
        : problem(401, "auth.unauthenticated", "Sign in to continue."),
    ),
  )
}

function renderApp(path: string, queryClient: QueryClient = createTestQueryClient()) {
  const router = createAppRouter(queryClient, createMemoryHistory({ initialEntries: [path] }))
  render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  )
  return { queryClient, router }
}

describe("route guards", () => {
  it("sends a visitor to setup while the instance has no users", async () => {
    serverState({ needsSetup: true, signedIn: false })
    const { router } = renderApp("/")

    expect(await screen.findByRole("heading", { name: "Set up OpenPlan" })).toBeInTheDocument()
    expect(router.state.location.pathname).toBe("/setup")
  })

  it("sends a signed-out visitor to sign in and remembers where they were going", async () => {
    serverState({ needsSetup: false, signedIn: false })
    const { router } = renderApp("/")

    expect(await screen.findByRole("heading", { name: "Sign in" })).toBeInTheDocument()
    expect(router.state.location.pathname).toBe("/login")
    expect(router.state.location.search).toEqual({ redirect: "/" })
  })

  it("lets a signed-in user through and exposes them on the route context", async () => {
    serverState({ needsSetup: false, signedIn: true })
    const { router } = renderApp("/")

    await waitFor(() => expect(router.state.status).toBe("idle"))
    const appMatch = router.state.matches.find((match) => match.routeId === "/_app")
    expect(router.state.location.pathname).toBe("/")
    expect(appMatch?.context.me).toEqual(me)
  })

  it("sends setup visitors to sign in once setup is done", async () => {
    serverState({ needsSetup: false, signedIn: false })
    const { router } = renderApp("/setup")

    expect(await screen.findByRole("heading", { name: "Sign in" })).toBeInTheDocument()
    expect(router.state.location.pathname).toBe("/login")
  })

  it("shows setup to a visitor of a fresh instance", async () => {
    serverState({ needsSetup: true, signedIn: false })
    const { router } = renderApp("/setup")

    expect(await screen.findByRole("heading", { name: "Set up OpenPlan" })).toBeInTheDocument()
    expect(router.state.location.pathname).toBe("/setup")
  })
})

describe("useLogout", () => {
  it("signs out, clears every cached query and goes to sign in", async () => {
    serverState({ needsSetup: false, signedIn: true })
    const signOut = vi.fn()
    server.use(
      http.post("/api/v1/auth/logout", () => {
        signOut()
        return new HttpResponse(null, { status: 204 })
      }),
    )
    const { queryClient, router } = renderApp("/")
    await waitFor(() => expect(router.state.status).toBe("idle"))
    queryClient.setQueryData(["workspaces"], [])

    const { result } = renderHook(() => useLogout(), {
      wrapper: ({ children }: { children: ReactNode }) => (
        <QueryClientProvider client={queryClient}>
          <RouterContextProvider router={router}>{children}</RouterContextProvider>
        </QueryClientProvider>
      ),
    })
    result.current.mutate()

    await waitFor(() => expect(router.state.location.pathname).toBe("/login"))
    await waitFor(() => expect(queryClient.getQueryCache().getAll()).toHaveLength(0))
    expect(signOut).toHaveBeenCalledOnce()
  })
})
