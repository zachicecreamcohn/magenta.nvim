import { describe, expect, it } from "vitest";
import type { Nvim } from "../../nvim/nvim-node/index.ts";
import type { HomeDir, NvimCwd } from "../../utils/files.ts";
import { absolutizeFileRefs, expandEditorCommands } from "./editor-commands.ts";

const cwd = "/proj" as NvimCwd;
const homeDir = "/home/me" as HomeDir;

describe("absolutizeFileRefs", () => {
  it("resolves relative and ~ paths, leaves absolute ones", () => {
    expect(
      absolutizeFileRefs(
        "see @file:a.ts and @file:~/b.ts and @file:/abs/c.ts end",
        cwd,
        homeDir,
      ),
    ).toBe(
      "see @file:/proj/a.ts and @file:/home/me/b.ts and @file:/abs/c.ts end",
    );
  });
});

describe("expandEditorCommands", () => {
  it("reports a failed expansion per match, in command order", async () => {
    const nvim = {
      call: () => Promise.reject(new Error("boom")),
      logger: { error: () => {} },
    } as unknown as Nvim;
    const result = await expandEditorCommands("@buf @buf x", {
      nvim,
      cwd,
      homeDir,
    });
    expect(result).toBe(
      "@buf @buf x\n\nError fetching buffers list: boom\n\nError fetching buffers list: boom",
    );
  });
});
