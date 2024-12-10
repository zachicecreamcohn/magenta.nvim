import Anthropic from "@anthropic-ai/sdk";
import { Mark, insertBeforeMark, replaceBetweenMarks } from "./utils/extmarks";
import { ToolRequest } from "./tools/index";
import { Buffer } from "neovim";
import { assertUnreachable } from "./utils/assertUnreachable";
import { ToolProcess } from "./tools/types";
import { Context } from "./types";

/** A line that's meant to be sent to neovim. Should not contain newlines
 */
export type Line = string & { __line: true };

export type RenderContext = Context & {
  startMark: Mark;
  endMark: Mark;
  buffer: Buffer;
  namespace: number;
};

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

export class TextPart {
  constructor(
    public param: Anthropic.TextBlockParam,
    private context: RenderContext,
  ) {}

  renderToLines(): Line[] {
    return this.param.text.split("\n") as Line[];
  }

  async render() {
    const lines = this.renderToLines();

    await replaceBetweenMarks({
      nvim: this.context.nvim,
      buffer: this.context.buffer,
      namespace: this.context.namespace,
      startMark: this.context.startMark,
      endMark: this.context.endMark,
      lines,
    });
  }

  async append(text: string) {
    this.param.text += text;
    const lines = text.split("\n") as Line[];
    await insertBeforeMark({
      nvim: this.context.nvim,
      buffer: this.context.buffer,
      markId: this.context.endMark,
      lines,
      namespace: this.context.namespace,
    });
  }
}

export class ToolUsePart {
  constructor(
    public readonly request: ToolRequest,
    public readonly process: ToolProcess,
    private context: RenderContext,
  ) {
    const unsubscribe = process.subscribe((state) => {
      if (state.state == "done") {
        unsubscribe();
      }

      this.render().catch((err) => this.context.logger.error(err as Error));
    });
  }

  renderToLines(): Line[] {
    const toolLines = this.process.getLines();
    return [`🔧 Using tool: ${this.request.name}` as Line, ...toolLines];
  }

  async render() {
    const lines = this.renderToLines();
    await replaceBetweenMarks({
      ...this.context,
      lines,
    });
  }
}

export class ToolResultPart {
  constructor(
    public readonly request: ToolRequest,
    public readonly response: Anthropic.ToolResultBlockParam,
    private context: RenderContext,
  ) {}

  renderToLines(): Line[] {
    const summary = `🔧 Tool result: ${this.request.name}` as Line;
    let stateText: Line;
    switch (this.response.is_error) {
      case true:
        stateText = "❌ Error" as Line;
        break;
      case undefined:
      case false:
        stateText = "✅ Success" as Line;
        break;
      default:
        assertUnreachable(this.response.is_error);
    }
    return [summary, stateText];
  }

  async render() {
    const lines = this.renderToLines();
    await replaceBetweenMarks({
      ...this.context,
      lines,
    });
  }
}

export type Part = TextPart | ToolUsePart | ToolResultPart;

export function partToMessageParam(
  part: Part,
):
  | Anthropic.TextBlockParam
  | Anthropic.ToolUseBlockParam
  | Anthropic.ToolResultBlockParam {
  if (part instanceof TextPart) {
    return part.param;
  } else if (part instanceof ToolUsePart) {
    return part.request;
  } else if (part instanceof ToolResultPart) {
    return part.response;
  }
  return assertUnreachable(part);
}
