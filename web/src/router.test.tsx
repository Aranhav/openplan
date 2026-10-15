import { MutationObserver } from "@tanstack/react-query"
import { screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { HttpResponse, delay, http } from "msw"
import { describe, expect, it } from "vitest"
import { api, unwrap } from "@/lib/api/client"
import { me, mockSession, renderApp } from "@/test/app"
import { problem } from "@/test/problem"
import { server } from "@/test/server"

describe("when the guards cannot reach a working server", () => {
  it("shows the server's message and does not redirect when it fails", async () => {
    mockSession()
    server.use(
      http.get("/api/v1/auth/me", () => problem(500, "internal", "The database is starting up.")),
    )
    const { router } = renderApp("/")

    expect(await screen.findByRole("heading", { name: "Can't load OpenPlan" })).toBeInTheDocument()
    expect(screen.getByRole("alert")).toHaveTextContent("The database is starting up.")
    expect(screen.getByRole("button", { name: "Try again" })).toBeEnabled()
    expect(router.state.location.pathname).toBe("/")
  })

  it("explains a network failure and does not redirect", async () => {
    server.use(http.get("/api/v1/setup/status", () => HttpResponse.error()))
    const { router } = renderApp("/")

    expect(await screen.findByRole("heading", { name: "Can't load OpenPlan" })).toBeInTheDocument()
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Can't reach the server. Check your connection and try again.",
    )
    expect(router.state.location.pathname).toBe("/")
  })

  it("recovers when Try again finds the server back", async () => {
    mockSession()
    server.use(http.get("/api/v1/auth/me", () => problem(503, "internal", "Starting up.")))
    const typist = userEvent.setup()
    const { router } = renderApp("/profile")
    await screen.findByRole("heading", { name: "Can't load OpenPlan" })

    server.use(http.get("/api/v1/auth/me", () => HttpResponse.json(me)))
    await typist.click(screen.getByRole("button", { name: "Try again" }))

    await waitFor(() => {
      const appMatch = router.state.matches.find((match) => match.routeId === "/_app")
      expect(appMatch?.context.me).toEqual(me)
    })
    expect(screen.queryByRole("heading", { name: "Can't load OpenPlan" })).not.toBeInTheDocument()
    expect(router.state.location.pathname).toBe("/profile")
  })
})

describe("while the guards are slow", () => {
  it("shows a spinner once the wait is noticeable, then the page", async () => {
    mockSession({ signedIn: false })
    server.use(
      http.get("/api/v1/auth/me", async () => {
        await delay(1500)
        return problem(401, "auth.unauthenticated", "Sign in to continue.")
      }),
    )
    renderApp("/")

    expect(await screen.findByRole("status", { name: "Loading" }, { timeout: 3000 })).toBeVisible()
    expect(await screen.findByRole("heading", { name: "Sign in" }, { timeout: 3000 })).toBeVisible()
    expect(screen.queryByRole("status", { name: "Loading" })).not.toBeInTheDocument()
  })
})

describe("an unknown address", () => {
  it("shows a not found page with a way home", async () => {
    renderApp("/no/such/page")

    expect(await screen.findByRole("heading", { name: "Page not found" })).toBeInTheDocument()
    expect(screen.getByRole("link", { name: "Go home" })).toHaveAttribute("href", "/")
  })
})

describe("when the session expires", () => {
  it("sends the user to sign in after a protected query gets a 401", async () => {
    const session = mockSession()
    server.use(
      http.get("/api/v1/users", () => problem(401, "auth.unauthenticated", "Sign in to continue.")),
    )
    const { queryClient, router } = renderApp("/profile")
    await waitFor(() => expect(router.state.status).toBe("idle"))
    queryClient.setQueryData(["models"], [{ id: "1" }])
    session.signedIn = false

    await expect(
      queryClient.fetchQuery({
        queryKey: ["users"],
        queryFn: () => unwrap(api.GET("/users")),
      }),
    ).rejects.toMatchObject({ status: 401 })

    expect(await screen.findByRole("heading", { name: "Sign in" })).toBeInTheDocument()
    expect(router.state.location.pathname).toBe("/login")
    expect(router.state.location.search).toEqual({ redirect: "/profile" })
    expect(router.history.length).toBe(1)
    expect(queryClient.getQueryData(["models"])).toBeUndefined()
    expect(queryClient.getQueryData(["me"])).toBeUndefined()
  })

  it("does the same after a mutation gets a 401", async () => {
    const session = mockSession()
    server.use(
      http.post("/api/v1/auth/logout", () =>
        problem(401, "auth.unauthenticated", "Sign in to continue."),
      ),
    )
    const { queryClient, router } = renderApp("/profile?tab=plan")
    await waitFor(() => expect(router.state.status).toBe("idle"))
    session.signedIn = false

    const mutation = new MutationObserver(queryClient, {
      mutationFn: () => unwrap(api.POST("/auth/logout")),
    })
    await expect(mutation.mutate()).rejects.toMatchObject({ status: 401 })

    expect(await screen.findByRole("heading", { name: "Sign in" })).toBeInTheDocument()
    expect(router.state.location.search).toEqual({ redirect: "/profile?tab=plan" })
    expect(router.history.length).toBe(1)
  })

  it("keeps the user signed in when a 401 only means wrong credentials", async () => {
    mockSession()
    server.use(
      http.post("/api/v1/auth/login", () =>
        problem(401, "auth.invalid_credentials", "Email or password is incorrect."),
      ),
    )
    const { queryClient, router } = renderApp("/profile")
    await waitFor(() => expect(router.state.status).toBe("idle"))

    const body = { email: "ada@example.com", password: "wrong-password" }
    const mutation = new MutationObserver(queryClient, {
      mutationFn: () => unwrap(api.POST("/auth/login", { body })),
    })
    await expect(mutation.mutate()).rejects.toMatchObject({ code: "auth.invalid_credentials" })

    expect(router.state.location.pathname).toBe("/profile")
    expect(queryClient.getQueryData(["me"])).toEqual(me)
  })
})
