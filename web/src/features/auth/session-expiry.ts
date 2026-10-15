import type { QueryClient } from "@tanstack/react-query"
import type { AnyRouter } from "@tanstack/react-router"
import { ApiError } from "@/lib/api/client"
import { loginSearch } from "./redirect"

const PUBLIC_PATHS = ["/login", "/setup"]

// A 401 from the sign-in call means "wrong password", not "your session ended".
function isSessionExpired(error: unknown): boolean {
  return (
    error instanceof ApiError && error.status === 401 && error.code !== "auth.invalid_credentials"
  )
}

/**
 * Sends the user to sign in when any query or mutation reports that the session has ended. The
 * route guards cover navigation; this covers requests that fail while a page is already open.
 */
export function watchSessionExpiry(queryClient: QueryClient, router: AnyRouter) {
  let leaving = false

  async function leave() {
    const { pathname, href } = router.state.location
    if (leaving || PUBLIC_PATHS.includes(pathname)) {
      return
    }
    leaving = true
    try {
      // Clear first: /login treats a cached `me` as proof that the user is still signed in.
      queryClient.removeQueries()
      await router.navigate({ to: "/login", search: loginSearch(href) })
    } finally {
      leaving = false
    }
  }

  function onUpdate(event: { type: string; action?: { type: string; error?: unknown } }) {
    if (
      event.type === "updated" &&
      event.action?.type === "error" &&
      isSessionExpired(event.action.error)
    ) {
      void leave()
    }
  }

  queryClient.getQueryCache().subscribe(onUpdate)
  queryClient.getMutationCache().subscribe(onUpdate)
}
