import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { renderHook, waitFor } from "@testing-library/react"
import { HttpResponse, http } from "msw"
import type { ReactNode } from "react"
import { describe, expect, it, vi } from "vitest"
import { queryKeys } from "@/lib/api/keys"
import { me, user, workspace } from "@/test/app"
import { server } from "@/test/server"
import {
  useAddMember,
  useCreateWorkspace,
  useMembers,
  useRemoveMember,
  useRenameWorkspace,
  useUpdateMember,
  useWorkspaces,
} from "./api"

const member = { user_id: user.id, email: user.email, name: user.name, role: "admin" as const }
const membersUrl = `/api/v1/workspaces/${workspace.id}/members`

/** A client like the app's, where data stays fresh for a while. */
function setup() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: 30_000 }, mutations: { retry: false } },
  })
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  )
  return { queryClient, wrapper }
}

/** Serves the workspace list and counts how often it is asked for. */
function serveWorkspaces() {
  const requests = vi.fn()
  server.use(
    http.get("/api/v1/workspaces", () => {
      requests()
      return HttpResponse.json(me.workspaces)
    }),
  )
  return requests
}

describe("useWorkspaces", () => {
  it("starts from the user the route guard already loaded, without asking again", async () => {
    const { queryClient, wrapper } = setup()
    queryClient.setQueryData(queryKeys.me, me)
    const { result } = renderHook(() => useWorkspaces(), { wrapper })

    expect(result.current.data).toEqual(me.workspaces)
    expect(result.current.isFetching).toBe(false)
  })

  it("fetches the list when nothing is known yet", async () => {
    serveWorkspaces()
    const { wrapper } = setup()
    const { result } = renderHook(() => useWorkspaces(), { wrapper })

    expect(result.current.data).toBeUndefined()
    await waitFor(() => expect(result.current.data).toEqual(me.workspaces))
  })
})

describe("workspace mutations", () => {
  it("creating a workspace refreshes the list and the signed-in user", async () => {
    const created = { id: "0192f3a0-0000-7000-8000-000000000004", name: "Initech", role: "admin" }
    const posted = vi.fn()
    server.use(
      http.post("/api/v1/workspaces", async ({ request }) => {
        posted(await request.json())
        return HttpResponse.json(created, { status: 201 })
      }),
    )
    const listRequests = serveWorkspaces()
    const { queryClient, wrapper } = setup()
    queryClient.setQueryData(queryKeys.me, me)
    const { result } = renderHook(() => ({ list: useWorkspaces(), create: useCreateWorkspace() }), {
      wrapper,
    })
    await result.current.create.mutateAsync({ name: "Initech" })

    expect(posted).toHaveBeenCalledWith({ name: "Initech" })
    expect(listRequests).toHaveBeenCalledTimes(1)
    expect(queryClient.getQueryState(queryKeys.me)?.isInvalidated).toBe(true)
  })

  it("renaming a workspace refreshes the list", async () => {
    const patched = vi.fn()
    server.use(
      http.patch(`/api/v1/workspaces/${workspace.id}`, async ({ request }) => {
        patched(await request.json())
        return HttpResponse.json({ ...workspace, name: "Acme Inc" })
      }),
    )
    const listRequests = serveWorkspaces()
    const { queryClient, wrapper } = setup()
    queryClient.setQueryData(queryKeys.me, me)
    const { result } = renderHook(() => ({ list: useWorkspaces(), rename: useRenameWorkspace() }), {
      wrapper,
    })
    await result.current.rename.mutateAsync({ id: workspace.id, name: "Acme Inc" })

    expect(patched).toHaveBeenCalledWith({ name: "Acme Inc" })
    expect(listRequests).toHaveBeenCalledTimes(1)
    expect(queryClient.getQueryState(queryKeys.me)?.isInvalidated).toBe(true)
  })
})

describe("member queries and mutations", () => {
  function serveMembers() {
    const requests = vi.fn()
    server.use(
      http.get(membersUrl, () => {
        requests()
        return HttpResponse.json([member])
      }),
    )
    return requests
  }

  it("lists a workspace's members", async () => {
    serveMembers()
    const { wrapper } = setup()
    const { result } = renderHook(() => useMembers(workspace.id), { wrapper })

    await waitFor(() => expect(result.current.data).toEqual([member]))
  })

  it("adding a member refreshes the members", async () => {
    const posted = vi.fn()
    server.use(
      http.post(membersUrl, async ({ request }) => {
        posted(await request.json())
        return HttpResponse.json(member, { status: 201 })
      }),
    )
    const requests = serveMembers()
    const { wrapper } = setup()
    const { result } = renderHook(
      () => ({ members: useMembers(workspace.id), add: useAddMember(workspace.id) }),
      { wrapper },
    )
    await waitFor(() => expect(result.current.members.isSuccess).toBe(true))
    await result.current.add.mutateAsync({ email: "grace@example.com", role: "planner" })

    expect(posted).toHaveBeenCalledWith({ email: "grace@example.com", role: "planner" })
    await waitFor(() => expect(requests).toHaveBeenCalledTimes(2))
  })

  it("changing a role refreshes the members and the user's own workspaces", async () => {
    const patched = vi.fn()
    server.use(
      http.patch(`${membersUrl}/${user.id}`, async ({ request }) => {
        patched(await request.json())
        return HttpResponse.json({ ...member, role: "planner" })
      }),
    )
    const requests = serveMembers()
    const listRequests = serveWorkspaces()
    const { queryClient, wrapper } = setup()
    queryClient.setQueryData(queryKeys.me, me)
    const { result } = renderHook(
      () => ({
        members: useMembers(workspace.id),
        workspaces: useWorkspaces(),
        update: useUpdateMember(workspace.id),
      }),
      { wrapper },
    )
    await waitFor(() => expect(result.current.members.isSuccess).toBe(true))
    await result.current.update.mutateAsync({ userId: user.id, role: "planner" })

    expect(patched).toHaveBeenCalledWith({ role: "planner" })
    await waitFor(() => expect(requests).toHaveBeenCalledTimes(2))
    await waitFor(() => expect(listRequests).toHaveBeenCalledTimes(1))
    expect(queryClient.getQueryState(queryKeys.me)?.isInvalidated).toBe(true)
  })

  it("removing a member refreshes the members and the user's own workspaces", async () => {
    const removed = vi.fn()
    server.use(
      http.delete(`${membersUrl}/${user.id}`, () => {
        removed()
        return new HttpResponse(null, { status: 204 })
      }),
    )
    const requests = serveMembers()
    const listRequests = serveWorkspaces()
    const { queryClient, wrapper } = setup()
    queryClient.setQueryData(queryKeys.me, me)
    const { result } = renderHook(
      () => ({
        members: useMembers(workspace.id),
        workspaces: useWorkspaces(),
        remove: useRemoveMember(workspace.id),
      }),
      { wrapper },
    )
    await waitFor(() => expect(result.current.members.isSuccess).toBe(true))
    await result.current.remove.mutateAsync(user.id)

    expect(removed).toHaveBeenCalledOnce()
    await waitFor(() => expect(requests).toHaveBeenCalledTimes(2))
    await waitFor(() => expect(listRequests).toHaveBeenCalledTimes(1))
    expect(queryClient.getQueryState(queryKeys.me)?.isInvalidated).toBe(true)
  })
})
