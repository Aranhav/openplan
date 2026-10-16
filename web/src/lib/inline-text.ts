/** The attribute that marks the input of an `InlineText` while its text is being edited. */
export const INLINE_TEXT_ATTRIBUTE = "data-inline-text"

/**
 * Whether a key event comes from the input of an `InlineText`. A dialog or sheet that holds one
 * hands Escape to the input first: Radix listens for it on the document before the input does, so
 * only the layer can let it through. Give the layer `onEscapeKeyDown` and prevent the default when
 * this is true; the first Escape then ends the edit and the second closes the layer.
 */
export function isEditingInlineText(target: EventTarget | null) {
  return target instanceof Element && target.closest(`[${INLINE_TEXT_ATTRIBUTE}]`) !== null
}
