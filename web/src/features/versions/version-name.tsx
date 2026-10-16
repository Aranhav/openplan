import { Pencil } from "lucide-react"
import { InlineText } from "@/components/inline-text"
import { structureNameSchema } from "@/lib/validation"

interface VersionNameProps {
  name: string
  /** Saves the new name; a refusal it throws is shown under the input. */
  onRename: (name: string) => Promise<void>
}

/** The name of a version, which turns into an input when it is clicked. */
export function VersionName({ name, onRename }: VersionNameProps) {
  return (
    <InlineText
      value={name}
      label={`Rename ${name}`}
      inputLabel={`Name of ${name}`}
      schema={structureNameSchema}
      onSave={onRename}
      icon={<Pencil className="text-muted-foreground" />}
      className="font-medium"
    />
  )
}
