# Context

The goal is to enhance the Chat class's thread overview to display threads in a hierarchical tree structure showing parent-child relationships, along with detailed status information.

Currently, the `renderThreadOverview()` method displays a flat list of threads. We need to:

1. Build a tree structure from the existing `threadWrappers` using `parentThreadId`
2. Render threads hierarchically with proper indentation
3. Show detailed status using the existing `getThreadSummary()` method
4. Maintain existing keybinding behavior for thread selection

The relevant files and entities are:

- `node/chat/chat.ts`: Contains the Chat class with `renderThreadOverview()` method
  - `ThreadWrapper` type: Has `parentThreadId` field for building hierarchy
  - `threadWrappers` property: Object mapping ThreadId to ThreadWrapper
  - `getThreadSummary()` method: Returns title and status information
  - `renderThreadOverview()` method: Currently renders flat list, needs enhancement
- `node/tea/view.ts`: Provides `d` template literal and `withBindings` for rendering
  - `d` template function: For declarative text rendering
  - `withBindings` function: For attaching keybindings to text sections
  - `VDOMNode` type: Return type for view components

# Implementation

- [ ] Write a `buildThreadHierarchy()` helper method in the Chat class

  - [ ] Create a map from parent ThreadId to array of child ThreadIds
  - [ ] Iterate through all `threadWrappers` to populate the map
  - [ ] Identify root threads (those with no `parentThreadId`)
  - [ ] Return object with `rootThreads: ThreadId[]` and `childrenMap: Map<ThreadId, ThreadId[]>`
  - [ ] Handle edge cases like missing parent references
  - [ ] Iterate until you get no compilation/type errors

- [ ] Write a `formatThreadStatus()` helper method in the Chat class

  - [ ] Take a `ThreadId` parameter and return formatted status string
  - [ ] Use existing `getThreadSummary()` method to get status information
  - [ ] Format status similar to `wait-for-subagents.ts` `renderThreadStatus()`:
    - `missing`: `❓ not found`
    - `pending`: `⏳ initializing`
    - `running`: `⏳ ${activity}`
    - `stopped`: `⏹️ stopped (${reason})`
    - `yielded`: `✅ yielded: ${truncated response}`
    - `error`: `❌ error: ${truncated message}`
  - [ ] Truncate long messages to 50 characters with "..." suffix
  - [ ] Handle all possible status types from `getThreadSummary()`
  - [ ] Iterate until you get no compilation/type errors

- [ ] Write a `renderThread()` helper method in the Chat class

  - [ ] Take `threadId`, `isChild`, and `activeThreadId` parameters
  - [ ] Generate proper indentation: no indent for parents, 2 spaces for children
  - [ ] Get thread summary using `getThreadSummary()` method
  - [ ] Format display line: `${indent}${marker} [${threadId}] ${title}: ${status}`
    - Use `*` marker for active thread, `-` for others
    - Use title from summary or "[Untitled]" fallback
    - Use status from `formatThreadStatus()` helper
  - [ ] Apply `withBindings` for thread selection similar to wait-for-subagents:
    - `"<CR>"` key should dispatch `select-thread` message with threadId
  - [ ] Return `VDOMNode` for the thread line
  - [ ] Iterate until you get no compilation/type errors

- [ ] Update the `renderThreadOverview()` method to use simple hierarchy

  - [ ] Replace existing flat list logic with parent-child rendering
  - [ ] Call `buildThreadHierarchy()` to get structure
  - [ ] First render all root threads using `renderThread()`
  - [ ] For each root thread, render its children with indentation
  - [ ] Maintain the existing "No threads yet" fallback case
  - [ ] Preserve the existing header "# Threads"
  - [ ] Iterate until you get no compilation/type errors

- [ ] Write tests for the new functionality

  - [ ] Test `buildThreadHierarchy()` with various parent-child configurations
  - [ ] Test `formatThreadStatus()` with different thread states
  - [ ] Test `renderThread()` with parent and child threads
  - [ ] Test thread selection keybindings still work correctly
  - [ ] Test edge cases: orphaned threads, missing parents
  - [ ] Iterate until unit tests pass

- [ ] Handle edge cases and validation
  - [ ] Add logging for malformed thread relationships
  - [ ] Handle threads with missing parent references gracefully
  - [ ] Consider performance implications for large thread trees
  - [ ] Add defensive coding for undefined thread states
  - [ ] Iterate until you get no compilation/type errors
