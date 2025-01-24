import { PROVIDER_NAMES, type ProviderName } from "./providers/provider";

export type MagentaOptions = {
  provider: ProviderName;
  openai: { model: string };
  anthropic: { model: string };
};

export const DEFAULT_OPTIONS: MagentaOptions = {
  provider: "anthropic",
  anthropic: {
    model: "claude-3-5-sonnet-latest",
  },
  openai: {
    model: "gpt-4o",
  },
};

export function parseOptions(inputOptions: unknown): MagentaOptions {
  const options = JSON.parse(JSON.stringify(DEFAULT_OPTIONS)) as MagentaOptions;

  if (typeof inputOptions == "object" && inputOptions != null) {
    const inputOptionsObj = inputOptions as { [key: string]: unknown };
    if (
      typeof inputOptionsObj["provider"] == "string" &&
      PROVIDER_NAMES.indexOf(inputOptionsObj["provider"] as ProviderName) != -1
    ) {
      options.provider = inputOptionsObj.provider as ProviderName;
    }

    if (typeof inputOptionsObj["anthropic"] == "object") {
      const anthropicOptions = inputOptionsObj["anthropic"] as {
        [key: string]: unknown;
      };
      if (typeof anthropicOptions["model"] == "string") {
        options.anthropic.model = anthropicOptions.model;
      }
    }

    if (typeof inputOptionsObj["openai"] == "object") {
      const openaiOptions = inputOptionsObj["openai"] as {
        [key: string]: unknown;
      };
      if (typeof openaiOptions["model"] == "string") {
        options.openai.model = openaiOptions.model;
      }
    }
  }

  return options;
}
