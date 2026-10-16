import { zodResolver } from "@hookform/resolvers/zod"
import { Loader2 } from "lucide-react"
import { useForm } from "react-hook-form"
import { toast } from "sonner"
import { z } from "zod"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form"
import { Input } from "@/components/ui/input"
import { useCreateVersion } from "@/features/structure/api"
import { closeUnlessBusy } from "@/lib/close-unless-busy"
import { NAME_TAKEN_FIELD_ERRORS, reportFormError } from "@/lib/form-errors"
import { structureNameSchema } from "@/lib/validation"

const schema = z.object({ name: structureNameSchema })

type VersionValues = z.infer<typeof schema>

interface AddVersionDialogProps {
  modelId: string
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Called as the dialog closes; preventing the event stops focus returning to where it was. */
  onCloseAutoFocus?: (event: Event) => void
}

export function AddVersionDialog({
  modelId,
  open,
  onOpenChange,
  onCloseAutoFocus,
}: AddVersionDialogProps) {
  const createVersion = useCreateVersion(modelId)
  return (
    <Dialog open={open} onOpenChange={closeUnlessBusy(createVersion.isPending, onOpenChange)}>
      <DialogContent onCloseAutoFocus={onCloseAutoFocus} showCloseButton={!createVersion.isPending}>
        <DialogHeader>
          <DialogTitle>Add version</DialogTitle>
          <DialogDescription>
            Name the new scenario. You can set when it switches over from actuals afterwards.
          </DialogDescription>
        </DialogHeader>
        <AddVersionForm createVersion={createVersion} onClose={() => onOpenChange(false)} />
      </DialogContent>
    </Dialog>
  )
}

// A separate component, so the form starts empty each time the dialog opens.
function AddVersionForm({
  createVersion,
  onClose,
}: {
  createVersion: ReturnType<typeof useCreateVersion>
  onClose: () => void
}) {
  const form = useForm<VersionValues>({
    resolver: zodResolver(schema),
    defaultValues: { name: "" },
  })

  async function onSubmit({ name }: VersionValues) {
    try {
      await createVersion.mutateAsync({
        name,
        is_actual: false,
        is_current: false,
        switchover: null,
      })
      toast.success("Version added")
      onClose()
    } catch (error) {
      reportFormError(form, error, NAME_TAKEN_FIELD_ERRORS)
    }
  }

  return (
    <Form {...form}>
      <form onSubmit={form.handleSubmit(onSubmit)} noValidate className="flex flex-col gap-4">
        <FormField
          control={form.control}
          name="name"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Name</FormLabel>
              <FormControl>
                <Input placeholder="Downside" autoComplete="off" autoFocus {...field} />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />
        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            disabled={createVersion.isPending}
            onClick={onClose}
          >
            Cancel
          </Button>
          <Button type="submit" disabled={createVersion.isPending}>
            {createVersion.isPending && <Loader2 className="animate-spin" />}
            Add version
          </Button>
        </DialogFooter>
      </form>
    </Form>
  )
}
