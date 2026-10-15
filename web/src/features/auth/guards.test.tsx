import { QueryClientProvider } from "@tanstack/react-query"
import { RouterContextProvider } from "@tanstack/react-router"
import { renderHook, screen, waitFor } from "@testing-library/react"
import { HttpResponse, http } from "msw"
import type { ReactNode } from "react"
import { describe, expect, it, vi } from "vitest"
import { me, mockSession, renderApp } from "@/test/app"
import { server } from "@/test/server"
import { useLogout } from "./api"

function appContext(router: ReturnType<typeof renderApp>["router"]) {
  return router.state.matches.find((match) => match.routeId === "/_app")?.context
}

describe("the app guard", () => {
  it("sends a visitor to setup while the instance has no users", async () => {
    mockSession({ needsSetup: true, signedIn: false })
    const { router } = renderApp("/")

    expect(await screen.findByRole("heading", { name: "Set up OpenPlan" })).toBeInTheDocument()
    expect(router.state.location.pathname).toBe("/setup")
  })

  it("sends a signed-out visitor to sign in", async () => {
    mockSession({ signedIn: false })
    const { router } = renderApp("/")

    expect(await screen.findByRole("heading", { name: "Sign in" })).toBeInTheDocument()
    expect(router.state.location.pathname).toBe("/login")
  })

  it("leaves the redirect out when the visitor was only going home", async () => {
    mockSession({ signedIn: false })
    const { router } = renderApp("/")

    await screen.findByRole("heading", { name: "Sign in" })
    expect(router.state.location.search).toEqual({})
    expect(router.state.location.href).toBe("/login")
  })

  it("remembers where a signed-out visitor was going", async () => {
    mockSession({ signedIn: false })
    const { router } = renderApp("/?tab=plan")

    await screen.findByRole("heading", { name: "Sign in" })
    expect(router.state.location.search).toEqual({ redirect: "/?tab=plan" })
  })

  it("lets a signed-in user through and exposes them on the route context", async () => {
    mockSession()
    const { router } = renderApp("/")

    await waitFor(() => expect(router.state.status).toBe("idle"))
    expect(router.state.location.pathname).toBe("/")
    expect(appContext(router)?.me).toEqual(me)
  })
})

describe("the setup page", () => {
  it("sends visitors to sign in once setup is done", async () => {
    mockSession({ signedIn: false })
    const { router } = renderApp("/setup")

    expect(await screen.findByRole("heading", { name: "Sign in" })).toBeInTheDocument()
    expect(router.state.location.pathname).toBe("/login")
  })

  it("shows the form to a visitor of a fresh instance", async () => {
    mockSession({ needsSetup: true, signedIn: false })
    const { router } = renderApp("/setup")

    expect(await screen.findByRole("heading", { name: "Set up OpenPlan" })).toBeInTheDocument()
    expect(router.state.location.pathname).toBe("/setup")
    expect(document.title).toBe("Set up OpenPlan")
  })
})

describe("the sign-in page", () => {
  it("shows the form to a signed-out visitor", async () => {
    mockSession({ signedIn: false })
    const { router } = renderApp("/login")

    expect(await screen.findByRole("heading", { name: "Sign in" })).toBeInTheDocument()
    expect(router.state.location.pathname).toBe("/login")
    expect(document.title).toBe("Sign in · OpenPlan")
  })

  it("sends visitors to setup while the instance has no users", async () => {
    mockSession({ needsSetup: true, signedIn: false })
    const { router } = renderApp("/login")

    expect(await screen.findByRole("heading", { name: "Set up OpenPlan" })).toBeInTheDocument()
    expect(router.state.location.pathname).toBe("/setup")
  })

  it("sends a signed-in user home", async () => {
    mockSession()
    const { router } = renderApp("/login")

    await waitFor(() => expect(router.state.location.href).toBe("/"))
    expect(screen.queryByRole("heading", { name: "Sign in" })).not.toBeInTheDocument()
  })

  it("sends a signed-in user on to the page in the redirect parameter", async () => {
    mockSession()
    const { router } = renderApp("/login?redirect=%2F%3Ftab%3Dplan")

    await waitFor(() => expect(router.state.location.href).toBe("/?tab=plan"))
  })

  it("does not follow a redirect parameter that leaves the app", async () => {
    mockSession()
    const { router } = renderApp("/login?redirect=https%3A%2F%2Fevil.example")

    await waitFor(() => expect(router.state.location.href).toBe("/"))
  })
})

describe("useLogout", () => {
  it("signs out, forgets the session's data and goes to sign in", async () => {
    const session = mockSession()
    const signOut = vi.fn()
    server.use(
      http.post("/api/v1/auth/logout", () => {
        signOut()
        session.signedIn = false
        return new HttpResponse(null, { status: 204 })
      }),
    )
    const { queryClient, router } = renderApp("/")
    await waitFor(() => expect(router.state.status).toBe("idle"))
    queryClient.setQueryData(["workspaces"], [{ id: "1" }])

    const { result } = renderHook(() => useLogout(), {
      wrapper: ({ children }: { children: ReactNode }) => (
        <QueryClientProvider client={queryClient}>
          <RouterContextProvider router={router}>{children}</RouterContextProvider>
        </QueryClientProvider>
      ),
    })
    result.current.mutate()

    expect(await screen.findByRole("heading", { name: "Sign in" })).toBeInTheDocument()
    expect(router.state.location.pathname).toBe("/login")
    expect(signOut).toHaveBeenCalledOnce()
    expect(queryClient.getQueryData(["workspaces"])).toBeUndefined()
    expect(queryClient.getQueryData(["me"])).toBeUndefined()
  })
})
