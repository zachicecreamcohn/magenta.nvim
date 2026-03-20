import {
  getProvider as coreGetProvider,
  type Provider,
  type ProviderProfile,
  setMockProvider,
  validateInput,
} from "@magenta/core";
import * as AnthropicAuthImpl from "../auth/anthropic.ts";
import { NvimAuthUI } from "../auth/auth-ui.ts";
import type { Nvim } from "../nvim/nvim-node/index.ts";
import { execSync } from "node:child_process";
import { userInfo } from "node:os";

export { setMockProvider };
export * from "./provider-types.ts";

export function getProvider(nvim: Nvim, profile: ProviderProfile): Provider {
  let profileToUse = profile;

  // If using keychain auth, load the API key from macOS Keychain synchronously
  if (profile.authType === "keychain" && process.platform === "darwin") {
    try {
      const username = userInfo().username;
      const apiKey = execSync(
        `security find-generic-password -s "Claude Code" -a "${username}" -w 2>/dev/null`,
        { encoding: "utf-8" },
      ).trim();

      if (apiKey && apiKey.startsWith("sk-ant-")) {
        // Convert keychain auth to key auth with the loaded API key
        profileToUse = {
          ...profile,
          authType: "key",
          apiKey: apiKey,
        };
        nvim.logger.info("Loaded API key from macOS Keychain (Claude Code)");
      } else {
        nvim.logger.warn(
          "Could not find Claude Code API key in macOS Keychain",
        );
      }
    } catch (e) {
      nvim.logger.error(`Error loading from keychain: ${e}`);
    }
  }

  const provider = coreGetProvider(
    nvim.logger,
    new NvimAuthUI(nvim),
    validateInput,
    AnthropicAuthImpl,
    profileToUse,
  );

  return provider;
}
