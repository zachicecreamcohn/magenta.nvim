import type { Session, ThreadId, ThreadOrigin } from "@magenta/server";
import { NvimBuffer } from "../nvim/buffer.ts";
import type { Nvim } from "../nvim/nvim-node/index.ts";
import type { Row0Indexed } from "../nvim/window.ts";
import * as TEA from "../tea/tea.ts";
import { d, pos, type VDOMNode, withBindings } from "../tea/view.ts";

export type ReflectionEntry = {
  threadId: ThreadId;
  origin: Extract<ThreadOrigin, { type: "reflect" }>;
};

/** The source's reflections in anchor order (creation order breaks ties). */
export function orderedReflections(
  session: Pick<Session, "listDerived">,
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
  onDelete,
}: {
  entries: ReflectionEntry[];
  label: (childId: ThreadId) => string;
  onOpen: (childId: ThreadId) => void;
  onDelete: (childId: ThreadId) => void;
}): VDOMNode {
  const header = d`# Reflections\n\n`;
  if (entries.length === 0) {
    return d`${header}No reflections yet. Visually select text in the thread and press r to reflect on it.\n`;
  }
  return d`${header}${entries.map(({ threadId, origin }) =>
    withBindings(
      d`> ${truncate(origin.anchor.reflectionText, 60)} — ${truncate(label(threadId), 40)}\n`,
      {
        "<CR>": () => onOpen(threadId),
        dd: () => onDelete(threadId),
      },
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

/** A read-only reflection overview for one thread: its buffer and TEA app.
 * The sidebar shows the buffer in the right column's display window. */
export class ReflectionsOverview {
  /** The entry under the overview's cursor, drawn with `MagentaReflectActive`
   * in the source thread. Lives here so it can't outlive the overview. */
  activeReflectionId: ThreadId | undefined;

  private constructor(
    readonly threadId: ThreadId,
    private session: Pick<Session, "listDerived">,
    readonly buffer: NvimBuffer,
    private app: TEA.App<undefined>,
    readonly mountedApp: TEA.MountedApp,
  ) {}

  static async open({
    nvim,
    threadId,
    session,
    label,
    onOpen,
    onDelete,
  }: {
    nvim: Nvim;
    threadId: ThreadId;
    session: Session;
    label: (childId: ThreadId) => string;
    onOpen: (childId: ThreadId) => void;
    onDelete: (childId: ThreadId) => void;
  }): Promise<ReflectionsOverview> {
    const buffer = await NvimBuffer.create(false, true, nvim);
    await buffer.setName(`[Magenta Reflections ${threadId.replace(/-/g, "")}]`);
    await buffer.setOption("bufhidden", "hide");
    await buffer.setOption("buftype", "nofile");
    await buffer.setOption("swapfile", false);
    await buffer.setDisplayKeymaps();
    await nvim.call("nvim_exec_lua", [
      `require("magenta.keymaps").set_reflections_buffer_keymaps(...)`,
      [buffer.id],
    ]);
    const app = TEA.createApp<undefined>({
      nvim,
      initialModel: undefined,
      View: () =>
        renderReflectionsOverview({
          entries: orderedReflections(session, threadId),
          label,
          onOpen,
          onDelete,
        }),
    });
    const mountedApp = await app.mount({
      nvim,
      buffer,
      startPos: pos(0 as Row0Indexed, 0),
      endPos: pos(-1 as Row0Indexed, -1),
    });
    return new ReflectionsOverview(threadId, session, buffer, app, mountedApp);
  }

  render(): void {
    this.mountedApp.render();
  }

  entryAt(line: number): ReflectionEntry | undefined {
    return entryAtLine(orderedReflections(this.session, this.threadId), line);
  }

  async close(): Promise<void> {
    this.mountedApp.unmount();
    this.app.destroy();
    await this.buffer.delete({ force: true }).catch(() => {
      // Already deleted, e.g. by `:bd`.
    });
  }
}
