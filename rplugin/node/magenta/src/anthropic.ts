import Anthropic from '@anthropic-ai/sdk';
import { Logger } from './logger'

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

  async sendMessage(messages: Array<Anthropic.MessageParam>, onText: (text: string) => Promise<void>) {
    this.logger.trace(`initializing stream with messages: ${JSON.stringify(messages, null, 2)}`)
    const buf: string[] = [];
    let flushInProgress: boolean = false;

    function flushBuffer() {
      if (buf.length && !flushInProgress) {
        const text = buf.join('');
        buf.splice(0);

        flushInProgress = true;


        // eslint-disable-next-line @typescript-eslint/no-floating-promises
        onText(text).finally(() => {
          flushInProgress = false;
          setInterval(flushBuffer, 1)
        })
      }
    }

    try {
      const stream = this.client.messages.stream({
        messages,
        model: 'claude-3-5-sonnet-20241022',
        max_tokens: 1024,
      }).on('text', (text: string) => {
        buf.push(text);
        flushBuffer()
      });

      await stream.finalMessage();
    } catch (e: unknown) {
      this.logger.error(e as Error)
    }
  }
}
