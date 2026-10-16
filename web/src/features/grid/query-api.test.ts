import { HttpResponse, http } from "msw"
import { describe, expect, it, vi } from "vitest"
import { server } from "@/test/server"
import { MODULE_ID, answer, salesQuery, salesView } from "@/test/view-query"
import { queryView } from "./query-api"
import type { ViewQuery } from "./view-types"

const window = { row_offset: 0, row_limit: 100, col_offset: 0, col_limit: 40 }

describe("queryView", () => {
  it("posts the query to the model's query endpoint and returns the result", async () => {
    const seen = vi.fn()
    server.use(
      http.post("/api/v1/models/:id/query", async ({ request }) => {
        const query = (await request.json()) as ViewQuery
        seen(new URL(request.url).pathname, query.module)
        return HttpResponse.json(answer(salesView(), query))
      }),
    )

    const result = await queryView("m1", { ...salesQuery, window })

    expect(seen).toHaveBeenCalledExactlyOnceWith("/api/v1/models/m1/query", MODULE_ID)
    expect(result.total_rows).toBe(1000)
    expect(result.seq).toBe(1)
  })

  it("keeps a model id from changing the path it is put in", async () => {
    const seen = vi.fn()
    server.use(
      http.post("/api/v1/models/*", ({ request }) => {
        seen(new URL(request.url).pathname)
        return HttpResponse.json({})
      }),
    )

    await queryView("a/b c?", { ...salesQuery, window })

    expect(seen).toHaveBeenCalledExactlyOnceWith("/api/v1/models/a%2Fb%20c%3F/query")
  })
})
