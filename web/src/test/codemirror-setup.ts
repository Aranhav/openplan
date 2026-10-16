// jsdom has no layout, and CodeMirror measures text through the rectangles of ranges.
const noRects = {
  length: 0,
  item: () => null,
  [Symbol.iterator]: function* () {},
} as unknown as DOMRectList

Range.prototype.getClientRects = () => noRects
Range.prototype.getBoundingClientRect = () => new DOMRect()
