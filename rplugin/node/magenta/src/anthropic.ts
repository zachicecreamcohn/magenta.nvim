import Anthropic from '@anthropic-ai/sdk';
import {Logger} from './logger'

export class AnthropicClient {
  private client: Anthropic;

  constructor(private logger: Logger) {
    const apiKey = process.env.ANTHROPIC_API_KEY;

    if (!apiKey) {
      throw new Error('Anthropic API key not found in config or environment');
    }

    this.client = new Anthropic({
      apiKey
    });
  }

  sendMessage(messages: Array<Anthropic.MessageParam>, onText: (text: string) => Promise<void>) {
    this.logger.trace(`initializing stream`)
    this.client.messages.stream({
      messages,
      model: 'claude-3-5-sonnet-20241022',
      max_tokens: 1024,
    }).on('text', (text: string) => {
      onText(text).catch((err: Error) => {
        this.logger.error(err)
      })
    });
  }
}
