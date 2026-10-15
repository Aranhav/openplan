import createClient, { type Middleware } from "openapi-fetch"
import type { paths } from "./schema"

type StripApiPrefix<P> = {
  [K in keyof P as K extends `/api/v1${infer Rest}` ? Rest : never]: P[K]
}

export type ApiPaths = StripApiPrefix<paths>

const CSRF_COOKIE = "op_csrf"
const CSRF_HEADER = "x-openplan-csrf"
const FALLBACK_DETAIL = "Something went wrong."
const NETWORK_DETAIL = "Can't reach the server. Check your connection and try again."

export interface FieldError {
  field: string
  message: string
}

export class ApiError extends Error {
  status: number
  code: string
  detail: string
  errors: FieldError[]
  /** Seconds to wait before retrying, from the Retry-After header of a 429. */
  retryAfter?: number

  constructor(
    status: number,
    code: string,
    detail: string,
    errors: FieldError[] = [],
    retryAfter?: number,
  ) {
    super(detail)
    this.name = "ApiError"
    this.status = status
    this.code = code
    this.detail = detail
    this.errors = errors
    this.retryAfter = retryAfter
  }
}

export function errorDetail(error: unknown): string {
  return error instanceof ApiError ? error.detail : FALLBACK_DETAIL
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

function isFieldError(value: unknown): value is FieldError {
  return isRecord(value) && typeof value.field === "string" && typeof value.message === "string"
}

function parseRetryAfter(header: string | null): number | undefined {
  if (!header || !/^\d+$/.test(header.trim())) {
    return undefined
  }
  return Number(header)
}

function toApiError(response: Response, body: unknown): ApiError {
  const retryAfter = parseRetryAfter(response.headers.get("retry-after"))
  if (!isRecord(body)) {
    return new ApiError(response.status, "internal", FALLBACK_DETAIL, [], retryAfter)
  }
  return new ApiError(
    response.status,
    typeof body.code === "string" ? body.code : "internal",
    typeof body.detail === "string" ? body.detail : FALLBACK_DETAIL,
    Array.isArray(body.errors) ? body.errors.filter(isFieldError) : [],
    retryAfter,
  )
}

function readCookie(name: string): string | undefined {
  for (const pair of document.cookie.split("; ")) {
    const [key, ...value] = pair.split("=")
    if (key === name) {
      return value.join("=")
    }
  }
  return undefined
}

const csrf: Middleware = {
  onRequest({ request }) {
    if (request.method !== "GET") {
      const token = readCookie(CSRF_COOKIE)
      if (token) {
        request.headers.set(CSRF_HEADER, token)
      }
    }
    return request
  },
}

const network: Middleware = {
  onError({ error }) {
    if (isRecord(error) && error.name === "AbortError") {
      return undefined
    }
    return new ApiError(0, "network", NETWORK_DETAIL)
  },
}

export const api = createClient<ApiPaths>({
  baseUrl: "/api/v1",
  // Resolve fetch per call so test doubles installed after import are used.
  fetch: (request) => globalThis.fetch(request),
})

api.use(csrf, network)

export async function unwrap<T>(
  result: Promise<{ data?: T; error?: unknown; response: Response }>,
): Promise<T> {
  const { data, error, response } = await result
  if (!response.ok) {
    throw toApiError(response, error)
  }
  return data as T
}
