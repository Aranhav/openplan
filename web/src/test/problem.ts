import { HttpResponse } from "msw"

interface ProblemOptions {
  errors?: { field: string; message: string }[]
  headers?: Record<string, string>
}

export function problem(
  status: number,
  code: string,
  detail: string,
  { errors, headers }: ProblemOptions = {},
) {
  return HttpResponse.json(
    { type: "about:blank", title: detail, status, code, detail, ...(errors && { errors }) },
    { status, headers: { "content-type": "application/problem+json", ...headers } },
  )
}
