import type { Nvim } from "../nvim/nvim-node";
import { NvimBuffer, type BufNr } from "../nvim/buffer";
import {
  NvimWindow,
  pos1col1to0,
  type Position0Indexed,
  type Position1Indexed,
  type Position1IndexedCol1Indexed,
  type WindowId,
} from "../nvim/window";
import { getCurrentWindow, getcwd } from "../nvim/nvim";
import * as TEA from "../tea/tea";
import * as InlineEdit from "./inline-edit-controller";
import type { Provider, ProviderMessage } from "../providers/provider";
import path from "node:path";
import { getMarkdownExt } from "../utils/markdown";
import {
  spec as replaceSelectionSpec,
  type NvimSelection,
} from "../tools/replace-selection-tool";
import { spec as inlineEditSpec } from "../tools/inline-edit-tool";
import type { Dispatch } from "../tea/tea";

export type InlineEditId = number & { __inlineEdit: true };

export type InlineEditState = {
  targetWindowId: WindowId;
  targetBufnr: BufNr;
  inputWindowId: WindowId;
  inputBufnr: BufNr;
  cursor: Position1Indexed;
  dispatch: Dispatch<InlineEdit.Msg>;
  controller: InlineEdit.InlineEditController;
  selection?: NvimSelection | undefined;
  app: TEA.App<InlineEdit.InlineEditController>;
  mountedApp?: TEA.MountedApp;
};

export class InlineEditManager {
  private nvim: Nvim;
  private inlineEdits: {
    [bufnr: BufNr]: InlineEditState;
  } = {};

  constructor({ nvim }: { nvim: Nvim }) {
    this.nvim = nvim;
  }

  onWinClosed() {
    return Promise.all(
      Object.entries(this.inlineEdits).map(async ([bufnr, edit]) => {
        const window = new NvimWindow(edit.inputWindowId, this.nvim);
        if (!(await window.valid())) {
          delete this.inlineEdits[bufnr as unknown as BufNr];
          edit.app.destroy();
        }
      }),
    );
  }

  destroy() {
    Object.entries(this.inlineEdits).map(([bufnr, edit]) => {
      delete this.inlineEdits[bufnr as unknown as BufNr];
      edit.app.destroy();
    });
  }

  async initInlineEdit(selection?: {
    startPos: Position1IndexedCol1Indexed;
    endPos: Position1IndexedCol1Indexed;
  }) {
    const targetWindow = await getCurrentWindow(this.nvim);
    const isMagentaWindow = await targetWindow.getVar("magenta");

    if (isMagentaWindow) {
      return;
    }

    const targetBufnr = (await this.nvim.call("nvim_win_get_buf", [
      targetWindow.id,
    ])) as BufNr;

    if (this.inlineEdits[targetBufnr]) {
      return;
    }
    const targetBuffer = new NvimBuffer(targetBufnr, this.nvim);
    const cursor = await targetWindow.getCursor();

    const inputBuffer = await NvimBuffer.create(false, true, this.nvim);
    await inputBuffer.setOption("bufhidden", "wipe");
    await inputBuffer.setOption("filetype", "markdown");

    const inlineInputWindowId = (await this.nvim.call("nvim_open_win", [
      inputBuffer.id,
      true, // enter the input window
      {
        win: targetWindow.id, // split inside current window
        split: "above",
        height: 10,
        style: "minimal",
      },
    ])) as WindowId;

    const inlineInputWindow = new NvimWindow(inlineInputWindowId, this.nvim);
    await inlineInputWindow.setOption("winbar", "Magenta Inline Prompt");

    // Enter insert mode
    await this.nvim.call("nvim_exec2", ["startinsert", {}]);

    // Set up <CR> mapping in normal mode
    await inputBuffer.setInlineKeymaps(targetBufnr);

    let selectionWithText: InlineEditState["selection"];
    if (selection) {
      selectionWithText = {
        ...selection,
        text: (
          await targetBuffer.getText({
            startPos: pos1col1to0(selection.startPos),
            endPos: pos1col1to0(selection.endPos),
          })
        ).join("\n"),
      };
    }

    const dispatch = (msg: InlineEdit.Msg) => {
      controller.update(msg);
      const mountedApp = this.inlineEdits[targetBufnr].mountedApp;
      if (mountedApp) {
        mountedApp.render();
      }
    };

    const controller = new InlineEdit.InlineEditController({
      nvim: this.nvim,
      bufnr: targetBufnr,
      selection: selectionWithText,
      dispatch,
    });

    this.inlineEdits[targetBufnr] = {
      targetWindowId: targetWindow.id,
      targetBufnr,
      inputWindowId: inlineInputWindowId,
      inputBufnr: inputBuffer.id,
      cursor,
      dispatch,
      selection: selectionWithText,
      controller: controller,
      app: TEA.createApp<InlineEdit.InlineEditController>({
        nvim: this.nvim,
        initialModel: controller,
        View: () => controller.view(),
      }),
    };
  }

  async submitInlineEdit(
    targetBufnr: BufNr,
    provider: Provider,
    messages: ProviderMessage[],
  ) {
    if (!this.inlineEdits[targetBufnr]) {
      return;
    }

    const { inputBufnr, selection, cursor, app, dispatch } =
      this.inlineEdits[targetBufnr];

    const inputBuffer = new NvimBuffer(inputBufnr, this.nvim);
    const inputLines = await inputBuffer.getLines({
      start: 0,
      end: -1,
    });
    const targetBuffer = new NvimBuffer(targetBufnr, this.nvim);
    const targetLines = await targetBuffer.getLines({
      start: 0,
      end: -1,
    });
    const bufferName = await targetBuffer.getName();
    const cwd = await getcwd(this.nvim);

    // TODO: do not include buffer content if it's already in the context manager.

    if (selection) {
      messages.push({
        role: "user",
        content: `\
I am working in file \`${path.relative(cwd, bufferName)}\` with the following contents:
\`\`\`${getMarkdownExt(bufferName)}
${targetLines.join("\n")}
\`\`\`

I have the following text selected on line ${selection.startPos.row - 1}:
\`\`\`
${selection.text}
\`\`\`

${inputLines.join("\n")}`,
      });
    } else {
      messages.push({
        role: "user",
        content: `\
I am working in file \`${path.relative(cwd, bufferName)}\` with the following contents:
\`\`\`${getMarkdownExt(bufferName)}
${targetLines.join("\n")}
\`\`\`

My cursor is on line ${cursor.row - 1}: ${targetLines[cursor.row - 1]}

${inputLines.join("\n")}`,
      });
    }

    await inputBuffer.setOption("modifiable", false);
    const mountedApp = await app.mount({
      nvim: this.nvim,
      buffer: inputBuffer,
      startPos: { row: 0, col: 0 } as Position0Indexed,
      endPos: { row: -1, col: -1 } as Position0Indexed,
    });
    this.inlineEdits[targetBufnr].mountedApp = mountedApp;

    const request = provider.forceToolUse(
      messages,
      selection ? replaceSelectionSpec : inlineEditSpec,
    );
    dispatch({
      type: "request-sent",
      request,
    });
  }

  abort() {
    for (const inlineEdit of Object.values(this.inlineEdits)) {
      const state = inlineEdit.controller.state;
      if (state.state == "response-pending") {
        state.request.abort();
      }
    }
  }
}
