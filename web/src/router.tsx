import type { QueryClient } from "@tanstack/react-query"
import { type RouterHistory, createRouter } from "@tanstack/react-router"
import { RouteError } from "@/components/route-error"
import { RouteNotFound } from "@/components/route-not-found"
import { RoutePending } from "@/components/route-pending"
import { watchSessionExpiry } from "@/features/auth/session-expiry"
import { routeTree } from "./routeTree.gen"

export function createAppRouter(queryClient: QueryClient, history?: RouterHistory) {
  const router = createRouter({
    routeTree,
    history,
    context: { queryClient },
    defaultPreload: "intent",
    defaultPreloadStaleTime: 0,
    defaultErrorComponent: RouteError,
    defaultPendingComponent: RoutePending,
    defaultNotFoundComponent: RouteNotFound,
  })
  watchSessionExpiry(queryClient, router)
  return router
}

declare module "@tanstack/react-router" {
  interface Register {
    router: ReturnType<typeof createAppRouter>
  }
}
