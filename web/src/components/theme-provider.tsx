import { createContext, useContext, useEffect, useState } from "react"

export type Theme = "light" | "dark" | "system"

interface ThemeProviderProps {
  children: React.ReactNode
  defaultTheme?: Theme
  storageKey?: string
}

interface ThemeContextValue {
  theme: Theme
  setTheme: (theme: Theme) => void
}

const ThemeContext = createContext<ThemeContextValue | undefined>(undefined)

function isTheme(value: unknown): value is Theme {
  return value === "light" || value === "dark" || value === "system"
}

function readStoredTheme(storageKey: string, fallback: Theme): Theme {
  try {
    const stored = window.localStorage.getItem(storageKey)
    return isTheme(stored) ? stored : fallback
  } catch {
    return fallback
  }
}

export function ThemeProvider({
  children,
  defaultTheme = "system",
  storageKey = "openplan-theme",
}: ThemeProviderProps) {
  const [theme, setThemeState] = useState<Theme>(() => readStoredTheme(storageKey, defaultTheme))

  useEffect(() => {
    const root = window.document.documentElement
    const query = window.matchMedia("(prefers-color-scheme: dark)")

    function apply() {
      const dark = theme === "dark" || (theme === "system" && query.matches)
      root.classList.toggle("dark", dark)
    }

    apply()
    if (theme !== "system") {
      return
    }
    query.addEventListener("change", apply)
    return () => query.removeEventListener("change", apply)
  }, [theme])

  function setTheme(next: Theme) {
    try {
      window.localStorage.setItem(storageKey, next)
    } catch {
      // Storage can be unavailable (private mode); the choice still applies for this session.
    }
    setThemeState(next)
  }

  return <ThemeContext.Provider value={{ theme, setTheme }}>{children}</ThemeContext.Provider>
}

export function useTheme(): ThemeContextValue {
  const context = useContext(ThemeContext)
  if (!context) {
    throw new Error("useTheme must be used within a ThemeProvider")
  }
  return context
}
