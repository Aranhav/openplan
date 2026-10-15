import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { renderHook, waitFor } from "@testing-library/react"
import { HttpResponse, http } from "msw"
import type { ReactNode } from "react"
import { describe, expect, it, vi } from "vitest"
import { useMembers } from "@/features/workspaces/api"
import { queryKeys } from "@/lib/api/keys"
import { globex, me, user, workspace } from "@/test/app"
import { server } from "@/test/server"
import { useUpdateProfile, useUpdateUser } from "./api"

const member = { user_id: user.id, email: user.email, name: user.name, role: "admin" as const }

/** A client like the app's, where data stays fresh for a while. */
function setup() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: 30_000 }, mutations: { retry: false } },
  })
  queryClient.setQueryData(queryKeys.me, me)
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  )
  return { queryClient, wrapper }
}

/** Serves the members of both workspaces and counts how often each list is asked for. */
function serveMembers() {
  const acme = vi.fn()
  const globexRequests = vi.fn()
  server.use(
    http.get(`/api/v1/workspaces/${workspace.id}/members`, () => {
      acme()
      return HttpResponse.json([member])
    }),
    http.get(`/api/v1/workspaces/${globex.id}/members`, () => {
      globexRequests()
      return HttpResponse.json([member])
    }),
  )
  return { acme, globex: globexRequests }
}

describe("a change to a user's name", () => {
  it("refreshes the members lists of every workspace, which show that name", async () => {
    server.use(
      http.patch("/api/v1/auth/me", () => HttpResponse.json({ ...user, name: "Ada King" })),
    )
    const requests = serveMembers()
    const { wrapper } = setup()
    const { result } = renderHook(
      () => ({
        acme: useMembers(workspace.id),
        globex: useMembers(globex.id),
        update: useUpdateProfile(),
      }),
      { wrapper },
    )
    await waitFor(() =>
      expect(result.current.acme.isSuccess && result.current.globex.isSuccess).toBe(true),
    )
    await result.current.update.mutateAsync({ name: "Ada King" })

    await waitFor(() => expect(requests.acme).toHaveBeenCalledTimes(2))
    await waitFor(() => expect(requests.globex).toHaveBeenCalledTimes(2))
  })

  it("refreshes the members lists too when an admin renames a user", async () => {
    server.use(
      http.patch(`/api/v1/users/${user.id}`, () =>
        HttpResponse.json({
          ...user,
          name: "Ada King",
          disabled: false,
          created_at: "2026-10-01T09:00:00Z",
        }),
      ),
      http.get("/api/v1/users", () => HttpResponse.json([])),
    )
    const requests = serveMembers()
    const { wrapper } = setup()
    const { result } = renderHook(
      () => ({
        acme: useMembers(workspace.id),
        globex: useMembers(globex.id),
        update: useUpdateUser(),
      }),
      { wrapper },
    )
    await waitFor(() =>
      expect(result.current.acme.isSuccess && result.current.globex.isSuccess).toBe(true),
    )
    await result.current.update.mutateAsync({ id: user.id, name: "Ada King" })

    await waitFor(() => expect(requests.acme).toHaveBeenCalledTimes(2))
    await waitFor(() => expect(requests.globex).toHaveBeenCalledTimes(2))
  })
})
