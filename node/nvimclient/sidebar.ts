import type { BufferKey, BufferManager } from "./buffer-manager.ts";
import { type Line, NvimBuffer } from "./nvim/buffer.ts";
import { getOption } from "./nvim/nvim.ts";
import type { Nvim } from "./nvim/nvim-node/index.ts";
import {
  NvimWindow,
  type Position1Indexed,
  type Row0Indexed,
  type WindowId,
} from "./nvim/window.ts";
import type {
  Profile,
  SidebarPositionOpts,
  SidebarPositions,
} from "./options.ts";
import { formatTokenCount } from "./utils/tokens.ts";

/** Resolves responsive positions based on terminal orientation */
function resolveResponsivePosition(
  position: SidebarPositions,
  totalWidth: number,
  totalHeight: number,
): SidebarPositions {
  // If not a responsive position, return as-is
  if (
    !["leftbelow", "leftabove", "rightbelow", "rightabove"].includes(position)
  ) {
    return position;
  }

  // Determine if terminal is in landscape (wider than tall) or portrait mode
  const isLandscape = totalWidth > totalHeight;

  switch (position) {
    case "leftbelow":
      return isLandscape ? "left" : "below";
    case "leftabove":
      return isLandscape ? "left" : "above";
    case "rightbelow":
      return isLandscape ? "right" : "below";
    case "rightabove":
      return isLandscape ? "right" : "above";
    default:
      return position;
  }
}

export type SidebarColumnName = "left" | "right";

/** Right-column windows. The input window only exists while it shows a thread. */
type RightColumn = {
  displayWindow: NvimWindow;
  inputWindow?: NvimWindow | undefined;
};

/** What the right column should show; `sync` reconciles windows to it. */
export type RightColumnTarget =
  | { type: "thread"; displayBuffer: NvimBuffer; inputBuffer: NvimBuffer }
  | { type: "overview"; displayBuffer: NvimBuffer }
  | undefined;

export type ColumnStatus = "none" | "busy" | "failed" | "ok";
const STATUS_ICONS: Record<ColumnStatus, string> = {
  none: "",
  busy: "⏳",
  failed: "✗",
  ok: "✓",
};
/** Winbar chrome, computed per column from the thread that column shows. */
export type ColumnChrome = {
  profile: Profile;
  tokenCount: number;
  status: ColumnStatus;
  sandboxBypassed: boolean;
};

/** This will mostly manage the window toggle
 */
export class Sidebar {
  static async calculateWindowDimensions(
    sidebarPosition: SidebarPositions,
    sidebarPositionOpts: SidebarPositionOpts,
    nvim: Nvim,
  ): Promise<{
    inputHeight: number;
    displayHeight: number;
  }> {
    const totalHeight = (await getOption("lines", nvim)) as number;
    const cmdHeight = (await getOption("cmdheight", nvim)) as number;
    const windowHeight = totalHeight - cmdHeight;
    const totalWidth = (await getOption("columns", nvim)) as number;

    // Resolve responsive positions based on terminal orientation
    const resolvedPosition = resolveResponsivePosition(
      sidebarPosition,
      totalWidth,
      totalHeight,
    );

    let inputHeight;
    let displayHeight;

    switch (resolvedPosition) {
      case "left":
        displayHeight = Math.floor(
          windowHeight * sidebarPositionOpts.left.displayHeightPercentage,
        );
        inputHeight = totalHeight - displayHeight - 2;
        break;
      case "right":
        displayHeight = Math.floor(
          windowHeight * sidebarPositionOpts.right.displayHeightPercentage,
        );
        inputHeight = totalHeight - displayHeight - 2;
        break;
      case "above":
        displayHeight = Math.floor(
          windowHeight * sidebarPositionOpts.above.displayHeightPercentage,
        );
        inputHeight = Math.floor(
          windowHeight * sidebarPositionOpts.above.inputHeightPercentage,
        );
        break;
      case "below":
        displayHeight = Math.floor(
          windowHeight * sidebarPositionOpts.below.displayHeightPercentage,
        );
        inputHeight = Math.floor(
          windowHeight * sidebarPositionOpts.below.inputHeightPercentage,
        );
        break;
      case "tab":
        displayHeight = Math.floor(
          windowHeight * sidebarPositionOpts.tab.displayHeightPercentage,
        );
        inputHeight = totalHeight - displayHeight - 2;
        break;
      default:
        // This should never happen since resolveResponsivePosition always returns a base position
        throw new Error(`Unexpected resolved position: ${resolvedPosition}`);
    }

    return { inputHeight, displayHeight };
  }

  public state:
    | {
        state: "hidden";
      }
    | {
        state: "visible";
        displayWindow: NvimWindow;
        displayWidth: number;
        inputWindow: NvimWindow;
        right?: RightColumn | undefined;
      };

  private resolvedPosition: SidebarPositions | undefined;

  constructor(
    private nvim: Nvim,
    private getColumnChrome: (column: SidebarColumnName) => ColumnChrome,
    public bufferManager: BufferManager,
    private getActiveKey: () => BufferKey,
  ) {
    this.state = {
      state: "hidden",
    };
  }

  private getDisplayWindowTitle(): string {
    return "Magenta Chat";
  }

  private getInputWindowTitle(column: SidebarColumnName): string {
    const { profile, tokenCount, status, sandboxBypassed } =
      this.getColumnChrome(column);
    const thinkingStatus = profile.thinking?.enabled
      ? profile.thinking.effort
        ? ` thinking:${profile.thinking.effort}`
        : " thinking"
      : "";
    const baseTitle = `Magenta Input (${profile.name}${thinkingStatus})`;

    const bypassIndicator = sandboxBypassed
      ? " %#ErrorMsg# SANDBOX OFF %#Normal#"
      : "";

    const icon = STATUS_ICONS[status];
    const statusText = icon ? `${icon} ` : "";
    return `${baseTitle} ${statusText}[${formatTokenCount(tokenCount)}]${bypassIndicator}`;
  }

  /** Returns true when a right-column window was closed out from under us, so
   * the caller can clear the right pane. */
  async onWinClosed(): Promise<{ rightClosed: boolean }> {
    let rightClosed = false;
    if (this.state.state === "visible" && this.state.right) {
      const { displayWindow, inputWindow } = this.state.right;
      const [d, i] = await Promise.all([
        displayWindow.valid(),
        inputWindow ? inputWindow.valid() : Promise.resolve(true),
      ]);
      if (!(d && i)) {
        rightClosed = true;
        await this.closeRight();
      }
    }
    if (this.state.state === "visible") {
      const [displayWindowValid, inputWindowValid] = await Promise.all([
        this.state.displayWindow.valid(),
        this.state.inputWindow.valid(),
      ]);

      if (!(displayWindowValid && inputWindowValid)) {
        await this.hide();
      }
    }
    return { rightClosed };
  }

  /** Reconciles the right column's windows to `target`. Only left/right
   * sidebar positions support a second column. */
  async syncRight(target: RightColumnTarget): Promise<void> {
    if (this.state.state !== "visible") return;
    if (
      !target ||
      !(this.resolvedPosition === "left" || this.resolvedPosition === "right")
    ) {
      await this.closeRight();
      return;
    }
    const left = this.state;
    let right = left.right;
    if (right && !(await right.displayWindow.valid())) {
      await this.closeRight();
      right = undefined;
    }
    if (!right) {
      const winId = (await this.nvim.call("nvim_open_win", [
        target.displayBuffer.id,
        false,
        // A global split (win: -1) spans the full editor height; splitting the
        // left display window would only split within the left column.
        {
          split: this.resolvedPosition,
          win: -1,
        },
      ])) as WindowId;
      if (this.resolvedPosition === "left") {
        // The new window is now leftmost; move the left column back to its
        // left so the layout is [left column | right column | editor].
        const inputHeight = (await this.nvim.call("nvim_win_get_height", [
          left.inputWindow.id,
        ])) as number;
        await this.nvim.call("nvim_call_function", [
          "win_splitmove",
          [left.displayWindow.id, winId, { vertical: true, rightbelow: false }],
        ]);
        await this.nvim.call("nvim_call_function", [
          "win_splitmove",
          [
            left.inputWindow.id,
            left.displayWindow.id,
            { vertical: false, rightbelow: true },
          ],
        ]);
        await this.nvim.call("nvim_win_set_height", [
          left.inputWindow.id,
          inputHeight,
        ]);
      }
      const displayWindow = new NvimWindow(winId, this.nvim);
      await this.initWindow(displayWindow);
      await displayWindow.setVar("magenta_display_window", true);
      await displayWindow.setOption("winbar", this.getDisplayWindowTitle());
      await this.nvim.call("nvim_command", ["vertical wincmd ="]);
      right = { displayWindow };
      left.right = right;
    } else {
      await right.displayWindow.setBuffer(target.displayBuffer);
    }
    if (target.type === "thread") {
      if (right.inputWindow && (await right.inputWindow.valid())) {
        await right.inputWindow.setBuffer(target.inputBuffer);
      } else {
        const inputHeight = (await this.nvim.call("nvim_win_get_height", [
          left.inputWindow.id,
        ])) as number;
        const winId = (await this.nvim.call("nvim_open_win", [
          target.inputBuffer.id,
          false,
          { split: "below", win: right.displayWindow.id, height: inputHeight },
        ])) as WindowId;
        const inputWindow = new NvimWindow(winId, this.nvim);
        await this.initWindow(inputWindow);
        await inputWindow.setOption("winfixheight", true);
        right.inputWindow = inputWindow;
      }
      await right.inputWindow.setOption(
        "winbar",
        this.getInputWindowTitle("right"),
      );
    } else if (right.inputWindow) {
      const inputWindow = right.inputWindow;
      right.inputWindow = undefined;
      await inputWindow.close().catch(() => undefined);
    }
  }

  private async initWindow(win: NvimWindow) {
    for (const [key, value] of Object.entries({
      wrap: true,
      linebreak: true,
      cursorline: true,
    })) {
      await win.setOption(key, value);
    }
    await win.setVar("magenta", true);
  }

  private async closeRight(): Promise<void> {
    if (this.state.state !== "visible" || !this.state.right) return;
    const { displayWindow, inputWindow } = this.state.right;
    this.state.right = undefined;
    for (const win of [displayWindow, inputWindow]) {
      if (win && (await win.valid())) {
        await win.close().catch(() => undefined);
      }
    }
    await this.nvim.call("nvim_command", ["vertical wincmd ="]);
  }

  /** The right column's windows, if it is open. */
  getRightWindows(): RightColumn | undefined {
    return this.state.state === "visible" ? this.state.right : undefined;
  }

  /** Which column a window belongs to, if it is a sidebar window. */
  columnOfWindow(winId: WindowId): SidebarColumnName | undefined {
    if (this.state.state !== "visible") return undefined;
    if (
      winId === this.state.displayWindow.id ||
      winId === this.state.inputWindow.id
    )
      return "left";
    const right = this.state.right;
    if (
      right &&
      (winId === right.displayWindow.id || winId === right.inputWindow?.id)
    )
      return "right";
    return undefined;
  }

  async toggle(
    sidebarPosition: SidebarPositions,
    sidebarPositionOpts: SidebarPositionOpts,
  ): Promise<boolean> {
    if (this.state.state === "hidden") {
      await this.show(sidebarPosition, sidebarPositionOpts);
      return true;
    } else {
      await this.hide();
      return false;
    }
  }

  private async show(
    sidebarPosition: SidebarPositions,
    sidebarPositionOpts: SidebarPositionOpts,
  ): Promise<void> {
    this.nvim.logger.debug(`sidebar.show`);

    const { displayBuffer, inputBuffer } =
      await this.bufferManager.ensureActiveIsMounted(this.getActiveKey());
    const { inputHeight, displayHeight } =
      await Sidebar.calculateWindowDimensions(
        sidebarPosition,
        sidebarPositionOpts,
        this.nvim,
      );

    // Get terminal dimensions for resolving responsive positions
    const totalHeight = (await getOption("lines", this.nvim)) as number;
    const totalWidth = (await getOption("columns", this.nvim)) as number;
    const resolvedPosition = resolveResponsivePosition(
      sidebarPosition,
      totalWidth,
      totalHeight,
    );

    let displayWindowId: WindowId;

    if (resolvedPosition === "tab") {
      await this.nvim.call("nvim_command", ["tabnew"]);
      displayWindowId = (await this.nvim.call(
        "nvim_get_current_win",
        [],
      )) as unknown as WindowId;
      await this.nvim.call("nvim_win_set_buf", [
        displayWindowId,
        displayBuffer.id,
      ]);
    } else {
      displayWindowId = (await this.nvim.call("nvim_open_win", [
        displayBuffer.id,
        false,
        {
          win: -1, // global split
          split: resolvedPosition,
          height: displayHeight,
        },
      ])) as WindowId;
    }
    const displayWindow = new NvimWindow(displayWindowId, this.nvim);
    this.resolvedPosition = resolvedPosition;

    const inputWindowId = (await this.nvim.call("nvim_open_win", [
      inputBuffer.id,
      true, // enter the input window
      {
        win: displayWindow.id, // split inside this window
        split: "below",
        height: inputHeight,
      },
    ])) as WindowId;

    const inputWindow = new NvimWindow(inputWindowId, this.nvim);
    await inputWindow.clearjumps();

    const winOptions = {
      wrap: true,
      linebreak: true,
      cursorline: true,
    };

    for (const [key, value] of Object.entries(winOptions)) {
      await displayWindow.setOption(key, value);
      await inputWindow.setOption(key, value);
    }
    await displayWindow.setOption("winbar", this.getDisplayWindowTitle());
    // set vars so we can identify this as the magenta display window
    await displayWindow.setVar("magenta", true);
    await displayWindow.setVar("magenta_display_window", true);
    await inputWindow.setOption("winbar", this.getInputWindowTitle("left"));
    // set var so we can avoid closing this window when displaying a diff
    await inputWindow.setVar("magenta", true);
    await inputWindow.setOption("winfixheight", true);
    if (resolvedPosition !== "tab") {
      await this.nvim.call("nvim_command", ["vertical wincmd ="]);
    }

    const displayWidth = (await this.nvim.call("nvim_win_get_width", [
      displayWindow.id,
    ])) as number;

    this.nvim.logger.debug(`sidebar.create setting state`);
    this.state = {
      state: "visible",
      displayWindow,
      displayWidth,
      inputWindow,
    };
  }

  async renderInputHeader() {
    if (this.state.state === "visible") {
      // The input window may have been closed out from under us (e.g. by `:bd`
      // on a magenta buffer, which can also close its window). Guard against
      // touching an invalid window id.
      if (!(await this.state.inputWindow.valid())) {
        return;
      }
      await this.state.inputWindow.setOption(
        "winbar",
        this.getInputWindowTitle("left"),
      );
      const rightInput = this.state.right?.inputWindow;
      if (rightInput && (await rightInput.valid())) {
        await rightInput
          .setOption("winbar", this.getInputWindowTitle("right"))
          .catch(() => undefined);
      }
    }
  }

  async hide() {
    if (this.state.state === "visible") {
      await this.closeRight();
      const { displayWindow, inputWindow } = this.state;

      // Check if the only windows open are magenta windows
      const allWindows = (await this.nvim.call(
        "nvim_list_wins",
        [],
      )) as WindowId[];

      const nonMagentaWindows: WindowId[] = [];
      for (const winId of allWindows) {
        const win = new NvimWindow(winId, this.nvim);
        const isMagenta = await win.getVar("magenta").catch(() => false);
        if (!isMagenta) {
          nonMagentaWindows.push(winId);
        }
      }

      // If only magenta windows are open, create a new empty window first
      if (nonMagentaWindows.length === 0) {
        // Create a new empty buffer and open it in a new window
        const emptyBuf = await NvimBuffer.create(false, true, this.nvim);
        await this.nvim.call("nvim_open_win", [
          emptyBuf.id,
          true,
          {
            win: -1, // global split
            split: "left",
          },
        ]);
      }

      try {
        await Promise.all([displayWindow.close(), inputWindow.close()]);
      } catch {
        // windows may fail to close if they're already closed
      }
      this.state = {
        state: "hidden",
      };
    }
  }

  async scrollToLastUserMessage() {
    const { displayWindow } = await this.getWindowIfVisible();
    if (displayWindow) {
      const displayBuffer = await displayWindow.buffer();
      const lines = await displayBuffer.getLines({
        start: 0 as Row0Indexed,
        end: -1 as Row0Indexed,
      });
      const lineIdx = lines.lastIndexOf("# user:" as Line);
      if (lineIdx !== -1) {
        await displayWindow.setCursor({
          row: lineIdx + 1,
          col: 0,
        } as Position1Indexed);
        await displayWindow.zt();
      }

      // Place cursor at the end of the buffer without scrolling - use neovim
      // commands so this stays consistent even as the buffer is streaming.
      await displayWindow.cursorToEnd();
    }
  }

  async setCursorToBottom() {
    const { displayWindow } = await this.getWindowIfVisible();
    if (displayWindow) {
      await displayWindow.cursorToEnd();
      await displayWindow.zb();
    }
  }

  async getWindowIfVisible(): Promise<{
    displayWindow?: NvimWindow | undefined;
    inputWindow?: NvimWindow | undefined;
  }> {
    if (this.state.state !== "visible") {
      return {};
    }

    const { displayWindow, inputWindow } = this.state;
    const displayWindowValid = await displayWindow.valid();
    const inputWindowValid = await inputWindow.valid();

    return {
      displayWindow: displayWindowValid ? displayWindow : undefined,
      inputWindow: inputWindowValid ? inputWindow : undefined,
    };
  }

  isVisible(): boolean {
    return this.state.state === "visible";
  }

  async getMessage(inputBuffer: NvimBuffer): Promise<string> {
    const lines = await inputBuffer.getLines({
      start: 0 as Row0Indexed,
      end: -1 as Row0Indexed,
    });

    this.nvim.logger.debug(
      `sidebar got lines ${JSON.stringify(lines)} from inputBuffer`,
    );
    const message = lines.join("\n");
    await inputBuffer.setLines({
      start: 0 as Row0Indexed,
      end: -1 as Row0Indexed,
      lines: [""] as Line[],
    });

    return message;
  }
}
