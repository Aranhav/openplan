import { Loader2 } from "lucide-react"
import { useDocumentTitle } from "@/hooks/use-document-title"

export function RoutePending() {
  useDocumentTitle("Loading · OpenPlan")
  return (
    <main className="flex min-h-svh items-center justify-center">
      <div role="status" aria-label="Loading">
        <Loader2 className="size-6 animate-spin text-muted-foreground" />
      </div>
    </main>
  )
}
