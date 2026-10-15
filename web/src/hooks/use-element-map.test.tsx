import { render, screen } from "@testing-library/react"
import { describe, expect, it } from "vitest"
import { useElementMap } from "./use-element-map"

type ElementMap = ReturnType<typeof useElementMap<HTMLButtonElement>>

function Buttons({ keys, onRender }: { keys: string[]; onRender: (map: ElementMap) => void }) {
  const buttons = useElementMap<HTMLButtonElement>()
  onRender(buttons)
  return keys.map((key) => (
    <button key={key} ref={buttons.refFor(key)}>
      {key}
    </button>
  ))
}

describe("useElementMap", () => {
  it("finds the element of a key", () => {
    let map!: ElementMap
    render(<Buttons keys={["ada", "grace"]} onRender={(current) => (map = current)} />)

    expect(map.get("grace")).toBe(screen.getByRole("button", { name: "grace" }))
    expect(map.get("ada")).toBe(screen.getByRole("button", { name: "ada" }))
  })

  it("knows nothing of a key that was never listed, or none at all", () => {
    let map!: ElementMap
    render(<Buttons keys={["ada"]} onRender={(current) => (map = current)} />)

    expect(map.get("alan")).toBeUndefined()
    expect(map.get(undefined)).toBeUndefined()
  })

  it("forgets an element once it leaves the list", () => {
    let map!: ElementMap
    const onRender = (current: ElementMap) => {
      map = current
    }
    const { rerender } = render(<Buttons keys={["ada", "grace"]} onRender={onRender} />)
    rerender(<Buttons keys={["ada"]} onRender={onRender} />)

    expect(map.get("grace")).toBeUndefined()
    expect(map.get("ada")).toBe(screen.getByRole("button", { name: "ada" }))
  })

  it("keeps finding elements through a map from an earlier render", () => {
    const seen: ElementMap[] = []
    const { rerender } = render(<Buttons keys={["ada"]} onRender={(map) => seen.push(map)} />)
    rerender(<Buttons keys={["ada"]} onRender={(map) => seen.push(map)} />)

    expect(seen.length).toBeGreaterThan(1)
    expect(seen[0].get("ada")).toBe(screen.getByRole("button", { name: "ada" }))
  })
})
