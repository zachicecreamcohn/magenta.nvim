import Anthropic from "@anthropic-ai/sdk";
import { context } from "./context.ts";
import { TOOL_SPECS, ToolRequest } from "./tools/toolManager.ts";

export class AnthropicClient {
  private client: Anthropic;

  constructor() {
    const apiKey = process.env.ANTHROPIC_API_KEY;

    if (!apiKey) {
      throw new Error("Anthropic API key not found in config or environment");
    }

    this.client = new Anthropic({
      apiKey,
    });
  }

  async sendMessage(
    messages: Array<Anthropic.MessageParam>,
    onText: (text: string) => void,
  ): Promise<ToolRequest[]> {
    context.logger.trace(
      `initializing stream with messages: ${JSON.stringify(messages, null, 2)}`,
    );
    const buf: string[] = [];
    let flushInProgress: boolean = false;

    const flushBuffer = () => {
      if (buf.length && !flushInProgress) {
        const text = buf.join("");
        buf.splice(0);

        flushInProgress = true;

        try {
          onText(text);
        } finally {
          flushInProgress = false;
          setInterval(flushBuffer, 1);
        }
      }
    };

    const stream = this.client.messages
      .stream({
        messages,
        model: "claude-3-5-sonnet-20241022",
        max_tokens: 1024,
        system: `You are a coding assistant to a software engineer, inside a neovim plugin called Magenta. Be concise.`,
        tool_choice: {
          type: "auto",
          disable_parallel_tool_use: false,
        },
        tools: TOOL_SPECS,
      })
      .on("text", (text: string) => {
        buf.push(text);
        flushBuffer();
      })
      .on("inputJson", (_delta, snapshot) => {
        context.logger.debug(`inputJson: ${JSON.stringify(snapshot)}`);
      });

    const response = await stream.finalMessage();
    const toolRequests = response.content.filter(
      (c): c is ToolRequest => c.type == "tool_use",
    );
    context.logger.debug("toolRequests: " + JSON.stringify(toolRequests));
    return toolRequests;
  }
}
