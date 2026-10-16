import { QueryClientProvider } from "@tanstack/react-query"
import { render } from "@testing-library/react"
import { type ReactElement, useState } from "react"
import { type ViewAction, reduceView } from "@/features/grid/toolbar/view-state"
import type { ViewDefinition } from "@/features/grid/view-types"
import { QUERY_STALE_TIME } from "@/lib/query-client"
import { createTestQueryClient } from "./render"

/**
 * Renders a toolbar control over a view that its actions change as the module screen would, and
 * gives what the view is now and every action it was sent.
 */
export function renderOverView(
  initial: ViewDefinition,
  ui: (view: ViewDefinition, dispatch: (action: ViewAction) => void) => ReactElement,
) {
  const state = { view: initial, actions: [] as ViewAction[] }
  function Harness() {
    const [view, setView] = useState(initial)
    state.view = view
    return ui(view, (action) => {
      state.actions.push(action)
      setView((previous) => {
        state.view = reduceView(previous, action)
        return state.view
      })
    })
  }
  const queryClient = createTestQueryClient({ staleTime: QUERY_STALE_TIME })
  render(
    <QueryClientProvider client={queryClient}>
      <Harness />
    </QueryClientProvider>,
  )
  return { state, queryClient }
}
