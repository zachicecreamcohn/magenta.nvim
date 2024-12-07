import Anthropic from '@anthropic-ai/sdk';

export class AnthropicClient {
  private client: Anthropic;

  constructor() {
    const apiKey = process.env.ANTHROPIC_API_KEY;

    if (!apiKey) {
      throw new Error('Anthropic API key not found in config or environment');
    }

    this.client = new Anthropic({
      apiKey
    });
  }

  sendMessage(messages: Array<Anthropic.MessageParam>, onText: (text: string) => void) {
    this.client.messages.stream({
      messages,
      model: 'claude-3-5-sonnet-20241022',
      max_tokens: 1024,
    }).on('text', onText);
  }
}
