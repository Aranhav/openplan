import { QueryClient } from "@tanstack/react-query"
import { ApiError } from "./api/client"

const MAX_RETRIES = 2

/** How long what a query loaded counts as fresh, so scrolling back to it loads nothing. */
export const QUERY_STALE_TIME = 30_000

/** Retries network failures and server errors, never a request the server already refused. */
export function shouldRetry(failureCount: number, error: Error): boolean {
  const refused = error instanceof ApiError && error.status >= 400 && error.status < 500
  return !refused && failureCount < MAX_RETRIES
}

export function createQueryClient() {
  return new QueryClient({
    defaultOptions: { queries: { retry: shouldRetry, staleTime: QUERY_STALE_TIME } },
  })
}
