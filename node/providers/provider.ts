import type { Nvim } from "../nvim/nvim-node";
import { assertUnreachable } from "../utils/assertUnreachable.ts";
import { AnthropicProvider } from "./anthropic.ts";
import { BedrockProvider } from "./bedrock.ts";
import { OpenAIProvider } from "./openai.ts";
import type { Provider, ProviderName } from "./provider-types.ts";
import { type Profile } from "../options.ts";
import { OllamaProvider } from "./ollama.ts";
import { CopilotProvider } from "./copilot.ts";

export * from "./provider-types.ts";

const clients: { [key: string]: Provider } = {};

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
      case "ollama":
        clients[clientKey] = new OllamaProvider(nvim);
        break;
      case "copilot":
        clients[clientKey] = new CopilotProvider(nvim);
        break;
      default:
        assertUnreachable(profile.provider);
    }
  }

  return clients[clientKey];
}

export function setClient(providerName: ProviderName, c: Provider | undefined) {
  if (c) {
    clients[providerName] = c;
  } else {
    delete clients[providerName];
  }
}
