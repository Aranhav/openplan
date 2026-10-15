import { Link } from "@tanstack/react-router"
import { MoreHorizontal, Pencil, Trash2 } from "lucide-react"
import { useId, useRef, useState } from "react"
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
  /** Where focus goes when this card is deleted and there is no other card to give it to. */
  fallbackFocus?: () => HTMLElement | null
}

export function ModelCard({ model, canEdit, fallbackFocus }: ModelCardProps) {
  const titleId = useId()
  const card = useRef<HTMLDivElement>(null)
  const neighbour = useRef<Element | null>(null)
  const [dialog, setDialog] = useState<"rename" | "delete" | null>(null)
  // The dialogs open from menu items, which are gone by then: focus returns to the menu's button.
  const { ref: menuButtonRef, onCloseAutoFocus: restoreFocus } =
    useRestoreFocus<HTMLButtonElement>()

  function startDelete() {
    // Once this card is gone, focus moves to the card next to it (else the one before it).
    neighbour.current =
      card.current?.nextElementSibling ?? card.current?.previousElementSibling ?? null
    setDialog("delete")
  }

  // The menu sits beside the link, not inside it, so choosing from it never opens the model. The
  // wrapper is the hover group, so the card stays highlighted while the menu button is hovered
  // or its menu is open.
  return (
    <div ref={card} className="group relative">
      <Link
        to="/m/$modelId"
        params={{ modelId: model.id }}
        aria-labelledby={titleId}
        className="block h-full rounded-xl outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
      >
        <Card
          className={cn(
            "h-full gap-4 py-5 transition-colors group-hover:bg-accent/50",
            "group-has-[button[data-state=open]]:bg-accent/50",
          )}
        >
          <CardHeader className="px-5">
            <CardTitle
              id={titleId}
              title={model.name}
              className={cn("line-clamp-2 leading-snug break-words", canEdit && "pr-8")}
            >
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
              <DropdownMenuItem variant="destructive" onSelect={startDelete}>
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
            focusAfterDelete={() => neighbour.current?.querySelector("a") ?? fallbackFocus?.()}
          />
        </>
      )}
    </div>
  )
}
