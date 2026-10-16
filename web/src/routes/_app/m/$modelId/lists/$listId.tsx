import { createFileRoute } from "@tanstack/react-router"
import { ListPage } from "@/features/lists/list-page"

export const Route = createFileRoute("/_app/m/$modelId/lists/$listId")({
  component: ListRoute,
})

function ListRoute() {
  const { modelId, listId } = Route.useParams()
  return <ListPage modelId={modelId} listId={listId} />
}
