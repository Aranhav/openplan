import { Link } from "@tanstack/react-router"
import { ArrowLeft, Box } from "lucide-react"
import { EmptyState } from "@/components/empty-state"
import { Button } from "@/components/ui/button"
import { useDocumentTitle } from "@/hooks/use-document-title"

export function ModelNotFound() {
  useDocumentTitle("Model not found · OpenPlan")
  return (
    <EmptyState
      icon={Box}
      title="Model not found"
      description="It may have been deleted, or you don't have access."
      action={
        <Button asChild>
          <Link to="/">
            <ArrowLeft />
            Back to models
          </Link>
        </Button>
      }
      headingLevel={1}
    />
  )
}
