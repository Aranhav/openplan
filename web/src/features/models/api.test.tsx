import { QueryClientProvider } from "@tanstack/react-query"
import { renderHook, waitFor } from "@testing-library/react"
import { HttpResponse, http } from "msw"
import type { ReactNode } from "react"
import { describe, expect, it, vi } from "vitest"
import { queryKeys } from "@/lib/api/keys"
import { makeModel, workspace } from "@/test/app"
import { problem } from "@/test/problem"
import { createTestQueryClient } from "@/test/render"
import { server } from "@/test/server"
import { useCreateModel, useDeleteModel, useModel, useModels, useUpdateModel } from "./api"

const model = makeModel()
const listUrl = `/api/v1/workspaces/${workspace.id}/models`

function setup() {
  const queryClient = createTestQueryClient()
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  )
  return { queryClient, wrapper }
}

/** Serves the list and counts how often it is asked for. */
function serveList(models = [model]) {
  const requests = vi.fn()
  server.use(
    http.get(listUrl, () => {
      requests()
      return HttpResponse.json(models)
    }),
  )
  return requests
}

describe("model queries", () => {
  it("lists the models of a workspace", async () => {
    serveList()
    const { wrapper } = setup()
    const { result } = renderHook(() => useModels(workspace.id), { wrapper })

    await waitFor(() => expect(result.current.data).toEqual([model]))
  })

  it("fetches one model", async () => {
    server.use(http.get(`/api/v1/models/${model.id}`, () => HttpResponse.json(model)))
    const { wrapper } = setup()
    const { result } = renderHook(() => useModel(model.id), { wrapper })

    await waitFor(() => expect(result.current.data).toEqual(model))
  })

  it("does not fetch anything without an id", async () => {
    const { wrapper } = setup()
    const { result } = renderHook(() => useModel(undefined), { wrapper })

    expect(result.current.fetchStatus).toBe("idle")
    expect(result.current.data).toBeUndefined()
  })

  it("reports a missing model", async () => {
    server.use(
      http.get(`/api/v1/models/${model.id}`, () => problem(404, "not_found", "Not found.")),
    )
    const { wrapper } = setup()
    const { result } = renderHook(() => useModel(model.id), { wrapper })

    await waitFor(() => expect(result.current.error).toMatchObject({ status: 404 }))
  })
})

describe("model mutations", () => {
  it("creating a model keeps it for its own page and refreshes the list", async () => {
    const created = makeModel({ id: "0192f3a0-0000-7000-8000-000000000099", name: "New plan" })
    const posted = vi.fn()
    server.use(
      http.post(listUrl, async ({ request }) => {
        posted(await request.json())
        return HttpResponse.json(created, { status: 201 })
      }),
    )
    const listRequests = serveList()
    const { queryClient, wrapper } = setup()
    const { result } = renderHook(
      () => ({ models: useModels(workspace.id), create: useCreateModel(workspace.id) }),
      {
        wrapper,
      },
    )
    await waitFor(() => expect(result.current.models.isSuccess).toBe(true))
    await result.current.create.mutateAsync({ name: "New plan", description: "" })

    expect(posted).toHaveBeenCalledWith({ name: "New plan", description: "" })
    expect(queryClient.getQueryData(queryKeys.model(created.id))).toEqual(created)
    await waitFor(() => expect(listRequests).toHaveBeenCalledTimes(2))
  })

  it("updating a model replaces its page's copy and refreshes the list", async () => {
    const renamed = { ...model, name: "Renamed" }
    server.use(http.patch(`/api/v1/models/${model.id}`, () => HttpResponse.json(renamed)))
    const listRequests = serveList()
    const { queryClient, wrapper } = setup()
    const { result } = renderHook(
      () => ({ models: useModels(workspace.id), update: useUpdateModel(model.id) }),
      {
        wrapper,
      },
    )
    await waitFor(() => expect(result.current.models.isSuccess).toBe(true))
    await result.current.update.mutateAsync({ name: "Renamed" })

    expect(queryClient.getQueryData(queryKeys.model(model.id))).toEqual(renamed)
    await waitFor(() => expect(listRequests).toHaveBeenCalledTimes(2))
  })

  it("deleting a model refreshes the list and marks its page's copy out of date", async () => {
    const deleted = vi.fn()
    server.use(
      http.delete(`/api/v1/models/${model.id}`, () => {
        deleted()
        return new HttpResponse(null, { status: 204 })
      }),
    )
    const listRequests = serveList([])
    const { queryClient, wrapper } = setup()
    queryClient.setQueryData(queryKeys.model(model.id), model)
    const { result } = renderHook(
      () => ({ models: useModels(workspace.id), remove: useDeleteModel() }),
      { wrapper },
    )
    await waitFor(() => expect(result.current.models.isSuccess).toBe(true))
    await result.current.remove.mutateAsync(model)

    expect(deleted).toHaveBeenCalledOnce()
    expect(queryClient.getQueryState(queryKeys.model(model.id))?.isInvalidated).toBe(true)
    await waitFor(() => expect(listRequests).toHaveBeenCalledTimes(2))
  })

  it("deleting a model leaves a page that still shows it alone, instead of fetching it again", async () => {
    const detailRequests = vi.fn()
    server.use(
      http.get(`/api/v1/models/${model.id}`, () => {
        detailRequests()
        return HttpResponse.json(model)
      }),
      http.delete(`/api/v1/models/${model.id}`, () => new HttpResponse(null, { status: 204 })),
    )
    serveList([])
    const { wrapper } = setup()
    const { result, rerender } = renderHook(
      () => ({ detail: useModel(model.id), remove: useDeleteModel() }),
      { wrapper },
    )
    await waitFor(() => expect(result.current.detail.isSuccess).toBe(true))
    await result.current.remove.mutateAsync(model)
    rerender()
    // Give a wrongly started fetch the time to show up.
    await new Promise((resolve) => setTimeout(resolve, 100))

    expect(detailRequests).toHaveBeenCalledOnce()
    expect(result.current.detail.data).toEqual(model)
    expect(result.current.detail.isError).toBe(false)
  })
})
