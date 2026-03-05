import { describe, it, expect, vi } from "vitest";
import {
  CoreContextManager,
  InMemoryFileIO,
  type DiffUpdate,
} from "@magenta/core";
import {
  FileCategory,
  type AbsFilePath,
  type RelFilePath,
} from "../utils/files.ts";
import type { NvimCwd, HomeDir } from "../utils/files.ts";

function createTestContextManager(files: Record<string, string>) {
  const fileIO = new InMemoryFileIO(files);
  const mockLogger = {
    error: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
  };

  const cm = new CoreContextManager(
    mockLogger,
    fileIO,
    "/test" as NvimCwd,
    "/home" as HomeDir,
  );

  return { cm, fileIO };
}

const TEST_PATH = "/test/file.txt" as AbsFilePath;
const TEST_REL = "file.txt" as RelFilePath;
const TEXT_FILE_TYPE = {
  category: FileCategory.TEXT,
  mimeType: "text/plain",
  extension: ".txt",
};

describe("ContextManager unit tests", () => {
  it("get_file sets agentView", async () => {
    const { cm } = createTestContextManager({
      [TEST_PATH]: "hello world",
    });

    cm.toolApplied(
      TEST_PATH,
      { type: "get-file", content: "hello world" },
      TEXT_FILE_TYPE,
    );

    expect(cm.files[TEST_PATH].agentView).toEqual({
      type: "text",
      content: "hello world",
    });

    // No update needed since content hasn't changed
    const updates = await cm.getContextUpdate();
    expect(Object.keys(updates).length).toBe(0);
  });

  it("edl-edit sets agentView", async () => {
    const { cm } = createTestContextManager({
      [TEST_PATH]: "edited content",
    });

    cm.toolApplied(
      TEST_PATH,
      { type: "edl-edit", content: "edited content" },
      TEXT_FILE_TYPE,
    );

    expect(cm.files[TEST_PATH].agentView).toEqual({
      type: "text",
      content: "edited content",
    });

    // No update needed since fileIO has same content
    const updates = await cm.getContextUpdate();
    expect(Object.keys(updates).length).toBe(0);
  });

  it("file updated after agentView set returns a diff", async () => {
    const { cm, fileIO } = createTestContextManager({
      [TEST_PATH]: "original content",
    });

    // Simulate get_file tool setting agentView
    cm.toolApplied(
      TEST_PATH,
      { type: "get-file", content: "original content" },
      TEXT_FILE_TYPE,
    );

    // Simulate file being modified (e.g., by a formatter)
    await fileIO.writeFile(TEST_PATH, "formatted content");

    const updates = await cm.getContextUpdate();
    const update = updates[TEST_PATH];
    expect(update).toBeDefined();
    expect(update.update.status).toBe("ok");
    if (update.update.status !== "ok") throw new Error("Expected ok");
    expect(update.update.value.type).toBe("diff");

    const diff = update.update.value as DiffUpdate;
    expect(diff.patch).toContain("original content");
    expect(diff.patch).toContain("formatted content");
  });

  it("edl-edit followed by formatter change returns a diff", async () => {
    const { cm, fileIO } = createTestContextManager({
      [TEST_PATH]: "const x=1",
    });

    // EDL writes the file
    cm.toolApplied(
      TEST_PATH,
      { type: "edl-edit", content: "const x=1" },
      TEXT_FILE_TYPE,
    );

    // Formatter rewrites it
    await fileIO.writeFile(TEST_PATH, "const x = 1;\n");

    const updates = await cm.getContextUpdate();
    const update = updates[TEST_PATH];
    expect(update).toBeDefined();
    expect(update.update.status).toBe("ok");
    if (update.update.status !== "ok") throw new Error("Expected ok");
    expect(update.update.value.type).toBe("diff");

    const diff = update.update.value as DiffUpdate;
    expect(diff.patch).toContain("const x = 1;");
  });

  it("no update when file content matches agentView", async () => {
    const { cm } = createTestContextManager({
      [TEST_PATH]: "same content",
    });

    cm.toolApplied(
      TEST_PATH,
      { type: "get-file", content: "same content" },
      TEXT_FILE_TYPE,
    );

    const updates = await cm.getContextUpdate();
    expect(Object.keys(updates).length).toBe(0);
  });

  it("avoids redundant context update after edl tool application", async () => {
    const originalContent = "original line 1\noriginal line 2\n";
    const editedContent = "original line 1\nedited line 2\n";
    const { cm, fileIO } = createTestContextManager({
      [TEST_PATH]: originalContent,
    });

    // Add file and establish initial agentView
    cm.addFileContext(TEST_PATH, TEST_REL, TEXT_FILE_TYPE);
    await cm.getContextUpdate();

    // EDL tool writes the file and sets agentView
    await fileIO.writeFile(TEST_PATH, editedContent);
    cm.toolApplied(
      TEST_PATH,
      { type: "edl-edit", content: editedContent },
      TEXT_FILE_TYPE,
    );

    // Next context update should be empty — agent already knows the content
    const updates = await cm.getContextUpdate();
    expect(Object.keys(updates).length).toBe(0);
  });

  it("file deleted after agentView set returns file-deleted", async () => {
    const { cm, fileIO } = createTestContextManager({
      [TEST_PATH]: "some content",
    });

    cm.toolApplied(
      TEST_PATH,
      { type: "get-file", content: "some content" },
      TEXT_FILE_TYPE,
    );

    // Delete the file
    fileIO.deleteFile(TEST_PATH);

    const updates = await cm.getContextUpdate();
    const update = updates[TEST_PATH];
    expect(update).toBeDefined();
    expect(update.update.status).toBe("ok");
    if (update.update.status !== "ok") throw new Error("Expected ok");
    expect(update.update.value.type).toBe("file-deleted");

    // File should be removed from context
    expect(cm.files[TEST_PATH]).toBeUndefined();
  });
});
