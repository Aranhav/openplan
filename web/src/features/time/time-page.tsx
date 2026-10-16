import { ErrorState } from "@/components/error-state"
import { PageHeader } from "@/components/page-header"
import { ProductionNotice } from "@/components/production-lock"
import { Card, CardContent, CardHeader } from "@/components/ui/card"
import { Skeleton } from "@/components/ui/skeleton"
import { useStructure } from "@/features/structure/api"
import type { StructureDto } from "@/features/structure/types"
import { useStructureAccess } from "@/hooks/use-structure-access"
import { CalendarCard } from "./calendar-form"
import { TimelinePreviewCard } from "./timeline-preview"
import { TimeRangesCard } from "./time-ranges-table"

export function TimePage({ modelId }: { modelId: string }) {
  const structure = useStructure(modelId)

  return (
    <>
      <PageHeader title="Time" description="The calendar of the model and its time ranges." />
      {/* A refresh that fails in the background leaves the settings already on screen alone. */}
      {structure.data ? (
        <TimeSettings modelId={modelId} structure={structure.data} />
      ) : structure.isError ? (
        <ErrorState error={structure.error} onRetry={() => void structure.refetch()} />
      ) : (
        <TimeSkeleton />
      )}
    </>
  )
}

function TimeSettings({ modelId, structure }: { modelId: string; structure: StructureDto }) {
  const { canEdit, locked } = useStructureAccess(modelId)
  return (
    <div className="flex max-w-4xl flex-col gap-6">
      {locked && <ProductionNotice />}
      <CalendarCard modelId={modelId} structure={structure} canEdit={canEdit} locked={locked} />
      <TimelinePreviewCard structure={structure} />
      <TimeRangesCard modelId={modelId} structure={structure} canEdit={canEdit} locked={locked} />
    </div>
  )
}

function TimeSkeleton() {
  return (
    <div role="status" aria-label="Loading time settings" className="flex max-w-4xl flex-col gap-6">
      <Card>
        <CardHeader>
          <Skeleton className="h-5 w-24" />
        </CardHeader>
        <CardContent className="grid gap-6 sm:grid-cols-2">
          {Array.from({ length: 4 }, (_, index) => (
            <div key={index} className="grid gap-2">
              <Skeleton className="h-4 w-28" />
              <Skeleton className="h-9 w-full" />
            </div>
          ))}
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <Skeleton className="h-5 w-36" />
        </CardHeader>
        <CardContent className="grid gap-3">
          {Array.from({ length: 3 }, (_, index) => (
            <Skeleton key={index} className="h-6 w-full" />
          ))}
        </CardContent>
      </Card>
    </div>
  )
}
