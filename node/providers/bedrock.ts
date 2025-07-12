import { AnthropicBedrock } from "@anthropic-ai/bedrock-sdk";
import type { Nvim } from "../nvim/nvim-node";
import { AnthropicProvider } from "./anthropic.ts";
import type Anthropic from "@anthropic-ai/sdk";

export class BedrockProvider extends AnthropicProvider {
  constructor(nvim: Nvim, promptCaching: boolean) {
    super(nvim, { promptCaching, awsAPIKey: true });
    this.client = new AnthropicBedrock() as unknown as Anthropic;
  }
}
