import { zodResolver } from "@hookform/resolvers/zod"
import { Layers, Loader2 } from "lucide-react"
import { useEffect, useEffectEvent, useRef, useState } from "react"
import { useForm } from "react-hook-form"
import { toast } from "sonner"
import { z } from "zod"
import { DeleteDialog } from "@/components/delete-dialog"
import { InlineText } from "@/components/inline-text"
import { ProductionLock, ProductionNotice } from "@/components/production-lock"
import { RowDeleteButton } from "@/components/row-delete-button"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import { Button } from "@/components/ui/button"
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form"
import { Input } from "@/components/ui/input"
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet"
import { useCreateSubset, useDeleteSubset, useUpdateSubset } from "@/features/structure/api"
import { useElementMap } from "@/hooks/use-element-map"
import { useRemovalFocus } from "@/hooks/use-removal-focus"
import { NAME_TAKEN_FIELD_ERRORS, reportFormError } from "@/lib/form-errors"
import { isEditingInlineText } from "@/lib/inline-text"
import { structureNameSchema } from "@/lib/validation"
import { sameIds } from "./selection"
import { SubsetMembers } from "./subset-members"
import type { ItemDto, ListDto, SubsetDto } from "./types"
import { countOf } from "@/lib/format"

interface SubsetsSheetProps {
  modelId: string
  list: ListDto
  /** The subsets of this list. */
  subsets: SubsetDto[]
  /** The items of this list, in order. */
  items: ItemDto[]
  canEdit: boolean
  locked: boolean
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Called as the sheet closes; preventing the event stops focus returning to where it was. */
  onCloseAutoFocus?: (event: Event) => void
}

/** The subsets of a list: a name each, and the items they hold. */
export function SubsetsSheet({
  modelId,
  list,
  subsets,
  items,
  canEdit,
  locked,
  open,
  onOpenChange,
  onCloseAutoFocus,
}: SubsetsSheetProps) {
  const createSubset = useCreateSubset(modelId)
  const updateSubset = useUpdateSubset(modelId)
  const deleteSubset = useDeleteSubset(modelId)
  // The subset whose items are on show, or else the one whose items were on show a moment ago. A
  // subset that is gone (deleted elsewhere) shows the list.
  const [view, setView] = useState<{ open?: string; left?: string }>({})
  const opened = subsets.find((subset) => subset.id === view.open)
  // The items ticked for the subset on show: a draft until it is saved.
  const [draft, setDraft] = useState<ReadonlySet<string>>(new Set())
  const dirty = opened !== undefined && !sameIds(draft, opened.items)
  // What to do once the user agrees to drop the draft, and where focus goes if they do not.
  const [discarding, setDiscarding] = useState<{ then: () => void }>()
  const asker = useRef<HTMLElement | null>(null)
  const busy = createSubset.isPending || updateSubset.isPending || deleteSubset.isPending

  function leave(then: () => void) {
    if (dirty) {
      asker.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
      setDiscarding({ then })
    } else {
      then()
    }
  }

  // Not while something is being saved, which a closed sheet would hide.
  function changeOpen(next: boolean) {
    if (busy) {
      return
    }
    if (next) {
      onOpenChange(true)
    } else {
      leave(() => {
        setView({})
        onOpenChange(false)
      })
    }
  }

  return (
    <>
      <Sheet open={open} onOpenChange={changeOpen}>
        <SheetContent
          onCloseAutoFocus={onCloseAutoFocus}
          // The first Escape ends a rename in the list; only the next closes the sheet.
          onEscapeKeyDown={(event) => {
            if (isEditingInlineText(event.target)) {
              event.preventDefault()
            }
          }}
          showCloseButton={!busy}
          className="w-full gap-0 sm:max-w-md"
        >
          <SheetHeader className="border-b pr-12">
            <SheetTitle>Subsets of {list.name}</SheetTitle>
            <SheetDescription>
              Named selections of the items of this list. Modules can use a subset as a dimension.
            </SheetDescription>
          </SheetHeader>
          {opened ? (
            <SubsetMembers
              key={opened.id}
              subset={opened}
              items={items}
              members={draft}
              onMembersChange={setDraft}
              dirty={dirty}
              update={updateSubset}
              canEdit={canEdit}
              locked={locked}
              onBack={() => leave(() => setView({ left: opened.id }))}
              onSaved={() => setView({ left: opened.id })}
            />
          ) : (
            <SubsetList
              list={list}
              subsets={subsets}
              create={createSubset}
              update={updateSubset}
              remove={deleteSubset}
              canEdit={canEdit}
              locked={locked}
              returnTo={view.left}
              onOpen={(id, itemIds) => {
                setDraft(new Set(itemIds))
                setView({ open: id })
              }}
            />
          )}
        </SheetContent>
      </Sheet>
      <AlertDialog
        open={discarding !== undefined}
        onOpenChange={(next) => !next && setDiscarding(undefined)}
      >
        <AlertDialogContent
          onCloseAutoFocus={(event) => {
            event.preventDefault()
            asker.current?.focus()
          }}
        >
          <AlertDialogHeader>
            <AlertDialogTitle>Discard changes?</AlertDialogTitle>
            <AlertDialogDescription>
              The items ticked in {opened?.name} are not saved yet.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep editing</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={() => {
                discarding?.then()
              }}
            >
              Discard changes
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}

interface SubsetListProps {
  list: ListDto
  subsets: SubsetDto[]
  canEdit: boolean
  locked: boolean
  /** The subset that was open before the list came back, whose button takes focus. */
  returnTo?: string
  /** The mutations, which the sheet owns so that it can tell when one is running. */
  create: ReturnType<typeof useCreateSubset>
  update: ReturnType<typeof useUpdateSubset>
  remove: ReturnType<typeof useDeleteSubset>
  /** Opens the items of a subset, which hold these ids. */
  onOpen: (subsetId: string, itemIds: readonly string[]) => void
}

const newSubsetSchema = z.object({ name: structureNameSchema })

type NewSubsetValues = z.infer<typeof newSubsetSchema>

function SubsetList({
  list,
  subsets,
  canEdit,
  locked,
  returnTo,
  create,
  update,
  remove,
  onOpen,
}: SubsetListProps) {
  const buttons = useElementMap<HTMLButtonElement>()
  const removal = useRemovalFocus(subsets.map((subset) => subset.id))
  const [deleting, setDeleting] = useState<SubsetDto>()
  const form = useForm<NewSubsetValues>({
    resolver: zodResolver(newSubsetSchema),
    defaultValues: { name: "" },
  })

  // Coming back from a subset's items, focus goes to the button that opened them.
  const focusReturn = useEffectEvent(() => {
    if (returnTo) {
      buttons.get(returnTo)?.focus()
    }
  })
  useEffect(() => {
    focusReturn()
  }, [])

  async function onCreate({ name }: NewSubsetValues) {
    try {
      const created = await create.mutateAsync({ list_id: list.id, name, item_ids: [] })
      toast.success("Subset created")
      form.reset()
      onOpen(created.id, created.item_ids)
    } catch (error) {
      reportFormError(form, error, NAME_TAKEN_FIELD_ERRORS)
    }
  }

  return (
    <>
      <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-4">
        {locked && <ProductionNotice />}
        {canEdit && (
          <Form {...form}>
            <form
              onSubmit={(event) => void form.handleSubmit(onCreate)(event)}
              noValidate
              className="flex flex-col gap-2"
            >
              <FormField
                control={form.control}
                name="name"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>New subset</FormLabel>
                    <div className="flex items-start gap-2">
                      <FormControl>
                        <Input
                          {...field}
                          placeholder="Core products"
                          autoComplete="off"
                          disabled={locked}
                          className="min-w-0 flex-1"
                        />
                      </FormControl>
                      <ProductionLock locked={locked}>
                        <Button type="submit" disabled={locked || create.isPending}>
                          {create.isPending && <Loader2 className="animate-spin" />}
                          Add subset
                        </Button>
                      </ProductionLock>
                    </div>
                    <FormMessage />
                  </FormItem>
                )}
              />
            </form>
          </Form>
        )}
        {subsets.length === 0 ? (
          <p className="flex items-center gap-2 text-sm text-muted-foreground">
            <Layers className="size-4 shrink-0" />
            {canEdit
              ? "No subsets yet. Name one above, then choose its items."
              : "This list has no subsets."}
          </p>
        ) : (
          <ul aria-label="Subsets" className="divide-y rounded-md border">
            {subsets.map((subset) => (
              <li key={subset.id} className="flex items-center gap-2 px-3 py-1.5">
                <div className="min-w-0 flex-1">
                  {canEdit && !locked ? (
                    <InlineText
                      value={subset.name}
                      label={`Rename ${subset.name}`}
                      inputLabel={`Name of ${subset.name}`}
                      schema={structureNameSchema}
                      className="font-medium"
                      onSave={async (name) => {
                        await update.mutateAsync({ subsetId: subset.id, body: { name } })
                        toast.success("Subset renamed")
                      }}
                    />
                  ) : (
                    <span className="block truncate font-medium" title={subset.name}>
                      {subset.name}
                    </span>
                  )}
                </div>
                <Button
                  ref={buttons.refFor(subset.id)}
                  variant="outline"
                  size="sm"
                  aria-label={`${canEdit ? "Choose" : "View"} the items of ${subset.name}, ${countOf(subset.items.length, "item")}`}
                  onClick={() => onOpen(subset.id, subset.items)}
                >
                  {countOf(subset.items.length, "item")}
                </Button>
                {canEdit && (
                  <RowDeleteButton
                    label={`Delete ${subset.name}`}
                    tooltip="Delete subset"
                    locked={locked}
                    buttonRef={removal.refFor(subset.id)}
                    onClick={() => {
                      removal.remember(subset.id)
                      setDeleting(subset)
                    }}
                  />
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
      <DeleteDialog
        title={`Delete ${deleting?.name ?? "subset"}?`}
        description="The subset is deleted; the items stay in the list. A subset that a module or line item uses can't be deleted."
        action="Delete subset"
        done="Subset deleted"
        onConfirm={async () => {
          if (deleting) {
            await remove.mutateAsync(deleting.id)
          }
        }}
        open={deleting !== undefined}
        onOpenChange={(next) => !next && setDeleting(undefined)}
        onCloseAutoFocus={removal.onCloseAutoFocus}
      />
    </>
  )
}
