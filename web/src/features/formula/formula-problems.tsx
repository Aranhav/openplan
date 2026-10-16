import { CircleAlert } from "lucide-react"
import type { FormulaProblem } from "@/lib/api/client"
import { problemMessage } from "./lint"
import { formulaSpan } from "./offsets"

interface FormulaProblemsProps {
  id?: string
  problems: FormulaProblem[]
  /** The formula the problems are about, to show the part each is about. */
  formula: string
  /** The problems are the server's answer to a save just now, which is announced as it comes. */
  announce?: boolean
}

/** What is wrong with a formula, one problem to a line, with the part of the formula each is about. */
export function FormulaProblems({ id, problems, formula, announce }: FormulaProblemsProps) {
  return (
    <div
      id={id}
      role={announce ? "alert" : undefined}
      className="flex flex-col gap-2 text-sm text-destructive"
    >
      <p className="font-medium">
        {problems.length === 1
          ? "The formula has a problem."
          : `The formula has ${problems.length} problems.`}
      </p>
      <ul className="flex flex-col gap-2">
        {problems.map((problem, index) => {
          const span = formulaSpan(formula, problem.start, problem.end)
          return (
            <li key={index} className="flex items-start gap-2">
              <CircleAlert className="mt-0.5 size-4 shrink-0" aria-hidden />
              <span className="min-w-0 break-words">
                {problemMessage(problem)}
                {span && !problem.message.includes(span) && (
                  <>
                    {" "}
                    <code className="rounded-sm bg-destructive/10 px-1 py-0.5 font-mono text-xs">
                      {span}
                    </code>
                  </>
                )}
              </span>
            </li>
          )
        })}
      </ul>
    </div>
  )
}
