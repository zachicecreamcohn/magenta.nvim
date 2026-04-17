import { describe, expect, it } from "vitest";
import type { FileIO } from "../capabilities/file-io.ts";
import type { HelpTagsProvider } from "../capabilities/help-tags-provider.ts";
import type { ProviderToolResult } from "../providers/provider-types.ts";
import type { ToolRequestId } from "../tool-types.ts";
import * as Docs from "./docs.ts";

type FileMap = Record<string, string>;

function makeFileIO(files: FileMap): FileIO {
  return {
    readFile: async (path: string) => {
      if (path in files) return files[path];
      throw new Error(`no such file: ${path}`);
    },
    readBinaryFile: async () => {
      throw new Error("unused");
    },
    writeFile: async () => {},
    fileExists: async (path: string) => path in files,
    mkdir: async () => {},
    stat: async () => undefined,
    readdir: async () => [],
    isDirectory: async () => false,
  };
}

function makeProvider(paths: string[]): HelpTagsProvider {
  return { listTagFiles: async () => paths };
}

async function resultText(invocation: {
  promise: Promise<ProviderToolResult>;
}): Promise<string> {
  const { result } = await invocation.promise;
  if (result.status === "ok") {
    return (result.value[0] as { type: "text"; text: string }).text;
  }
  return result.error;
}

const request = (query: string, id = "t1") => ({
  id: id as ToolRequestId,
  toolName: "docs" as const,
  input: { query },
});

describe("docs tool", () => {
  it("returns matching tags with resolved line numbers", async () => {
    const tagsPath = "/rt/doc/tags";
    const helpPath = "/rt/doc/magenta-skills.txt";
    const files: FileMap = {
      [tagsPath]: [
        "magenta-skills\tmagenta-skills.txt\t/*magenta-skills*",
        "magenta-other\tmagenta-other.txt\t/*magenta-other*",
      ].join("\n"),
      [helpPath]: ["intro", "more", "see *magenta-skills* here", "tail"].join(
        "\n",
      ),
    };

    const invocation = Docs.execute(request("skills"), {
      fileIO: makeFileIO(files),
      helpTagsProvider: makeProvider([tagsPath]),
    });

    const text = await resultText(invocation);
    expect(text).toContain("/rt/doc/");
    expect(text).toContain("magenta-skills.txt");
    expect(text).toContain("magenta-skills:3");
    expect(text).not.toContain("magenta-other");
  });

  it("resolves multiple tags in the same file independently", async () => {
    const tagsPath = "/rt/doc/tags";
    const helpPath = "/rt/doc/multi.txt";
    const files: FileMap = {
      [tagsPath]: ["tag1\tmulti.txt\t/*tag1*", "tag2\tmulti.txt\t/*tag2*"].join(
        "\n",
      ),
      [helpPath]: [
        "",
        "",
        "first *tag1* here",
        "",
        "",
        "",
        "second *tag2*",
      ].join("\n"),
    };

    const invocation = Docs.execute(request("tag"), {
      fileIO: makeFileIO(files),
      helpTagsProvider: makeProvider([tagsPath]),
    });

    const text = await resultText(invocation);
    const helpPathOccurrences = text.split(helpPath).length - 1;
    expect(helpPathOccurrences).toBe(0);
    expect(text).toContain("multi.txt");
    const fileCount = text.split("multi.txt").length - 1;
    expect(fileCount).toBe(1);
    expect(text).toContain("tag1:3");
    expect(text).toContain("tag2:7");
  });

  it("falls back to line 1 when tag marker is missing", async () => {
    const tagsPath = "/rt/doc/tags";
    const helpPath = "/rt/doc/nomarker.txt";
    const files: FileMap = {
      [tagsPath]: "orphan\tnomarker.txt\t/*orphan*",
      [helpPath]: "no markers here at all",
    };

    const invocation = Docs.execute(request("orphan"), {
      fileIO: makeFileIO(files),
      helpTagsProvider: makeProvider([tagsPath]),
    });

    const text = await resultText(invocation);
    expect(text).toContain("nomarker.txt");
    expect(text).toContain("orphan:1");
  });

  it("reports no matches for a query that does not match any tag", async () => {
    const tagsPath = "/rt/doc/tags";
    const files: FileMap = {
      [tagsPath]: "alpha\tfoo.txt\t/*alpha*",
    };

    const invocation = Docs.execute(request("zzzznope"), {
      fileIO: makeFileIO(files),
      helpTagsProvider: makeProvider([tagsPath]),
    });

    const text = await resultText(invocation);
    expect(text).toContain("No matches");
  });

  it("truncates when matches exceed the cap", async () => {
    const tagsPath = "/rt/doc/tags";
    const helpPath = "/rt/doc/many.txt";
    const tagLines: string[] = [];
    const helpLines: string[] = [];
    for (let i = 0; i < 250; i++) {
      tagLines.push(`common-${i}\tmany.txt\t/*common-${i}*`);
      helpLines.push(`line *common-${i}*`);
    }
    const files: FileMap = {
      [tagsPath]: tagLines.join("\n"),
      [helpPath]: helpLines.join("\n"),
    };

    const invocation = Docs.execute(request("common"), {
      fileIO: makeFileIO(files),
      helpTagsProvider: makeProvider([tagsPath]),
    });

    const text = await resultText(invocation);
    expect(text).toContain("truncated");
    const tagLineCount = text
      .split("\n")
      .filter((l) => /^\s{4}common-\d+:\d+$/.test(l)).length;
    expect(tagLineCount).toBeLessThanOrEqual(200);
    const filePathCount = text.split(helpPath).length - 1;
    expect(filePathCount).toBe(0);
    const fileHeaderCount = text.split("many.txt").length - 1;
    expect(fileHeaderCount).toBe(1);
  });

  it("skips metadata lines starting with !", async () => {
    const tagsPath = "/rt/doc/tags";
    const files: FileMap = {
      [tagsPath]: [
        "!_TAG_FILE_FORMAT\t2",
        "realtag\tfile.txt\t/*realtag*",
      ].join("\n"),
      "/rt/doc/file.txt": "a *realtag* b",
    };

    const invocation = Docs.execute(request("realtag"), {
      fileIO: makeFileIO(files),
      helpTagsProvider: makeProvider([tagsPath]),
    });

    const text = await resultText(invocation);
    expect(text).toContain("realtag");
    expect(text).not.toContain("_TAG_FILE_FORMAT");
  });
});
