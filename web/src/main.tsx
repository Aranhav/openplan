import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { RouterProvider } from "@tanstack/react-router"
import { StrictMode } from "react"
import { createRoot } from "react-dom/client"
import { AppToaster } from "@/components/app-toaster"
import { ThemeProvider } from "@/components/theme-provider"
import { ApiError } from "@/lib/api/client"
import { createAppRouter } from "./router"
import "./index.css"

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: (failureCount, error) =>
        !(error instanceof ApiError && error.status < 500) && failureCount < 2,
      staleTime: 30_000,
    },
  },
})

const router = createAppRouter(queryClient)

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ThemeProvider>
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
        <AppToaster />
      </QueryClientProvider>
    </ThemeProvider>
  </StrictMode>,
)
