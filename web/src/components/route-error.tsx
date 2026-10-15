import { type ErrorComponentProps, useRouter } from "@tanstack/react-router"
import { CircleAlert } from "lucide-react"
import { AuthLayout } from "@/components/auth-layout"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { useDocumentTitle } from "@/hooks/use-document-title"
import { errorDetail } from "@/lib/api/client"

export function RouteError({ error }: ErrorComponentProps) {
  const router = useRouter()
  useDocumentTitle("Can't load OpenPlan")
  return (
    <AuthLayout title="Can't load OpenPlan">
      <div className="flex flex-col gap-4">
        <Alert variant="destructive">
          <CircleAlert />
          <AlertDescription>{errorDetail(error)}</AlertDescription>
        </Alert>
        {/* Invalidating reruns the guards; the page shows its spinner while they do. */}
        <Button onClick={() => router.invalidate()}>Try again</Button>
      </div>
    </AuthLayout>
  )
}
