import { Link } from "@tanstack/react-router"
import { MoreHorizontal, Pencil, Trash2 } from "lucide-react"
import { useId, useState } from "react"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardFooter, CardHeader, CardTitle } from "@/components/ui/card"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { useRestoreFocus } from "@/hooks/use-restore-focus"
import type { components } from "@/lib/api/schema"
import { relativeTime } from "@/lib/format"
import { cn } from "@/lib/utils"
import { DeleteModelDialog } from "./delete-model-dialog"
import { ModeBadge } from "./mode-badge"
import { RenameModelDialog } from "./rename-model-dialog"

interface ModelCardProps {
  model: components["schemas"]["ModelDto"]
  /** Whether the signed-in user may rename and delete the model. */
  canEdit: boolean
}

export function ModelCard({ model, canEdit }: ModelCardProps) {
  const titleId = useId()
  const [dialog, setDialog] = useState<"rename" | "delete" | null>(null)
  // The dialogs open from menu items, which are gone by then: focus returns to the menu's button.
  const { ref: menuButtonRef, onCloseAutoFocus: restoreFocus } =
    useRestoreFocus<HTMLButtonElement>()

  // The menu sits beside the link, not inside it, so choosing from it never opens the model.
  return (
    <div className="relative">
      <Link
        to="/m/$modelId"
        params={{ modelId: model.id }}
        aria-labelledby={titleId}
        className="group block h-full rounded-xl outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
      >
        <Card className="h-full gap-4 py-5 transition-colors group-hover:bg-accent/50">
          <CardHeader className="px-5">
            <CardTitle id={titleId} className={cn("truncate leading-snug", canEdit && "pr-8")}>
              {model.name}
            </CardTitle>
          </CardHeader>
          <CardContent className="flex-1 px-5">
            <p className="line-clamp-2 text-sm text-muted-foreground">
              {model.description || "No description"}
            </p>
          </CardContent>
          <CardFooter className="justify-between gap-2 px-5 text-xs text-muted-foreground">
            <ModeBadge mode={model.mode} />
            <time dateTime={model.updated_at}>Updated {relativeTime(model.updated_at)}</time>
          </CardFooter>
        </Card>
      </Link>
      {canEdit && (
        <>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                ref={menuButtonRef}
                variant="ghost"
                size="icon-sm"
                className="absolute top-3 right-3"
                aria-label={`Actions for ${model.name}`}
              >
                <MoreHorizontal />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onSelect={() => setDialog("rename")}>
                <Pencil />
                Rename
              </DropdownMenuItem>
              <DropdownMenuItem variant="destructive" onSelect={() => setDialog("delete")}>
                <Trash2 />
                Delete
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
          <RenameModelDialog
            model={model}
            open={dialog === "rename"}
            onOpenChange={(open) => setDialog(open ? "rename" : null)}
            onCloseAutoFocus={restoreFocus}
          />
          <DeleteModelDialog
            model={model}
            open={dialog === "delete"}
            onOpenChange={(open) => setDialog(open ? "delete" : null)}
            onCloseAutoFocus={restoreFocus}
          />
        </>
      )}
    </div>
  )
}
