import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import {
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from "@tanstack/react-router"
import { render } from "@testing-library/react"
import type { ReactElement } from "react"

export function createTestQueryClient() {
  return new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
}

/**
 * Renders `ui` at /host inside a query client and an in-memory router. Every
 * other path renders an "Elsewhere" page, so tests can assert where the UI
 * navigated through `router.state.location`.
 */
export function renderWithProviders(ui: ReactElement) {
  const queryClient = createTestQueryClient()
  const rootRoute = createRootRoute()
  const hostRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/host",
    component: () => ui,
  })
  const elsewhereRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "$",
    component: () => <p>Elsewhere</p>,
  })
  const router = createRouter({
    routeTree: rootRoute.addChildren([hostRoute, elsewhereRoute]),
    history: createMemoryHistory({ initialEntries: ["/host"] }),
  })

  render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  )
  return { queryClient, router }
}
