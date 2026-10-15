import { zodResolver } from "@hookform/resolvers/zod"
import { Loader2 } from "lucide-react"
import type { ReactNode } from "react"
import { useForm } from "react-hook-form"
import { toast } from "sonner"
import { z } from "zod"
import { Button } from "@/components/ui/button"
import { CardContent, CardFooter } from "@/components/ui/card"
import {
  Form,
  FormControl,
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
} from "@/components/ui/form"
import { Switch } from "@/components/ui/switch"
import type { components } from "@/lib/api/schema"
import { useUpdateModel } from "./api"
import { ModelDescriptionField, ModelNameField } from "./model-fields"
import { modelDescriptionSchema, modelNameSchema, reportModelFormError } from "./model-form"
import { ModeBadge } from "./mode-badge"

type ModelDto = components["schemas"]["ModelDto"]

const schema = z.object({
  name: modelNameSchema,
  description: modelDescriptionSchema,
  production: z.boolean(),
})

type SettingsValues = z.infer<typeof schema>

function settingsOf(model: ModelDto): SettingsValues {
  return {
    name: model.name,
    description: model.description,
    production: model.mode === "prod",
  }
}

interface ModelSettingsFormProps {
  model: ModelDto
  /** Whether the signed-in user may change the model; if not, the settings are shown as text. */
  canEdit: boolean
}

/** The contents of the "Model settings" card. */
export function ModelSettingsForm({ model, canEdit }: ModelSettingsFormProps) {
  return canEdit ? <EditableSettings model={model} /> : <ReadOnlySettings model={model} />
}

function EditableSettings({ model }: { model: ModelDto }) {
  const updateModel = useUpdateModel(model.id)
  const form = useForm<SettingsValues>({
    resolver: zodResolver(schema),
    defaultValues: settingsOf(model),
  })

  async function onSubmit({ name, description, production }: SettingsValues) {
    try {
      const saved = await updateModel.mutateAsync({
        name,
        description,
        mode: production ? "prod" : "dev",
      })
      // Starts over from what the server kept (the name, trimmed), so the form is clean again.
      form.reset(settingsOf(saved))
      toast.success("Changes saved")
    } catch (error) {
      reportModelFormError(form, error)
    }
  }

  return (
    <Form {...form}>
      <form onSubmit={form.handleSubmit(onSubmit)} noValidate className="flex flex-col gap-6">
        <CardContent className="flex flex-col gap-6">
          <ModelNameField />
          <ModelDescriptionField />
          <FormField
            control={form.control}
            name="production"
            render={({ field }) => (
              <FormItem className="flex flex-row items-center justify-between gap-4 rounded-lg border p-4">
                <div className="grid gap-1">
                  <FormLabel>Production mode</FormLabel>
                  <FormDescription>
                    Structural changes are blocked. Changes arrive through ALM sync.
                  </FormDescription>
                </div>
                <FormControl>
                  <Switch
                    ref={field.ref}
                    name={field.name}
                    checked={field.value}
                    onCheckedChange={field.onChange}
                    onBlur={field.onBlur}
                  />
                </FormControl>
              </FormItem>
            )}
          />
        </CardContent>
        <CardFooter className="justify-end">
          <Button type="submit" disabled={!form.formState.isDirty || updateModel.isPending}>
            {updateModel.isPending && <Loader2 className="animate-spin" />}
            Save changes
          </Button>
        </CardFooter>
      </form>
    </Form>
  )
}

function ReadOnlySettings({ model }: { model: ModelDto }) {
  return (
    <CardContent>
      <dl className="grid gap-4 text-sm">
        <Setting label="Name">{model.name}</Setting>
        <Setting label="Description">
          {model.description || <span className="text-muted-foreground">No description</span>}
        </Setting>
        <Setting label="Mode">
          <ModeBadge mode={model.mode} />
        </Setting>
      </dl>
    </CardContent>
  )
}

function Setting({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid gap-1">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="break-words whitespace-pre-wrap">{children}</dd>
    </div>
  )
}
