import { afterEach, describe, expect, it, vi } from "vitest"
import { ApiError, api, unwrap } from "./client"

function problem(status: number, body: Record<string, unknown>) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/problem+json" },
  })
}

afterEach(() => {
  vi.unstubAllGlobals()
  document.cookie = "op_csrf=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/"
})

describe("unwrap", () => {
  it("throws ApiError with code and field errors", async () => {
    const body = {
      type: "about:blank",
      title: "Unprocessable Entity",
      status: 422,
      code: "validation",
      detail: "Some fields are invalid.",
      errors: [{ field: "name", message: "Name is required." }],
    }

    const result = unwrap(
      Promise.resolve({
        error: body,
        response: problem(422, body),
      }),
    )

    await expect(result).rejects.toBeInstanceOf(ApiError)
    await expect(result).rejects.toMatchObject({
      status: 422,
      code: "validation",
      detail: "Some fields are invalid.",
      errors: [{ field: "name", message: "Name is required." }],
    })
  })

  it("falls back to an internal error when the body is not problem+json", async () => {
    const result = unwrap(
      Promise.resolve({
        error: "boom",
        response: new Response("boom", { status: 500 }),
      }),
    )

    await expect(result).rejects.toMatchObject({
      status: 500,
      code: "internal",
      detail: "Something went wrong.",
      errors: [],
    })
  })

  it("returns data on 200", async () => {
    const data = { id: "abc", name: "Acme" }

    await expect(
      unwrap(Promise.resolve({ data, response: new Response(null, { status: 200 }) })),
    ).resolves.toEqual(data)
  })

  it("returns undefined on 204", async () => {
    await expect(
      unwrap(Promise.resolve({ response: new Response(null, { status: 204 }) })),
    ).resolves.toBeUndefined()
  })
})

describe("api", () => {
  it("adds the csrf header on POST", async () => {
    document.cookie = "op_csrf=abc; path=/"
    const fetchMock = vi.fn<(request: Request) => Promise<Response>>(
      async () => new Response(null, { status: 204 }),
    )
    vi.stubGlobal("fetch", fetchMock)

    await api.POST("/auth/logout")

    const request = fetchMock.mock.calls[0][0]
    expect(request.headers.get("x-openplan-csrf")).toBe("abc")
  })

  it("does not add the csrf header on GET", async () => {
    document.cookie = "op_csrf=abc; path=/"
    const fetchMock = vi.fn<(request: Request) => Promise<Response>>(
      async () =>
        new Response(JSON.stringify({ needs_setup: false }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    )
    vi.stubGlobal("fetch", fetchMock)

    await api.GET("/setup/status")

    const request = fetchMock.mock.calls[0][0]
    expect(request.headers.has("x-openplan-csrf")).toBe(false)
  })
})
