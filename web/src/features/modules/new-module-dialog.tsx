import { zodResolver } from "@hookform/resolvers/zod"
import { useNavigate } from "@tanstack/react-router"
import { Loader2 } from "lucide-react"
import { useForm } from "react-hook-form"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Form } from "@/components/ui/form"
import { useCreateModule } from "@/features/structure/api"
import type { StructureDto } from "@/features/structure/types"
import { closeUnlessBusy } from "@/lib/close-unless-busy"
import { reportFormError } from "@/lib/form-errors"
import { axesOf } from "./axes"
import { MODULE_FIELD_ERRORS, type ModuleValues, moduleSchema } from "./module-form"
import { ModuleFields } from "./module-fields"

const NEW_MODULE: ModuleValues = {
  name: "",
  functional_area: "",
  dimensions: [],
  time: false,
  time_level: "month",
  time_range: "",
  versions: false,
}

interface NewModuleDialogProps {
  modelId: string
  structure: StructureDto
  /** The functional areas of the model's modules, offered as shortcuts. */
  areas: string[]
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Called as the dialog closes; preventing the event stops focus returning to where it was. */
  onCloseAutoFocus?: (event: Event) => void
}

export function NewModuleDialog({
  modelId,
  structure,
  areas,
  open,
  onOpenChange,
  onCloseAutoFocus,
}: NewModuleDialogProps) {
  const createModule = useCreateModule(modelId)
  return (
    <Dialog open={open} onOpenChange={closeUnlessBusy(createModule.isPending, onOpenChange)}>
      <DialogContent
        onCloseAutoFocus={onCloseAutoFocus}
        showCloseButton={!createModule.isPending}
        className="max-h-[calc(100svh-2rem)] grid-rows-[auto_minmax(0,1fr)] gap-0 overflow-hidden p-0 sm:max-w-lg"
      >
        <DialogHeader className="border-b p-6 pb-4">
          <DialogTitle>New module</DialogTitle>
          <DialogDescription>
            Name it and choose the dimensions its line items are laid out over. You open its
            Blueprint next, to add line items.
          </DialogDescription>
        </DialogHeader>
        <NewModuleForm
          modelId={modelId}
          structure={structure}
          areas={areas}
          createModule={createModule}
          onClose={() => onOpenChange(false)}
        />
      </DialogContent>
    </Dialog>
  )
}

interface NewModuleFormProps {
  modelId: string
  structure: StructureDto
  areas: string[]
  createModule: ReturnType<typeof useCreateModule>
  onClose: () => void
}

// A separate component, so the form starts empty each time the dialog opens.
function NewModuleForm({ modelId, structure, areas, createModule, onClose }: NewModuleFormProps) {
  const navigate = useNavigate()
  const form = useForm<ModuleValues>({
    resolver: zodResolver(moduleSchema),
    defaultValues: NEW_MODULE,
  })

  async function onSubmit(values: ModuleValues) {
    try {
      const created = await createModule.mutateAsync({
        name: values.name,
        functional_area: values.functional_area || null,
        axes: axesOf(values),
      })
      toast.success("Module created")
      onClose()
      await navigate({
        to: "/m/$modelId/modules/$moduleId",
        params: { modelId, moduleId: created.id },
        search: { tab: "blueprint" },
      })
    } catch (error) {
      reportFormError(form, error, MODULE_FIELD_ERRORS)
    }
  }

  return (
    <Form {...form}>
      <form
        onSubmit={form.handleSubmit(onSubmit)}
        noValidate
        className="flex min-h-0 flex-1 flex-col"
      >
        <div className="flex flex-1 flex-col gap-4 overflow-y-auto px-6 py-4">
          <ModuleFields form={form} structure={structure} areas={areas} />
        </div>
        <DialogFooter className="border-t p-4 sm:px-6">
          <Button
            type="button"
            variant="outline"
            disabled={createModule.isPending}
            onClick={onClose}
          >
            Cancel
          </Button>
          <Button type="submit" disabled={createModule.isPending}>
            {createModule.isPending && <Loader2 className="animate-spin" />}
            Create module
          </Button>
        </DialogFooter>
      </form>
    </Form>
  )
}
