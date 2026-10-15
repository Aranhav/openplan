import { HttpResponse, delay, http } from "msw"
import { afterEach, describe, expect, it, vi } from "vitest"
import { server } from "@/test/server"
import { ApiError, api, errorDetail, unwrap } from "./client"

function problem(status: number, body: Record<string, unknown>) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/problem+json" },
  })
}

afterEach(() => {
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

  it("reads retryAfter in seconds from the Retry-After header", async () => {
    const body = { code: "auth.rate_limited", detail: "Too many attempts." }

    await expect(
      unwrap(
        Promise.resolve({
          error: body,
          response: new Response(JSON.stringify(body), {
            status: 429,
            headers: { "retry-after": "120" },
          }),
        }),
      ),
    ).rejects.toMatchObject({ status: 429, code: "auth.rate_limited", retryAfter: 120 })
  })

  it.each([["soon"], ["-5"], [""]])(
    "leaves retryAfter unset when the Retry-After header is %j",
    async (header) => {
      const error = await unwrap(
        Promise.resolve({
          error: { code: "auth.rate_limited" },
          response: new Response(null, { status: 429, headers: { "retry-after": header } }),
        }),
      ).catch((cause: unknown) => cause)

      expect(error).toBeInstanceOf(ApiError)
      expect((error as ApiError).retryAfter).toBeUndefined()
    },
  )

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

describe("errorDetail", () => {
  it("shows the server's detail for an ApiError", () => {
    const error = new ApiError(409, "setup.already_done", "Setup has already been completed.")

    expect(errorDetail(error)).toBe("Setup has already been completed.")
  })

  it("hides the message of anything else", () => {
    expect(errorDetail(new TypeError("x is not a function"))).toBe("Something went wrong.")
  })
})

describe("network failures", () => {
  it("become an ApiError with status 0 and code network", async () => {
    server.use(http.get("/api/v1/setup/status", () => HttpResponse.error()))

    const result = unwrap(api.GET("/setup/status"))

    await expect(result).rejects.toBeInstanceOf(ApiError)
    await expect(result).rejects.toMatchObject({
      status: 0,
      code: "network",
      detail: "Can't reach the server. Check your connection and try again.",
      errors: [],
    })
  })

  it("do not swallow a request the caller aborted", async () => {
    server.use(
      http.get("/api/v1/setup/status", async () => {
        await delay("infinite")
        return HttpResponse.json({ needs_setup: false })
      }),
    )
    const controller = new AbortController()

    const result = unwrap(api.GET("/setup/status", { signal: controller.signal }))
    controller.abort()

    await expect(result).rejects.toMatchObject({ name: "AbortError" })
  })
})

describe("api", () => {
  it("adds the csrf header on POST", async () => {
    document.cookie = "op_csrf=abc; path=/"
    const csrfHeader = vi.fn()
    server.use(
      http.post("/api/v1/auth/logout", ({ request }) => {
        csrfHeader(request.headers.get("x-openplan-csrf"))
        return new HttpResponse(null, { status: 204 })
      }),
    )

    await api.POST("/auth/logout")

    expect(csrfHeader).toHaveBeenCalledExactlyOnceWith("abc")
  })

  it("does not add the csrf header on GET", async () => {
    document.cookie = "op_csrf=abc; path=/"
    const csrfHeader = vi.fn()
    server.use(
      http.get("/api/v1/setup/status", ({ request }) => {
        csrfHeader(request.headers.get("x-openplan-csrf"))
        return HttpResponse.json({ needs_setup: false })
      }),
    )

    await api.GET("/setup/status")

    expect(csrfHeader).toHaveBeenCalledExactlyOnceWith(null)
  })
})
