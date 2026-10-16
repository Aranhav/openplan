import { createFileRoute } from "@tanstack/react-router"
import { TimePage } from "@/features/time/time-page"

export const Route = createFileRoute("/_app/m/$modelId/time")({
  component: TimeRoute,
})

function TimeRoute() {
  const { modelId } = Route.useParams()
  return <TimePage modelId={modelId} />
}
