import { QueryClient } from "@tanstack/react-query"
import { ApiError } from "./api/client"

const MAX_RETRIES = 2

/** Retries network failures and server errors, never a request the server already refused. */
export function shouldRetry(failureCount: number, error: Error): boolean {
  const refused = error instanceof ApiError && error.status >= 400 && error.status < 500
  return !refused && failureCount < MAX_RETRIES
}

export function createQueryClient() {
  return new QueryClient({
    defaultOptions: { queries: { retry: shouldRetry, staleTime: 30_000 } },
  })
}
