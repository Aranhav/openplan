/**
 * For a sheet that opens on a form: puts the focus in its first field without selecting the text
 * in it, which Radix does otherwise, so that the first key typed does not replace the name. A sheet
 * with no field to type in (nothing can be changed) keeps the focus on itself.
 */
export function focusFirstField(event: Event) {
  event.preventDefault()
  const sheet = event.target as HTMLElement
  const field = sheet.querySelector<HTMLElement>("input:not(:disabled), textarea:not(:disabled)")
  ;(field ?? sheet).focus()
}
