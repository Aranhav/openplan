import { ApiError } from "@/lib/api/client"

/** What a 429 from the API asks of the user, in words; undefined for any other failure. */
export function rateLimitMessage(error: unknown): string | undefined {
  if (!(error instanceof ApiError) || error.code !== "auth.rate_limited") {
    return undefined
  }
  const minutes = Math.max(1, Math.ceil((error.retryAfter ?? 0) / 60))
  return `Too many attempts. Try again in ${minutes} ${minutes === 1 ? "minute" : "minutes"}.`
}
