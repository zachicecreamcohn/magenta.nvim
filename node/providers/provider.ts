import type { Nvim } from "nvim-node";
import { assertUnreachable } from "../utils/assertUnreachable.ts";
import { stripThinking } from "../utils/strip-thinking.ts";
import type { MagentaOptions } from "../options.ts";
import { AnthropicProvider } from "./anthropic.ts";
import { BedrockProvider } from "./bedrock.ts";
import { OpenAIProvider } from "./openai.ts";
import type { Provider, ProviderName } from "./provider-types.ts";
import { type Profile } from "../options.ts";

export * from "./provider-types.ts";
export { stripThinking };

const clients: { [key: string]: Provider } = {};

export function processLlmOutput(
  text: string,
  options: MagentaOptions,
): string {
  if (options.hideThinking) {
    return stripThinking(text);
  }
  return text;
}

// lazy load so we have a chance to init context before constructing the class
export function getProvider(nvim: Nvim, profile: Profile): Provider {
  const providerName = profile.provider;

  // use a composite key for the client to allow the openai provider to be used for openai and ollama
  let clientKey: string = providerName;
  if (providerName === "openai" && profile.baseUrl) {
    clientKey = `${providerName}-${profile.baseUrl}`;
  }

  if (!clients[clientKey]) {
    switch (profile.provider) {
      case "anthropic":
        clients[clientKey] = new AnthropicProvider(nvim, {
          baseUrl: profile.baseUrl,
          apiKeyEnvVar: profile.apiKeyEnvVar,
          promptCaching: true,
        });
        break;
      case "openai":
        clients[clientKey] = new OpenAIProvider(nvim, {
          baseUrl: profile.baseUrl,
          apiKeyEnvVar: profile.apiKeyEnvVar,
        });
        break;
      case "bedrock":
        clients[clientKey] = new BedrockProvider(nvim, !!profile.promptCaching);
        break;
      default:
        assertUnreachable(profile.provider);
    }
  }

  const provider = clients[clientKey];
  provider.setModel(profile.model);

  return provider;
}

export function setClient(providerName: ProviderName, c: Provider | undefined) {
  if (c) {
    clients[providerName] = c;
  } else {
    delete clients[providerName];
  }
}
