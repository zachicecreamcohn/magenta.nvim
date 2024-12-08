import Anthropic from '@anthropic-ai/sdk';
import { Buffer } from 'neovim'
import { Context } from './types';
import { getExtMark, setExtMark } from './utils/extmarks';
import { ToolResultBlockParam } from '@anthropic-ai/sdk/resources';
import { GetFileToolUseRequest } from './tools';

export type Part = Anthropic.TextBlockParam | GetFileToolUseRequest | Anthropic.ToolResultBlockParam;
type Role = 'user' | 'assistant'

export class Message {
  constructor(
    private chat: Chat,
    public data: {
      role: Role;
      parts: Part[];
      startMark: number;
      endMark: number;
    }
  ) { }

  async appendText(text: string) {
    const lastPart = this.data.parts[this.data.parts.length - 1];
    if (lastPart && lastPart.type === 'text') {
      lastPart.text += text;
    } else {
      this.data.parts.push({
        text,
        type: 'text'
      });
    }

    await this.appendToDisplayBuffer(text);
  }

  async addToolUse(toolUse: GetFileToolUseRequest) {
    // Add a visual indicator in the buffer
    const summary = `🔧 Using tool: ${toolUse.name} <${toolUse.input.path}>`;
    await this.appendToDisplayBuffer(`\n${summary}\n`);

    // Add the tool use to the message parts
    this.data.parts.push(toolUse);
  }

  private async appendToDisplayBuffer(text: string) {
    const { nvim, logger } = this.chat.context;
    logger.trace(`appendToDisplayBuffer ${text}`)
    const lines = text.split('\n');
    if (lines.length === 0) return;

    logger.trace(`getExtMark ${typeof nvim}, ${this.chat.displayBuffer.id}, ${this.chat.namespace}, ${this.data.endMark}`)
    const [endRow, endCol] = await getExtMark({
      nvim,
      buffer: this.chat.displayBuffer,
      namespace: this.chat.namespace,
      markId: this.data.endMark,
    });

    logger.trace(`endPos ${JSON.stringify([endRow, endCol])}`)

    await this.chat.displayBuffer.setOption('modifiable', true);

    await nvim.call('nvim_buf_set_text', [
      this.chat.displayBuffer.id,
      endRow,
      endCol,
      endRow,
      endCol,
      lines
    ]);

    await this.chat.displayBuffer.setOption('modifiable', false);
  }
}

export class Chat {
  private messages: Message[] = [];

  private constructor(public displayBuffer: Buffer, public namespace: number, public context: Context) {
  }

  private async createMessageShell(lines: string[]): Promise<{ startMark: number; endMark: number }> {
    const { nvim } = this.context;

    await this.displayBuffer.setOption('modifiable', true);

    const bufLength = await this.displayBuffer.length;

    await this.displayBuffer.setLines([''], {
      start: bufLength,
      end: bufLength,
      strictIndexing: false
    });

    const startMark = await setExtMark({
      nvim,
      buffer: this.displayBuffer,
      namespace: this.namespace,
      row: bufLength,
      col: 0
    });

    const messageLines = [...lines, '<end>'];

    await this.displayBuffer.setLines(messageLines, {
      start: bufLength,
      end: bufLength + 1,
      strictIndexing: false
    });

    const endMark = await setExtMark({
      nvim,
      buffer: this.displayBuffer,
      namespace: this.namespace,
      row: bufLength + messageLines.length - 1,
      col: 0
    });

    await this.displayBuffer.setOption('modifiable', false);

    return { startMark, endMark };
  }

  async addMessage(role: Role, content?: string): Promise<Message> {
    const rolePrefix = role.charAt(0).toUpperCase() + role.slice(1) + ': ';
    const contentLines = content ? content.split('\n') : [];
    const messageLines = ['', rolePrefix, '', ...contentLines];

    const { startMark, endMark } = await this.createMessageShell(messageLines);

    const parts: Part[] = [];
    if (content) {
      parts.push({
        type: 'text',
        text: content
      });
    }

    const message = new Message(this, {
      role,
      parts,
      startMark,
      endMark
    });

    this.messages.push(message);
    return message;
  }

  async addToolUseMessage(toolResults: ToolResultBlockParam[]) {
    // Format concise summaries for display
    const messageLines = ['Tool Results:'];
    for (const result of toolResults) {
      const status = result.is_error ? '❌' : '✓';

      if (result.is_error) {
        messageLines.push(`${status} Failed to read file`);
      } else {
        messageLines.push(`${status} Read file successfully`);
      }
    }

    const { startMark, endMark } = await this.createMessageShell(messageLines);

    // Create a new user message with the full tool results
    const message = new Message(this, {
      role: 'user',
      parts: toolResults,
      startMark,
      endMark
    });

    this.messages.push(message);
    return message;
  }

  getMessages(): Anthropic.MessageParam[] {
    return this.messages.map(msg => ({
      role: msg.data.role,
      content: msg.data.parts,
    }));
  }

  clear() {
    this.messages = [];
  }

  static async init(context: Context) {
    const { nvim, logger } = context;

    const namespace = await nvim.createNamespace('magenta-chat');
    const displayBuffer = await nvim.createBuffer(false, true) as Buffer;
    logger.trace(`displayBuffer: ${displayBuffer.id}`)

    await displayBuffer.setOption('buftype', 'nofile');
    await displayBuffer.setOption('swapfile', false);
    await displayBuffer.setOption('modifiable', false);

    return new Chat(displayBuffer, namespace, context);
  }
}
