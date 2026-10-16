import { zodResolver } from "@hookform/resolvers/zod"
import { Loader2, Trash2 } from "lucide-react"
import { useRef, useState } from "react"
import { useForm } from "react-hook-form"
import { toast } from "sonner"
import { DeleteDialog } from "@/components/delete-dialog"
import { ProductionLock, ProductionNotice } from "@/components/production-lock"
import { Button } from "@/components/ui/button"
import { Form } from "@/components/ui/form"
import { Separator } from "@/components/ui/separator"
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet"
import { useDeleteModule, useUpdateModule } from "@/features/structure/api"
import { groupModules } from "@/features/structure/modules"
import type { ModuleDto, StructureDto } from "@/features/structure/types"
import { useRestoreFocus } from "@/hooks/use-restore-focus"
import { closeUnlessBusy } from "@/lib/close-unless-busy"
import type { components } from "@/lib/api/schema"
import { reportFormError } from "@/lib/form-errors"
import { axesOf, axesValues, sameAxes } from "./axes"
import { ClearValuesDialog } from "./clear-values-dialog"
import { MODULE_FIELD_ERRORS, type ModuleValues, moduleSchema } from "./module-form"
import { ModuleFields } from "./module-fields"

type UpdateModuleRequest = components["schemas"]["UpdateModuleRequest"]

function moduleValues(module: ModuleDto): ModuleValues {
  return {
    name: module.name,
    functional_area: module.functional_area,
    ...axesValues(module.axes),
  }
}

/** Only what `values` changes about `module`, in the shape the update endpoint takes. */
function modulePatch(module: ModuleDto, values: ModuleValues): UpdateModuleRequest {
  const axes = axesOf(values)
  return {
    ...(values.name.trim() !== module.name && { name: values.name.trim() }),
    ...(values.functional_area.trim() !== module.functional_area && {
      functional_area: values.functional_area.trim(),
    }),
    ...(!sameAxes(axes, module.axes) && { axes }),
  }
}

interface ModuleSettingsSheetProps {
  modelId: string
  structure: StructureDto
  module: ModuleDto
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Whether production mode switches the settings off. */
  locked: boolean
  /** Called once the module is deleted, to leave its page. */
  onDeleted: () => void
  /** Called as the sheet closes; preventing the event stops focus returning to where it was. */
  onCloseAutoFocus?: (event: Event) => void
}

/** The name, functional area and dimensions of a module, and the way to delete it. */
export function ModuleSettingsSheet({
  modelId,
  structure,
  module,
  open,
  onOpenChange,
  locked,
  onDeleted,
  onCloseAutoFocus,
}: ModuleSettingsSheetProps) {
  const update = useUpdateModule(modelId)
  return (
    <Sheet open={open} onOpenChange={closeUnlessBusy(update.isPending, onOpenChange)}>
      <SheetContent
        onCloseAutoFocus={onCloseAutoFocus}
        showCloseButton={!update.isPending}
        className="w-full gap-0 sm:max-w-lg"
      >
        <SheetHeader className="border-b pr-12">
          <SheetTitle>Module settings</SheetTitle>
          <SheetDescription>
            What {module.name} is called and the dimensions its line items are laid out over.
          </SheetDescription>
        </SheetHeader>
        <ModuleSettingsForm
          modelId={modelId}
          update={update}
          structure={structure}
          module={module}
          locked={locked}
          onClose={() => onOpenChange(false)}
          onDeleted={onDeleted}
        />
      </SheetContent>
    </Sheet>
  )
}

interface ModuleSettingsFormProps {
  modelId: string
  update: ReturnType<typeof useUpdateModule>
  structure: StructureDto
  module: ModuleDto
  locked: boolean
  onClose: () => void
  onDeleted: () => void
}

function ModuleSettingsForm({
  modelId,
  update,
  structure,
  module,
  locked,
  onClose,
  onDeleted,
}: ModuleSettingsFormProps) {
  const deleteModule = useDeleteModule(modelId)
  // The form follows the structure: a field nobody has touched takes the latest saved value (a
  // rename from the page's title shows up), a field being edited keeps what was typed.
  const form = useForm<ModuleValues>({
    resolver: zodResolver(moduleSchema),
    values: moduleValues(module),
    resetOptions: { keepDirtyValues: true },
  })
  // The values waiting for a yes to clearing the module's input values.
  const [confirming, setConfirming] = useState<ModuleValues>()
  const [deleting, setDeleting] = useState(false)
  const { ref: saveRef, onCloseAutoFocus: restoreFocus } = useRestoreFocus<HTMLButtonElement>()
  // Set once the module is saved, when the sheet closing takes focus where it belongs.
  const saved = useRef(false)
  const areas = groupModules(structure.modules.filter((other) => other.id !== module.id)).areas.map(
    (area) => area.name,
  )

  async function save(values: ModuleValues) {
    const patch = modulePatch(module, values)
    try {
      if (Object.keys(patch).length > 0) {
        await update.mutateAsync({ moduleId: module.id, body: patch })
        toast.success("Module saved")
      }
      saved.current = true
      onClose()
    } catch (error) {
      reportFormError(form, error, MODULE_FIELD_ERRORS)
    } finally {
      setConfirming(undefined)
    }
  }

  async function onSubmit(values: ModuleValues) {
    if (!sameAxes(axesOf(values), module.axes)) {
      setConfirming(values)
    } else {
      await save(values)
    }
  }

  // Back to the save button, or if the server refused a field to that field, which is on screen
  // again once the dialog is gone.
  function afterDialog(event: Event) {
    if (saved.current) {
      event.preventDefault()
      return
    }
    const refused = Object.keys(form.formState.errors)[0] as keyof ModuleValues | undefined
    if (refused) {
      event.preventDefault()
      form.setFocus(refused)
    } else {
      restoreFocus(event)
    }
  }

  return (
    <Form {...form}>
      <form
        onSubmit={(event) => void form.handleSubmit(onSubmit)(event)}
        noValidate
        className="flex min-h-0 flex-1 flex-col"
      >
        <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-4">
          {locked && <ProductionNotice />}
          <ModuleFields form={form} structure={structure} areas={areas} disabled={locked} />
          <Separator className="my-2" />
          <section aria-labelledby="delete-module-heading" className="flex flex-col gap-3">
            <h3 id="delete-module-heading" className="text-sm font-semibold">
              Delete module
            </h3>
            <p className="text-sm text-muted-foreground">
              Deleting the module deletes its line items and the values entered in them.
            </p>
            <ProductionLock locked={locked}>
              <Button
                type="button"
                variant="outline"
                className="w-fit text-destructive hover:text-destructive"
                disabled={locked || update.isPending}
                onClick={() => setDeleting(true)}
              >
                <Trash2 />
                Delete module
              </Button>
            </ProductionLock>
          </section>
        </div>
        <SheetFooter className="flex-row justify-end border-t">
          <Button type="button" variant="outline" disabled={update.isPending} onClick={onClose}>
            Cancel
          </Button>
          <ProductionLock locked={locked}>
            <Button
              ref={saveRef}
              type="submit"
              disabled={locked || !form.formState.isDirty || update.isPending}
            >
              {update.isPending && <Loader2 className="animate-spin" />}
              Save changes
            </Button>
          </ProductionLock>
        </SheetFooter>
      </form>
      <ClearValuesDialog
        open={confirming !== undefined}
        description="Changing dimensions clears this module's input values."
        pending={update.isPending}
        onConfirm={() => confirming && void save(confirming)}
        onOpenChange={(next) => !next && setConfirming(undefined)}
        onCloseAutoFocus={afterDialog}
      />
      <DeleteDialog
        title={`Delete ${module.name}?`}
        description="The module, its line items and the values entered in them are deleted."
        action="Delete module"
        done="Module deleted"
        onConfirm={async () => {
          await deleteModule.mutateAsync(module.id)
          onDeleted()
        }}
        open={deleting}
        onOpenChange={setDeleting}
      />
    </Form>
  )
}
