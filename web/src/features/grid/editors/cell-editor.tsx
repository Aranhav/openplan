import type { Direction } from "../core/selection"
import type { Value } from "../core/types"
import type { ListOption } from "../edit-reference"
import { DateEditor } from "./date-editor"
import { ListEditor } from "./list-editor"
import { TextEditor } from "./text-editor"

export type CellEditorProps = {
  kind: "text" | "list" | "date"
  /** Names the editor for assistive technology. */
  label: string
  /** The text the editor opens with: the value, or what was typed to open it. */
  initial: string
  align: "left" | "right"
  /** The items of the list, for a list cell. */
  options: readonly ListOption[]
  /** The item a list cell holds. */
  currentItem: string | null
  /** The day a date cell holds, as yyyy-mm-dd. */
  currentDate: string | null
  onText: (text: string, move: Direction) => boolean
  /** A value picked from a list or a calendar. */
  onValue: (value: Value, move: Direction | null) => void
  onLeave: (text: string) => void
  onCancel: () => void
}

/** The editor that fits a cell: a list's items, a calendar with the date as text, or text. */
export function CellEditor({
  kind,
  label,
  initial,
  align,
  options,
  currentItem,
  currentDate,
  onText,
  onValue,
  onLeave,
  onCancel,
}: CellEditorProps) {
  switch (kind) {
    case "list":
      return (
        <ListEditor
          label={label}
          options={options}
          current={currentItem}
          initialSearch={initial}
          onPick={(id, move) => onValue({ t: "item", v: id }, move)}
          onCancel={onCancel}
          onLeave={() => onLeave("")}
        />
      )
    case "date":
      return (
        <DateEditor
          label={label}
          initial={initial}
          current={currentDate}
          onText={onText}
          onDate={(date, move) => onValue({ t: "date", v: date }, move)}
          onCancel={onCancel}
          onLeave={onLeave}
        />
      )
    case "text":
      return (
        <TextEditor
          label={label}
          initial={initial}
          align={align}
          onCommit={onText}
          onCancel={onCancel}
          onLeave={onLeave}
        />
      )
  }
}
