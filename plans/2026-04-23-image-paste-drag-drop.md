# Context

Goal: make it easy to include images in magenta messages by either dragging a file into the input buffer, or copy-pasting an image from the system clipboard. In both cases we want the input buffer to contain an `@file:` reference to a file on disk so the existing context-manager pipeline picks up and attaches the file.

Two user actions to support:

1. **Drag-and-drop** a file (e.g. a macOS screenshot whose temporary path contains spaces) into the magenta input window. Terminals deliver this as a bracketed paste of an escaped file path, which Neovim routes through `vim.paste()`. We need to detect that the pasted content is a path to an existing file and replace it with an `@file:` reference.

2. **Clipboard image paste** (Cmd+V / Ctrl+V while the clipboard contains an image). The terminal does not expose image data to Neovim, so the pasted text is empty or junk. We intercept the paste keybinding in the input buffer, probe the OS clipboard for image data with a platform-specific shell command, write it to a tmp file, and insert an `@file:` reference.

## `@file:` syntax extension

Today the pattern is `/@file:(\S+)/g` (defined in `node/chat/commands/file.ts`). Paths with spaces cannot be expressed. We extend the grammar to support backtick-fenced paths, with fences of length **1 or 2** only. Rules:

- **Length-1 fence** `` `...` ``: raw body, must contain no backticks at all.
- **Length-2 fence** `` ``...`` ``: escape-processed body. `\\` means literal backslash, `` \` `` means literal backtick, any other `\x` is literal `\` + `x`. Runs of 2+ consecutive backticks in the path are expressed by escaping each backtick as `\``.

Writer picks the shortest form that works: bare → length-1 → length-2 (with escaping only if needed).

- `@file:path/without/spaces.txt` — unchanged, matches `\S+`.
- `` @file:`path with spaces.txt` `` — length-1 fence (body has no backticks).
- `` @file:``foo`bar.txt`` `` — length-2 fence; body has an isolated backtick (no escape needed since run length is 1).
- `` @file:``foo\`\`bar.txt`` `` — length-2 fence; path on disk is `` foo``bar.txt `` (two consecutive backticks escaped).
- `` @file:``C:\\path\`with\`ticks`` `` — length-2 fence; `\\` → `\`, `\`` → `` ` ``.
- Triple backticks and up work similarly, picking the smallest N such that N backticks don't appear inside the body

Regex draft: ``/@file:(?:(``|`)((?:\\.|[^`\\])*?)\1|(\S+))/g`` — the inner body accepts either `\\.` (any escape pair) or a non-backtick / non-backslash char. Non-greedy to prefer the shortest close.

Capture groups: group 1 = fence (one or two backticks), group 2 = body (apply escape processing when `group1.length === 2`, verbatim when `group1.length === 1`), group 3 = bare path.

## Relevant files

- `node/chat/commands/file.ts` — defines the `@file:` command, regex, and execute(). Must be updated to use the new pattern and unescape quoted paths.
- `node/chat/commands/registry.ts` — `processMessage()` runs each command's regex. No change required, but verify the new pattern still works under the global-flag loop.
- `node/core/src/utils/files.ts` — `resolveFilePath`, `detectFileType`, `FileCategory`. Already supports image files end-to-end, so no change required for image plumbing.
- `node/core/src/context/context-manager.ts` — `addFileContext()` accepts any detected file type, including IMAGE; already base64-encodes images and attaches them. No change required.
- `node/buffer-manager.ts` — `createInputBuffer()` creates the input buffer and wires keymaps via `setSiderbarKeymaps()`. New step: also wire up a buffer-scoped `vim.paste` hook and the clipboard-paste keymap.
- `node/nvim/buffer.ts` — `setSiderbarKeymaps()` bridges to lua. New sibling method `setupPasteHandlers(bufnr)` that calls a new lua function.
- `lua/magenta/keymaps.lua` — sidebar keymap setup. New function `set_paste_handlers(bufnr)` that installs the paste-wrapping and clipboard-paste binding.
- `lua/magenta/init.lua` — RPC notifier definitions. We add a `magentaClipboardImagePaste` notification (optional; depending on where we decide to do the clipboard probe).
- `lua/magenta/completion/file_files.lua` — completion source for `@file:`. Update the trigger pattern so completion still works when inside backticks.
- `node/magenta.ts` — RPC handler registration. Wire up any new notification.

## Platform probes for clipboard image

| Platform | Probe command | Save command |
| --- | --- | --- |
| macOS | `osascript -e 'clipboard info' | grep -q «class PNGf»` (or try `pngpaste -b`) | `osascript -e 'set f to open for access POSIX file "<path>" with write permission' ...` or `pngpaste <path>` if installed |
| Linux (Wayland) | `wl-paste --list-types | grep -q image/png` | `wl-paste --type image/png > <path>` |
| Linux (X11) | `xclip -selection clipboard -t TARGETS -o | grep -q image/png` | `xclip -selection clipboard -t image/png -o > <path>` |
| Windows | PowerShell `Get-Clipboard -Format Image` | PS `[System.Windows.Forms.Clipboard]::GetImage().Save(...)` |

We'll implement macOS first (the platform the user is on) and structure the code so Linux/Windows can be added later. Prefer a pure-`osascript` approach so no extra binary is required; fall back to `pngpaste` if present.

## Tmp file location

Use `path.join(os.tmpdir(), `magenta-paste-${Date.now()}.png`)` on the node side. Node has better tmp-file handling than lua; we keep the probing logic on the node side and only the keymap trigger in lua.

# Implementation

- [ ] Extend the `@file:` regex and resolver to accept backtick-fenced paths (length 1 or 2).
  - Update `fileCommand.pattern` in `node/chat/commands/file.ts` to the new alternation regex.
  - In `fileCommand.execute()`:
    - If group 2 is defined and group 1 is `` ` `` (length-1 fence), use group 2 verbatim as the path.
    - If group 2 is defined and group 1 is `` `` `` (length-2 fence), apply unescape: walk the string; `\\` → `\`, `` \` `` → `` ` ``, any other `\x` → `\x` literal.
    - Otherwise use group 3 (bare path).
  - Factor the unescape into a helper `unescapeFenceBody(body: string): string` alongside the command.
  - Verify `CommandRegistry.processMessage` iterates correctly with alternation + backreference regex under the global-flag loop.
  - Testing
    - Behavior: `@file:foo` still resolves to path `foo`.
    - Behavior: `` @file:`foo bar.txt` `` resolves to `foo bar.txt`.
    - Behavior: `` @file:``foo`bar.txt`` `` resolves to `` foo`bar.txt `` (isolated backtick, no escape in body).
    - Behavior: `` @file:``foo\`\`bar.txt`` `` resolves to `` foo``bar.txt `` (escape applied).
    - Behavior: `` @file:``C:\\path`` `` resolves to `C:\path`.
    - Setup: unit test over `fileCommand.pattern.exec()` and `unescapeFenceBody`.
    - Actions: run regex.exec(text) and dispatch by fence length.
    - Expected: recovered path matches expected literal.
    - Assertions: string equality on the resolved path.

- [ ] Add a formatter for producing `@file:` references.
  - New helper in `node/core/src/utils/files.ts` (or `at-file-ref.ts`): `formatFileRef(path: string): string`.
  - Decision tree:
    1. If path has no whitespace and no backticks → `@file:<path>`.
    2. Else if path has no backticks → `` @file:`<path>` `` (length-1 fence).
    3. Else if path contains no run of 2+ consecutive backticks → `` @file:``<path>`` `` (length-2 fence, body verbatim).
    4. Else → `` @file:``<escaped>`` `` where `escaped` is produced by replacing every `\` with `\\` and every `` ` `` with `\``.
  - Testing
    - Behavior: round-trips against the parser for each branch of the decision tree.
    - Setup: table of paths: plain, spaces, single embedded backtick, double embedded backtick run, triple run, backslash, mixed.
    - Actions: `formatFileRef(p)` then feed through the command regex + `unescapeFenceBody` and compare.
    - Expected: recovered path equals original.
    - Assertions: string equality.

- [ ] Update the `@file:` completion lua source to understand quoted context.
  - In `lua/magenta/completion/file_files.lua`, adjust the trigger regex so it fires both for `@file:<word>` and for ``@file:`<partial>`` (unterminated backtick).
  - When the chosen completion contains whitespace, insert with backticks + escape; otherwise insert bare.
  - Testing: manual smoke test (no automated coverage for lua-side completion today).

- [ ] Implement a clipboard image probe + save on the node side.
  - New file `node/core/src/utils/clipboard-image.ts` with:
    - `type ClipboardProbeResult = { kind: "image"; tmpPath: string } | { kind: "none" }`
    - `probeAndSaveClipboardImage(nvim): Promise<ClipboardProbeResult>`
    - Dispatches by `process.platform`. Start with `darwin` implementation using `osascript`:
      - Probe: `osascript -e 'clipboard info'` → check output for ``«class PNGf»``.
      - Save: an AppleScript that writes `(the clipboard as «class PNGf»)` to `POSIX file`.
    - `linux` / `win32`: return `{ kind: "none" }` with a TODO + logger warning, to be filled in later.
  - Testing
    - Behavior: on darwin with a PNG in the clipboard the function returns a path to a file that exists and is an image.
    - Setup: unit test with a mocked child-process exec returning canned output; assert the save command is invoked and the returned path is reported. Real end-to-end would require OS clipboard manipulation, so we keep that out of automated tests.
    - Assertions: saved file exists, detectFileType reports IMAGE.

- [ ] Wrap `vim.paste` for the input buffer to detect drag-dropped file paths.
  - Drag-drop on macOS (and most terminals) delivers the path with shell-style escaping — backslashes before spaces, quotes, `$`, `` ` ``, `!`, `\\`, etc. We must **unshell-escape** first to get the real on-disk path, then **re-wrap** that path with our backtick-fence format for insertion into the buffer.
  - In `lua/magenta/keymaps.lua` add `M.set_paste_handlers(bufnr, channelId)`.
  - Save the original `vim.paste` once (module-scoped). Reinstall a wrapper that:
    - If `vim.api.nvim_get_current_buf() ~= bufnr` → delegate to original.
    - Join `lines` with `\n` and trim surrounding whitespace.
    - Strip a single pair of surrounding single/double quotes if present (some terminals wrap the dropped path).
    - Apply shell unescape: replace `\\<char>` with `<char>` for any char (so `\\ ` → space, `\\\\` → `\\`, `` \\` `` → `` ` ``, etc.). This is a simple one-pass state machine, not a full shell parser.
    - `vim.uv.fs_stat(path)` on the unescaped path; if it exists and is a regular file → re-format via `formatFileRef(path)` (from the earlier step) so the buffer contains a well-formed `@file:` fence, and invoke `original_paste({ formatted }, phase)` and return its result.
    - Otherwise delegate to original with the unmodified lines.
  - Ensure the wrapper is only installed once (guard with a module-level flag keyed by bufnr).
  - Cleanup: when the input buffer is wiped, remove the bufnr from the guard map. Use a `BufWipeout` autocmd scoped to the buffer.
  - Because multiple input buffers exist (per-thread), store the set of registered input bufnrs and match inside the shared wrapper.
  - Testing
    - Behavior: `vim.paste({ "/tmp/test.png" }, -1)` in the input buffer inserts `@file:/tmp/test.png` when the file exists.
    - Behavior: `vim.paste({ [[/tmp/Screenshot\ at\ 10.png]] }, -1)` — the path on disk is `/tmp/Screenshot at 10.png`; the buffer should end up with `` @file:`/tmp/Screenshot at 10.png` `` (bare path now has spaces so the formatter fences it).
    - Behavior: path containing a literal backtick (rare, but robust) round-trips through shell-unescape + formatFileRef.
    - Setup: integration test via `withDriver()` with `setupFiles` creating a real file at the test path (including one with spaces). Drag-drop cannot be simulated at the pointing-device level, but it enters Neovim via the exact same channel as bracketed paste — the terminal inserts the escaped path into a bracketed-paste sequence, which Neovim routes through `nvim_paste()` → `vim.paste()`. So the fidelity test is to call `nvim.call("nvim_paste", [escapedPath, false, -1])` directly with a shell-escaped string, which is byte-for-byte what a real drag-drop delivers.
    - Actions: trigger paste via `nvim_paste`.
    - Expected: input buffer content equals the `@file:` reference; running the command registry over that buffer text resolves back to the real path.
    - Assertions: read buffer lines, and verify parser recovery.
    - Additional case: non-existent path → original paste text remains untouched.

- [ ] Add a buffer-local clipboard-image paste keymap.
  - In `M.set_paste_handlers(bufnr)`, register insert-mode and normal-mode mappings on the default paste keys (`<C-v>` in insert, `p`/`P` in normal). Keys should be configurable via `Options.options.sidebarKeymaps` eventually; for v1 hardcode `<D-v>` (macOS) and `<C-v>` in insert mode only to avoid stomping on vim's `p`.
  - The mapping calls `safe_rpcnotify(channelId, "magentaClipboardImagePaste", { bufnr })`.
  - In `node/magenta.ts` add an RPC handler that:
    - Invokes `probeAndSaveClipboardImage()`.
    - On `kind: "image"`: inserts `formatFileRef(tmpPath)` at the cursor position in the buffer (use `nvim_paste` so dot-repeat works).
    - On `kind: "none"`: calls `vim.paste` with the text clipboard content (i.e. the normal paste behavior). Simplest is to execute `normal! "+p` / insert-mode equivalent via `nvim_put` from lua; consider returning an enum and letting lua perform the fallback so we don't round-trip the text twice.
  - Prefer splitting responsibilities: lua probes first (via `vim.system` on darwin) and only rpc-notifies on confirmed image. Rationale: avoids blocking on a round-trip for every normal paste. If the probe reports image: rpc-notify to node, which saves the file and returns the path; lua then inserts the `@file:` reference. If not: fall through to the default paste.
  - Testing
    - Behavior: pressing the bound key when the clipboard holds an image inserts an `@file:` reference to a tmp file.
    - Setup: hard to automate (requires OS clipboard). Instead unit-test the node-side handler: call it with a mocked clipboard-image utility that returns a canned tmp path; assert the buffer gets the expected `@file:` text.
    - Actions: dispatch the RPC notification.
    - Expected: buffer text contains `@file:<tmpPath>`.
    - Assertions: buffer-lines equality.
    - Manual end-to-end verification on macOS.

- [ ] Wire new keymap setup into `createInputBuffer`.
  - In `node/nvim/buffer.ts` add `setupPasteHandlers()` that calls `require('magenta.keymaps').set_paste_handlers(<bufnr>, <channelId>)`.
  - Call it in `node/buffer-manager.ts` `createInputBuffer()` right after `setSiderbarKeymaps()`.
  - Testing: covered by the integration tests above; additionally verify the wrapper is uninstalled after `BufWipeout` by creating and deleting a thread and pasting a known path in another buffer.

- [ ] Documentation and UX
  - Update `doc/magenta-commands-keymaps.txt` with the new bindings.
  - Update the README section on `@file:` syntax to mention backtick quoting.
  - Note the drag-drop behavior in the README usage section.

# Open questions

- Do we want to auto-delete the tmp file after the message is submitted, or leave it for the user? Leaving it is simpler and means the `@file:` reference stays valid if the user resubmits.
- Should `@file:` quoted form also allow double-quotes? Keeping it to backticks only for v1 — simpler grammar and avoids clashing with shell-style quoting in prose.
- Windows / Wayland / X11 support: deferred; probe function returns `{ kind: "none" }` so normal paste still works.
