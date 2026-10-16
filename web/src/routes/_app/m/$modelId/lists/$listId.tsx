import { createFileRoute } from "@tanstack/react-router"
import { z } from "zod"
import { ListPage } from "@/features/lists/list-page"

export const Route = createFileRoute("/_app/m/$modelId/lists/$listId")({
  validateSearch: z.object({
    tab: z.enum(["items", "properties"]).optional().catch(undefined),
  }),
  component: ListRoute,
})

function ListRoute() {
  const { modelId, listId } = Route.useParams()
  const { tab } = Route.useSearch()
  const navigate = Route.useNavigate()
  return (
    <ListPage
      modelId={modelId}
      listId={listId}
      tab={tab ?? "items"}
      onTabChange={(next) => void navigate({ search: { tab: next } })}
    />
  )
}
