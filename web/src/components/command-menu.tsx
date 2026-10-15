import { useNavigate } from "@tanstack/react-router"
import { Box, Building2, Check, CircleUser, LayoutGrid, UserCog, Users } from "lucide-react"
import { type ReactNode, type RefObject, useEffect, useRef } from "react"
import { ErrorState } from "@/components/error-state"
import { THEME_OPTIONS } from "@/components/theme-options"
import { useTheme } from "@/components/theme-provider"
import { Badge } from "@/components/ui/badge"
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Skeleton } from "@/components/ui/skeleton"
import { useMe } from "@/features/auth/api"
import { useModels } from "@/features/models/api"
import { useWorkspaces } from "@/features/workspaces/api"
import { roleLabels } from "@/features/workspaces/roles"
import { useCurrentWorkspace } from "@/hooks/use-current-workspace"
import { cn } from "@/lib/utils"

const OPEN_DIALOG = '[role="dialog"][data-state="open"], [role="alertdialog"][data-state="open"]'

interface CommandMenuProps {
  open: boolean
  onOpenChange: (open: boolean) => void
}

/** The palette only opens from the keyboard or the search button, so neither is the dialog's trigger. */
export function CommandMenu({
  open,
  onOpenChange,
  searchButton,
}: CommandMenuProps & {
  /** Gets the focus back when the palette closes and whatever had it before is gone. */
  searchButton: RefObject<HTMLElement | null>
}) {
  const navigate = useNavigate()
  const { theme, setTheme } = useTheme()
  const { data: me } = useMe()
  const { data: workspaces = [] } = useWorkspaces()
  const { workspace } = useCurrentWorkspace()
  // Set by the shortcut only: the search button is its own opener, and is the fallback anyway.
  const opener = useRef<HTMLElement | null>(null)

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      const shortcut = (event.metaKey || event.ctrlKey) && !event.shiftKey && !event.altKey
      if (!shortcut || event.key.toLowerCase() !== "k") {
        return
      }
      // The browser has its own use for this shortcut (Firefox focuses its search bar); take it
      // over in every case, but only act on a fresh press, and never from behind another dialog.
      event.preventDefault()
      if (!event.repeat && (open || !document.querySelector(OPEN_DIALOG))) {
        if (!open) {
          const active = document.activeElement
          opener.current = active instanceof HTMLElement && active !== document.body ? active : null
        }
        onOpenChange(!open)
      }
    }
    document.addEventListener("keydown", onKeyDown)
    return () => document.removeEventListener("keydown", onKeyDown)
  }, [open, onOpenChange])

  // Radix hands the focus back to the dialog's trigger, which this one does not have.
  function restoreFocus(event: Event) {
    event.preventDefault()
    const target = opener.current?.isConnected ? opener.current : searchButton.current
    opener.current = null
    target?.focus()
  }

  function run(action: () => unknown) {
    onOpenChange(false)
    void action()
  }

  // Each item's value is what the search matches, so it spells out where the item leads.
  return (
    <PaletteDialog open={open} onOpenChange={onOpenChange} onCloseAutoFocus={restoreFocus}>
      <CommandInput
        className="text-base md:text-sm"
        placeholder="Search pages, models and workspaces…"
      />
      <CommandList className="max-h-[min(24rem,60svh)]">
        <CommandEmpty>No results found.</CommandEmpty>
        <CommandGroup heading="Go to">
          {workspace && (
            <>
              <CommandItem
                value="Go to Models"
                onSelect={() =>
                  run(() =>
                    navigate({ to: "/w/$workspaceId", params: { workspaceId: workspace.id } }),
                  )
                }
              >
                <LayoutGrid />
                Models
              </CommandItem>
              <CommandItem
                value="Go to Members"
                onSelect={() =>
                  run(() =>
                    navigate({
                      to: "/w/$workspaceId/members",
                      params: { workspaceId: workspace.id },
                    }),
                  )
                }
              >
                <Users />
                Members
              </CommandItem>
            </>
          )}
          {me?.user.is_instance_admin && (
            <CommandItem
              value="Go to Users"
              onSelect={() => run(() => navigate({ to: "/admin/users" }))}
            >
              <UserCog />
              Users
            </CommandItem>
          )}
          <CommandItem
            value="Go to Profile"
            onSelect={() => run(() => navigate({ to: "/profile" }))}
          >
            <CircleUser />
            Profile
          </CommandItem>
        </CommandGroup>
        {workspace && <ModelsGroup workspaceId={workspace.id} run={run} />}
        {workspaces.length > 1 && (
          <CommandGroup heading="Workspaces">
            {workspaces.map((item) => (
              <CommandItem
                key={item.id}
                value={`Switch to ${item.name}`}
                aria-current={item.id === workspace?.id ? "true" : undefined}
                onSelect={() =>
                  run(() => navigate({ to: "/w/$workspaceId", params: { workspaceId: item.id } }))
                }
              >
                <Building2 />
                {item.name}
                <Badge variant="secondary" className="ml-auto">
                  {roleLabels[item.role]}
                </Badge>
                <Check className={cn(item.id !== workspace?.id && "invisible")} />
              </CommandItem>
            ))}
          </CommandGroup>
        )}
        <CommandGroup heading="Theme">
          {THEME_OPTIONS.map(({ value, label, icon: Icon }) => (
            <CommandItem
              key={value}
              value={`${label} theme`}
              onSelect={() => run(() => setTheme(value))}
            >
              <Icon />
              {label}
              <Check className={cn("ml-auto", theme !== value && "invisible")} />
            </CommandItem>
          ))}
        </CommandGroup>
      </CommandList>
    </PaletteDialog>
  )
}

/**
 * The palette's dialog, put together here rather than with the stock `CommandDialog`, which renders
 * its title and description outside the dialog's content: a heading on every page, even with the
 * palette closed. Here they only exist while it is open.
 */
function PaletteDialog({
  open,
  onOpenChange,
  onCloseAutoFocus,
  children,
}: CommandMenuProps & { onCloseAutoFocus: (event: Event) => void; children: ReactNode }) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="overflow-hidden p-0" onCloseAutoFocus={onCloseAutoFocus}>
        <DialogHeader className="sr-only">
          <DialogTitle>Command palette</DialogTitle>
          <DialogDescription>
            Search for a page, model or workspace, or change the theme.
          </DialogDescription>
        </DialogHeader>
        <Command className="**:data-[slot=command-input-wrapper]:h-12 [&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:font-medium [&_[cmdk-group-heading]]:text-muted-foreground [&_[cmdk-group]]:px-2 [&_[cmdk-group]:not([hidden])_~[cmdk-group]]:pt-0 [&_[cmdk-input-wrapper]_svg]:h-5 [&_[cmdk-input-wrapper]_svg]:w-5 [&_[cmdk-input]]:h-12 [&_[cmdk-item]]:px-2 [&_[cmdk-item]]:py-3 [&_[cmdk-item]_svg]:h-5 [&_[cmdk-item]_svg]:w-5">
          {children}
        </Command>
      </DialogContent>
    </Dialog>
  )
}

// Its own component, so the models are only fetched once the palette is open.
function ModelsGroup({
  workspaceId,
  run,
}: {
  workspaceId: string
  run: (action: () => unknown) => void
}) {
  const navigate = useNavigate()
  const models = useModels(workspaceId)

  if (models.isError) {
    return (
      <CommandGroup heading="Models">
        <ErrorState error={models.error} onRetry={() => void models.refetch()} />
      </CommandGroup>
    )
  }
  if (models.isPending) {
    return (
      <CommandGroup heading="Models">
        <div role="status" aria-label="Loading models" className="flex flex-col gap-2 px-2 py-1.5">
          <Skeleton className="h-5 w-full" />
          <Skeleton className="h-5 w-3/4" />
        </div>
      </CommandGroup>
    )
  }
  if (models.data.length === 0) {
    return null
  }
  return (
    <CommandGroup heading="Models">
      {models.data.map((model) => (
        <CommandItem
          key={model.id}
          value={`Open ${model.name}`}
          onSelect={() => run(() => navigate({ to: "/m/$modelId", params: { modelId: model.id } }))}
        >
          <Box />
          {model.name}
        </CommandItem>
      ))}
    </CommandGroup>
  )
}
