import { fireEvent, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { describe, expect, it, vi } from "vitest"
import { TextEditor } from "./text-editor"

function setup(props: Partial<Parameters<typeof TextEditor>[0]> = {}) {
  const onCommit = vi.fn(() => true)
  const onCancel = vi.fn()
  const onLeave = vi.fn()
  render(
    <TextEditor
      label="Sales, Widget"
      initial="1234"
      align="right"
      onCommit={onCommit}
      onCancel={onCancel}
      onLeave={onLeave}
      {...props}
    />,
  )
  return {
    input: screen.getByRole("textbox", { name: "Sales, Widget" }),
    onCommit,
    onCancel,
    onLeave,
  }
}

function addOutside() {
  const outside = document.createElement("button")
  document.body.append(outside)
  return outside
}

describe("TextEditor when it was opened by typing", () => {
  it.each([
    ["{ArrowDown}", "down"],
    ["{ArrowUp}", "up"],
    ["{ArrowLeft}", "left"],
    ["{ArrowRight}", "right"],
  ])("saves the text and moves on %s, as Excel does", async (keys, move) => {
    const { onCommit } = setup({ entered: true })

    await userEvent.keyboard(`5${keys}`)

    expect(onCommit).toHaveBeenCalledExactlyOnceWith("12345", move)
  })

  it("leaves an arrow with Shift, Ctrl or Alt to the text", async () => {
    const { onCommit, input } = setup({ entered: true })

    await userEvent.keyboard("{Shift>}{ArrowLeft}{/Shift}{Control>}{ArrowLeft}{/Control}")

    expect(onCommit).not.toHaveBeenCalled()
    expect(input).toHaveFocus()
  })

  it("keeps the caret keys for the text once F2 has switched to editing", async () => {
    const { onCommit, input } = setup({ entered: true })

    await userEvent.keyboard("{F2}{ArrowLeft}{ArrowLeft}")

    expect(onCommit).not.toHaveBeenCalled()
    expect((input as HTMLInputElement).selectionStart).toBe(2)
  })

  it("goes back to entering on a second F2", async () => {
    const { onCommit } = setup({ entered: true })

    await userEvent.keyboard("{F2}{F2}{ArrowDown}")

    expect(onCommit).toHaveBeenCalledExactlyOnceWith("1234", "down")
  })
})

describe("TextEditor when it was opened on the value", () => {
  it("moves the caret on the arrows instead of saving", async () => {
    const { onCommit, input } = setup()

    await userEvent.keyboard("{ArrowLeft}{ArrowLeft}{ArrowDown}{ArrowUp}")

    expect(onCommit).not.toHaveBeenCalled()
    expect(input).toHaveFocus()
  })

  it("switches to entering on F2, where the arrows save", async () => {
    const { onCommit } = setup()

    await userEvent.keyboard("{F2}{ArrowDown}")

    expect(onCommit).toHaveBeenCalledExactlyOnceWith("1234", "down")
  })
})

describe("TextEditor", () => {
  it("opens focused on its text with the caret at the end", () => {
    const { input } = setup()

    expect(input).toHaveFocus()
    expect(input).toHaveValue("1234")
    expect((input as HTMLInputElement).selectionStart).toBe(4)
    expect((input as HTMLInputElement).selectionEnd).toBe(4)
  })

  it("takes what is typed after its text", async () => {
    const { input } = setup({ initial: "7" })

    await userEvent.keyboard("89")

    expect(input).toHaveValue("789")
  })

  it.each([
    ["{Enter}", "down"],
    ["{Shift>}{Enter}{/Shift}", "up"],
    ["{Tab}", "right"],
    ["{Shift>}{Tab}{/Shift}", "left"],
  ])("saves the text with %s and moves %s", async (keys, move) => {
    const { onCommit, onCancel } = setup()

    await userEvent.keyboard(`5${keys}`)

    expect(onCommit).toHaveBeenCalledExactlyOnceWith("12345", move)
    expect(onCancel).not.toHaveBeenCalled()
  })

  it("gives up with Escape without saving", async () => {
    const { onCommit, onCancel } = setup()

    await userEvent.keyboard("9{Escape}")

    expect(onCancel).toHaveBeenCalledOnce()
    expect(onCommit).not.toHaveBeenCalled()
  })

  it("hands the text over when the focus goes elsewhere, and leaves the focus where it went", async () => {
    const { onCommit, onCancel, onLeave } = setup()
    await userEvent.keyboard("0")
    const outside = addOutside()

    await userEvent.click(outside)

    expect(onLeave).toHaveBeenCalledExactlyOnceWith("12340")
    expect(onCommit).not.toHaveBeenCalled()
    expect(onCancel).not.toHaveBeenCalled()
    expect(outside).toHaveFocus()
  })

  it("does not hand the text over twice when Enter is followed by the focus leaving", async () => {
    const { input, onCommit, onLeave } = setup()

    await userEvent.keyboard("{Enter}")
    fireEvent.blur(input)

    expect(onCommit).toHaveBeenCalledOnce()
    expect(onLeave).not.toHaveBeenCalled()
  })

  it("does not hand the text over after Escape either", async () => {
    const { input, onLeave } = setup()

    await userEvent.keyboard("{Escape}")
    fireEvent.blur(input)

    expect(onLeave).not.toHaveBeenCalled()
  })

  it("stays open and marks the text invalid when the text is refused", async () => {
    const onCommit = vi.fn(() => false)
    const { input, onCancel } = setup({ onCommit })

    await userEvent.keyboard("x{Enter}")

    expect(input).toHaveFocus()
    expect(input).toBeInvalid()
    expect(onCancel).not.toHaveBeenCalled()
    await userEvent.keyboard("{Backspace}")
    expect(input).toBeValid()
  })

  it("can be saved again after a refusal", async () => {
    const onCommit = vi.fn().mockReturnValueOnce(false).mockReturnValue(true)
    setup({ onCommit })

    await userEvent.keyboard("{Enter}{Enter}")

    expect(onCommit).toHaveBeenCalledTimes(2)
  })

  it("leaves the keys of the text alone", async () => {
    const { input, onCommit, onCancel } = setup()

    await userEvent.keyboard("{ArrowLeft}{Home}{Delete}")
    await userEvent.keyboard("{Control>}a{/Control}")

    expect(input).toHaveValue("234")
    expect(onCommit).not.toHaveBeenCalled()
    expect(onCancel).not.toHaveBeenCalled()
  })

  describe("while an input method composes", () => {
    it("does not save on the Enter that confirms the composition", () => {
      const { input, onCommit } = setup()

      fireEvent.keyDown(input, { key: "Enter", isComposing: true })
      fireEvent.keyDown(input, { key: "Enter", keyCode: 229 })

      expect(onCommit).not.toHaveBeenCalled()
    })

    it("does not give up on the Escape that cancels the composition", () => {
      const { input, onCancel } = setup()

      fireEvent.keyDown(input, { key: "Escape", isComposing: true })
      fireEvent.keyDown(input, { key: "Escape", keyCode: 229 })

      expect(onCancel).not.toHaveBeenCalled()
    })

    it("saves on Enter once the composition is over", () => {
      const { input, onCommit } = setup()

      fireEvent.keyDown(input, { key: "Enter", isComposing: false, keyCode: 13 })

      expect(onCommit).toHaveBeenCalledExactlyOnceWith("1234", "down")
    })
  })

  it("aligns numbers to the right and other text to the left", () => {
    const right = setup({ align: "right" })
    expect(right.input).toHaveClass("text-right")
  })

  it("lets its owner see the keys first and take them", async () => {
    const onKey = vi.fn(() => true)
    const { onCommit } = setup({ onKey })

    await userEvent.keyboard("{Enter}")

    expect(onKey).toHaveBeenCalled()
    expect(onCommit).not.toHaveBeenCalled()
  })

  it("does not save when the focus goes where its owner says it may", async () => {
    const outside = addOutside()
    const { onCommit, onCancel, onLeave } = setup({ keepOpenFor: (target) => target === outside })

    outside.focus()

    expect(onCommit).not.toHaveBeenCalled()
    expect(onCancel).not.toHaveBeenCalled()
    expect(onLeave).not.toHaveBeenCalled()
  })
})
