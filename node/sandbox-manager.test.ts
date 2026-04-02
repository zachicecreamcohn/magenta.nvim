import { describe, it, expect, vi, beforeEach } from "vitest";
import type { HomeDir, NvimCwd } from "./utils/files.ts";
import type { SandboxConfig } from "./options.ts";
import { DEFAULT_SANDBOX_CONFIG } from "./options.ts";

const mockInitialize = vi.fn().mockResolvedValue(undefined);
const mockIsSupportedPlatform = vi.fn().mockReturnValue(true);
const mockCheckDependencies = vi
  .fn()
  .mockReturnValue({ warnings: [] as string[], errors: [] as string[] });
const mockUpdateConfig = vi.fn();
const mockReset = vi.fn().mockResolvedValue(undefined);

vi.mock("@anthropic-ai/sandbox-runtime", () => ({
  SandboxManager: {
    initialize: (...args: unknown[]) => mockInitialize(...args),
    isSupportedPlatform: () => mockIsSupportedPlatform(),
    checkDependencies: () => mockCheckDependencies(),
    updateConfig: (...args: unknown[]) => mockUpdateConfig(...args),
    reset: () => mockReset(),
  },
}));

const cwd = "/home/user/project" as NvimCwd;
const homeDir = "/home/user" as HomeDir;

function makeConfig(overrides?: Partial<SandboxConfig>): SandboxConfig {
  return structuredClone({ ...DEFAULT_SANDBOX_CONFIG, ...overrides });
}

describe("sandbox-manager", () => {
  let getSandboxState: typeof import("./sandbox-manager.ts").getSandboxState;
  let initializeSandbox: typeof import("./sandbox-manager.ts").initializeSandbox;
  let updateSandboxConfigIfChanged: typeof import("./sandbox-manager.ts").updateSandboxConfigIfChanged;
  let resetSandbox: typeof import("./sandbox-manager.ts").resetSandbox;
  let resolveConfigPaths: typeof import("./sandbox-manager.ts").resolveConfigPaths;

  beforeEach(async () => {
    vi.resetModules();

    // Reset mock implementations to defaults
    mockInitialize.mockReset().mockResolvedValue(undefined);
    mockIsSupportedPlatform.mockReset().mockReturnValue(true);
    mockCheckDependencies
      .mockReset()
      .mockReturnValue({ warnings: [], errors: [] });
    mockUpdateConfig.mockReset();
    mockReset.mockReset().mockResolvedValue(undefined);
    logger.warn.mockReset();

    // Re-register the mock before re-importing
    vi.doMock("@anthropic-ai/sandbox-runtime", () => ({
      SandboxManager: {
        initialize: (...args: unknown[]) => mockInitialize(...args),
        isSupportedPlatform: () => mockIsSupportedPlatform(),
        checkDependencies: () => mockCheckDependencies(),
        updateConfig: (...args: unknown[]) => mockUpdateConfig(...args),
        reset: () => mockReset(),
      },
    }));

    const mod = await import("./sandbox-manager.ts");
    getSandboxState = mod.getSandboxState;
    initializeSandbox = mod.initializeSandbox;
    updateSandboxConfigIfChanged = mod.updateSandboxConfigIfChanged;
    resetSandbox = mod.resetSandbox;
    resolveConfigPaths = mod.resolveConfigPaths;
  });

  const logger = {
    warn: vi.fn(),
  };

  describe("initializeSandbox", () => {
    it("disabled config sets state to disabled, SandboxManager.initialize not called", async () => {
      const config = makeConfig({ enabled: false });
      const result = await initializeSandbox(
        config,
        cwd,
        homeDir,
        undefined,
        logger,
      );
      expect(result).toEqual({ status: "disabled" });
      expect(getSandboxState()).toEqual({ status: "disabled" });
      expect(mockInitialize).not.toHaveBeenCalled();
    });

    it("unsupported platform sets state to unsupported, logger.warn called", async () => {
      mockIsSupportedPlatform.mockReturnValue(false);
      const config = makeConfig();
      const result = await initializeSandbox(
        config,
        cwd,
        homeDir,
        undefined,
        logger,
      );
      expect(result).toEqual({
        status: "unsupported",
        reason: "Sandbox is not supported on this platform",
      });
      expect(getSandboxState()).toEqual({
        status: "unsupported",
        reason: "Sandbox is not supported on this platform",
      });
      expect(logger.warn).toHaveBeenCalled();
      expect(mockInitialize).not.toHaveBeenCalled();
    });

    it("dependency errors set state to unsupported with reason", async () => {
      mockCheckDependencies.mockReturnValue({
        warnings: [],
        errors: ["bwrap not found"],
      });
      const config = makeConfig();
      const result = await initializeSandbox(
        config,
        cwd,
        homeDir,
        undefined,
        logger,
      );
      expect(result.status).toBe("unsupported");
      if (result.status === "unsupported") {
        expect(result.reason).toContain("bwrap not found");
      }
      expect(logger.warn).toHaveBeenCalled();
      expect(mockInitialize).not.toHaveBeenCalled();
    });

    it("successful init sets state to ready, SandboxManager.initialize called with resolved paths", async () => {
      const config = makeConfig();
      const askCallback = vi
        .fn()
        .mockResolvedValue(true) as unknown as import("@anthropic-ai/sandbox-runtime").SandboxAskCallback;
      const result = await initializeSandbox(
        config,
        cwd,
        homeDir,
        askCallback,
        logger,
      );
      expect(result).toEqual({ status: "ready" });
      expect(getSandboxState()).toEqual({ status: "ready" });
      expect(mockInitialize).toHaveBeenCalledOnce();
      const calledConfig = mockInitialize.mock.calls[0][0] as import("@anthropic-ai/sandbox-runtime").SandboxRuntimeConfig;
      expect(calledConfig.filesystem.allowWrite).toEqual(
        expect.arrayContaining(["/home/user/project"]),
      );
      expect(mockInitialize.mock.calls[0][2]).toBe(true);
    });

    it("dependency warnings are logged but do not prevent initialization", async () => {
      mockCheckDependencies.mockReturnValue({
        warnings: ["seccomp not available"],
        errors: [],
      });
      const config = makeConfig();
      await initializeSandbox(config, cwd, homeDir, undefined, logger);
      expect(getSandboxState()).toEqual({ status: "ready" });
      expect(logger.warn).toHaveBeenCalledWith(
        "Sandbox dependency warning: seccomp not available",
      );
      expect(mockInitialize).toHaveBeenCalledOnce();
    });
  });

  describe("resolveConfigPaths", () => {
    it("expands ~/ to homeDir", () => {
      const config = makeConfig({
        filesystem: {
          allowWrite: [],
          denyWrite: [],
          denyRead: ["~/.ssh"],
        },
      });
      const resolved = resolveConfigPaths(config, cwd, homeDir);
      expect(resolved.filesystem.denyRead).toEqual(["/home/user/.ssh"]);
    });

    it("expands ./ to cwd", () => {
      const config = makeConfig({
        filesystem: {
          allowWrite: ["./"],
          denyWrite: [],
          denyRead: [],
        },
      });
      const resolved = resolveConfigPaths(config, cwd, homeDir);
      expect(resolved.filesystem.allowWrite).toEqual(["/home/user/project"]);
    });

    it("leaves absolute paths unchanged", () => {
      const config = makeConfig({
        filesystem: {
          allowWrite: ["/tmp/build"],
          denyWrite: [],
          denyRead: [],
        },
      });
      const resolved = resolveConfigPaths(config, cwd, homeDir);
      expect(resolved.filesystem.allowWrite).toEqual(["/tmp/build"]);
    });

    it("resolves relative paths to cwd-relative", () => {
      const config = makeConfig({
        filesystem: {
          allowWrite: ["src/output"],
          denyWrite: [],
          denyRead: [],
        },
      });
      const resolved = resolveConfigPaths(config, cwd, homeDir);
      expect(resolved.filesystem.allowWrite).toEqual([
        "/home/user/project/src/output",
      ]);
    });

    it("passes network config through unchanged", () => {
      const config = makeConfig({
        network: {
          allowedDomains: ["example.com"],
          deniedDomains: ["evil.com"],
        },
      });
      const resolved = resolveConfigPaths(config, cwd, homeDir);
      expect(resolved.network.allowedDomains).toEqual(["example.com"]);
      expect(resolved.network.deniedDomains).toEqual(["evil.com"]);
    });
  });

  describe("updateSandboxConfigIfChanged", () => {
    it("does not call updateConfig when config is unchanged", async () => {
      const config = makeConfig();
      await initializeSandbox(config, cwd, homeDir, undefined, logger);
      mockUpdateConfig.mockClear();

      updateSandboxConfigIfChanged(config, cwd, homeDir);
      expect(mockUpdateConfig).not.toHaveBeenCalled();
    });

    it("calls updateConfig when config has changed", async () => {
      const config = makeConfig();
      await initializeSandbox(config, cwd, homeDir, undefined, logger);
      mockUpdateConfig.mockClear();

      const changedConfig = makeConfig({
        filesystem: {
          allowWrite: ["./", "/tmp"],
          denyWrite: [".env"],
          denyRead: [],
        },
      });
      updateSandboxConfigIfChanged(changedConfig, cwd, homeDir);
      expect(mockUpdateConfig).toHaveBeenCalledOnce();
      const calledConfig = mockUpdateConfig.mock.calls[0][0] as import("@anthropic-ai/sandbox-runtime").SandboxRuntimeConfig;
      expect(calledConfig.filesystem.allowWrite).toContain("/tmp");
    });
  });

  describe("resetSandbox", () => {
    it("resets state to uninitialized and calls SandboxManager.reset", async () => {
      const config = makeConfig();
      await initializeSandbox(config, cwd, homeDir, undefined, logger);
      expect(getSandboxState()).toEqual({ status: "ready" });

      await resetSandbox();
      expect(getSandboxState()).toEqual({ status: "uninitialized" });
      expect(mockReset).toHaveBeenCalledOnce();
    });
  });
});
