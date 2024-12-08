import Anthropic from "@anthropic-ai/sdk";
import { Buffer } from "neovim";
import { Context } from "./types";
import {
  createMarkedSpaces,
  getExtMark,
  Mark,
  replaceBetweenMarks,
} from "./utils/extmarks";
import { ToolResultBlockParam } from "@anthropic-ai/sdk/resources";
import { GetFileToolUseRequest } from "./tools";
import {
  appendToTextPart,
  createTextPart,
  createToolUsePart,
  Line,
  Part,
  partToMessageParam,
  renderPart,
  ToolUsePart,
} from "./part";

type Role = "user" | "assistant";

export class Message {
  constructor(
    private chat: Chat,
    public data: {
      role: Role;
      parts: Part[];
      startMark: Mark;
      endMark: Mark;
    },
  ) {}

  // Create a shell right before the endMark for this message
  async createPartShell() {
    const [row, col] = await getExtMark({
      nvim: this.chat.context.nvim,
      buffer: this.chat.displayBuffer,
      namespace: this.chat.namespace,
      markId: this.data.endMark,
    });

    return createMarkedSpaces({
      nvim: this.chat.context.nvim,
      buffer: this.chat.displayBuffer,
      namespace: this.chat.namespace,
      row,
      col,
    });
  }

  async appendText(text: string) {
    const lastPart = this.data.parts[this.data.parts.length - 1];
    if (lastPart && lastPart.type === "text") {
      await appendToTextPart(lastPart, text, {
        nvim: this.chat.context.nvim,
        buffer: this.chat.displayBuffer,
        namespace: this.chat.namespace,
      });
    } else {
      const { startMark, endMark } = await this.createPartShell();
      const textPart = await createTextPart({
        text,
        startMark,
        endMark,
        nvim: this.chat.context.nvim,
        buffer: this.chat.displayBuffer,
        namespace: this.chat.namespace,
      });

      this.data.parts.push(textPart);
    }
  }

  async addToolUse(toolUse: GetFileToolUseRequest) {
    const { startMark, endMark } = await this.createPartShell();
    const toolUsePart = await createToolUsePart({
      toolUse,
      startMark,
      endMark,
      nvim: this.chat.context.nvim,
      buffer: this.chat.displayBuffer,
      namespace: this.chat.namespace,
    });

    this.data.parts.push(toolUsePart);
    this.chat.context.logger.trace(
      `Registering part with tool use id ${toolUse.id}`,
    );
    this.chat.registerToolUse(toolUsePart);
  }
}

export type ChatState =
  | {
      state: "pending-user-input";
    }
  | {
      state: "streaming-response";
    }
  | {
      state: "awaiting-tool-use";
    };

export class Chat {
  private messages: Message[] = [];
  private toolParts: {
    [tool_use_id: string]: ToolUsePart;
  } = {};

  private constructor(
    public displayBuffer: Buffer,
    public namespace: number,
    public context: Context,
  ) {}

  async addMessage(role: Role, content?: string): Promise<Message> {
    const bufLength = await this.displayBuffer.length;

    await this.displayBuffer.setOption("modifiable", true);
    this.context.logger.trace(`creating new message at ${bufLength}`);
    await this.displayBuffer.setLines([""], {
      start: bufLength,
      end: bufLength,
      strictIndexing: false,
    });
    await this.displayBuffer.setOption("modifiable", false);

    const { startMark, endMark } = await createMarkedSpaces({
      nvim: this.context.nvim,
      buffer: this.displayBuffer,
      namespace: this.namespace,
      row: bufLength,
      col: 0,
    });
    this.context.logger.trace(
      `creating new message shell at marks ${startMark}, ${endMark}`,
    );

    const rolePrefix = (role.charAt(0).toUpperCase() +
      role.slice(1) +
      ": ") as Line;
    const messageHeaderLines = ["", rolePrefix, ""] as Line[];

    this.context.logger.trace(`calling replaceBetweenMarks`);
    await replaceBetweenMarks({
      nvim: this.context.nvim,
      buffer: this.displayBuffer,
      startMark,
      endMark,
      lines: messageHeaderLines,
      namespace: this.namespace,
    });

    this.context.logger.trace(`creating message`);
    const message = new Message(this, {
      role,
      parts: [],
      startMark,
      endMark,
    });
    this.messages.push(message);

    if (content) {
      this.context.logger.trace(`Appending content to message`);
      await message.appendText(content);
    }

    return message;
  }

  getMessages(): Anthropic.MessageParam[] {
    return this.messages.map((msg) => ({
      role: msg.data.role,
      content: msg.data.parts.map(partToMessageParam),
    }));
  }

  registerToolUse(part: ToolUsePart) {
    this.toolParts[part.request.id] = part;
  }

  async updateToolUse(
    req: GetFileToolUseRequest,
    response: ToolResultBlockParam,
  ) {
    if (response.tool_use_id != req.id) {
      throw new Error(
        `response tool_use_id ${response.tool_use_id} != req.id ${req.id}`,
      );
    }

    const part = this.toolParts[req.id];
    if (!part) {
      throw new Error(`unable to find toolUse with id ${req.id}`);
    }

    part.state = {
      state: "done",
      response,
    };

    await renderPart(part, {
      nvim: this.context.nvim,
      buffer: this.displayBuffer,
      namespace: this.namespace,
    });
  }

  clear() {
    this.messages = [];
  }

  static async init(context: Context) {
    const { nvim, logger } = context;

    const namespace = await nvim.createNamespace("magenta-chat");
    const displayBuffer = (await nvim.createBuffer(false, true)) as Buffer;
    logger.trace(`displayBuffer: ${displayBuffer.id}`);

    await displayBuffer.setOption("buftype", "nofile");
    await displayBuffer.setOption("swapfile", false);
    await displayBuffer.setOption("modifiable", false);

    return new Chat(displayBuffer, namespace, context);
  }
}
