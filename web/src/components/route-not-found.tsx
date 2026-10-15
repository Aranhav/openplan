import { Link } from "@tanstack/react-router"
import { House } from "lucide-react"
import { AuthLayout } from "@/components/auth-layout"
import { Button } from "@/components/ui/button"

export function RouteNotFound() {
  return (
    <AuthLayout
      title="Page not found"
      description="This page doesn't exist, or it has moved."
    >
      <Button asChild>
        <Link to="/">
          <House />
          Go home
        </Link>
      </Button>
    </AuthLayout>
  )
}
