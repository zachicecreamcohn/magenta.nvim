import type { ThreadId } from "@magenta/core";
import { type BufNr, type Line, NvimBuffer } from "./nvim/buffer.ts";
import type { Nvim } from "./nvim/nvim-node/index.ts";
import type { NvimWindow, Row0Indexed } from "./nvim/window.ts";
import type * as TEA from "./tea/tea.ts";
import { pos } from "./tea/view.ts";

/** Buffer name prefix used to identify magenta input buffers.
 * Must match the pattern in lua/magenta/completion/ sources.
 */
export const MAGENTA_INPUT_BUFFER_PREFIX = "Magenta Input";

/** Sanitize a thread title for use in a buffer name: single line, collapsed
 * whitespace, truncated. */
function sanitizeTitle(title: string): string {
  const cleaned = title.replace(/\s+/g, " ").trim();
  const MAX = 40;
  return cleaned.length > MAX ? cleaned.slice(0, MAX).trimEnd() : cleaned;
}

function displayBufferName(
  title: string | undefined,
  bufferId: string,
): string {
  const sanitized = title ? sanitizeTitle(title) : "";
  const lead = sanitized || "Thread";
  return `${lead} [Magenta ${bufferId}]`;
}

function inputBufferName(title: string | undefined, bufferId: string): string {
  const sanitized = title ? sanitizeTitle(title) : "";
  const lead = sanitized || "Thread";
  return `${lead} [${MAGENTA_INPUT_BUFFER_PREFIX} ${bufferId}]`;
}

type BufferEntry =
  | {
      state: "registered";
      buffer: NvimBuffer;
      inputBuffer: NvimBuffer;
    }
  | {
      state: "mounted";
      buffer: NvimBuffer;
      inputBuffer: NvimBuffer;
      app: TEA.App<unknown>;
      mountedApp: TEA.MountedApp;
    };

export type BufferRole = "display" | "input";

export type BufferInfo = {
  key: ThreadId | "overview";
  role: BufferRole;
};

export class BufferManager {
  private threadEntries: Map<ThreadId, BufferEntry> = new Map();
  private overviewEntry: BufferEntry;
  /** Reverse lookup: buffer id → { key, role } */
  private bufNrToInfo: Map<BufNr, BufferInfo> = new Map();

  private createThreadApp!: (threadId: ThreadId) => TEA.App<unknown>;
  private createOverviewApp!: () => TEA.App<unknown>;

  private constructor(
    private nvim: Nvim,
    overviewEntry: BufferEntry,
  ) {
    this.overviewEntry = overviewEntry;
  }

  setAppFactories(
    createThreadApp: (threadId: ThreadId) => TEA.App<unknown>,
    createOverviewApp: () => TEA.App<unknown>,
  ): void {
    this.createThreadApp = createThreadApp;
    this.createOverviewApp = createOverviewApp;
  }

  static async create(nvim: Nvim): Promise<BufferManager> {
    const [buffer, inputBuffer] = await Promise.all([
      BufferManager.createDisplayBuffer(nvim, "[Magenta Threads]", false),
      BufferManager.createReadOnlyInputBuffer(nvim, "[Magenta Overview Input]"),
    ]);
    const overviewEntry: BufferEntry = {
      state: "registered",
      buffer,
      inputBuffer,
    };
    const manager = new BufferManager(nvim, overviewEntry);
    manager.bufNrToInfo.set(buffer.id, { key: "overview", role: "display" });
    manager.bufNrToInfo.set(inputBuffer.id, { key: "overview", role: "input" });
    return manager;
  }

  async registerThread(
    threadId: ThreadId,
  ): Promise<{ displayBuffer: NvimBuffer; inputBuffer: NvimBuffer }> {
    const existing = this.threadEntries.get(threadId);
    if (existing)
      return {
        displayBuffer: existing.buffer,
        inputBuffer: existing.inputBuffer,
      };

    const bufferId = threadId.replace(/-/g, "");
    const [buffer, inputBuffer] = await Promise.all([
      BufferManager.createDisplayBuffer(
        this.nvim,
        displayBufferName(undefined, bufferId),
        true,
      ),
      BufferManager.createInputBuffer(
        this.nvim,
        inputBufferName(undefined, bufferId),
      ),
    ]);

    const entry: BufferEntry = {
      state: "registered",
      buffer,
      inputBuffer,
    };
    this.threadEntries.set(threadId, entry);
    this.bufNrToInfo.set(buffer.id, { key: threadId, role: "display" });
    this.bufNrToInfo.set(inputBuffer.id, { key: threadId, role: "input" });
    return { displayBuffer: buffer, inputBuffer };
  }

  private async ensureMounted(threadId: ThreadId): Promise<TEA.MountedApp> {
    const entry = this.threadEntries.get(threadId);
    if (!entry) {
      throw new Error(`No buffers registered for thread ${threadId}`);
    }

    if (entry.state === "mounted") {
      return entry.mountedApp;
    }

    const app = this.createThreadApp(threadId);

    const mountedApp = await app.mount({
      nvim: this.nvim,
      buffer: entry.buffer,
      startPos: pos(0 as Row0Indexed, 0),
      endPos: pos(-1 as Row0Indexed, -1),
    });

    this.threadEntries.set(threadId, {
      state: "mounted",
      buffer: entry.buffer,
      inputBuffer: entry.inputBuffer,
      app,
      mountedApp,
    });

    return mountedApp;
  }

  async ensureOverviewMounted(): Promise<{
    buffer: NvimBuffer;
    mountedApp: TEA.MountedApp;
  }> {
    if (this.overviewEntry.state !== "mounted") {
      const app = this.createOverviewApp();
      const mountedApp = await app.mount({
        nvim: this.nvim,
        buffer: this.overviewEntry.buffer,
        startPos: pos(0 as Row0Indexed, 0),
        endPos: pos(-1 as Row0Indexed, -1),
      });
      this.overviewEntry = {
        state: "mounted",
        buffer: this.overviewEntry.buffer,
        inputBuffer: this.overviewEntry.inputBuffer,
        app,
        mountedApp,
      };
    }

    return {
      buffer: this.overviewEntry.buffer,
      mountedApp: this.overviewEntry.mountedApp,
    };
  }

  getOverviewBuffers(): { displayBuffer: NvimBuffer; inputBuffer: NvimBuffer } {
    return {
      displayBuffer: this.overviewEntry.buffer,
      inputBuffer: this.overviewEntry.inputBuffer,
    };
  }

  getThreadBuffers(
    threadId: ThreadId,
  ): { displayBuffer: NvimBuffer; inputBuffer: NvimBuffer } | undefined {
    const entry = this.threadEntries.get(threadId);
    if (!entry) return undefined;
    return { displayBuffer: entry.buffer, inputBuffer: entry.inputBuffer };
  }

  /** Rename a thread's display and input buffers to reflect its title. */
  async setThreadTitle(threadId: ThreadId, title: string): Promise<void> {
    const entry = this.threadEntries.get(threadId);
    if (!entry) return;
    const bufferId = threadId.replace(/-/g, "");
    await Promise.all([
      entry.buffer.setName(displayBufferName(title, bufferId)),
      entry.inputBuffer.setName(inputBufferName(title, bufferId)),
    ]);
  }

  /** Remove a thread's buffers and state. Idempotent: a no-op if already gone.
   * Deletes both backing NvimBuffers best-effort. */
  async removeThread(threadId: ThreadId): Promise<void> {
    const entry = this.threadEntries.get(threadId);
    if (!entry) return;
    this.threadEntries.delete(threadId);
    this.bufNrToInfo.delete(entry.buffer.id);
    this.bufNrToInfo.delete(entry.inputBuffer.id);
    await Promise.all(
      [entry.buffer, entry.inputBuffer].map((buf) =>
        buf
          .delete({ force: true })
          .catch((e: Error) =>
            this.nvim.logger.error(
              `Error deleting buffer for thread ${threadId}: ${e.message}`,
            ),
          ),
      ),
    );
  }

  /** Recreate the overview buffers after they were externally deleted.
   * Resets the overview to an unmounted state so the next mount rebinds it. */
  async recreateOverview(): Promise<void> {
    const dead = [this.overviewEntry.buffer, this.overviewEntry.inputBuffer];
    this.bufNrToInfo.delete(this.overviewEntry.buffer.id);
    this.bufNrToInfo.delete(this.overviewEntry.inputBuffer.id);
    // Fully wipe the dead buffers so their (canonical) names are released
    // before we recreate buffers with the same names.
    await Promise.all(
      dead.map((buf) =>
        buf.delete({ force: true }).catch(() => {
          // best-effort; the buffer may already be gone
        }),
      ),
    );
    const [buffer, inputBuffer] = await Promise.all([
      BufferManager.createDisplayBuffer(this.nvim, "[Magenta Threads]", false),
      BufferManager.createReadOnlyInputBuffer(
        this.nvim,
        "[Magenta Overview Input]",
      ),
    ]);
    this.overviewEntry = { state: "registered", buffer, inputBuffer };
    this.bufNrToInfo.set(buffer.id, { key: "overview", role: "display" });
    this.bufNrToInfo.set(inputBuffer.id, { key: "overview", role: "input" });
  }

  /** Look up which thread/overview a buffer belongs to and its role. */
  /** Look up which thread/overview a buffer belongs to and its role. */
  lookupBuffer(bufNr: BufNr): BufferInfo | undefined {
    return this.bufNrToInfo.get(bufNr);
  }

  /** Check if a buffer id belongs to any magenta buffer. */
  isMagentaBuffer(bufNr: BufNr): boolean {
    return this.bufNrToInfo.has(bufNr);
  }

  getMountedApp(activeKey: ThreadId | "overview"): TEA.MountedApp | undefined {
    if (activeKey === "overview") {
      return this.overviewEntry.state === "mounted"
        ? this.overviewEntry.mountedApp
        : undefined;
    }
    const entry = this.threadEntries.get(activeKey);
    return entry?.state === "mounted" ? entry.mountedApp : undefined;
  }

  /** Ensure the active view is mounted and return its buffers. */
  async ensureActiveIsMounted(
    activeKey: ThreadId | "overview",
  ): Promise<{ displayBuffer: NvimBuffer; inputBuffer: NvimBuffer }> {
    if (activeKey === "overview") {
      await this.ensureOverviewMounted();
      return this.getOverviewBuffers();
    }
    // Lazily register thread buffers if not yet registered
    if (!this.threadEntries.has(activeKey)) {
      await this.registerThread(activeKey);
    }
    await this.ensureMounted(activeKey);
    const entry = this.threadEntries.get(activeKey)!;
    return { displayBuffer: entry.buffer, inputBuffer: entry.inputBuffer };
  }

  async switchToThread(
    threadId: ThreadId,
    displayWindow: NvimWindow,
    inputWindow: NvimWindow,
  ): Promise<{ displayBuffer: NvimBuffer; inputBuffer: NvimBuffer }> {
    if (!this.threadEntries.has(threadId)) {
      await this.registerThread(threadId);
    }
    const entry = this.threadEntries.get(threadId)!;

    const mountedApp = await this.ensureMounted(threadId);
    await Promise.all([
      displayWindow.setBuffer(entry.buffer),
      inputWindow.setBuffer(entry.inputBuffer),
    ]);
    // Sync the view to current state, in case dispatches occurred while this app wasn't visible
    mountedApp.render();
    return { displayBuffer: entry.buffer, inputBuffer: entry.inputBuffer };
  }

  async switchToOverview(
    displayWindow: NvimWindow,
    inputWindow: NvimWindow,
  ): Promise<{ displayBuffer: NvimBuffer; inputBuffer: NvimBuffer }> {
    const { buffer, mountedApp } = await this.ensureOverviewMounted();
    await Promise.all([
      displayWindow.setBuffer(buffer),
      inputWindow.setBuffer(this.overviewEntry.inputBuffer),
    ]);

    // Sync the view to current state, in case dispatches occurred while this app wasn't visible
    mountedApp.render();
    return this.getOverviewBuffers();
  }

  private static async createDisplayBuffer(
    nvim: Nvim,
    name: string,
    listed: boolean,
  ): Promise<NvimBuffer> {
    const buffer = await NvimBuffer.create(listed, true, nvim);
    await buffer.setName(name);
    await buffer.setOption("bufhidden", "hide");
    await buffer.setOption("buftype", "nofile");
    await buffer.setOption("swapfile", false);
    await buffer.setDisplayKeymaps();
    return buffer;
  }

  private static async createReadOnlyInputBuffer(
    nvim: Nvim,
    name: string,
  ): Promise<NvimBuffer> {
    const buffer = await NvimBuffer.create(false, true, nvim);
    await buffer.setName(name);
    await buffer.setOption("bufhidden", "hide");
    await buffer.setOption("buftype", "nofile");
    await buffer.setOption("swapfile", false);
    await buffer.setOption("modifiable", false);
    return buffer;
  }

  private static async createInputBuffer(
    nvim: Nvim,
    name: string,
  ): Promise<NvimBuffer> {
    const buffer = await NvimBuffer.create(true, true, nvim);
    await buffer.setName(name);
    await buffer.setOption("bufhidden", "hide");
    await buffer.setOption("buftype", "nofile");
    await buffer.setOption("swapfile", false);
    await buffer.setOption("filetype", "markdown");
    await buffer.setSiderbarKeymaps();
    await buffer.setupPasteHandlers();

    await buffer.setLines({
      start: 0 as Row0Indexed,
      end: -1 as Row0Indexed,
      lines: ["" as Line],
    });

    return buffer;
  }
}
