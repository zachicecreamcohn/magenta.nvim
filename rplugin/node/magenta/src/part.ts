import Anthropic from "@anthropic-ai/sdk";
import { Mark, insertBeforeMark, replaceBetweenMarks } from "./utils/extmarks";
import { GetFileToolUseRequest } from "./tools";
import { Buffer } from "neovim";
import { Neovim } from "neovim";
import { assertUnreachable } from "./utils/assertUnreachable";

/** A line that's meant to be sent to neovim. Should not contain newlines
 */
export type Line = string & { __line: true };

export type ToolUseState =
  | {
      state: "processing";
    }
  | {
      state: "pending-approval";
    }
  | {
      state: "done";
      response: Anthropic.ToolResultBlockParam;
    };

/** a "Part" is a segment of a chat message. For example, the response, or a proposed tool use.
 */
export type TextPart = {
  type: "text";
  startMark: Mark;
  endMark: Mark;
  param: Anthropic.TextBlockParam;
};

export type ToolUsePart = {
  type: "tool-use";
  startMark: Mark;
  endMark: Mark;
  request: GetFileToolUseRequest;
  state: ToolUseState;
};

export type Part = TextPart | ToolUsePart;

function renderPartToLines(part: Part): Line[] {
  switch (part.type) {
    case "text":
      return part.param.text.split("\n") as Line[];
    case "tool-use": {
      const summary = `🔧 Using tool: ${part.request.name}` as Line;
      let stateText: Line;
      switch (part.state.state) {
        case "done":
          stateText = "✅ Complete" as Line;
          break;
        case "pending-approval":
          stateText = "⏳ Pending approval" as Line;
          break;
        case "processing":
          stateText = "⚙️ Processing" as Line;
          break;
        default:
          assertUnreachable(part.state);
      }
      return [summary, stateText];
    }
    default:
      assertUnreachable(part);
  }
}

export async function renderPart(
  part: Part,
  {
    nvim,
    buffer,
    namespace,
  }: { nvim: Neovim; buffer: Buffer; namespace: number },
) {
  const lines = renderPartToLines(part);
  await replaceBetweenMarks({
    nvim,
    buffer,
    namespace,
    startMark: part.startMark,
    endMark: part.endMark,
    lines,
  });
}

export async function appendToTextPart(
  part: TextPart,
  text: string,
  {
    nvim,
    buffer,
    namespace,
  }: { nvim: Neovim; buffer: Buffer; namespace: number },
) {
  part.param.text += text;
  const lines = text.split("\n") as Line[];
  await insertBeforeMark({
    nvim,
    buffer,
    markId: part.endMark,
    lines,
    namespace,
  });
}

export async function createTextPart({
  text,
  nvim,
  startMark,
  endMark,
  buffer,
  namespace,
}: {
  text: string;
  nvim: Neovim;
  startMark: Mark;
  endMark: Mark;
  buffer: Buffer;
  namespace: number;
}): Promise<TextPart> {
  const part: TextPart = {
    type: "text",
    startMark,
    endMark,
    param: {
      type: "text",
      text,
    },
  };

  await renderPart(part, { nvim, buffer, namespace });

  return part;
}

export async function createToolUsePart({
  toolUse,
  startMark,
  endMark,
  nvim,
  buffer,
  namespace,
}: {
  toolUse: GetFileToolUseRequest;
  startMark: Mark;
  endMark: Mark;
  nvim: Neovim;
  buffer: Buffer;
  namespace: number;
}): Promise<ToolUsePart> {
  const part: ToolUsePart = {
    type: "tool-use",
    startMark,
    endMark,
    request: toolUse,
    state: {
      state: "pending-approval",
    },
  };

  await renderPart(part, { nvim, buffer, namespace });

  return part;
}

export function partToMessageParam(
  part: Part,
): Anthropic.TextBlockParam | Anthropic.ToolUseBlockParam {
  switch (part.type) {
    case "text":
      return part.param;
    case "tool-use":
      return part.request;
    default:
      assertUnreachable(part);
  }
}
