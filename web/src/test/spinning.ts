/** Whether a button shows the spinner that says its request is running. */
export function spinning(element: HTMLElement): boolean {
  return element.querySelector("svg.animate-spin") !== null
}
