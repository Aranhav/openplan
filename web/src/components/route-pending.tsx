import { Loader2 } from "lucide-react"

export function RoutePending() {
  return (
    <main className="flex min-h-svh items-center justify-center">
      <div role="status" aria-label="Loading">
        <Loader2 className="size-6 animate-spin text-muted-foreground" />
      </div>
    </main>
  )
}
