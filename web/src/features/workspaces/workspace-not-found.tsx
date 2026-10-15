import { Link } from "@tanstack/react-router"
import { Building2, House } from "lucide-react"
import { EmptyState } from "@/components/empty-state"
import { Button } from "@/components/ui/button"
import { useDocumentTitle } from "@/hooks/use-document-title"

/** For an address that names a workspace the user is not in, or that no longer exists. */
export function WorkspaceNotFound() {
  useDocumentTitle("Workspace not found · OpenPlan")
  return (
    <EmptyState
      icon={Building2}
      title="Workspace not found"
      description="It may have been deleted, or you don't have access."
      action={
        <Button asChild>
          <Link to="/">
            <House />
            Go home
          </Link>
        </Button>
      }
      headingLevel={1}
    />
  )
}
