import { createFileRoute } from "@tanstack/react-router"
import { VersionsPage } from "@/features/versions/versions-page"

export const Route = createFileRoute("/_app/m/$modelId/versions")({
  component: VersionsRoute,
})

function VersionsRoute() {
  const { modelId } = Route.useParams()
  return <VersionsPage modelId={modelId} />
}
