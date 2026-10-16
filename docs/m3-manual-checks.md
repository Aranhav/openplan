# Manual checks for the build screens and the grid (M3)

The automated suites (Vitest with jsdom, Playwright in Chromium, axe in both themes) cover what a script can see. These cases need a real input method, a finger, the browser's own permission prompt, a window that is resized by hand, or a screen reader, so they are checked by a person before a release that changes the grid, the formula editor or the toolbar.

Set up once. Run the app (`docker compose up --build`, or `cargo run -p openplan-server -- serve` with `pnpm --dir web build` done) and sign in as a builder or admin. Make a model with a list `Regions` (items `North America`, `Europe`), a module `Revenue Plan` with the dimensions Regions, Time (Month) and Versions, and the line items `Units`, `Price` and `Revenue` (`Units * Price`). Add a line item `Label` whose format type is Text, for the composition cases. Open the module on its Grid tab.

Write down the browser, its version and the operating system next to each result.

## 1. Safari: IME composition in grid cells and the formula editor

Why by hand: no script produces the events of a real input method. Safari ends a composition before the `keydown` of the key that confirms it, which then reports `isComposing: false` and key code 229; the grid and the editor have to treat that key as part of the composition.

Needs: Safari on macOS, with a Japanese (Hiragana) or Chinese (Pinyin) input source added in System Settings → Keyboard → Input Sources.

### 1a. A text cell in the grid

1. Switch to the Japanese Hiragana input source.
2. Double-click a cell of `Label` (or select it and press F2) to open the editor, and type `nihon`. `にほん` shows underlined while it is composed.
3. Press Return once. Expected: the composition is accepted (`にほん` no longer underlined), the editor is still open and the grid has not moved to the cell below.
4. Press Return again. Expected: the cell shows `にほん`, and the selection moves down one row.
5. Open the editor again with F2, type `nihon`, and press Escape while it is underlined. Expected: the composition is cancelled, and the editor stays open with the text it had; a second Escape closes the editor and keeps the value from step 4.
6. Compose `nihon` in the editor and press the arrow keys to choose another candidate. Expected: the arrow keys move within the candidates and do not save the cell or move the selection.

### 1b. The formula bar and the settings of a line item

1. Click a cell of `Revenue`, click into the formula in the bar, and select all.
2. With Hiragana active, type `nihon`. Expected: the text is underlined, and the editor keeps the focus while it is composed.
3. Press Return. Expected: the first Return only accepts the composition; the formula is not saved. The Save button and the Blueprint row are unchanged.
4. Press Escape. Expected: the edit is given up as for any formula (the bar returns to `Units * Price`), and no error toast shows.
5. Repeat in the formula of the settings sheet (Blueprint → double-click a row). Expected: the same, and Escape while composing does not close the sheet.

## 2. Touch: long-press on grid cells

Why by hand: a long press makes the browser's `contextmenu` event, which Chromium's device emulation does not send for a touch the way iOS Safari and Chrome on Android do.

Needs: a phone or tablet (iOS Safari, Chrome on Android), with the grid at its normal size.

1. Tap a cell. Expected: the cell is selected and no menu opens.
2. Press and hold the cell for about a second without moving. Expected: the cell menu opens next to the finger (Copy, Paste, Clear, Fill down and the like), and the cell stays selected.
3. Choose Copy, then long-press another cell and choose Paste. Expected: the value arrives, and the grid shows it without a reload.
4. Long-press a column header and a row header. Expected: the header's menu opens when it has items (collapse, widths), and the browser's own menu does not open instead.
5. Long-press a cell of a calculated line item, such as `Revenue`. Expected: the menu opens, with Paste disabled.
6. Drag a finger across the cells. Expected: the page scrolls or the range grows, and the grid is not left stuck in a selection: a tap afterwards selects a single cell.

## 3. The browser's permission prompt for Paste in the cell menu

Why by hand: the Paste item of the context menu reads the clipboard through `navigator.clipboard.readText()`, which asks for permission and can refuse. The keyboard shortcut does not go through it. Playwright grants the permission up front, so the prompt itself is never seen.

Needs: Chrome (permission shows as a prompt on first use) and Safari (a small "Paste" bubble appears under the pointer). Reset the site's clipboard permission first (Chrome: the icon left of the address, Site settings, Clipboard, Reset).

1. Copy `1<Tab>2<Tab>3` from a spreadsheet or a text editor (`Tab` between the numbers).
2. Right-click a cell of `Units`, and choose Paste.
3. Expected: the browser asks to see the clipboard. Allow it. The three numbers arrive in three cells to the right.
4. Repeat, and Block (Chrome) or dismiss the bubble (Safari). Expected: nothing is pasted, and a toast says "Your browser blocked reading the clipboard. Press Ctrl+V instead." (⌘V on a Mac). Press the shortcut; the paste works.
5. Choose Copy from the menu on a selection, with the permission blocked. Expected: the toast "Your browser blocked copying. Press Ctrl+C instead.".

## 4. Resizing the window across 768 px with the More menu open

Why by hand: the toolbar measures its row and moves four controls into a More menu below the width where they fit. A real drag of the window edge sends many resize events while the menu is open; the test suite sets the size in one step.

Needs: a desktop browser whose window can be dragged to narrower and wider, with no other window in the way.

1. Make the window about 1000 px wide. Expected: the row shows Pivot, the page selectors, Filter, Show/hide, the summaries toggle, Conditional formatting and the saved views; no More button.
2. Drag the window narrower until the filter, show/hide, summaries and formatting controls disappear and a More button (three dots) takes their place. Expected: this happens at one width, without the controls flickering in and out while the edge moves.
3. Open the More menu, and drag the window slowly to under 768 px and back to over it. Expected: the menu stays open or closes cleanly (no orphan menu left on screen), nothing in the row is cut off, overlaps another control, or makes the page scroll sideways, and the focus is on the More button or on the page, not lost.
4. With the window at 700 px open the More menu, choose Filter, and resize back to over 1000 px. Expected: the panel stays open and attached to the Filter button, which is back in the row.
5. Go down to about 400 px. Expected: the row wraps onto more lines instead of clipping, and the page does not scroll sideways.

## 5. Screen reader: the live indicator and the formula problem count

Why by hand: a script can read the text of a live region, but not that a screen reader says it, once, at the right moment.

Needs: VoiceOver (macOS, Safari) and NVDA with Firefox or Chrome (Windows). Check each.

### 5a. The live indicator

The mark beside "Module settings" has the name "Live updates on" when the page is connected.

1. Open a module and let it connect. Expected: nothing is announced at first, and not at the moment it connects. Move to the mark with the virtual cursor: it is read as an image, "Live updates on".
2. Stop the server (or turn the network off in the browser's developer tools). Expected: "Reconnecting…" is announced once, within a few seconds, and the mark changes to the arrows.
3. After the server has been gone for a while (about a minute) Expected: "Live updates off" is announced once.
4. Start the server again and reload. Expected: still silent when the connection is first made.
5. Break and restore the connection once more while the page stays open. Expected: "Reconnecting…" when it breaks, and "Live updates on" when it is back, each once.

### 5b. The formula problem count

1. Click into the formula bar of a calculated line item, select all, and type `Units * Prce` slowly, then stop typing.
2. Expected: about a third of a second after the last key, the reader says "Checked: 1 problem found." once. It does not repeat while the text stays the same, and does not interrupt the typing.
3. Press F8 (or Ctrl+Shift+M) to go to the problem. Expected: the reader reads the message, "Unknown name 'Prce'" and the suggestion "Did you mean 'Price'?", and the focus is in the formula.
4. Fix the name to `Price`. Expected: "Checked: no problems found." is announced.
5. Type a second problem (`Units * Prce + Nothing`). Expected: "Checked: 2 problems found.".
6. Press Save with a formula the server refuses. Expected: the list of problems under the formula is announced as an alert, once, and the focus returns to the formula.
