import Anthropic from '@anthropic-ai/sdk';

export interface Part {
  content: string;
  type: 'text' | 'code' | 'error';
  startMark?: number;
  endMark?: number;
}

type Role = 'user' | 'assistant'

export class Message {
  constructor(public data: {
    role: Role;
    parts: Part[];
    startMark?: number;
    endMark?: number;
  }) { }

  append(text: string, type: Part['type'] = 'text') {
    const lastPart = this.data.parts[this.data.parts.length - 1];
    if (lastPart && lastPart.type === type) {
      lastPart.content += text;
    } else {
      this.data.parts.push({
        content: text,
        type
      });
    }
  }


}

export class Chat {
  private messages: Message[] = [];
  private currentMessage?: Message;

  constructor() { }

  addMessage(role: Role, content: string): Message {
    const message: Message = new Message({
      role,
      parts: [{
        content,
        type: 'text'
      }]
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
    delete this.currentMessage;
  }

  render(): string {
    return this.messages.map(msg => {
      const role = msg.data.role.charAt(0).toUpperCase() + msg.data.role.slice(1);
      const content = msg.data.parts.map(part => part.content).join('');
      return `${role}: ${content}`;
    }).join('\n\n');
  }
}
