import type { Nvim } from "nvim-node";
import { NvimBuffer, type BufNr, type Line } from "../nvim/buffer";
import {
  NvimWindow,
  type Position0Indexed,
  type WindowId,
} from "../nvim/window";
import { getCurrentWindow } from "../nvim/nvim";
import * as TEA from "../tea/tea";
import * as InlineEdit from "./inline-edit";
import type { Provider, ProviderMessage } from "../providers/provider";

export type InlineEditId = number & { __inlineEdit: true };

export class InlineEditManager {
  private nvim: Nvim;
  private inlineEdits: {
    [bufnr: BufNr]: {
      targetWindowId: WindowId;
      targetBufnr: BufNr;
      inputWindowId: WindowId;
      inputBufnr: BufNr;
      app: TEA.App<InlineEdit.Msg, InlineEdit.Model>;
    };
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

  async initInlineEdit() {
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
    await inputBuffer.setKeymap({
      mode: "n",
      lhs: "<CR>",
      rhs: `:Magenta submit-inline-edit ${targetBufnr}<CR>`,
      opts: { silent: true, noremap: true },
    });

    this.inlineEdits[targetBufnr] = {
      targetWindowId: targetWindow.id,
      targetBufnr,
      inputWindowId: inlineInputWindowId,
      inputBufnr: inputBuffer.id,
      app: TEA.createApp<InlineEdit.Model, InlineEdit.Msg>({
        nvim: this.nvim,
        initialModel: InlineEdit.initModel(),
        update: (msg, model) => {
          return InlineEdit.update(msg, model);
        },
        View: InlineEdit.view,
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

    const { inputBufnr, app } = this.inlineEdits[targetBufnr];

    app.dispatch({
      type: "update-model",
      next: {
        state: "response-pending",
      },
    });

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
    const ft = (await targetBuffer.getOption("filetype")) as string;

    // TODO: do not include buffer content if it's already in the context manager.
    // TODO: support selection / position within the buffer for additional context.
    messages.push({
      role: "user",
      content: `\
        I am working in buffer \`${bufferName}\` with the following contents:
        \`\`\`${ft}
      ${targetLines.join("\n")}
      \`\`\`

      ${inputLines.join("\n")}`,
    });

    await app.mount({
      nvim: this.nvim,
      buffer: inputBuffer,
      startPos: { row: 0, col: 0 } as Position0Indexed,
      endPos: { row: -1, col: -1 } as Position0Indexed,
    });

    messages.push({
      role: "user",
      content: inputLines.join("\n"),
    });

    let result;
    try {
      result = await provider.inlineEdit(messages);
    } catch (e) {
      app.dispatch({
        type: "update-model",
        next: {
          state: "error",
          error: e instanceof Error ? e.message : JSON.stringify(e),
        },
      });
      return;
    }

    const { inlineEdit, stopReason, usage } = result;
    app.dispatch({
      type: "update-model",
      next: {
        state: "tool-use",
        inlineEdit,
        stopReason,
        usage,
      },
    });

    if (inlineEdit.status === "error") {
      return;
    }

    const input = inlineEdit.value.input;

    const buffer = new NvimBuffer(targetBufnr, this.nvim);
    const lines = await buffer.getLines({ start: 0, end: -1 });
    const content = lines.join("\n");

    const replaceStart = content.indexOf(input.find);
    if (replaceStart === -1) {
      app.dispatch({
        type: "update-model",
        next: {
          state: "error",
          error: `\
Unable to find text in buffer:
\`\`\`
${input.find}
\`\`\``,
        },
      });
      return;
    }
    const replaceEnd = replaceStart + input.find.length;

    const nextContent =
      content.slice(0, replaceStart) +
      "\n>>>>>>> Suggested change\n" +
      input.replace +
      "\n=======\n" +
      input.find +
      "\n<<<<<<< Current\n" +
      content.slice(replaceEnd);

    await buffer.setLines({
      start: 0,
      end: -1,
      lines: nextContent.split("\n") as Line[],
    });
  }
}
