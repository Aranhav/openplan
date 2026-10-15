import { act, render, screen } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { ThemeProvider, useTheme } from "./theme-provider"

function ThemeProbe() {
  const { theme, setTheme } = useTheme()
  return (
    <>
      <span data-testid="theme">{theme}</span>
      <button onClick={() => setTheme("dark")}>Use dark</button>
      <button onClick={() => setTheme("light")}>Use light</button>
    </>
  )
}

function renderProbe() {
  return render(
    <ThemeProvider>
      <ThemeProbe />
    </ThemeProvider>,
  )
}

function mockSystemDark(matches: boolean) {
  vi.spyOn(window, "matchMedia").mockImplementation(
    (query) =>
      ({
        matches,
        media: query,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      }) as unknown as MediaQueryList,
  )
}

beforeEach(() => {
  window.localStorage.clear()
  document.documentElement.classList.remove("dark")
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe("ThemeProvider", () => {
  it("defaults to system and stays light when the system is light", () => {
    renderProbe()

    expect(screen.getByTestId("theme")).toHaveTextContent("system")
    expect(document.documentElement).not.toHaveClass("dark")
  })

  it("follows a dark system preference when the theme is system", () => {
    mockSystemDark(true)

    renderProbe()

    expect(document.documentElement).toHaveClass("dark")
  })

  it("toggles the dark class and stores the choice under openplan-theme", () => {
    renderProbe()

    act(() => screen.getByRole("button", { name: "Use dark" }).click())

    expect(document.documentElement).toHaveClass("dark")
    expect(window.localStorage.getItem("openplan-theme")).toBe("dark")

    act(() => screen.getByRole("button", { name: "Use light" }).click())

    expect(document.documentElement).not.toHaveClass("dark")
    expect(window.localStorage.getItem("openplan-theme")).toBe("light")
  })

  it("restores the stored theme on mount", () => {
    window.localStorage.setItem("openplan-theme", "dark")

    renderProbe()

    expect(screen.getByTestId("theme")).toHaveTextContent("dark")
    expect(document.documentElement).toHaveClass("dark")
  })

  it("ignores an invalid stored value", () => {
    window.localStorage.setItem("openplan-theme", "purple")

    renderProbe()

    expect(screen.getByTestId("theme")).toHaveTextContent("system")
  })
})
