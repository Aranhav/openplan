import { useTheme } from "@/components/theme-provider"
import { Toaster } from "@/components/ui/sonner"

export function AppToaster() {
  const { theme } = useTheme()
  return <Toaster theme={theme} richColors closeButton />
}
