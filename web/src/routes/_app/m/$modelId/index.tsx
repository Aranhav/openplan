import { createFileRoute, redirect } from "@tanstack/react-router"

export const Route = createFileRoute("/_app/m/$modelId/")({
  beforeLoad: ({ params }) => {
    throw redirect({ to: "/m/$modelId/modules", params, replace: true })
  },
})
