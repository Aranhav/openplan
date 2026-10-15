import { screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { HttpResponse, http } from "msw"
import { toast } from "sonner"
import { describe, expect, it, vi } from "vitest"
import { renderWithProviders } from "@/test/render"
import { problem } from "@/test/problem"
import { server } from "@/test/server"
import { SetupForm } from "./setup-form"

vi.mock("sonner", () => ({ toast: { error: vi.fn(), info: vi.fn() } }))

const user = {
  id: "0192f3a0-0000-7000-8000-000000000001",
  email: "ada@example.com",
  name: "Ada Lovelace",
  is_instance_admin: true,
}
const workspace = { id: "0192f3a0-0000-7000-8000-000000000002", name: "Acme Corp", role: "admin" }

type Typist = ReturnType<typeof userEvent.setup>

async function fillForm(typist: Typist, confirmation = "correct-horse-battery") {
  await typist.type(await screen.findByLabelText("Your name"), "  Ada Lovelace ")
  await typist.type(screen.getByLabelText("Work email"), "ada@example.com")
  await typist.type(screen.getByLabelText("Password"), "correct-horse-battery")
  await typist.type(screen.getByLabelText("Confirm password"), confirmation)
  await typist.type(screen.getByLabelText("Workspace name"), "Acme Corp")
}

async function submit(typist: Typist) {
  await typist.click(screen.getByRole("button", { name: "Create account" }))
}

describe("SetupForm", () => {
  it("shows a mismatch error and sends nothing when the passwords differ", async () => {
    const attempts = vi.fn()
    server.use(
      http.post("/api/v1/setup", () => {
        attempts()
        return HttpResponse.json({ user, workspace }, { status: 201 })
      }),
    )
    const typist = userEvent.setup()
    renderWithProviders(<SetupForm />)
    await fillForm(typist, "something-else-entirely")
    await submit(typist)

    expect(await screen.findByText("Passwords don't match.")).toBeInTheDocument()
    expect(screen.getByLabelText("Confirm password")).toHaveAccessibleDescription(
      "Passwords don't match.",
    )
    expect(attempts).not.toHaveBeenCalled()
  })

  it("explains what is missing without sending a request", async () => {
    const attempts = vi.fn()
    server.use(
      http.post("/api/v1/setup", () => {
        attempts()
        return HttpResponse.json({ user, workspace }, { status: 201 })
      }),
    )
    const typist = userEvent.setup()
    renderWithProviders(<SetupForm />)
    await typist.type(await screen.findByLabelText("Password"), "short")
    await submit(typist)

    expect(await screen.findByText("Name is required.")).toBeInTheDocument()
    expect(screen.getByText("Enter an email address.")).toBeInTheDocument()
    expect(screen.getByText("Password must be at least 10 characters.")).toBeInTheDocument()
    expect(screen.getByText("Workspace name is required.")).toBeInTheDocument()
    expect(attempts).not.toHaveBeenCalled()
  })

  it("holds the email and the names to the same rules as everywhere else", async () => {
    const attempts = vi.fn()
    server.use(
      http.post("/api/v1/setup", () => {
        attempts()
        return HttpResponse.json({ user, workspace }, { status: 201 })
      }),
    )
    const typist = userEvent.setup()
    renderWithProviders(<SetupForm />)
    await typist.click(await screen.findByLabelText("Your name"))
    await typist.paste("n".repeat(101))
    await typist.type(screen.getByLabelText("Work email"), "not-an-email")
    await typist.click(screen.getByLabelText("Workspace name"))
    await typist.paste("w".repeat(81))
    await submit(typist)

    expect(await screen.findByText("Name must be at most 100 characters.")).toBeInTheDocument()
    expect(screen.getByText("Enter a valid email address.")).toBeInTheDocument()
    expect(screen.getByText("Workspace name must be at most 80 characters.")).toBeInTheDocument()
    expect(attempts).not.toHaveBeenCalled()
  })

  it("maps server field errors onto the matching fields", async () => {
    server.use(
      http.post("/api/v1/setup", () =>
        problem(422, "validation", "Some fields are invalid.", {
          errors: [
            { field: "email", message: "That email address can't be used." },
            { field: "workspace_name", message: "Workspace name is already taken." },
          ],
        }),
      ),
    )
    const typist = userEvent.setup()
    renderWithProviders(<SetupForm />)
    await fillForm(typist)
    await submit(typist)

    const email = screen.getByLabelText("Work email")
    await waitFor(() =>
      expect(email).toHaveAccessibleDescription("That email address can't be used."),
    )
    expect(email).toBeInvalid()
    expect(screen.getByLabelText("Workspace name")).toHaveAccessibleDescription(
      "Workspace name is already taken.",
    )
    expect(screen.getByRole("button", { name: "Create account" })).toBeEnabled()
  })

  it("creates the account, seeds the caches and goes to the home page", async () => {
    const received = vi.fn()
    server.use(
      http.post("/api/v1/setup", async ({ request }) => {
        received(await request.json())
        return HttpResponse.json({ user, workspace }, { status: 201 })
      }),
    )
    const typist = userEvent.setup()
    const { queryClient, router } = renderWithProviders(<SetupForm />)
    await fillForm(typist)
    await submit(typist)

    await waitFor(() => expect(router.state.location.href).toBe("/"))
    expect(received).toHaveBeenCalledExactlyOnceWith({
      name: "Ada Lovelace",
      email: "ada@example.com",
      password: "correct-horse-battery",
      workspace_name: "Acme Corp",
    })
    expect(queryClient.getQueryData(["me"])).toEqual({ user, workspaces: [workspace] })
    expect(queryClient.getQueryData(["setup-status"])).toEqual({ needs_setup: false })
  })

  it("replaces the setup entry in the history, so Back does not return to it", async () => {
    server.use(
      http.post("/api/v1/setup", () => HttpResponse.json({ user, workspace }, { status: 201 })),
    )
    const typist = userEvent.setup()
    const { router } = renderWithProviders(<SetupForm />)
    await fillForm(typist)
    await submit(typist)

    await waitFor(() => expect(router.state.location.href).toBe("/"))
    expect(router.history.length).toBe(1)
  })

  it("disables the button while the request is pending", async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    server.use(
      http.post("/api/v1/setup", async () => {
        await gate
        return HttpResponse.json({ user, workspace }, { status: 201 })
      }),
    )
    const typist = userEvent.setup()
    const { router } = renderWithProviders(<SetupForm />)
    await fillForm(typist)
    await submit(typist)

    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Create account" })).toBeDisabled(),
    )

    release()
    await waitFor(() => expect(router.state.location.pathname).toBe("/"))
  })

  it("reports other failures in a toast and stays put", async () => {
    server.use(http.post("/api/v1/setup", () => problem(500, "internal", "Something went wrong.")))
    const typist = userEvent.setup()
    const { router } = renderWithProviders(<SetupForm />)
    await fillForm(typist)
    await submit(typist)

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("Something went wrong."))
    expect(screen.getByRole("button", { name: "Create account" })).toBeEnabled()
    expect(router.state.location.pathname).toBe("/host")
  })

  it("toasts a server error that names no field on the form", async () => {
    server.use(
      http.post("/api/v1/setup", () =>
        problem(422, "validation", "Some fields are invalid.", {
          errors: [{ field: "toString", message: "Nothing to see here." }],
        }),
      ),
    )
    const typist = userEvent.setup()
    renderWithProviders(<SetupForm />)
    await fillForm(typist)
    await submit(typist)

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("Some fields are invalid."))
  })

  it("sends the user to sign in when setup was already completed elsewhere", async () => {
    server.use(
      http.post("/api/v1/setup", () =>
        problem(409, "setup.already_done", "Setup has already been completed."),
      ),
    )
    const typist = userEvent.setup()
    const { queryClient, router } = renderWithProviders(<SetupForm />)
    queryClient.setQueryData(["setup-status"], { needs_setup: true })
    await fillForm(typist)
    await submit(typist)

    await waitFor(() => expect(router.state.location.pathname).toBe("/login"))
    expect(router.history.length).toBe(1)
    expect(toast.info).toHaveBeenCalledWith("OpenPlan is already set up. Sign in to continue.")
    expect(toast.error).not.toHaveBeenCalled()
    expect(queryClient.getQueryData(["setup-status"])).toEqual({ needs_setup: false })
  })
})
