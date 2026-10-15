import { SelectContent, SelectItem } from "@/components/ui/select"
import { roleLabels, roleOptions } from "./roles"

/** The roles a member can have, to put inside a `Select`. */
export function RoleSelectContent() {
  return (
    <SelectContent>
      {roleOptions.map((role) => (
        <SelectItem key={role} value={role}>
          {roleLabels[role]}
        </SelectItem>
      ))}
    </SelectContent>
  )
}
