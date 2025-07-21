# Completion Support Plan

## Context

The goal is to implement nvim-cmp completion support specifically for the magenta input buffer with custom completion patterns:

- `@file:<file path>` - complete to any non-secret file path in cwd
- `@diff:<file path>` - complete to files with unstaged diffs
- `@staged:<file path>` - complete to files with staged diffs
- `@qf/@diag/@buf/@buffers/@quickfix/@diagnostics/@compact` - keyword completions

This integrates with the existing magenta.nvim architecture where:

- The `Sidebar` class in `node/sidebar.ts` manages input and display buffers
- The input buffer is created with specific buffer options and keymaps in `setSiderbarKeymaps()`
- Lua-side options are managed in `lua/magenta/options.lua` with buffer-specific keymap configurations
- The node.js side communicates with Lua via RPC notifications through the bridge established in `lua/magenta/init.lua`

Key architectural considerations:

- **Buffer Restriction**: Completion should only activate in magenta input buffers, identified by specific buffer variables or filetype
- **Controller Pattern**: If this needs state management, it should follow the controller/message pattern
- **Performance**: File system operations should be cached and debounced to avoid blocking the UI
- **Security**: Respect .gitignore and avoid completing sensitive paths

## Implementation

### Phase 1: Setup nvim-cmp Infrastructure

- [x] Create `lua/magenta/completion.lua` with custom completion source registration
  - [x] Implement buffer detection to ensure completion only works in magenta input buffers
  - [x] Add pattern detection for `@` triggers with different completion types
  - [x] Set up completion source registration that integrates with existing `setSiderbarKeymaps()` call

### Phase 2: Keyword Completion

- [x] Implement keyword completion for magenta-specific commands
  - [x] Define static keyword list: `qf`, `diag`, `buf`, `buffers`, `quickfix`, `diagnostics`, `compact`
  - [x] Create completion items with appropriate LSP kind (Keyword)
  - [x] Add documentation for each keyword explaining its function
  - [x] Ensure keywords only complete after standalone `@` (not `@word:`)

### Phase 3: Git Integration (`@diff:` and `@staged:`)

- [x] Create git status integration module
  - [x] Implement `git status --porcelain` parsing
  - [x] Cache git status results with reasonable TTL (5-10 seconds)
  - [x] Handle cases where git is not available or not in a git repository
- [x] Add completion items for git-tracked files
  - [x] `@diff:` completes files with unstaged changes (modified, added, deleted, untracked)
  - [x] `@staged:` completes files with staged changes
  - [x] Use appropriate LSP kinds and visual indicators for different git states

### Phase 4: FZF-Style File Path Completion (`@file:`)

**Reference Implementation**: See `lua/magenta/fzf-files.txt` for a proven fzf-powered completion source

- [x] Implement project-wide file discovery using external tools
  - [x] Create smart file discovery command selection (adapted from fzf-lua):
    - `fdfind --type f --hidden --no-ignore-vcs` if available
    - `fd --type f --hidden --no-ignore-vcs` if available
    - `rg --files --hidden --no-ignore-vcs` if available
    - `find . -type f ! -path '*/.*'` as fallback
  - [x] Execute via `vim.fn.jobstart()` for non-blocking async operation
  - [x] Generate completion items with proper LSP kind (File/Folder)
  - [x] Store relative paths for display, absolute paths in `data.path`
- [x] Implement fzf native fuzzy matching
  - [x] Use `fzf --filter` for non-interactive fuzzy matching
  - [x] Pipe file list to fzf: `files_cmd | fzf --filter='search_term'`
  - [x] Execute combined command via shell: `{"sh", "-c", combined_cmd}`
  - [x] Stream fzf's filtered results via `on_stdout` callback
  - [x] Handle empty search term (run files_cmd without fzf filter)
  - [x] Fallback to simple substring matching if fzf not available

### Phase 5: Pattern Detection and Trigger Logic

- [x] Implement robust pattern matching for completion triggers
  - [x] Use compiled regex (`vim.regex()`) for efficient `@file:` pattern detection
  - [x] Extract fuzzy search term after colon from `cursor_before_line`
  - [x] Detect `@diff:` and `@staged:` patterns with search term extraction
  - [x] Detect standalone `@` for keyword completion
  - [x] Handle cursor position and text before cursor for accurate completion
- [x] Add performance safeguards and UX improvements
  - [x] Implement timeout mechanism (500ms default) with automatic job cancellation
  - [x] Cancel previous jobs when new completion requests arrive (`self.last_job` pattern)
  - [x] Show "Searching..." immediately for user feedback
  - [x] Show "No matches found" for empty results
  - [x] Use `filterText` hack to prevent nvim-cmp's own filtering: `filterText = cursor_before_line:sub(offset)`
  - [x] Set `isIncomplete = true` to prevent caching of streaming results

## Technical Architecture Details

### Completion Source Structure

The completion source will follow nvim-cmp patterns with methods:

- `is_available()`: Check if current buffer is magenta input buffer
- `get_trigger_characters()`: Return `['@']`
- `get_keyword_pattern()`: Custom pattern to detect `@word:` sequences
- `complete(request, callback)`: Main completion logic with async job execution
- `resolve(completion_item, callback)`: Add file preview documentation (first 1KB, 20 lines max)
- `get_debug_name()`: Return 'magenta' for debugging

**Key Implementation Patterns** (from `lua/magenta/fzf-files.txt`):

- Stream results via job stdout rather than batch completion
- Use `data = { path, stat, score }` to store metadata for sorting
- Implement job cancellation and timeout handling
- Track performance metrics (timing, timeout counts) for debugging

### Buffer Identification

Magenta input buffers will be identified by:

- Buffer variable: `vim.b.magenta_input_buffer = true`
- Filetype: `markdown` (already set)
- Buffer name pattern: `[Magenta Input]`

### Caching Strategy

- File listings: Cache with directory mtime checking
- Git status: Cache with 5-second TTL
- Keyword list: Static, no caching needed
- Use weak references where possible to allow garbage collection

### Performance Optimizations

- Debounce completion requests (150ms)
- Limit completion results (100 items max)
- Async file operations where possible
- Early termination for cancelled requests
- Incremental filtering instead of full rescanning

### Integration Points

- `node/sidebar.ts`: Buffer creation and setup
- `lua/magenta/keymaps.lua`: Keymap integration
- `lua/magenta/options.lua`: Configuration management
- `lua/magenta/completion.lua`: Main completion implementation

This plan ensures completion support integrates seamlessly with magenta.nvim's existing architecture while providing performant, contextual completions for common use cases.

# nvim-cmp docs

Creating a custom source~

NOTE:

1. The `complete` method is required. Others can be omitted.
2. The `callback` function must always be called.
3. You can use only `require('cmp')` in custom source.
4. If the LSP spec was changed, nvim-cmp may implement it without any announcement (potentially introducing breaking changes).
5. You should read ./lua/cmp/types and https://microsoft.github.io/language-server-protocol/specifications/specification-current.
6. Please add your source to the list of sources in the Wiki (https://github.com/hrsh7th/nvim-cmp/wiki/List-of-sources)
   and if you publish it on GitHub, add the `nvim-cmp` topic so users can find it more easily.

Here is an example on how to create a custom source:

> lua
> local source = {}

---Return whether this source is available in the current context or not (optional).
---@return boolean
function source:is_available()
return true
end

---Return the debug name of this source (optional).
---@return string
function source:get_debug_name()
return 'debug name'
end

---Return LSP's PositionEncodingKind.
---@NOTE: If this method is omitted, the default value will be `utf-16`.
---@return lsp.PositionEncodingKind
function source:get_position_encoding_kind()
return 'utf-16'
end

---Return the keyword pattern for triggering completion (optional).
---If this is omitted, nvim-cmp will use a default keyword pattern. See |cmp-config.completion.keyword_pattern|.
---@return string
function source:get_keyword_pattern()
return [[\k\+]]
end

---Return trigger characters for triggering completion (optional).
function source:get_trigger_characters()
return { '.' }
end

---Invoke completion (required).
---@param params cmp.SourceCompletionApiParams
---@param callback fun(response: lsp.CompletionResponse|nil)
function source:complete(params, callback)
callback({
{ label = 'January' },
{ label = 'February' },
{ label = 'March' },
{ label = 'April' },
{ label = 'May' },
{ label = 'June' },
{ label = 'July' },
{ label = 'August' },
{ label = 'September' },
{ label = 'October' },
{ label = 'November' },
{ label = 'December' },
})
end

---Resolve completion item (optional). This is called right before the completion is about to be displayed.
---Useful for setting the text shown in the documentation window (`completion_item.documentation`).
---@param completion_item lsp.CompletionItem
---@param callback fun(completion_item: lsp.CompletionItem|nil)
function source:resolve(completion_item, callback)
callback(completion_item)
end

---Executed after the item was selected.
---@param completion_item lsp.CompletionItem
---@param callback fun(completion_item: lsp.CompletionItem|nil)
function source:execute(completion_item, callback)
callback(completion_item)
end

---Register your source to nvim-cmp.
require('cmp').register_source('month', source)
<
