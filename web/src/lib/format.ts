const SECOND = 1000
const MINUTE = 60 * SECOND
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

// Largest first, so the first unit a gap reaches is the one to count in.
const UNITS: [Intl.RelativeTimeFormatUnit, number][] = [
  ["year", 365 * DAY],
  ["month", 30 * DAY],
  ["week", 7 * DAY],
  ["day", DAY],
  ["hour", HOUR],
  ["minute", MINUTE],
]

const formatter = new Intl.RelativeTimeFormat("en", { numeric: "auto" })

/** How long ago an RFC 3339 timestamp was, in words: "just now", "2 hours ago", "yesterday". */
export function relativeTime(iso: string, now: Date = new Date()): string {
  const gap = new Date(iso).getTime() - now.getTime()
  if (Number.isNaN(gap)) {
    return "at an unknown time"
  }
  // Within a minute either way, which also covers a server clock a little ahead of ours.
  if (Math.abs(gap) < MINUTE) {
    return "just now"
  }
  const [unit, size] = UNITS.find(([, size]) => Math.abs(gap) >= size)!
  return formatter.format(Math.trunc(gap / size), unit)
}
