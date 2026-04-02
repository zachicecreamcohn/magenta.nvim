import type { FileIO } from "@magenta/core";
import { beforeEach, describe, expect, test, vi } from "vitest";
import type { HomeDir, NvimCwd } from "../utils/files.ts";
import { setSandboxState } from "../sandbox-manager.ts";
import { SandboxFileIO } from "./sandbox-file-io.ts";

vi.mock("@anthropic-ai/sandbox-runtime", () => {
  return {
    SandboxManager: {
      getFsReadConfig: vi.fn(),
      getFsWriteConfig: vi.fn(),
    },
  };
});

import { SandboxManager } from "@anthropic-ai/sandbox-runtime";

const mockedGetFsReadConfig = vi.mocked(SandboxManager.getFsReadConfig);
const mockedGetFsWriteConfig = vi.mocked(SandboxManager.getFsWriteConfig);

function createMockFileIO(): FileIO & {
  readFile: ReturnType<typeof vi.fn>;
  readBinaryFile: ReturnType<typeof vi.fn>;
  writeFile: ReturnType<typeof vi.fn>;
  fileExists: ReturnType<typeof vi.fn>;
  mkdir: ReturnType<typeof vi.fn>;
  stat: ReturnType<typeof vi.fn>;
} {
  return {
    readFile: vi.fn().mockResolvedValue("file content"),
    readBinaryFile: vi.fn().mockResolvedValue(Buffer.from("binary")),
    writeFile: vi.fn().mockResolvedValue(undefined),
    fileExists: vi.fn().mockResolvedValue(true),
    mkdir: vi.fn().mockResolvedValue(undefined),
    stat: vi.fn().mockResolvedValue({ mtimeMs: 1000, size: 42 }),
  };
}

const cwd = "/test/cwd" as NvimCwd;
const homeDir = "/test/home" as HomeDir;

function createSandboxIO(
  inner: FileIO,
  promptForWriteApproval: (absPath: string) => Promise<void> = vi.fn(),
) {
  return new SandboxFileIO(inner, { cwd, homeDir }, promptForWriteApproval);
}

describe("SandboxFileIO", () => {
  let mockIO: ReturnType<typeof createMockFileIO>;

  beforeEach(() => {
    mockIO = createMockFileIO();
    vi.clearAllMocks();
  });

  describe("when sandbox is ready", () => {
    beforeEach(() => {
      setSandboxState({ status: "ready" });
    });

    describe("reads", () => {
      test("read allowed path delegates to inner", async () => {
        mockedGetFsReadConfig.mockReturnValue({
          denyOnly: ["/test/home/.ssh"],
        });

        const sio = createSandboxIO(mockIO);
        const result = await sio.readFile("/test/cwd/src/file.ts");
        expect(result).toBe("file content");
        expect(mockIO.readFile).toHaveBeenCalledWith("/test/cwd/src/file.ts");
      });

      test("read denied path throws", async () => {
        mockedGetFsReadConfig.mockReturnValue({
          denyOnly: ["/test/home/.ssh"],
        });

        const sio = createSandboxIO(mockIO);
        await expect(
          sio.readFile("/test/home/.ssh/id_rsa"),
        ).rejects.toThrow("Sandbox: read access denied");
        expect(mockIO.readFile).not.toHaveBeenCalled();
      });

      test("read deny exact path match", async () => {
        mockedGetFsReadConfig.mockReturnValue({
          denyOnly: ["/test/home/.ssh"],
        });

        const sio = createSandboxIO(mockIO);
        await expect(
          sio.readFile("/test/home/.ssh"),
        ).rejects.toThrow("Sandbox: read access denied");
      });

      test("read deny prefix does not match non-child paths", async () => {
        mockedGetFsReadConfig.mockReturnValue({
          denyOnly: ["/test/home/.ssh"],
        });

        const sio = createSandboxIO(mockIO);
        const result = await sio.readFile("/test/home/.sshrc");
        expect(result).toBe("file content");
        expect(mockIO.readFile).toHaveBeenCalled();
      });

      test("readBinaryFile denied path throws", async () => {
        mockedGetFsReadConfig.mockReturnValue({
          denyOnly: ["/test/home/.aws"],
        });

        const sio = createSandboxIO(mockIO);
        await expect(
          sio.readBinaryFile("/test/home/.aws/credentials"),
        ).rejects.toThrow("Sandbox: read access denied");
        expect(mockIO.readBinaryFile).not.toHaveBeenCalled();
      });

      test("readBinaryFile allowed path delegates to inner", async () => {
        mockedGetFsReadConfig.mockReturnValue({
          denyOnly: ["/test/home/.ssh"],
        });

        const sio = createSandboxIO(mockIO);
        const result = await sio.readBinaryFile("/test/cwd/image.png");
        expect(result).toEqual(Buffer.from("binary"));
        expect(mockIO.readBinaryFile).toHaveBeenCalledWith(
          "/test/cwd/image.png",
        );
      });

      test("allowWithinDeny re-allows denied paths", async () => {
        mockedGetFsReadConfig.mockReturnValue({
          denyOnly: ["/test/home/.config"],
          allowWithinDeny: ["/test/home/.config/nvim"],
        });

        const sio = createSandboxIO(mockIO);
        const result = await sio.readFile("/test/home/.config/nvim/init.lua");
        expect(result).toBe("file content");
        expect(mockIO.readFile).toHaveBeenCalled();
      });

      test("allowWithinDeny does not re-allow sibling paths", async () => {
        mockedGetFsReadConfig.mockReturnValue({
          denyOnly: ["/test/home/.config"],
          allowWithinDeny: ["/test/home/.config/nvim"],
        });

        const sio = createSandboxIO(mockIO);
        await expect(
          sio.readFile("/test/home/.config/secrets/key"),
        ).rejects.toThrow("Sandbox: read access denied");
      });
    });

    describe("writes", () => {
      test("write to allowed path delegates to inner", async () => {
        mockedGetFsWriteConfig.mockReturnValue({
          allowOnly: ["/test/cwd"],
          denyWithinAllow: [],
        });

        const sio = createSandboxIO(mockIO);
        await sio.writeFile("/test/cwd/src/file.ts", "content");
        expect(mockIO.writeFile).toHaveBeenCalledWith(
          "/test/cwd/src/file.ts",
          "content",
        );
      });

      test("write outside allowOnly prompts", async () => {
        mockedGetFsWriteConfig.mockReturnValue({
          allowOnly: ["/test/cwd"],
          denyWithinAllow: [],
        });

        const prompt = vi.fn().mockResolvedValue(undefined);
        const sio = createSandboxIO(mockIO, prompt);
        await sio.writeFile("/outside/file.txt", "data");
        expect(prompt).toHaveBeenCalledWith("/outside/file.txt");
        expect(mockIO.writeFile).toHaveBeenCalledWith(
          "/outside/file.txt",
          "data",
        );
      });

      test("write to denyWithinAllow prompts", async () => {
        mockedGetFsWriteConfig.mockReturnValue({
          allowOnly: ["/test/cwd"],
          denyWithinAllow: ["/test/cwd/.env"],
        });

        const prompt = vi.fn().mockResolvedValue(undefined);
        const sio = createSandboxIO(mockIO, prompt);
        await sio.writeFile("/test/cwd/.env", "SECRET=x");
        expect(prompt).toHaveBeenCalledWith("/test/cwd/.env");
        expect(mockIO.writeFile).toHaveBeenCalled();
      });

      test("write denied when prompt rejects", async () => {
        mockedGetFsWriteConfig.mockReturnValue({
          allowOnly: ["/test/cwd"],
          denyWithinAllow: [],
        });

        const prompt = vi
          .fn()
          .mockRejectedValue(new Error("User denied write"));
        const sio = createSandboxIO(mockIO, prompt);
        await expect(
          sio.writeFile("/outside/file.txt", "data"),
        ).rejects.toThrow("User denied write");
        expect(mockIO.writeFile).not.toHaveBeenCalled();
      });

      test("write denyWithinAllow prefix does not match non-child", async () => {
        mockedGetFsWriteConfig.mockReturnValue({
          allowOnly: ["/test/cwd"],
          denyWithinAllow: ["/test/cwd/.env"],
        });

        const sio = createSandboxIO(mockIO);
        await sio.writeFile("/test/cwd/.environment", "data");
        expect(mockIO.writeFile).toHaveBeenCalled();
      });
    });
  });

  describe("when sandbox is disabled", () => {
    beforeEach(() => {
      setSandboxState({ status: "disabled" });
    });

    test("reads are allowed without prompt", async () => {
      const sio = createSandboxIO(mockIO);
      const result = await sio.readFile("/anywhere/file.txt");
      expect(result).toBe("file content");
      expect(mockIO.readFile).toHaveBeenCalled();
    });

    test("writes prompt for every write", async () => {
      const prompt = vi.fn().mockResolvedValue(undefined);
      const sio = createSandboxIO(mockIO, prompt);
      await sio.writeFile("/test/cwd/file.ts", "data");
      expect(prompt).toHaveBeenCalledWith("/test/cwd/file.ts");
      expect(mockIO.writeFile).toHaveBeenCalled();
    });

    test("write denied when prompt rejects", async () => {
      const prompt = vi
        .fn()
        .mockRejectedValue(new Error("User denied write"));
      const sio = createSandboxIO(mockIO, prompt);
      await expect(
        sio.writeFile("/test/cwd/file.ts", "data"),
      ).rejects.toThrow("User denied write");
      expect(mockIO.writeFile).not.toHaveBeenCalled();
    });
  });

  describe("when sandbox is unsupported", () => {
    beforeEach(() => {
      setSandboxState({ status: "unsupported", reason: "Linux not supported" });
    });

    test("reads are allowed without prompt", async () => {
      const sio = createSandboxIO(mockIO);
      const result = await sio.readFile("/anywhere/file.txt");
      expect(result).toBe("file content");
    });

    test("writes prompt for every write", async () => {
      const prompt = vi.fn().mockResolvedValue(undefined);
      const sio = createSandboxIO(mockIO, prompt);
      await sio.writeFile("/test/cwd/file.ts", "data");
      expect(prompt).toHaveBeenCalledWith("/test/cwd/file.ts");
    });
  });

  describe("when sandbox is uninitialized", () => {
    beforeEach(() => {
      setSandboxState({ status: "uninitialized" });
    });

    test("reads are allowed without prompt", async () => {
      const sio = createSandboxIO(mockIO);
      const result = await sio.readFile("/anywhere/file.txt");
      expect(result).toBe("file content");
    });

    test("writes prompt for every write", async () => {
      const prompt = vi.fn().mockResolvedValue(undefined);
      const sio = createSandboxIO(mockIO, prompt);
      await sio.writeFile("/test/cwd/file.ts", "data");
      expect(prompt).toHaveBeenCalled();
    });
  });

  describe("passthrough methods", () => {
    test("fileExists passes through without checks", async () => {
      setSandboxState({ status: "ready" });
      const sio = createSandboxIO(mockIO);
      const result = await sio.fileExists("/anywhere/file.txt");
      expect(result).toBe(true);
      expect(mockIO.fileExists).toHaveBeenCalledWith("/anywhere/file.txt");
    });

    test("mkdir passes through without checks", async () => {
      setSandboxState({ status: "ready" });
      const sio = createSandboxIO(mockIO);
      await sio.mkdir("/anywhere/dir");
      expect(mockIO.mkdir).toHaveBeenCalledWith("/anywhere/dir");
    });

    test("stat passes through without checks", async () => {
      setSandboxState({ status: "ready" });
      const sio = createSandboxIO(mockIO);
      const result = await sio.stat("/anywhere/file.txt");
      expect(result).toEqual({ mtimeMs: 1000, size: 42 });
      expect(mockIO.stat).toHaveBeenCalledWith("/anywhere/file.txt");
    });
  });

  describe("path resolution", () => {
    test("resolves relative paths before checking", async () => {
      setSandboxState({ status: "ready" });
      mockedGetFsReadConfig.mockReturnValue({
        denyOnly: ["/test/home/.ssh"],
      });

      const sio = createSandboxIO(mockIO);
      // "src/file.ts" resolves to "/test/cwd/src/file.ts"
      const result = await sio.readFile("src/file.ts");
      expect(result).toBe("file content");
    });

    test("resolves tilde paths before checking", async () => {
      setSandboxState({ status: "ready" });
      mockedGetFsReadConfig.mockReturnValue({
        denyOnly: ["/test/home/.ssh"],
      });

      const sio = createSandboxIO(mockIO);
      await expect(sio.readFile("~/.ssh/id_rsa")).rejects.toThrow(
        "Sandbox: read access denied",
      );
    });
  });
});
