# context

## Objective

Simplify the buffer synchronization system by adopting a **disk-first** approach. Currently, the agent reads from and writes to nvim buffers when they're open, with complex conflict detection logic. This leads to buffer corruption issues due to race conditions, timeout-based write verification, and the fragility of keeping buffer and disk in sync.

The new approach:
1. **Agent always reads from and writes to disk** (via `FsFileIO` or equivalent)
2. **After a disk write, attempt to reload the nvim buffer** (`:edit`) so the user sees fresh content
3. **If the buffer reload fails or the buffer has unsaved changes, warn the user** rather than blocking the operation
4. The disk is always the source of truth for the agent.

## Key insight

The current `SandboxFileIO` tries to be smart about buffer vs disk, but this creates a matrix of failure modes (both changed, timeout on write, stale tracker info, etc.). By making the agent always work with disk, we eliminate the entire conflict-detection layer. The buffer becomes a "best-effort display" that tries to stay in sync via `:edit` after writes.

## Relevant files

- `node/core/src/capabilities/file-io.ts` — `FileIO` interface and `FsFileIO` (disk-only implementation). This is the target interface.
- `node/capabilities/sandbox-file-io.ts` — Current nvim-aware `FileIO` with buffer tracking, conflict detection, and buffer read/write. **Will be heavily simplified.**
- `node/buffer-tracker.ts` — `BufferTracker` class that tracks mtime/changeTick sync state. **Will be removed.**
- `node/nvim/buffer.ts` — `NvimBuffer` class with `attemptWrite()`, `attemptEdit()`, `setLines()`, `getLines()`.
- `node/utils/buffers.ts` — `getBufferIfOpen()` and `getOrOpenBuffer()` utilities.
- `node/magenta.ts` — Creates `BufferTracker`, handles `magentaBufferTracker` RPC events.
- `node/environment.ts` — Creates `SandboxFileIO` with `bufferTracker`.
- `node/chat/chat.ts` — Uses `bufferTracker`.
- `lua/magenta/init.lua` — Lua autocmds that send buffer tracker RPC notifications.
- `node/buffer-tracker.test.ts` — Tests for buffer tracker.
- `node/capabilities/sandbox-file-io.test.ts` — Tests for sandbox file IO.
- `node/tools/edl.test.ts` — EDL integration tests.

# implementation

## Step 1: Add buffer-reload-after-write capability to SandboxFileIO

Instead of writing to buffers directly, write to disk and then ask nvim to reload any open buffer for that file.

- [ ] Create a helper method `reloadBufferIfOpen(absPath)` on `SandboxFileIO` that:
  1. Calls `getBufferIfOpen()` to check if the file is open in nvim
  2. If open, checks if the buffer has unsaved modifications (`buffer.getOption('modified')`)
  3. If modified, logs a warning via `nvim.logger.warn()` (e.g., "Buffer for {path} has unsaved changes; disk was updated by agent but buffer was not reloaded")
  4. If not modified, calls `buffer.attemptEdit()` to reload from disk
  5. If `attemptEdit()` times out, logs a warning (non-fatal)
  6. If no buffer is open, does nothing

- [ ] Simplify `SandboxFileIO.writeFile()`:
  1. Always write to disk via `fs.writeFile(abs, content, "utf-8")`
  2. Call `this.reloadBufferIfOpen(abs)` afterward (fire-and-forget with error catching)
  3. Remove all `buffer.setLines()` / `buffer.attemptWrite()` / `bufferTracker.trackBufferSync()` logic

- [ ] Simplify `SandboxFileIO.readFile()`:
  1. Always read from disk via `fs.readFile(abs, "utf-8")`
  2. Remove all buffer-tracking conflict detection logic
  3. Keep sandbox read-blocking checks

- [ ] Remove `bufferTracker` from `SandboxFileIO` constructor and all references within

### Testing
- **Behavior**: Agent writes to disk and nvim buffer is reloaded
  - **Setup**: Open a file in nvim buffer, write new content via SandboxFileIO
  - **Actions**: Call `writeFile()` with new content
  - **Expected output**: Disk file has new content; buffer content matches disk
  - **Assertions**: Read disk file, verify content; check buffer lines match

- **Behavior**: Agent writes to disk when buffer has unsaved changes
  - **Setup**: Open a file in nvim, modify buffer (don't save)
  - **Actions**: Call `writeFile()` with new content
  - **Expected output**: Disk updated, buffer NOT reloaded, warning logged
  - **Assertions**: Disk has new content; buffer still has old modified content

- **Behavior**: Agent reads from disk (not buffer)
  - **Setup**: Open a file in nvim, modify buffer (don't save), so buffer and disk differ
  - **Actions**: Call `readFile()`
  - **Expected output**: Returns disk content, not buffer content
  - **Assertions**: Returned string matches what's on disk

## Step 2: Remove BufferTracker

- [ ] Remove `BufferTracker` class from `node/buffer-tracker.ts`
- [ ] Remove the `magentaBufferTracker` RPC handler from `node/magenta.ts`
  - Remove `MAGENTA_BUFFER_TRACKER` constant
  - Remove `onBufferTrackerEvent()` method
  - Remove `bufferTracker` field from the Magenta class
  - Remove `bufferTracker` from any context objects passed around
- [ ] Remove the three autocmds in `lua/magenta/init.lua` (BufReadPost, BufWritePost, BufDelete) that send `magentaBufferTracker` RPC notifications
- [ ] Remove `bufferTracker` from `node/environment.ts` where it's passed to `SandboxFileIO`
- [ ] Remove `bufferTracker` usage from `node/chat/chat.ts`
- [ ] Delete `node/buffer-tracker.test.ts`
- [ ] Update `node/capabilities/sandbox-file-io.test.ts` to remove buffer tracker setup/mocking

### Testing
- **Behavior**: Plugin starts without buffer tracker
  - **Setup**: Start magenta normally
  - **Actions**: Open files, interact with agent
  - **Expected output**: No errors, no buffer tracker RPC messages
  - **Assertions**: Type-check passes; existing integration tests pass

## Step 3: Clean up NvimBuffer

- [ ] Remove `attemptWrite()` from `NvimBuffer` (no longer needed — we write to disk directly)
- [ ] Keep `attemptEdit()` (still needed for reloading buffers from disk)
- [ ] Remove `setLines()` usage from file-IO paths (keep it for sidebar/TEA rendering which still needs it)

### Testing
- **Behavior**: Type-check and tests pass after cleanup
  - **Assertions**: `npx tsgo -b` passes; `npx vitest run` passes

## Step 4: Update existing tests

- [ ] Update `node/tools/edl.test.ts` — any tests that assert buffer content after EDL edits should be updated to assert disk content instead (or verify buffer was reloaded)
- [ ] Update `node/capabilities/sandbox-file-io.test.ts` — rewrite to test the simplified disk-first behavior
- [ ] Run full test suite and fix any failures

### Testing
- **Behavior**: All tests pass with the new disk-first approach
  - **Actions**: `TEST_MODE=sandbox npx vitest run`
  - **Assertions**: All tests pass

## Migration notes

- The `FileIO` interface in core is unchanged — this is purely a change in the root-layer implementation
- `DockerFileIO` is unaffected (it already works with disk only, inside the container)
- `FsFileIO` in core is unaffected
- The sidebar/TEA rendering system still uses `NvimBuffer.setLines()` for the chat buffers — that's separate from file-IO and unchanged
