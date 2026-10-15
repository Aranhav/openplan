import { Navigate, createFileRoute } from "@tanstack/react-router"
import { Building2 } from "lucide-react"
import { EmptyState } from "@/components/empty-state"
import { Skeleton } from "@/components/ui/skeleton"
import { useCurrentWorkspace } from "@/hooks/use-current-workspace"

export const Route = createFileRoute("/_app/")({
  component: HomePage,
})

function HomePage() {
  const { workspace, isLoading } = useCurrentWorkspace()
  if (workspace) {
    return <Navigate to="/w/$workspaceId" params={{ workspaceId: workspace.id }} replace />
  }
  if (isLoading) {
    return <Skeleton className="h-64 w-full" />
  }
  return (
    <EmptyState
      icon={Building2}
      title="You're not in any workspace yet"
      description="Ask an admin to add you to a workspace."
    />
  )
}
