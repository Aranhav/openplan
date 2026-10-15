import type { QueryClient } from "@tanstack/react-query"
import { type RouterHistory, createRouter } from "@tanstack/react-router"
import { routeTree } from "./routeTree.gen"

export function createAppRouter(queryClient: QueryClient, history?: RouterHistory) {
  return createRouter({
    routeTree,
    history,
    context: { queryClient },
    defaultPreload: "intent",
    defaultPreloadStaleTime: 0,
  })
}

declare module "@tanstack/react-router" {
  interface Register {
    router: ReturnType<typeof createAppRouter>
  }
}
