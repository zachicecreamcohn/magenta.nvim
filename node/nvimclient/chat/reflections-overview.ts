import type { Session, ThreadId, ThreadOrigin } from "@magenta/server";
import { NvimBuffer } from "../nvim/buffer.ts";
import type { Nvim } from "../nvim/nvim-node/index.ts";
import { NvimWindow, type Row0Indexed, type WindowId } from "../nvim/window.ts";
import * as TEA from "../tea/tea.ts";
import { d, pos, type VDOMNode, withBindings } from "../tea/view.ts";

export type ReflectionEntry = {
  threadId: ThreadId;
  origin: Extract<ThreadOrigin, { type: "reflect" }>;
};

/** The source's reflections in anchor order (creation order breaks ties). */
export function orderedReflections(
  session: Session,
  threadId: ThreadId,
): ReflectionEntry[] {
  return session
    .listDerived(threadId, "reflect")
    .map((entry, creationIdx) => ({ entry, creationIdx }))
    .sort(
      (a, b) =>
        a.entry.origin.anchor.messageIdx - b.entry.origin.anchor.messageIdx ||
        a.entry.origin.anchor.contentIdx - b.entry.origin.anchor.contentIdx ||
        a.creationIdx - b.creationIdx,
    )
    .map(({ entry }) => entry);
}

const HEADER_LINES = 2;

function truncate(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

export function renderReflectionsOverview({
  entries,
  label,
  onOpen,
}: {
  entries: ReflectionEntry[];
  label: (childId: ThreadId) => string;
  onOpen: (childId: ThreadId) => void;
}): VDOMNode {
  const header = d`# Reflections\n\n`;
  if (entries.length === 0) {
    return d`${header}No reflections yet. Visually select text in the thread and press r to reflect on it.\n`;
  }
  return d`${header}${entries.map(({ threadId, origin }) =>
    withBindings(
      d`> ${truncate(origin.anchor.reflectionText, 60)} — ${truncate(label(threadId), 40)}\n`,
      { "<CR>": () => onOpen(threadId) },
    ),
  )}`;
}

/** The entry under a 1-indexed buffer line; entries render one per line. */
export function entryAtLine(
  entries: ReflectionEntry[],
  line: number,
): ReflectionEntry | undefined {
  const idx = line - 1 - HEADER_LINES;
  return idx >= 0 ? entries[idx] : undefined;
}

/** A read-only reflection overview for one thread, shown in a window split to
 * the right of the sidebar's display window. Until the pane-state and
 * two-column stages land, this window is managed here rather than by Sidebar. */
export class ReflectionsOverview {
  private entries: ReflectionEntry[] = [];

  private constructor(
    readonly threadId: ThreadId,
    readonly buffer: NvimBuffer,
    readonly window: NvimWindow,
    private app: TEA.App<unknown>,
    readonly mountedApp: TEA.MountedApp,
  ) {}

  static async open({
    nvim,
    threadId,
    besideWindow,
    session,
    label,
    onOpen,
  }: {
    nvim: Nvim;
    threadId: ThreadId;
    besideWindow: NvimWindow;
    session: Session;
    label: (childId: ThreadId) => string;
    onOpen: (childId: ThreadId) => void;
  }): Promise<ReflectionsOverview> {
    const buffer = await NvimBuffer.create(false, true, nvim);
    await buffer.setName(`[Magenta Reflections ${threadId.replace(/-/g, "")}]`);
    await buffer.setOption("bufhidden", "wipe");
    await buffer.setOption("buftype", "nofile");
    await buffer.setOption("swapfile", false);
    await buffer.setDisplayKeymaps();
    await nvim.call("nvim_exec_lua", [
      `require("magenta.keymaps").set_reflections_buffer_keymaps(...)`,
      [buffer.id],
    ]);
    const width = await nvim.call("nvim_win_get_width", [besideWindow.id]);
    const winId = (await nvim.call("nvim_open_win", [
      buffer.id,
      true,
      { split: "right", win: besideWindow.id, width },
    ])) as WindowId;
    const window = new NvimWindow(winId, nvim);
    await window.setOption("winfixwidth", true);
    await window.setOption("wrap", false);

    let overview: ReflectionsOverview | undefined;
    const app = TEA.createApp<undefined>({
      nvim,
      initialModel: undefined,
      View: () => {
        const entries = orderedReflections(session, threadId);
        if (overview) overview.entries = entries;
        return renderReflectionsOverview({ entries, label, onOpen });
      },
    });
    const mountedApp = await app.mount({
      nvim,
      buffer,
      startPos: pos(0 as Row0Indexed, 0),
      endPos: pos(-1 as Row0Indexed, -1),
    });
    overview = new ReflectionsOverview(
      threadId,
      buffer,
      window,
      app,
      mountedApp,
    );
    overview.entries = orderedReflections(session, threadId);
    return overview;
  }

  render(): void {
    this.mountedApp.render();
  }

  entryAt(line: number): ReflectionEntry | undefined {
    return entryAtLine(this.entries, line);
  }

  async close(nvim: Nvim): Promise<void> {
    this.mountedApp.unmount();
    this.app.destroy();
    if (await this.window.valid()) {
      await nvim.call("nvim_win_close", [this.window.id, true]);
    }
    await this.buffer.delete({ force: true }).catch(() => {
      // bufhidden=wipe may already have removed it.
    });
  }
}
