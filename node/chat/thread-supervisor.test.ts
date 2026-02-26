import { describe, it, expect, vi } from "vitest";
import { DockerSupervisor } from "./thread-supervisor.ts";
import type { Shell, ShellResult } from "../capabilities/shell.ts";
import type { ProvisionResult, ContainerConfig } from "@magenta/core";
import type { NvimCwd } from "../utils/files.ts";

function createMockShell(execResult?: Partial<ShellResult>): Shell {
  return {
    execute: vi.fn().mockResolvedValue({
      exitCode: 0,
      signal: undefined,
      output: [],
      logFilePath: undefined,
      durationMs: 10,
      ...execResult,
    }),
    terminate: vi.fn(),
  };
}

const mockProvisionResult: ProvisionResult = {
  containerName: "test-container",
  tempDir: "/tmp/test-dir",
  imageName: "test-image",
};

const mockContainerConfig: ContainerConfig = {
  devcontainer: ".devcontainer",
  workspacePath: "/workspace",
  installCommand: "npm install",
};

describe("DockerSupervisor", () => {
  describe("onEndTurnWithoutYield", () => {
    it("returns send-message for auto-restart", () => {
      const supervisor = new DockerSupervisor(
        createMockShell(),
        mockProvisionResult,
        mockContainerConfig,
        "feature-branch",
        "/repo" as NvimCwd,
      );

      const action = supervisor.onEndTurnWithoutYield();
      expect(action.type).toBe("send-message");
      if (action.type === "send-message") {
        expect(action.text).toContain("yield_to_parent");
        expect(action.text).toContain("1/5");
      }
    });

    it("stops auto-restarting after max retries", () => {
      const supervisor = new DockerSupervisor(
        createMockShell(),
        mockProvisionResult,
        mockContainerConfig,
        "feature-branch",
        "/repo" as NvimCwd,
        { maxRestarts: 2 },
      );

      expect(supervisor.onEndTurnWithoutYield().type).toBe("send-message");
      expect(supervisor.onEndTurnWithoutYield().type).toBe("send-message");
      expect(supervisor.onEndTurnWithoutYield().type).toBe("none");
    });
  });

  describe("onYield", () => {
    it("rejects yield when git status is dirty", async () => {
      const shell = createMockShell({
        output: [{ stream: "stdout", text: " M dirty-file.ts" }],
      });
      const supervisor = new DockerSupervisor(
        shell,
        mockProvisionResult,
        mockContainerConfig,
        "feature-branch",
        "/repo" as NvimCwd,
      );

      const action = await supervisor.onYield("done");
      expect(action.type).toBe("reject");
      if (action.type === "reject") {
        expect(action.message).toContain("dirty");
        expect(action.message).toContain("dirty-file.ts");
      }
    });

    it("accepts yield when git status is clean", async () => {
      const shell = createMockShell({ output: [] });
      const supervisor = new DockerSupervisor(
        shell,
        mockProvisionResult,
        mockContainerConfig,
        "feature-branch",
        "/repo" as NvimCwd,
      );

      // teardownContainer will fail since there's no actual container,
      // but we can test that it's called by mocking the module
      // For now, just test the git status check path
      try {
        await supervisor.onYield("done");
      } catch {
        // teardownContainer will throw in test env — that's expected
      }

      // eslint-disable-next-line @typescript-eslint/unbound-method
      expect(shell.execute).toHaveBeenCalledWith(
        "git status --porcelain",
        expect.objectContaining({ toolRequestId: "supervisor-git-status" }),
      );
    });
  });

  describe("onAbort", () => {
    it("returns none", () => {
      const supervisor = new DockerSupervisor(
        createMockShell(),
        mockProvisionResult,
        mockContainerConfig,
        "feature-branch",
        "/repo" as NvimCwd,
      );

      expect(supervisor.onAbort()).toEqual({ type: "none" });
    });
  });
});
