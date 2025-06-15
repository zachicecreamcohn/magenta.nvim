import { PROVIDER_NAMES, type ProviderName } from "./providers/provider";
import * as fs from "fs";
import * as path from "path";

export type Profile = {
  name: string;
  provider: ProviderName;
  model: string;
  baseUrl?: string;
  apiKeyEnvVar?: string;
  promptCaching?: boolean; // Primarily used by Bedrock provider
};

export type CommandAllowlist = string[];

export type MagentaOptions = {
  profiles: Profile[];
  activeProfile: string;
  sidebarPosition: "left" | "right";
  commandAllowlist: CommandAllowlist;
  autoContext: string[];
};

// Reusable parsing helpers
function parseProfiles(
  profilesInput: unknown,
  logger?: { warn: (msg: string) => void },
): Profile[] {
  if (!Array.isArray(profilesInput)) {
    logger?.warn("profiles must be an array");
    return [];
  }

  const profiles: Profile[] = [];

  for (const profile of profilesInput) {
    try {
      if (typeof profile !== "object" || profile === null) {
        logger?.warn(`Skipping invalid profile: ${JSON.stringify(profile)}`);
        continue;
      }

      const p = profile as { [key: string]: unknown };

      if (
        !(
          typeof p["name"] === "string" &&
          typeof p["provider"] === "string" &&
          PROVIDER_NAMES.indexOf(p["provider"] as ProviderName) !== -1 &&
          typeof p["model"] === "string"
        )
      ) {
        logger?.warn(
          `Skipping profile with missing required fields: ${JSON.stringify(p)}`,
        );
        continue;
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
          logger?.warn(
            `Invalid base_url in profile ${p["name"]}, ignoring field`,
          );
        }
      }

      if ("apiKeyEnvVar" in p) {
        if (typeof p["apiKeyEnvVar"] === "string") {
          out.apiKeyEnvVar = p["apiKeyEnvVar"];
        } else {
          logger?.warn(
            `Invalid apiKeyEnvVar in profile ${p["name"]}, ignoring field`,
          );
        }
      }

      if ("promptCaching" in p) {
        if (typeof p["promptCaching"] === "boolean") {
          out.promptCaching = p["promptCaching"];
        } else {
          logger?.warn(
            `Invalid promptCaching in profile ${p["name"]}, ignoring field`,
          );
        }
      }

      profiles.push(out);
    } catch (error) {
      logger?.warn(
        `Error parsing profile: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  return profiles;
}

function parseStringArray(
  input: unknown,
  fieldName: string,
  logger?: { warn: (msg: string) => void },
): string[] {
  if (!Array.isArray(input)) {
    logger?.warn(`${fieldName} must be an array`);
    return [];
  }

  return input.filter((item) => {
    if (typeof item === "string") {
      return true;
    } else {
      logger?.warn(
        `Skipping non-string item in ${fieldName}: ${JSON.stringify(item)}`,
      );
      return false;
    }
  }) as string[];
}

function parseSidebarPosition(
  input: unknown,
  logger?: { warn: (msg: string) => void },
): "left" | "right" | undefined {
  if (input === "right" || input === "left") {
    return input;
  } else if (input !== undefined) {
    logger?.warn(
      `Invalid sidebarPosition: ${JSON.stringify(input)}, must be "left" or "right"`,
    );
  }
  return undefined;
}

export function parseOptions(inputOptions: unknown): MagentaOptions {
  const options: MagentaOptions = {
    profiles: [],
    activeProfile: "",
    sidebarPosition: "left",
    commandAllowlist: [],
    autoContext: [],
  };

  if (typeof inputOptions == "object" && inputOptions != null) {
    const inputOptionsObj = inputOptions as { [key: string]: unknown };

    // Parse sidebar position
    const sidebarPosition = parseSidebarPosition(
      inputOptionsObj["sidebarPosition"],
    );
    if (sidebarPosition) {
      options.sidebarPosition = sidebarPosition;
    }

    // Parse command allowlist
    options.commandAllowlist = parseStringArray(
      inputOptionsObj["commandAllowlist"],
      "commandAllowlist",
    );

    // Parse profiles (throw errors for invalid profiles in main config)
    options.profiles = parseProfiles(inputOptionsObj["profiles"], {
      warn: (msg) => {
        throw new Error(msg);
      },
    });

    if (options.profiles.length == 0) {
      throw new Error(`Invalid profiles provided`);
    }
    options.activeProfile = options.profiles[0].name;

    // Parse auto context
    options.autoContext = parseStringArray(
      inputOptionsObj["autoContext"],
      "autoContext",
    );
  }

  return options;
}

export function parseProjectOptions(
  inputOptions: unknown,
  logger?: { warn: (msg: string) => void },
): Partial<MagentaOptions> {
  const options: Partial<MagentaOptions> = {};

  if (typeof inputOptions !== "object" || inputOptions === null) {
    logger?.warn("Project options must be an object");
    return options;
  }

  const inputOptionsObj = inputOptions as { [key: string]: unknown };

  // Parse sidebar position
  const sidebarPosition = parseSidebarPosition(
    inputOptionsObj["sidebarPosition"],
    logger,
  );
  if (sidebarPosition) {
    options.sidebarPosition = sidebarPosition;
  }

  // Parse command allowlist
  if ("commandAllowlist" in inputOptionsObj) {
    options.commandAllowlist = parseStringArray(
      inputOptionsObj["commandAllowlist"],
      "commandAllowlist",
      logger,
    );
  }

  // Parse profiles
  if ("profiles" in inputOptionsObj) {
    const profiles = parseProfiles(inputOptionsObj["profiles"], logger);
    if (profiles.length > 0) {
      options.profiles = profiles;
      // Set active profile to first one if not explicitly set
      if (!("activeProfile" in inputOptionsObj)) {
        options.activeProfile = profiles[0].name;
      }
    }
  }

  // Parse active profile
  if ("activeProfile" in inputOptionsObj) {
    if (typeof inputOptionsObj["activeProfile"] === "string") {
      options.activeProfile = inputOptionsObj["activeProfile"];
    } else {
      logger?.warn("activeProfile must be a string");
    }
  }

  // Parse auto context
  if ("autoContext" in inputOptionsObj) {
    options.autoContext = parseStringArray(
      inputOptionsObj["autoContext"],
      "autoContext",
      logger,
    );
  }

  return options;
}

export function loadProjectSettings(
  cwd: string,
  logger?: { warn: (msg: string) => void },
): Partial<MagentaOptions> | undefined {
  const settingsPath = path.join(cwd, ".magenta", "options.json");

  try {
    if (fs.existsSync(settingsPath)) {
      const fileContent = fs.readFileSync(settingsPath, "utf8");
      const rawSettings = JSON.parse(fileContent) as unknown;

      return parseProjectOptions(rawSettings, logger);
    }
  } catch (error) {
    logger?.warn(
      `Failed to parse project settings at ${settingsPath}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  return undefined;
}

export function mergeOptions(
  baseOptions: MagentaOptions,
  projectSettings: Partial<MagentaOptions>,
): MagentaOptions {
  const merged: MagentaOptions = { ...baseOptions };

  if (projectSettings.profiles && projectSettings.profiles.length > 0) {
    merged.profiles = projectSettings.profiles;
    merged.activeProfile = projectSettings.profiles[0].name;
  }

  if (projectSettings.commandAllowlist) {
    merged.commandAllowlist = [
      ...baseOptions.commandAllowlist,
      ...projectSettings.commandAllowlist,
    ];
  }

  if (projectSettings.autoContext) {
    merged.autoContext = [
      ...baseOptions.autoContext,
      ...projectSettings.autoContext,
    ];
  }

  if (projectSettings.sidebarPosition !== undefined) {
    merged.sidebarPosition = projectSettings.sidebarPosition;
  }

  return merged;
}
