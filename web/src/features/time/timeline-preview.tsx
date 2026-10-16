import { Badge } from "@/components/ui/badge"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import type { StructureDto } from "@/features/structure/types"
import { fiscalYears } from "./timeline"

/** The fiscal years the saved calendar covers, with the months and quarters each one holds. */
export function TimelinePreviewCard({ structure }: { structure: StructureDto }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle role="heading" aria-level={2}>
          Timeline preview
        </CardTitle>
        <CardDescription>The saved timeline, one row per fiscal year.</CardDescription>
      </CardHeader>
      <CardContent>
        <div className="rounded-lg border">
          <Table aria-label="Timeline preview">
            <TableHeader>
              <TableRow>
                <TableHead className="pl-4">Fiscal year</TableHead>
                <TableHead className="hidden sm:table-cell">Months</TableHead>
                <TableHead className="pr-4">Quarters</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {fiscalYears(structure.calendar, structure.month_labels).map((year) => (
                <TableRow key={year.label}>
                  <TableCell className="pl-4 font-medium">
                    {year.label}
                    {/* The months move under the year where the quarters need the room. */}
                    <div className="text-xs font-normal text-muted-foreground tabular-nums sm:hidden">
                      {year.firstMonth} – {year.lastMonth}
                    </div>
                  </TableCell>
                  <TableCell className="hidden whitespace-nowrap tabular-nums sm:table-cell">
                    {year.firstMonth} – {year.lastMonth}
                  </TableCell>
                  <TableCell className="pr-4 whitespace-normal">
                    <div className="flex flex-wrap gap-1">
                      {year.quarters.map((quarter) => (
                        <Badge key={quarter} variant="outline">
                          {quarter}
                        </Badge>
                      ))}
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      </CardContent>
    </Card>
  )
}
