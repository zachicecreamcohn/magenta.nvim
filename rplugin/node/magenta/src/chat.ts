import Anthropic from '@anthropic-ai/sdk';
import { Buffer } from 'neovim'
import { Context } from './types';
import { getExtMark, setExtMark } from './utils/extmarks';

export interface Part {
  content: string;
  type: 'text' | 'code' | 'error';
  startMark?: number;
  endMark?: number;
}

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

  async append(text: string, type: Part['type'] = 'text') {
    const lastPart = this.data.parts[this.data.parts.length - 1];
    if (lastPart && lastPart.type === type) {
      lastPart.content += text;
    } else {
      this.data.parts.push({
        content: text,
        type
      });
    }

    await this.appendToDisplayBuffer(text);
  }

  private async appendToDisplayBuffer(text: string) {
    const { nvim, logger } = this.chat.context;
    logger.trace(`appendToDisplayBuffer ${text}`)
    const lines = text.split('\n');
    if (lines.length === 0) return;

    // Get the current position of our message using the marks
    // const startPos = await this.nvim.callFunction('nvim_buf_get_extmark_by_id', [
    //   this.displayBuffer.id,
    //   1, // namespace id
    //   this.data.startMark,
    //   {}
    // ]) as [number, number];

    // do a trace log of all of the following params
    logger.trace(`getExtMark ${typeof nvim}, ${this.chat.displayBuffer.id}, ${this.chat.namespace}, ${this.data.endMark}`)
    const endPos = await getExtMark({
      nvim,
      buffer: this.chat.displayBuffer,
      namespace: this.chat.namespace,
      markId: this.data.endMark,
    });

    logger.trace(`endPos ${JSON.stringify(endPos)}`)

    await this.chat.displayBuffer.setOption('modifiable', true);

    const lastLines = await this.chat.displayBuffer.getLines({
      start: endPos[0] - 1,
      end: endPos[0],
      strictIndexing: false
    });
    const lastLine = lastLines.length ? lastLines[0] : '';

    await this.chat.displayBuffer.setLines(lastLine + lines[0], {
      start: endPos[0] - 1,
      end: endPos[0],
      strictIndexing: false
    });

    if (lines.length > 1) {
      await this.chat.displayBuffer.setLines(lines.slice(1), {
        start: endPos[0],
        end: endPos[0],
        strictIndexing: false
      });
    }

    await this.chat.displayBuffer.setOption('modifiable', false);
  }
}

export class Chat {
  private messages: Message[] = [];

  private constructor(public displayBuffer: Buffer, public namespace: number, public context: Context) {
  }

  async addMessage(role: Role, content?: string): Promise<Message> {
    const { nvim, logger } = this.context;

    logger.trace(`addMessage`)
    await this.displayBuffer.setOption('modifiable', true);

    const bufLength = await this.displayBuffer.length;
    logger.trace(`bufLength ${bufLength}`)

    await this.displayBuffer.setLines([''], {
      start: bufLength,
      end: bufLength,
      strictIndexing: false
    });

    logger.trace(`setting mark for ns ${this.namespace}`)
    const startMark = await setExtMark({
      nvim,
      buffer: this.displayBuffer,
      namespace: this.namespace,
      row: bufLength,
      col: 0
    })

    logger.trace(`startMark ${startMark}`)

    const rolePrefix = role.charAt(0).toUpperCase() + role.slice(1) + ': ';
    const contentLines = content ? content.split('\n') : []
    const messageLines = ['', rolePrefix, ...contentLines, '<endmessage>']
    logger.trace(`messageLines: ${JSON.stringify(messageLines, null, 2)}`)
    await this.displayBuffer.setLines(messageLines, {
      start: bufLength,
      end: bufLength + 1,
      strictIndexing: false
    });

    const endMark = await setExtMark({ nvim, buffer: this.displayBuffer, namespace: this.namespace, row: bufLength + 1, col: 0 })

    await this.displayBuffer.setOption('modifiable', false);

    const parts: Part[] = []
    if (content) {
      parts.push({
        type: 'text',
        content: content
      })
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

  getMessages(): Anthropic.MessageParam[] {
    return this.messages.map(msg => ({
      role: msg.data.role,
      content: msg.data.parts.map(part => part.content).join('')
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
