# context

The goal: in the magenta display buffer, pressing `<CR>` on a file path
(absolute or relative) or a URL should open the target.

- File paths open in a new buffer in a non-magenta window.
- URLs open via the system `open` command (use neovim's built-in
  `vim.ui.open`, which on macOS invokes `open`).
- Existing `withBindings` handlers for `<CR>` must take precedence —
  this is only a fallback when the cursor is not on a bound region.

## Relevant files and entities

- `node/tea/tea.ts` — `createApp` / `onKey`. The display buffer's `<CR>`
  keypress is dispatched here via `listenToBufKey`. When
  `getBindings(...)[key]` returns undefined, nothing currently happens.
  This is where we add the fallback hook.
- `node/tea/bindings.ts` — declares `BINDING_KEYS` (includes `<CR>`).
- `node/magenta.ts` — wires `TEA.createApp` for each thread/overview.
  The `Magenta` class owns `cwd`, `homeDir`, `options`, `sidebar`, and
  is the natural owner of the fallback handler.
- `node/nvim/openFileInNonMagentaWindow.ts` — already provides
  `openFileInNonMagentaWindow`. We reuse it directly for file paths.
- `node/utils/files.ts` — `resolveFilePath`, `UnresolvedFilePath`,
  `AbsFilePath` types.
- `node/sidebar.ts` — creates display window, sets `magenta_display_window`
  var. Used for disambiguation in `findOrCreateNonMagentaWindow`.
- `node/test/driver.ts` — `triggerDisplayBufferKey` helper for firing
  `<CR>` in tests at a specific cursor position.

## Key types

```ts
// New on tea createApp props:
type UnhandledKeyHandler = (args: {
  key: BindingKey;
  buffer: NvimBuffer;
  row: Row0Indexed;
  col: number;
}) => void | Promise<void>;
```

## Detection strategy (TS side)

When the fallback fires for `<CR>`:

The cursor line is read once via `nvim_buf_get_lines` and the
cursor column is known. We then try the following in order:

1. **Markdown link** — scan the line for
   `/\[([^\]]*)\]\(([^)\s]+)\)/g`. If the cursor column falls inside
   any match's `[start, end)` span, take capture group 2 (the URL /
   path). Classify it:
   - If it matches `/^(https?|ftp|file|ssh):\/\//` →
     `openUrl(target, nvim)`.
   - Else treat as a path: `resolveFilePath(cwd, target, homeDir)` +
     `fs.stat`; if it's a regular file, call
     `openFileInNonMagentaWindow(target, ctx)`.
   - Else no-op.

   This makes `<CR>` work anywhere inside `[label](target)` — on
   the label, the parens, or the target.

2. **Plain URL via `<cWORD>`** — otherwise grab `<cWORD>` (whitespace-
   delimited; `<cWORD>` is used because default Unix `'isfname'`
   excludes `:`, so `<cfile>` can't hold a full URL). Strip trailing
   `,.;:!?)]>}`. If it matches the URL regex → `openUrl(token, nvim)`.

3. **File via `<cfile>`** — otherwise grab `<cfile>` via
   `nvim_buf_call` scoped to the display buffer. `<cfile>` honors
   `'isfname'`, collapses `\ ` to a space, strips trailing
   `.,:;!`, and expands `~`/`$VAR`. Then
   `resolveFilePath(cwd, token, homeDir)` + `fs.stat`; if it's a
   regular file, call `openFileInNonMagentaWindow(token, ctx)`.

4. **Else** → no-op.

This avoids regex-based "looks like a path" heuristics. Markdown
links are handled explicitly; plain URLs use `<cWORD>`; files use
nvim's `<cfile>`. All candidates are validated (URL scheme regex or
filesystem stat) before we act.

# implementation

- [ ] add an optional `onUnhandledKey` prop to `createApp` in
      `node/tea/tea.ts`
  - in the `onKey` handler, if `bindings?.[key]` is falsy, and
      `onUnhandledKey` was provided, call it with
      `{ key, buffer: mount.buffer, row, col }`.
  - unit-test in `node/tea/update.test.ts` (or a new sibling test):
    - Behavior: `onUnhandledKey` fires for `<CR>` when no binding
      covers the cursor position, and is NOT called when a binding
      exists at the cursor.
    - Setup: mount a simple view containing a mix of
      `withBindings(d`[btn]`, { "<CR>": spy })` and plain text.
    - Actions: call the tea app's `onKey("<CR>")` with the cursor
      first on the button, then on the plain text.
    - Expected output: `spy` called once; `onUnhandledKey` called
      once with the expected `row`/`col`.
    - Assertions: verify both spy call counts and the args passed
      to `onUnhandledKey`.

- [ ] add `node/nvim/openUrl.ts` exporting
      `openUrl(url: string, nvim: Nvim): Promise<void>`
  - implemented as `nvim.call("nvim_exec_lua", ["vim.ui.open(...)", [url]])`.
  - no dedicated unit test — covered by the integration test below.

- [ ] add `node/nvim/cursorToken.ts` exporting
      `getTokenAtCursor(nvim, window): Promise<string>`
  - executes lua that calls `vim.fn.expand("<cfile>")` scoped to the
    given window so it resolves against the magenta display buffer.
    Fall back to `<cWORD>` if `<cfile>` is empty.
  - unit test in `node/nvim/cursorToken.test.ts`:
    - Behavior: returns the correct target under the cursor for
      absolute paths, relative paths, plain URLs, and markdown
      links — and for markdown links the cursor can be on the
      label, either bracket/paren, or the target itself.
    - Setup: open a scratch buffer with a single line containing
      mixed content (e.g. `see /tmp/x.txt and https://example.com`).
    - Actions: set cursor col to within each token and call helper.
    - Expected output: returns `/tmp/x.txt` or `https://example.com`.
    - Assertions: `expect(token).toBe(...)` for each case.

- [ ] add `node/open-target-under-cursor.ts` exporting
      `openTargetUnderCursor(ctx)` where `ctx` has
      `{ nvim, cwd, homeDir, options }`.
  - steps:
    1. `getTokenAtCursor` for the active (display) window.
    2. If token matches URL regex → `openUrl(token, nvim)`.
    3. Else resolve file path via `resolveFilePath`; stat the file;
       if it is a regular file, call `openFileInNonMagentaWindow`.
    4. Otherwise log debug and no-op.
  - unit tests in `node/open-target-under-cursor.test.ts`:
    - Behavior: routes URLs to `openUrl`, file paths to
      `openFileInNonMagentaWindow`, and ignores non-existent paths.
    - Setup: stub `openUrl` and `openFileInNonMagentaWindow`;
      create a real fixture file in cwd for the path case.
    - Actions: invoke with cursor positioned on a URL, a valid
      relative path, an invalid token.
    - Expected output: the appropriate stub is called (or neither).
    - Assertions: spy call counts + arguments.

- [ ] wire the fallback into both display-buffer tea apps in
      `node/magenta.ts` (`setAppFactories` block)
  - pass `onUnhandledKey: async ({ key }) => { if (key === "<CR>")
      await openTargetUnderCursor({ nvim, cwd, homeDir, options }); }`
      to both `TEA.createApp` calls.
  - integration test in `node/chat/display-open-target.test.ts`:
    - Behavior: with the display buffer visible, pressing `<CR>` on
      a file path opens it in a non-magenta window; pressing `<CR>`
      on a URL invokes `vim.ui.open`.
    - Setup: `withDriver({ setupFiles })` creating `target.txt`;
      replace `vim.ui.open` with a lua spy that records calls via
      `vim.g.magenta_test_ui_open`.
      Send a mock assistant message whose text renders as plain
      display content containing `./target.txt` and
      `https://example.com`.
    - Actions:
      - `driver.triggerDisplayBufferKeyOnContent("./target.txt", "<CR>")`.
      - `driver.triggerDisplayBufferKeyOnContent("https://example.com", "<CR>")`.
    - Expected output:
      - after first action a non-magenta window exists whose buffer
        name ends with `target.txt`.
      - after second action `vim.g.magenta_test_ui_open` equals the
        url.
    - Assertions:
      - `expect(await findNonMagentaBufferName(driver)).toMatch(/target\.txt$/)`
      - `expect(await driver.nvim.call("nvim_get_var", ["magenta_test_ui_open"])).toBe("https://example.com")`.

- [ ] regression: existing `<CR>` bindings still work
  - add a case to the integration test that positions the cursor on
      an existing interactive region (e.g. the parent-thread link in
      `chat.ts` / `thread-view.ts`) and confirms the bound action
      fires — not `openTargetUnderCursor`.
    - Behavior: `<CR>` on a region covered by `withBindings` runs
      the bound handler only.
    - Setup: same driver; navigate to a view with a known
      `withBindings` `<CR>` (e.g. a thread header toggle).
    - Actions: `triggerDisplayBufferKeyOnContent` on that region.
    - Expected output: bound handler fires; no file/url open is
      attempted.
    - Assertions: no `vim.g.magenta_test_ui_open` set; no new
      non-magenta window opened; the bound side effect is observed.

- [ ] run `npx tsgo -b` and `npx biome check .`; iterate until clean.
- [ ] run `TEST_MODE=sandbox npx vitest run` via
      `tests-in-sandbox` subagent; iterate until green.
