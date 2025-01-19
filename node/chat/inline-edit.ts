import type { Nvim } from "nvim-node";
import { NvimBuffer, type BufNr, type Line } from "../nvim/buffer";
import type { WindowId } from "../nvim/window";
import { assertUnreachable } from "../utils/assertUnreachable";
import type { Dispatch, Update } from "../tea/tea";
import { getCurrentWindow } from "../nvim/nvim";
import type { InlineEditToolRequest } from "../tools/inlineEdit";
import type { Result } from "../utils/result";
import type { StopReason, Usage } from "../providers/provider";

export type Model =
  | {
      state: "inactive";
    }
  | {
      state: "error";
      error: string;
    }
  | {
      state: "awaiting-prompt";
      targetWindowId: WindowId;
      targetBufnr: BufNr;
      inputWindowId: WindowId;
      inputBufnr: BufNr;
    }
  | {
      state: "response-pending";
      targetWindowId: WindowId;
      targetBufnr: BufNr;
      inputWindowId: WindowId;
      inputBufnr: BufNr;
    };

export type Msg =
  | {
      type: "start-inline-edit";
    }
  | {
      type: "error";
      error: string;
    }
  | {
      type: "inline-edit-initialized";
      targetWindowId: WindowId;
      targetBufnr: BufNr;
      inputWindowId: WindowId;
      inputBufnr: BufNr;
    }
  | {
      type: "submit-inline-edit";
    }
  | {
      type: "inline-edit-tool-request";
      inlineEdit: Result<InlineEditToolRequest, { rawRequest: unknown }>;
      stopReason: StopReason;
      usage: Usage;
    }
  | {
      type: "dismiss-inline-edit";
    };

export function init({ nvim }: { nvim: Nvim }) {
  function initModel(): Model {
    return {
      state: "inactive",
    };
  }

  const update: Update<Msg, Model> = (msg, model) => {
    switch (msg.type) {
      case "start-inline-edit":
        return [model, startInlineEdit];

      case "inline-edit-initialized":
        return [
          {
            state: "awaiting-prompt",
            targetWindowId: msg.targetWindowId,
            targetBufnr: msg.targetBufnr,
            inputWindowId: msg.inputWindowId,
            inputBufnr: msg.inputBufnr,
          },
        ];

      case "submit-inline-edit":
        if (model.state === "awaiting-prompt") {
          return [
            {
              state: "response-pending",
              targetWindowId: model.targetWindowId,
              targetBufnr: model.targetBufnr,
              inputWindowId: model.inputWindowId,
              inputBufnr: model.inputBufnr,
            },
            // thunk will be handled by parent/chat
          ];
        } else {
          return [{ state: "inactive" }];
        }

      case "dismiss-inline-edit":
        return [
          {
            state: "inactive",
          },
        ];

      case "error":
        return [{ state: "error", error: msg.error }];

      case "inline-edit-tool-request": {
        if (model.state != "response-pending") {
          return [
            { state: "error", error: `Unexpected state: ${model.state}` },
          ];
        }
        if (msg.inlineEdit.status === "error") {
          return [
            {
              state: "error",
              error: `inlineEdit error: ${msg.inlineEdit.error}\nrawRequest:${JSON.stringify(msg.inlineEdit.rawRequest, null, 2)}`,
            },
          ];
        }

        const input = msg.inlineEdit.value.input;

        return [
          { state: "inactive" },
          async (dispatch) => {
            const { targetWindowId } = model;

            const targetBufnr = (await nvim.call("nvim_win_get_buf", [
              targetWindowId,
            ])) as BufNr;
            const buffer = new NvimBuffer(targetBufnr, nvim);
            const lines = await buffer.getLines({ start: 0, end: -1 });
            const content = lines.join("\n");

            const replaceStart = content.indexOf(input.find);
            if (replaceStart === -1) {
              dispatch({
                type: "error",
                error: `Unable to find text in buffer:
\`\`\`
${input.find}
\`\`\``,
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
          },
        ];
      }

      default:
        assertUnreachable(msg);
    }
  };

  async function startInlineEdit(dispatch: Dispatch<Msg>) {
    const targetWindow = await getCurrentWindow(nvim);
    const isMagentaWindow = await targetWindow.getVar("magenta");

    if (!isMagentaWindow) {
      const targetBufnr = (await nvim.call("nvim_win_get_buf", [
        targetWindow.id,
      ])) as BufNr;

      const scratchBuffer = await NvimBuffer.create(false, true, nvim);
      await scratchBuffer.setOption("bufhidden", "wipe");

      const inlineInputWindowId = (await nvim.call("nvim_open_win", [
        scratchBuffer.id,
        true, // enter the input window
        {
          win: targetWindow.id, // split inside current window
          split: "above",
          height: 10,
          style: "minimal",
        },
      ])) as WindowId;

      // Set up <CR> mapping in normal mode
      await scratchBuffer.setKeymap({
        mode: "n",
        lhs: "<CR>",
        rhs: ":Magenta submit-inline-edit<CR>",
        opts: { silent: true, noremap: true },
      });

      dispatch({
        type: "inline-edit-initialized",
        targetWindowId: targetWindow.id,
        targetBufnr,
        inputWindowId: inlineInputWindowId,
        inputBufnr: scratchBuffer.id,
      });
    }
  }

  return { initModel, update };
}
