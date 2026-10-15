import { createFileRoute, redirect } from "@tanstack/react-router"
import { Building2 } from "lucide-react"
import { EmptyState } from "@/components/empty-state"
import { useDocumentTitle } from "@/hooks/use-document-title"
import { pickWorkspace } from "@/lib/last-workspace"

export const Route = createFileRoute("/_app/")({
  // Redirecting before anything renders, so home never shows a frame of the shell with no page.
  beforeLoad: ({ context: { me } }) => {
    const workspace = pickWorkspace(me.workspaces)
    if (workspace) {
      throw redirect({
        to: "/w/$workspaceId",
        params: { workspaceId: workspace.id },
        replace: true,
      })
    }
  },
  component: NoWorkspace,
})

function NoWorkspace() {
  useDocumentTitle("No workspace · OpenPlan")
  return (
    <EmptyState
      icon={Building2}
      title="You're not in any workspace yet"
      description="Ask an admin to add you to a workspace."
      headingLevel={1}
    />
  )
}
