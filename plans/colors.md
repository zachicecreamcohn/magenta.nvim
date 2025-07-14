# Color and Highlighting System

## Overview

This document outlines the plan for adding color and highlighting support to the magenta.nvim render framework. The goal is to provide a `withHighlight()` wrapper similar to `withBindings()` that allows styling text while respecting the user's colorscheme.

## Technical Background

### Extmarks - The Modern Approach

Extmarks are Neovim's modern buffer annotation system that tracks text changes and provides highlighting capabilities:

- **Range highlighting**: Use `nvim_buf_set_extmark()` to highlight text ranges by specifying start/end positions and a highlight group
- **Line-level styling**: Apply highlight groups to whole lines using `line_hl_group`
- **Sign column styling**: Display custom text in the sign column with `sign_text` and `sign_hl_group`
- **Number column styling**: Style line numbers with `number_hl_group`
- **Priority system**: Use priority values to control which highlights take precedence when overlapping
- **Multi-line support**: Extmarks fully support highlighting arbitrary-length ranges across multiple lines

### Styling Properties Available

- **Foreground/background colors**: Use `fg` (foreground) and `bg` (background) properties in highlight groups
- **Font styles**: Bold, underline, italic, and combinations like "bold,underline"
- **Terminal vs GUI**: Separate styling for `cterm` (terminal) and `gui` modes
- **URL highlighting**: Extmarks can set URL attributes to create clickable hyperlinks in supporting terminals

## Colorscheme Integration Strategy

### Use Semantic Highlight Groups

Instead of hardcoded colors, use semantic highlight groups that respect the user's colorscheme:

1. **Standard groups**: `Normal`, `String`, `Comment`, `Function`, `ErrorMsg`, `WarningMsg`, etc.
2. **Treesitter groups**: `@variable`, `@function.call`, `@keyword`, etc.
3. **LSP semantic groups**: `@lsp.type.variable`, `@lsp.type.function`, etc.

Treesitter groups have default fallbacks to standard groups when colorschemes don't define them, ensuring compatibility.

### Benefits of This Approach

- Automatically respects user's chosen colorscheme
- Works with both light and dark themes
- Leverages Neovim's background detection
- More maintainable than hardcoded colors
- Semantic meaning is preserved

# Implementation Plan

## Context

The goal is to extend the existing magenta.nvim VDOM system with highlighting capabilities that integrate seamlessly with the current render pipeline. We need to add a `withHighlight()` wrapper similar to `withBindings()` that applies Neovim extmarks for text styling while respecting user colorschemes.

The relevant files and entities are:

- `node/tea/view.ts`: Core VDOM types (`VDOMNode`, `MountedVDOM`) and the `d` template function
- `node/tea/render.ts`: Initial rendering pipeline that converts VDOM to mounted nodes
- `node/tea/update.ts`: Update pipeline that efficiently diffs and re-renders changed nodes
- `node/tea/bindings.ts`: Existing binding system that we'll mirror for highlights
- `node/nvim/buffer.ts`: Buffer interface for interacting with Neovim buffers
- `node/tea/util.ts`: Utility functions for position calculations and buffer operations

Key interfaces to extend:

- `VDOMNode` types: Need to add optional `highlights` property
- `MountedVDOM` types: Need to add optional `highlights` property and extmark IDs
- `Bindings` type: Will be mirrored for highlight groups
- `MountPoint` interface: May need buffer namespace context

## Implementation

### Phase 1: Core Type Definitions and API Design

- [ ] Define highlight types and interfaces in `node/tea/highlights.ts`

  - [ ] Create `HighlightGroup` type for semantic highlight group names (string literals for standard groups)
  - [ ] Create `ExtmarkOptions` type covering all nvim_buf_set_extmark options:
    - `hl_group`: string (highlight group name)
    - `hl_eol`: boolean (continue highlight to end of line)
    - `hl_mode`: "replace" | "combine" | "blend"
    - `priority`: number (higher = more important)
    - `line_hl_group`: string (highlight entire line)
    - `sign_text`: string (1-2 chars for sign column)
    - `sign_hl_group`: string (sign column highlight)
    - `number_hl_group`: string (line number highlight)
    - `conceal`: string (concealment character)
    - `url`: string (clickable hyperlink)
  - [ ] Create convenience types for common styling:
    - `TextStyle`: { bold?: boolean, italic?: boolean, underline?: boolean, strikethrough?: boolean }
    - `ColorStyle`: { fg?: string, bg?: string } (for custom colors when needed)
  - [ ] Create `Highlights` type that maps text ranges to highlight options
  - [ ] Create `ExtmarkId` branded type for tracking extmark IDs
  - [ ] Check for type errors and iterate until they pass

- [ ] Extend VDOM type definitions in `node/tea/view.ts`
  - [ ] Add optional `highlights?: Highlights` to `StringVDOMNode`, `ComponentVDOMNode`, and `ArrayVDOMNode`
  - [ ] Add optional `highlights?: Highlights` and `extmarkIds?: ExtmarkId[]` to corresponding `MountedVDOM` types
  - [ ] Add `withHighlight()` function that mirrors `withBindings()` pattern
  - [ ] Check for type errors and iterate until they pass

### Phase 2: Extmark Utilities

- [ ] Create extmark utilities in `node/tea/extmarks.ts`

  - [ ] Add `setExtmark()` and `deleteExtmark()` wrapper functions
  - [ ] Add `clearAllExtmarks()` function for bulk cleanup (clears entire buffer namespace)
  - [ ] Use a single well-known namespace name like "magenta-highlights"
  - [ ] Write unit tests for extmark utilities
  - [ ] Iterate until unit tests pass

### Phase 3: Render Pipeline Integration

- [ ] Extend render pipeline in `node/tea/render.ts`

  - [ ] Modify `render()` function to process highlights during tree traversal
  - [ ] Add highlight application after text content is set in buffer
  - [ ] Store extmark IDs directly in mounted nodes for later cleanup/updates
  - [ ] Add error handling for extmark creation failures
  - [ ] Check for type errors and iterate until they pass

- [ ] Add highlight processing utility functions in `node/tea/highlights.ts`
  - [ ] Implement `applyHighlights()` function that creates extmarks and returns IDs
  - [ ] Implement `clearHighlights()` function that removes extmarks by ID array
  - [ ] Add highlight inheritance logic (child highlights combine with parent highlights using `hl_mode: "combine"`)
  - [ ] Add priority calculation for overlapping highlights (children get higher priority than parents)
  - [ ] **Key principle**: Parent node extmarks are applied AFTER entire subtree renders, covering the full range the node occupies
  - [ ] Write unit tests for highlight utilities
  - [ ] Iterate until unit tests pass

### Phase 4: Update Pipeline Integration

- [ ] Extend update pipeline in `node/tea/update.ts`

  - [ ] Modify `visitNode()` function to handle highlight changes
  - [ ] Add highlight diffing to determine when extmarks need updating
  - [ ] **When child nodes update**: Recalculate parent node boundaries and update parent extmarks accordingly
  - [ ] Clear old extmarks from mounted nodes before creating new ones
  - [ ] Store new extmark IDs in mounted nodes after recreation
  - [ ] Check for type errors and iterate until they pass

- [ ] Add highlight comparison utilities in `node/tea/highlights.ts`
  - [ ] Implement `highlightsEqual()` function for efficient diffing
  - [ ] Add `updateHighlights()` function that clears old and creates new extmarks
  - [ ] Add `updateExtmarkBoundaries()` function to adjust extmark ranges when content changes
  - [ ] Handle edge cases like multi-line highlight ranges during updates
  - [ ] Write unit tests for highlight comparison and updates
  - [ ] Iterate until unit tests pass

### Phase 5: Semantic Highlight Groups and API

- [ ] Define semantic highlight groups and styling options in `node/tea/highlights.ts`

  - [ ] Create predefined semantic highlight constants:
    - `SEMANTIC_GROUPS`: `ERROR`, `WARNING`, `INFO`, `SUCCESS`, `MUTED`, `EMPHASIS`, `CODE`, `LINK`
    - Map to standard Neovim groups: `ErrorMsg`, `WarningMsg`, `Directory`, `String`, `Comment`, `Bold`, `Identifier`, `Underlined`
  - [ ] Create Treesitter highlight groups:
    - `TREESITTER_GROUPS`: `@variable`, `@function.call`, `@keyword`, `@string`, `@comment`, `@type`, `@constant`
  - [ ] Create LSP semantic token groups:
    - `LSP_GROUPS`: `@lsp.type.variable`, `@lsp.type.function`, `@lsp.type.keyword`, etc.
  - [ ] Define styling utilities:
    - `createTextStyleGroup(style: TextStyle)`: dynamically create highlight groups for bold/italic/etc
    - `createColorGroup(colors: ColorStyle)`: create custom color highlight groups
  - [ ] Add fallback chains for maximum colorscheme compatibility
  - [ ] Write unit tests for highlight group mappings and style creation
  - [ ] Iterate until unit tests pass

- [ ] Create convenience API functions in `node/tea/view.ts`
  - [ ] Add semantic convenience functions: `withError()`, `withWarning()`, `withInfo()`, `withSuccess()`, `withMuted()`, `withEmphasis()`
  - [ ] Add styling convenience functions: `withBold()`, `withItalic()`, `withUnderline()`, `withCode()`
  - [ ] Add flexible functions:
    - `withHighlight(content, options: ExtmarkOptions)` - full control
    - `withStyle(content, style: TextStyle)` - for bold/italic/etc combinations
    - `withColors(content, colors: ColorStyle)` - for custom fg/bg colors
    - `withGroup(content, group: string)` - for arbitrary highlight group names
  - [ ] Ensure all functions follow the `withBindings()` pattern and can be chained/nested
  - [ ] Check for type errors and iterate until they pass

### Phase 6: Error Handling and Cleanup

- [ ] Implement robust error handling in `node/tea/extmarks.ts`

  - [ ] Handle buffer invalidation gracefully (catch and ignore extmark errors)
  - [ ] Add retry logic for transient Neovim API failures
  - [ ] Log extmark errors at appropriate levels (warn for expected failures)
  - [ ] Ensure partial failure doesn't break entire render cycle
  - [ ] Write unit tests for error scenarios
  - [ ] Iterate until unit tests pass

- [ ] Add cleanup procedures in `node/tea/view.ts`
  - [ ] Ensure `unmount()` clears namespace (which clears all extmarks)
  - [ ] Add cleanup on buffer deletion/invalidation
  - [ ] Handle cleanup during view replacement/updates
  - [ ] Add debug mode for tracking extmark lifecycle
  - [ ] Write integration tests for cleanup scenarios
  - [ ] Iterate until integration tests pass

### Phase 7: Integration Testing and Performance

- [ ] Add highlight tests to existing test files following established patterns

  - [ ] Extend `node/tea/render.spec.ts` with highlight rendering tests:
    - [ ] Test basic highlighting with `withHighlight()`
    - [ ] Test semantic convenience functions (`withError()`, `withWarning()`, etc.)
    - [ ] Test text styling functions (`withBold()`, `withItalic()`, etc.)
    - [ ] Test highlight inheritance and combination (child + parent effects)
    - [ ] Test multi-line highlight ranges
    - [ ] Test extmark creation with correct options and priorities
    - [ ] Test error scenarios and graceful degradation
  - [ ] Extend `node/tea/update.spec.ts` with highlight update tests:
    - [ ] Test highlight updates and diffing during re-renders
    - [ ] Test extmark boundary updates when content changes
    - [ ] Test highlight cleanup for removed/changed nodes
    - [ ] Test highlight combination when nesting changes
  - [ ] Create `node/tea/highlights.spec.ts` for utility function tests:
    - [ ] Test highlight group mappings and style creation
    - [ ] Test `highlightsEqual()` and comparison functions
    - [ ] Test extmark utility functions (`setExtmark()`, `deleteExtmark()`, etc.)
  - [ ] Iterate until all tests pass following existing test patterns

## Key Design Decisions

1. **Single Namespace**: Use one well-known namespace for all magenta highlighting in any buffer
2. **Priority System**: Use Neovim's extmark priority to handle overlapping highlights predictably
3. **Semantic Groups**: Prefer semantic highlight groups over hardcoded colors for colorscheme compatibility
4. **Error Resilience**: Highlighting failures should not break the render cycle - degrade gracefully
5. **Performance**: Minimize extmark operations during updates by diffing highlight changes
6. **API Consistency**: Mirror the `withBindings()` pattern for familiar developer experience
7. **Render-then-highlight**: Parent node extmarks are applied after the entire subtree renders, covering the full range the parent node occupies in the buffer
8. **Dynamic boundary updates**: When child nodes update and change boundaries, parent extmarks are updated to match the new range
9. **Highlight combination**: Child highlights combine with parent highlights using `hl_mode: "combine"` and higher priority values, preserving both effects

## Notes## Highlight Configuration Options

The system will support multiple ways to configure highlighting:

### 1. Semantic Highlighting (Recommended)

```typescript
withError(d`Error message`); // Uses ErrorMsg highlight group
withWarning(d`Warning text`); // Uses WarningMsg highlight group
withInfo(d`Info text`); // Uses Directory highlight group
withCode(d`function_name()`); // Uses @function.call treesitter group
```

### 2. Text Styling

```typescript
withBold(d`Important text`); // Creates bold highlight group
withItalic(d`Emphasized`); // Creates italic highlight group
withStyle(d`Text`, { bold: true, italic: true }); // Combined styles
```

### 3. Custom Colors (Use Sparingly)

```typescript
withColors(d`Text`, { fg: "#ff0000", bg: "#ffffff" }); // Custom colors
```

### 4. Full Control

```typescript
withHighlight(d`Text`, {
  hl_group: "MyCustomGroup",
  hl_mode: "combine",
  priority: 200,
  hl_eol: true,
});
```

### 5. Arbitrary Highlight Groups

```typescript
withGroup(d`Text`, "CursorLine"); // Use any existing highlight group
```

### Nesting and Combination

```typescript
withError(
  d`Error: ${withBold(d`critical`)} issue in ${withCode(d`function()`)}`,
);
// Results in: error coloring + bold "critical" + code styling for "function()"
```

### Relevant nvim api docs:

nvim_buf_set_extmark({buffer}, {ns_id}, {line}, {col}, {opts})
Creates or updates an |extmark|.

    By default a new extmark is created when no id is passed in, but it is
    also possible to create a new mark by passing in a previously unused id or
    move an existing mark by passing in its id. The caller must then keep
    track of existing and unused ids itself. (Useful over RPC, to avoid
    waiting for the return value.)

    Using the optional arguments, it is possible to use this to highlight a
    range of text, and also to associate virtual text to the mark.

    If present, the position defined by `end_col` and `end_row` should be
    after the start position in order for the extmark to cover a range. An
    earlier end position is not an error, but then it behaves like an empty
    range (no highlighting).

    Attributes: ~
        Since: 0.5.0

    Parameters: ~
      • {buffer}  Buffer id, or 0 for current buffer
      • {ns_id}   Namespace id from |nvim_create_namespace()|
      • {line}    Line where to place the mark, 0-based. |api-indexing|
      • {col}     Column where to place the mark, 0-based. |api-indexing|
      • {opts}    Optional parameters.
                  • id : id of the extmark to edit.
                  • end_row : ending line of the mark, 0-based inclusive.
                  • end_col : ending col of the mark, 0-based exclusive.
                  • hl_group : highlight group used for the text range. This
                    and below highlight groups can be supplied either as a
                    string or as an integer, the latter of which can be
                    obtained using |nvim_get_hl_id_by_name()|.
                    Multiple highlight groups can be stacked by passing an
                    array (highest priority last).
                  • hl_eol : when true, for a multiline highlight covering the
                    EOL of a line, continue the highlight for the rest of the
                    screen line (just like for diff and cursorline highlight).
                  • virt_text : virtual text to link to this mark. A list of
                    `[text, highlight]` tuples, each representing a text chunk
                    with specified highlight. `highlight` element can either
                    be a single highlight group, or an array of multiple
                    highlight groups that will be stacked (highest priority
                    last).
                  • virt_text_pos : position of virtual text. Possible values:
                    • "eol": right after eol character (default).
                    • "eol_right_align": display right aligned in the window
                      unless the virtual text is longer than the space
                      available. If the virtual text is too long, it is
                      truncated to fit in the window after the EOL character.
                      If the line is wrapped, the virtual text is shown after
                      the end of the line rather than the previous screen
                      line.
                    • "overlay": display over the specified column, without
                      shifting the underlying text.
                    • "right_align": display right aligned in the window.
                    • "inline": display at the specified column, and shift the
                      buffer text to the right as needed.
                  • virt_text_win_col : position the virtual text at a fixed
                    window column (starting from the first text column of the
                    screen line) instead of "virt_text_pos".
                  • virt_text_hide : hide the virtual text when the background
                    text is selected or hidden because of scrolling with
                    'nowrap' or 'smoothscroll'. Currently only affects
                    "overlay" virt_text.
                  • virt_text_repeat_linebreak : repeat the virtual text on
                    wrapped lines.
                  • hl_mode : control how highlights are combined with the
                    highlights of the text. Currently only affects virt_text
                    highlights, but might affect `hl_group` in later versions.
                    • "replace": only show the virt_text color. This is the
                      default.
                    • "combine": combine with background text color.
                    • "blend": blend with background text color. Not supported
                      for "inline" virt_text.
                  • virt_lines : virtual lines to add next to this mark This
                    should be an array over lines, where each line in turn is
                    an array over `[text, highlight]` tuples. In general,
                    buffer and window options do not affect the display of the
                    text. In particular 'wrap' and 'linebreak' options do not
                    take effect, so the number of extra screen lines will
                    always match the size of the array. However the 'tabstop'
                    buffer option is still used for hard tabs. By default
                    lines are placed below the buffer line containing the
                    mark.
                  • virt_lines_above: place virtual lines above instead.
                  • virt_lines_leftcol: Place virtual lines in the leftmost
                    column of the window, bypassing sign and number columns.
                  • virt_lines_overflow: controls how to handle virtual lines
                    wider than the window. Currently takes the one of the
                    following values:
                    • "trunc": truncate virtual lines on the right (default).
                    • "scroll": virtual lines can scroll horizontally with
                      'nowrap', otherwise the same as "trunc".
                  • ephemeral : for use with |nvim_set_decoration_provider()|
                    callbacks. The mark will only be used for the current
                    redraw cycle, and not be permanently stored in the buffer.
                  • right_gravity : boolean that indicates the direction the
                    extmark will be shifted in when new text is inserted (true
                    for right, false for left). Defaults to true.
                  • end_right_gravity : boolean that indicates the direction
                    the extmark end position (if it exists) will be shifted in
                    when new text is inserted (true for right, false for
                    left). Defaults to false.
                  • undo_restore : Restore the exact position of the mark if
                    text around the mark was deleted and then restored by
                    undo. Defaults to true.
                  • invalidate : boolean that indicates whether to hide the
                    extmark if the entirety of its range is deleted. For
                    hidden marks, an "invalid" key is added to the "details"
                    array of |nvim_buf_get_extmarks()| and family. If
                    "undo_restore" is false, the extmark is deleted instead.
                  • priority: a priority value for the highlight group, sign
                    attribute or virtual text. For virtual text, item with
                    highest priority is drawn last. For example treesitter
                    highlighting uses a value of 100.
                  • strict: boolean that indicates extmark should not be
                    placed if the line or column value is past the end of the
                    buffer or end of the line respectively. Defaults to true.
                  • sign_text: string of length 1-2 used to display in the
                    sign column.
                  • sign_hl_group: highlight group used for the sign column
                    text.
                  • number_hl_group: highlight group used for the number
                    column.
                  • line_hl_group: highlight group used for the whole line.
                  • cursorline_hl_group: highlight group used for the sign
                    column text when the cursor is on the same line as the
                    mark and 'cursorline' is enabled.
                  • conceal: string which should be either empty or a single
                    character. Enable concealing similar to |:syn-conceal|.
                    When a character is supplied it is used as |:syn-cchar|.
                    "hl_group" is used as highlight for the cchar if provided,
                    otherwise it defaults to |hl-Conceal|.
                  • conceal_lines: string which should be empty. When
                    provided, lines in the range are not drawn at all
                    (according to 'conceallevel'); the next unconcealed line
                    is drawn instead.
                  • spell: boolean indicating that spell checking should be
                    performed within this extmark
                  • ui_watched: boolean that indicates the mark should be
                    drawn by a UI. When set, the UI will receive win_extmark
                    events. Note: the mark is positioned by virt_text
                    attributes. Can be used together with virt_text.
                  • url: A URL to associate with this extmark. In the TUI, the
                    OSC 8 control sequence is used to generate a clickable
                    hyperlink to this URL.

    Return: ~
        Id of the created/updated extmark

nvim*create_namespace({name}) \_nvim_create_namespace()*
Creates a new namespace or gets an existing one. _namespace_

    Namespaces are used for buffer highlights and virtual text, see
    |nvim_buf_set_extmark()|.

    Namespaces can be named or anonymous. If `name` matches an existing
    namespace, the associated id is returned. If `name` is an empty string a
    new, anonymous namespace is created.

    Attributes: ~
        Since: 0.3.2

    Parameters: ~
      • {name}  Namespace name or empty string

    Return: ~
        Namespace id

