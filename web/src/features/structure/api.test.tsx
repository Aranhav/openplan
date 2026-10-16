import { QueryClientProvider } from "@tanstack/react-query"
import { renderHook, waitFor } from "@testing-library/react"
import { HttpResponse, http } from "msw"
import type { ReactNode } from "react"
import { describe, expect, it } from "vitest"
import { ApiError } from "@/lib/api/client"
import { queryKeys } from "@/lib/api/keys"
import { makeModel, workspace } from "@/test/app"
import { problem } from "@/test/problem"
import { createTestQueryClient } from "@/test/render"
import { server } from "@/test/server"
import { structure } from "@/test/structure"
import {
  useCreateItems,
  useCreateLineItem,
  useCreateList,
  useCreateModule,
  useCreateSubset,
  useCreateTimeRange,
  useCreateVersion,
  useDeleteItems,
  useDeleteLineItem,
  useDeleteList,
  useDeleteModule,
  useDeleteSubset,
  useDeleteTimeRange,
  useDeleteVersion,
  useReorderLineItems,
  useStructure,
  useUpdateCalendar,
  useUpdateItem,
  useUpdateLineItem,
  useUpdateList,
  useUpdateModule,
  useUpdateSubset,
  useUpdateVersion,
} from "./api"

const model = makeModel()
const other = makeModel({ id: "0192f3a0-0000-7000-8000-000000000099" })
const base = `/api/v1/models/${model.id}`
const id = "0192f3a0-0000-7000-8000-000000000abc"
const itemId = "0192f3a0-0000-7000-8000-000000000def"

function setup() {
  const queryClient = createTestQueryClient()
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  )
  return { queryClient, wrapper }
}

describe("useStructure", () => {
  it("fetches the structure of the model", async () => {
    server.use(http.get(`${base}/structure`, () => HttpResponse.json(structure)))
    const { wrapper } = setup()
    const { result } = renderHook(() => useStructure(model.id), { wrapper })

    await waitFor(() => expect(result.current.data).toEqual(structure))
  })

  it("keeps it under the structure key", async () => {
    server.use(http.get(`${base}/structure`, () => HttpResponse.json(structure)))
    const { queryClient, wrapper } = setup()
    renderHook(() => useStructure(model.id), { wrapper })

    await waitFor(() =>
      expect(queryClient.getQueryData(queryKeys.structure(model.id))).toEqual(structure),
    )
  })

  it("reports a failure as an ApiError", async () => {
    server.use(http.get(`${base}/structure`, () => problem(500, "internal", "Out of order.")))
    const { wrapper } = setup()
    const { result } = renderHook(() => useStructure(model.id), { wrapper })

    await waitFor(() => expect(result.current.error).toBeInstanceOf(ApiError))
    expect(result.current.error).toMatchObject({ status: 500, detail: "Out of order." })
  })
})

interface Case {
  name: string
  hook: (modelId: string) => { mutateAsync: (variables: never) => Promise<unknown> }
  variables: unknown
  method: "post" | "put" | "patch" | "delete"
  path: string
  /** The JSON the request must carry; none for a delete. */
  body?: unknown
  status: 200 | 201 | 204
}

const calendar = { first_year: 2027, fiscal_year_start_month: 4, years: 5 }
const version = { name: "Forecast", is_actual: false, is_current: true, switchover: "Jan 27" }
const lineItemBody = { name: "Revenue", formula: "1 + 1" }

const cases: Case[] = [
  {
    name: "create a list",
    hook: useCreateList,
    variables: { name: "Regions" },
    method: "post",
    path: "/lists",
    body: { name: "Regions" },
    status: 201,
  },
  {
    name: "update a list",
    hook: useUpdateList,
    variables: { listId: id, body: { name: "Areas" } },
    method: "patch",
    path: `/lists/${id}`,
    body: { name: "Areas" },
    status: 200,
  },
  {
    name: "delete a list",
    hook: useDeleteList,
    variables: id,
    method: "delete",
    path: `/lists/${id}`,
    status: 204,
  },
  {
    name: "create items",
    hook: useCreateItems,
    variables: { listId: id, items: [{ name: "EMEA" }, { name: "APAC", code: "AP" }] },
    method: "post",
    path: `/lists/${id}/items`,
    body: { items: [{ name: "EMEA" }, { name: "APAC", code: "AP" }] },
    status: 201,
  },
  {
    name: "update an item",
    hook: useUpdateItem,
    variables: { listId: id, itemId, body: { name: "Europe" } },
    method: "patch",
    path: `/lists/${id}/items/${itemId}`,
    body: { name: "Europe" },
    status: 200,
  },
  {
    name: "delete items",
    hook: useDeleteItems,
    variables: { listId: id, ids: [itemId] },
    method: "post",
    path: `/lists/${id}/items/delete`,
    body: { ids: [itemId] },
    status: 204,
  },
  {
    name: "create a subset",
    hook: useCreateSubset,
    variables: { list_id: id, name: "Europe", item_ids: [itemId] },
    method: "post",
    path: "/subsets",
    body: { list_id: id, name: "Europe", item_ids: [itemId] },
    status: 201,
  },
  {
    name: "update a subset",
    hook: useUpdateSubset,
    variables: { subsetId: id, body: { item_ids: [] } },
    method: "patch",
    path: `/subsets/${id}`,
    body: { item_ids: [] },
    status: 200,
  },
  {
    name: "delete a subset",
    hook: useDeleteSubset,
    variables: id,
    method: "delete",
    path: `/subsets/${id}`,
    status: 204,
  },
  {
    name: "create a version",
    hook: useCreateVersion,
    variables: version,
    method: "post",
    path: "/versions",
    body: version,
    status: 201,
  },
  {
    name: "update a version",
    hook: useUpdateVersion,
    variables: { versionId: id, body: version },
    method: "put",
    path: `/versions/${id}`,
    body: version,
    status: 200,
  },
  {
    name: "delete a version",
    hook: useDeleteVersion,
    variables: id,
    method: "delete",
    path: `/versions/${id}`,
    status: 204,
  },
  {
    name: "update the calendar",
    hook: useUpdateCalendar,
    variables: calendar,
    method: "put",
    path: "/calendar",
    body: calendar,
    status: 200,
  },
  {
    name: "create a time range",
    hook: useCreateTimeRange,
    variables: { name: "Long range", first_year: 2026, years: 10 },
    method: "post",
    path: "/time-ranges",
    body: { name: "Long range", first_year: 2026, years: 10 },
    status: 201,
  },
  {
    name: "delete a time range",
    hook: useDeleteTimeRange,
    variables: id,
    method: "delete",
    path: `/time-ranges/${id}`,
    status: 204,
  },
  {
    name: "create a module",
    hook: useCreateModule,
    variables: { name: "Revenue", axes: [{ kind: "versions" }], functional_area: "Finance" },
    method: "post",
    path: "/modules",
    body: { name: "Revenue", axes: [{ kind: "versions" }], functional_area: "Finance" },
    status: 201,
  },
  {
    name: "update a module",
    hook: useUpdateModule,
    variables: { moduleId: id, body: { functional_area: "People" } },
    method: "patch",
    path: `/modules/${id}`,
    body: { functional_area: "People" },
    status: 200,
  },
  {
    name: "delete a module",
    hook: useDeleteModule,
    variables: id,
    method: "delete",
    path: `/modules/${id}`,
    status: 204,
  },
  {
    name: "create a line item",
    hook: useCreateLineItem,
    variables: { moduleId: id, body: lineItemBody },
    method: "post",
    path: `/modules/${id}/line-items`,
    body: lineItemBody,
    status: 201,
  },
  {
    name: "update a line item",
    hook: useUpdateLineItem,
    variables: { lineItemId: id, body: { notes: "Billed monthly." } },
    method: "patch",
    path: `/line-items/${id}`,
    body: { notes: "Billed monthly." },
    status: 200,
  },
  {
    name: "delete a line item",
    hook: useDeleteLineItem,
    variables: id,
    method: "delete",
    path: `/line-items/${id}`,
    status: 204,
  },
  {
    name: "reorder line items",
    hook: useReorderLineItems,
    variables: { module_id: id, ids: [itemId, id] },
    method: "post",
    path: "/line-items/reorder",
    body: { module_id: id, ids: [itemId, id] },
    status: 204,
  },
]

function respond(status: Case["status"]) {
  return status === 204 ? new HttpResponse(null, { status }) : HttpResponse.json({}, { status })
}

function isInvalidated(
  queryClient: ReturnType<typeof setup>["queryClient"],
  key: readonly unknown[],
) {
  return queryClient.getQueryState(key)?.isInvalidated
}

describe("the structure mutations", () => {
  it.each(cases)(
    "send the request to $name",
    async ({ hook, variables, method, path, body, status }) => {
      let received: { method: string; pathname: string; body: unknown } | undefined
      server.use(
        http[method](`${base}${path}`, async ({ request }) => {
          const text = await request.text()
          received = {
            method: request.method,
            pathname: new URL(request.url).pathname,
            body: text ? JSON.parse(text) : undefined,
          }
          return respond(status)
        }),
      )
      const { wrapper } = setup()
      const { result } = renderHook(() => hook(model.id), { wrapper })
      await result.current.mutateAsync(variables as never)

      expect(received).toEqual({ method: method.toUpperCase(), pathname: `${base}${path}`, body })
    },
  )

  it.each(cases)(
    "invalidate the structure and the queries of the model when you $name",
    async ({ hook, variables, method, path, status }) => {
      server.use(http[method](`${base}${path}`, () => respond(status)))
      const { queryClient, wrapper } = setup()
      const pivot = queryKeys.query(model.id, "pivot", { rowBlock: 0 })
      const untouched = [
        queryKeys.structure(other.id),
        queryKeys.query(other.id, "pivot"),
        queryKeys.model(model.id),
        queryKeys.models(workspace.id),
      ]
      for (const key of [queryKeys.structure(model.id), pivot, ...untouched]) {
        queryClient.setQueryData(key, {})
      }
      const { result } = renderHook(() => hook(model.id), { wrapper })
      await result.current.mutateAsync(variables as never)

      expect(isInvalidated(queryClient, queryKeys.structure(model.id))).toBe(true)
      expect(isInvalidated(queryClient, pivot)).toBe(true)
      for (const key of untouched) {
        expect(isInvalidated(queryClient, key), JSON.stringify(key)).toBe(false)
      }
    },
  )

  it("refetch the structure before the mutation settles, so the caller sees the new one", async () => {
    let created = false
    server.use(
      http.get(`${base}/structure`, () =>
        HttpResponse.json({
          ...structure,
          modules: created ? [{ id, name: "Revenue", functional_area: "", axes: [] }] : [],
        }),
      ),
      http.post(`${base}/modules`, () => {
        created = true
        return HttpResponse.json({}, { status: 201 })
      }),
    )
    const { queryClient, wrapper } = setup()
    const { result } = renderHook(
      () => ({ structure: useStructure(model.id), create: useCreateModule(model.id) }),
      {
        wrapper,
      },
    )
    await waitFor(() => expect(result.current.structure.data?.modules).toEqual([]))
    await result.current.create.mutateAsync({ name: "Revenue", axes: [] })

    expect(queryClient.getQueryData(queryKeys.structure(model.id))).toMatchObject({
      modules: [{ id }],
    })
  })

  it("leave the caches alone when the server refuses", async () => {
    server.use(
      http.post(`${base}/lists`, () =>
        problem(409, "structure.name_taken", "A list with this name already exists."),
      ),
    )
    const { queryClient, wrapper } = setup()
    queryClient.setQueryData(queryKeys.structure(model.id), structure)
    const { result } = renderHook(() => useCreateList(model.id), { wrapper })

    await expect(result.current.mutateAsync({ name: "Regions" })).rejects.toMatchObject({
      status: 409,
      code: "structure.name_taken",
    })
    expect(isInvalidated(queryClient, queryKeys.structure(model.id))).toBe(false)
  })
})
