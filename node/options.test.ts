import { describe, expect, it } from "vitest";
import {
  DEFAULT_SANDBOX_CONFIG,
  type MagentaOptions,
  mergeOptions,
  parseOptions,
  parseProjectOptions,
} from "./options.ts";

function makeBaseOptions(overrides?: Partial<MagentaOptions>): MagentaOptions {
  return {
    profiles: [
      { name: "test", provider: "mock", model: "mock", fastModel: "mock-fast" },
    ],
    activeProfile: "test",
    sidebarPosition: "left",
    sidebarPositionOpts: {
      above: { displayHeightPercentage: 0.3, inputHeightPercentage: 0.1 },
      below: { displayHeightPercentage: 0.3, inputHeightPercentage: 0.1 },
      tab: { displayHeightPercentage: 0.8 },
      left: { widthPercentage: 0.4, displayHeightPercentage: 0.8 },
      right: { widthPercentage: 0.4, displayHeightPercentage: 0.8 },
    },
    maxConcurrentSubagents: 3,
    sandbox: structuredClone(DEFAULT_SANDBOX_CONFIG),
    autoContext: [],
    skillsPaths: [],
    agentsPaths: [],
    mcpServers: {},
    customCommands: [],
    ...overrides,
  };
}

const noopLogger = {
  warn: () => {},
  error: () => {},
};

describe("parseSandboxConfig", () => {
  it("should parse valid sandbox config", () => {
    const input = {
      profiles: [{ name: "test", provider: "mock" }],
      sandbox: {
        enabled: true,
        filesystem: {
          allowWrite: ["/tmp"],
          denyWrite: [".secret"],
          denyRead: ["~/.ssh"],
        },
        network: {
          allowedDomains: ["example.com"],
          deniedDomains: ["evil.com"],
        },
      },
    };
    const result = parseOptions(input, noopLogger);
    expect(result.sandbox).toEqual({
      enabled: true,
      filesystem: {
        allowWrite: ["/tmp"],
        denyWrite: [".secret"],
        denyRead: ["~/.ssh"],
      },
      network: {
        allowedDomains: ["example.com"],
        deniedDomains: ["evil.com"],
      },
    });
  });

  it("should fill defaults for missing fields", () => {
    const input = {
      profiles: [{ name: "test", provider: "mock" }],
      sandbox: {
        enabled: false,
      },
    };
    const result = parseOptions(input, noopLogger);
    expect(result.sandbox.enabled).toBe(false);
    expect(result.sandbox.filesystem).toEqual(
      DEFAULT_SANDBOX_CONFIG.filesystem,
    );
    expect(result.sandbox.network).toEqual(DEFAULT_SANDBOX_CONFIG.network);
  });

  it("should use all defaults when sandbox is not provided", () => {
    const input = {
      profiles: [{ name: "test", provider: "mock" }],
    };
    const result = parseOptions(input, noopLogger);
    expect(result.sandbox).toEqual(DEFAULT_SANDBOX_CONFIG);
  });
});

describe("parseProjectOptions sandbox", () => {
  it("should parse sandbox from project options", () => {
    const result = parseProjectOptions(
      {
        sandbox: {
          enabled: false,
          filesystem: { denyRead: ["/secret"] },
        },
      },
      noopLogger,
    );
    expect(result.sandbox?.enabled).toBe(false);
    expect(result.sandbox?.filesystem.denyRead).toEqual(["/secret"]);
    expect(result.sandbox?.filesystem.allowWrite).toEqual(
      DEFAULT_SANDBOX_CONFIG.filesystem.allowWrite,
    );
  });
});

describe("mergeOptions", () => {
  it("should concatenate sandbox arrays and overwrite enabled", () => {
    const base = makeBaseOptions({
      sandbox: {
        enabled: true,
        filesystem: {
          allowWrite: ["./"],
          denyWrite: [".env"],
          denyRead: ["~/.ssh"],
        },
        network: {
          allowedDomains: ["registry.npmjs.org"],
          deniedDomains: [],
        },
      },
    });

    const merged = mergeOptions(base, {
      sandbox: {
        enabled: false,
        filesystem: {
          allowWrite: ["/tmp"],
          denyWrite: [".git/hooks/"],
          denyRead: ["~/.aws"],
        },
        network: {
          allowedDomains: ["github.com"],
          deniedDomains: ["evil.com"],
        },
      },
    });

    expect(merged.sandbox.enabled).toBe(false);
    expect(merged.sandbox.filesystem.allowWrite).toEqual(["./", "/tmp"]);
    expect(merged.sandbox.filesystem.denyWrite).toEqual([
      ".env",
      ".git/hooks/",
    ]);
    expect(merged.sandbox.filesystem.denyRead).toEqual(["~/.ssh", "~/.aws"]);
    expect(merged.sandbox.network.allowedDomains).toEqual([
      "registry.npmjs.org",
      "github.com",
    ]);
    expect(merged.sandbox.network.deniedDomains).toEqual(["evil.com"]);
  });

  it("should keep base sandbox when project has no sandbox", () => {
    const base = makeBaseOptions();
    const merged = mergeOptions(base, {});
    expect(merged.sandbox).toEqual(base.sandbox);
  });
});
