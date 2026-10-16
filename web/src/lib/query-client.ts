import { QueryClient } from "@tanstack/react-query"
import { ApiError } from "./api/client"

const MAX_RETRIES = 2
const RETRY_DELAY_START_MS = 1_000
const RETRY_DELAY_MAX_MS = 30_000

/** How long what a query loaded counts as fresh, so scrolling back to it loads nothing. */
export const QUERY_STALE_TIME = 30_000

/** Retries network failures and server errors, never a request the server already refused. */
export function shouldRetry(failureCount: number, error: Error): boolean {
  const refused = error instanceof ApiError && error.status >= 400 && error.status < 500
  return !refused && failureCount < MAX_RETRIES
}

/**
 * How long to wait before a retry: as long as the server asked for in `Retry-After` (a busy
 * server says 2 seconds), and else 1 second, twice as long after each failure.
 */
export function retryDelay(failureCount: number, error: Error): number {
  const asked = error instanceof ApiError ? error.retryAfter : undefined
  return Math.min(
    asked === undefined ? RETRY_DELAY_START_MS * 2 ** failureCount : asked * 1000,
    RETRY_DELAY_MAX_MS,
  )
}

export function createQueryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: shouldRetry, retryDelay, staleTime: QUERY_STALE_TIME },
    },
  })
}
