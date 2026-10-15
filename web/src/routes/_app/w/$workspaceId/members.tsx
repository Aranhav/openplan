import { createFileRoute } from "@tanstack/react-router"
import { MembersPage } from "@/features/workspaces/members-page"

export const Route = createFileRoute("/_app/w/$workspaceId/members")({
  component: WorkspaceMembersRoute,
})

function WorkspaceMembersRoute() {
  const { workspaceId } = Route.useParams()
  return <MembersPage key={workspaceId} workspaceId={workspaceId} />
}
