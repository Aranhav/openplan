import { HttpResponse, http } from "msw"
import { describe, expect, it, vi } from "vitest"
import { ApiError } from "@/lib/api/client"
import { problem } from "@/test/problem"
import { server } from "@/test/server"
import { type CellWrite, writeCells } from "./cells-api"

const edit: CellWrite = {
  line_item_id: "li-1",
  coords: ["p1", "Jan 26"],
  value: { t: "number", v: 5 },
}

describe("writeCells", () => {
  it("posts the edits to the model's cells endpoint and returns what changed", async () => {
    const seen = vi.fn()
    server.use(
      http.post("/api/v1/models/:id/cells", async ({ request }) => {
        seen(new URL(request.url).pathname, await request.json())
        return HttpResponse.json({ seq: 7, changed_line_item_ids: ["li-1", "li-2"] })
      }),
    )

    const result = await writeCells("m1", [edit])

    expect(seen).toHaveBeenCalledExactlyOnceWith("/api/v1/models/m1/cells", { edits: [edit] })
    expect(result).toEqual({ seq: 7, changed_line_item_ids: ["li-1", "li-2"] })
  })

  it("keeps a model id from changing the path it is put in", async () => {
    const seen = vi.fn()
    server.use(
      http.post("/api/v1/models/*", ({ request }) => {
        seen(new URL(request.url).pathname)
        return HttpResponse.json({ seq: 1, changed_line_item_ids: [] })
      }),
    )

    await writeCells("a/b c?", [edit])

    expect(seen).toHaveBeenCalledExactlyOnceWith("/api/v1/models/a%2Fb%20c%3F/cells")
  })

  it("raises the server's refusal with the cell it names", async () => {
    server.use(
      http.post("/api/v1/models/:id/cells", () =>
        problem(422, "cells.invalid_value", "Some fields are invalid.", {
          errors: [{ field: "edits[0]", message: "Enter a number" }],
        }),
      ),
    )

    const error = await writeCells("m1", [edit]).catch((e: unknown) => e)

    expect(error).toBeInstanceOf(ApiError)
    expect(error).toMatchObject({
      status: 422,
      code: "cells.invalid_value",
      errors: [{ field: "edits[0]", message: "Enter a number" }],
    })
  })
})
