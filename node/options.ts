import { PROVIDER_NAMES, type ProviderName } from "./providers/provider";

export type Profile = {
  name: string;
  provider: ProviderName;
  model: string;
  baseUrl?: string;
  apiKeyEnvVar?: string;
  promptCaching?: boolean; // Primarily used by Bedrock provider
};

export type MagentaOptions = {
  profiles: Profile[];
  activeProfile: string;
  sidebarPosition: "left" | "right";
};

type DefaultOptions = Omit<MagentaOptions, "profiles" | "activeProfile">;

export const DEFAULT_OPTIONS: DefaultOptions = {
  sidebarPosition: "left",
};

export function parseOptions(inputOptions: unknown): MagentaOptions {
  const options = JSON.parse(JSON.stringify(DEFAULT_OPTIONS)) as DefaultOptions;

  let profiles: MagentaOptions["profiles"] = [];

  if (typeof inputOptions == "object" && inputOptions != null) {
    const inputOptionsObj = inputOptions as { [key: string]: unknown };

    // Parse sidebar position
    const sidebarPosition = inputOptionsObj["sidebar_position"];
    if (sidebarPosition === "right" || sidebarPosition === "left") {
      options.sidebarPosition = sidebarPosition;
    }

    if (Array.isArray(inputOptionsObj["profiles"])) {
      const optionProfiles = inputOptionsObj["profiles"] as unknown[];

      profiles = optionProfiles
        .map((profile): Profile | undefined => {
          if (typeof profile !== "object" || profile === null) return undefined;
          const p = profile as { [key: string]: unknown };

          if (
            !(
              typeof p["name"] === "string" &&
              typeof p["provider"] === "string" &&
              PROVIDER_NAMES.indexOf(p["provider"] as ProviderName) !== -1 &&
              typeof p["model"] === "string"
            )
          ) {
            throw new Error(
              `Invalid profile provided: ${JSON.stringify(p, null, 2)}`,
            );
          }

          const out: Profile = {
            name: p["name"],
            provider: p["provider"] as ProviderName,
            model: p["model"],
          };

          if ("base_url" in p) {
            if (typeof p["base_url"] === "string") {
              out.baseUrl = p["base_url"];
            } else {
              throw new Error(
                `Invalid profile - base_url must be a string: ${JSON.stringify(p, null, 2)}`,
              );
            }
          }

          if ("api_key_env_var" in p) {
            if (typeof p["api_key_env_var"] === "string") {
              out.apiKeyEnvVar = p["api_key_env_var"];
            } else {
              throw new Error(
                `Invalid profile - api_key_env_var must be a string: ${JSON.stringify(p, null, 2)}`,
              );
            }
          }

          if ("prompt_caching" in p) {
            if (typeof p["prompt_caching"] === "boolean") {
              out.promptCaching = p["prompt_caching"];
            } else {
              throw new Error(
                `Invalid profile - prompt_caching must be a boolean: ${JSON.stringify(p, null, 2)}`,
              );
            }
          }

          return out;
        })
        .filter((p) => p != undefined);
    }

    if (profiles.length == 0) {
      throw new Error(`Invalid profiles provided`);
    }
  }

  return {
    ...options,
    profiles,
    activeProfile: profiles[0].name,
  };
}
