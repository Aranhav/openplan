import { CircleAlert, Loader2 } from "lucide-react"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { errorDetail } from "@/lib/api/client"

interface ErrorStateProps {
  error: unknown
  /** Whether the data is being fetched again; Retry then waits for that attempt to end. */
  isFetching: boolean
  onRetry: () => void
}

export function ErrorState({ error, isFetching, onRetry }: ErrorStateProps) {
  return (
    <Alert variant="destructive">
      <CircleAlert />
      <AlertDescription>
        <p>{errorDetail(error)}</p>
        <Button
          variant="outline"
          size="sm"
          className="mt-3"
          disabled={isFetching}
          onClick={onRetry}
        >
          {isFetching && <Loader2 className="animate-spin" />}
          Retry
        </Button>
      </AlertDescription>
    </Alert>
  )
}
