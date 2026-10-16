import { createFileRoute } from "@tanstack/react-router"
import { ListsPage } from "@/features/lists/lists-page"

export const Route = createFileRoute("/_app/m/$modelId/lists/")({
  component: ListsRoute,
})

function ListsRoute() {
  const { modelId } = Route.useParams()
  return <ListsPage modelId={modelId} />
}
