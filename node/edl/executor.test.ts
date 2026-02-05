import { describe, it, expect } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { Executor } from "./executor.ts";
import { parse } from "./parser.ts";

let testCounter = 0;

async function withTmpDir(fn: (tmpDir: string) => Promise<void>) {
  const tmpDir = path.join(
    "/tmp/magenta-test",
    `executor-${Date.now()}-${testCounter++}`,
  );
  await fs.mkdir(tmpDir, { recursive: true });
  try {
    await fn(tmpDir);
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
}

function executor(commands: ReturnType<typeof parse>) {
  return new Executor().execute(commands);
}

it("should find and replace text in a file", async () => {
  await withTmpDir(async (tmpDir) => {
    const filePath = path.join(tmpDir, "test.txt");
    await fs.writeFile(
      filePath,
      `\
hello world
goodbye world
`,
      "utf-8",
    );

    const script = `\
file \`${filePath}\`
select /world/
replace <<END
planet
END`;
    const commands = parse(script);
    const executor = new Executor();
    const result = await executor.execute(commands);

    const content = await fs.readFile(filePath, "utf-8");
    expect(content).toBe(`\
hello planet
goodbye planet
`);
    expect(result.mutations.get(filePath)?.replacements).toBe(2);
  });
});

describe("selection commands", () => {
  it("select: refines within existing selection", async () => {
    await withTmpDir(async (tmpDir) => {
      const filePath = path.join(tmpDir, "test.txt");
      await fs.writeFile(filePath, "aaa bbb aaa bbb aaa\n", "utf-8");

      const script = `\
file \`${filePath}\`
select /aaa/
replace <<END
xxx
END`;
      const commands = parse(script);
      const result = await executor(commands);
      const content = await fs.readFile(filePath, "utf-8");
      expect(content).toBe("xxx bbb xxx bbb xxx\n");
      expect(result.mutations.get(filePath)?.replacements).toBe(3);
    });
  });

  it("select: errors when no match", async () => {
    await withTmpDir(async (tmpDir) => {
      const filePath = path.join(tmpDir, "test.txt");
      await fs.writeFile(filePath, "hello world\n", "utf-8");

      const script = `\
file \`${filePath}\`
select /zzz/`;
      const commands = parse(script);
      await expect(executor(commands)).rejects.toThrow("no matches");
    });
  });

  it("select_first: selects only the first match", async () => {
    await withTmpDir(async (tmpDir) => {
      const filePath = path.join(tmpDir, "test.txt");
      await fs.writeFile(filePath, "aaa bbb aaa bbb aaa\n", "utf-8");

      const script = `\
file \`${filePath}\`
select_first /aaa/
replace <<END
xxx
END`;
      const commands = parse(script);
      await executor(commands);
      const content = await fs.readFile(filePath, "utf-8");
      expect(content).toBe("xxx bbb aaa bbb aaa\n");
    });
  });

  it("select_last: selects only the last match", async () => {
    await withTmpDir(async (tmpDir) => {
      const filePath = path.join(tmpDir, "test.txt");
      await fs.writeFile(filePath, "aaa bbb aaa bbb aaa\n", "utf-8");

      const script = `\
file \`${filePath}\`
select_last /aaa/
replace <<END
xxx
END`;
      const commands = parse(script);
      await executor(commands);
      const content = await fs.readFile(filePath, "utf-8");
      expect(content).toBe("aaa bbb aaa bbb xxx\n");
    });
  });

  it("select_one: selects when exactly one match", async () => {
    await withTmpDir(async (tmpDir) => {
      const filePath = path.join(tmpDir, "test.txt");
      await fs.writeFile(filePath, "aaa bbb ccc\n", "utf-8");

      const script = `\
file \`${filePath}\`
select_one /bbb/
replace <<END
xxx
END`;
      const commands = parse(script);
      await executor(commands);
      const content = await fs.readFile(filePath, "utf-8");
      expect(content).toBe("aaa xxx ccc\n");
    });
  });

  it("select_one: errors when multiple matches", async () => {
    await withTmpDir(async (tmpDir) => {
      const filePath = path.join(tmpDir, "test.txt");
      await fs.writeFile(filePath, "aaa bbb aaa\n", "utf-8");

      const script = `\
file \`${filePath}\`
select_one /aaa/`;
      const commands = parse(script);
      await expect(executor(commands)).rejects.toThrow(
        "expected 1 match, got 2",
      );
    });
  });

  it("select_next: selects next occurrence after current selection", async () => {
    await withTmpDir(async (tmpDir) => {
      const filePath = path.join(tmpDir, "test.txt");
      await fs.writeFile(filePath, "aaa bbb aaa bbb aaa\n", "utf-8");

      const script = `\
file \`${filePath}\`
select_first /bbb/
select_next /aaa/
replace <<END
xxx
END`;
      const commands = parse(script);
      await executor(commands);
      const content = await fs.readFile(filePath, "utf-8");
      expect(content).toBe("aaa bbb xxx bbb aaa\n");
    });
  });

  it("select_prev: selects previous occurrence before current selection", async () => {
    await withTmpDir(async (tmpDir) => {
      const filePath = path.join(tmpDir, "test.txt");
      await fs.writeFile(filePath, "aaa bbb aaa bbb aaa\n", "utf-8");

      const script = `\
file \`${filePath}\`
select_last /bbb/
select_prev /aaa/
replace <<END
xxx
END`;
      const commands = parse(script);
      await executor(commands);
      const content = await fs.readFile(filePath, "utf-8");
      expect(content).toBe("aaa bbb xxx bbb aaa\n");
    });
  });

  it("extend_forward: extends selection to include match", async () => {
    await withTmpDir(async (tmpDir) => {
      const filePath = path.join(tmpDir, "test.txt");
      await fs.writeFile(
        filePath,
        "function hello() {\n  return 1;\n}\n",
        "utf-8",
      );

      const script = `\
file \`${filePath}\`
select_first /function hello/
extend_forward /}/
replace <<END
function hello() { return 2; }
END`;
      const commands = parse(script);
      await executor(commands);
      const content = await fs.readFile(filePath, "utf-8");
      expect(content).toBe("function hello() { return 2; }\n");
    });
  });

  it("extend_back: extends selection backward to include match", async () => {
    await withTmpDir(async (tmpDir) => {
      const filePath = path.join(tmpDir, "test.txt");
      await fs.writeFile(
        filePath,
        "function hello() {\n  return 1;\n}\n",
        "utf-8",
      );

      const script = `\
file \`${filePath}\`
select_first /}/
extend_back /function/
replace <<END
function hello() { return 2; }
END`;
      const commands = parse(script);
      await executor(commands);
      const content = await fs.readFile(filePath, "utf-8");
      expect(content).toBe("function hello() { return 2; }\n");
    });
  });

  it("nth: selects nth match from multi-select", async () => {
    await withTmpDir(async (tmpDir) => {
      const filePath = path.join(tmpDir, "test.txt");
      await fs.writeFile(filePath, "aaa bbb aaa bbb aaa\n", "utf-8");

      const script = `\
file \`${filePath}\`
select /aaa/
nth 1
replace <<END
xxx
END`;
      const commands = parse(script);
      await executor(commands);
      const content = await fs.readFile(filePath, "utf-8");
      expect(content).toBe("aaa bbb xxx bbb aaa\n");
    });
  });

  it("nth: supports negative indexing", async () => {
    await withTmpDir(async (tmpDir) => {
      const filePath = path.join(tmpDir, "test.txt");
      await fs.writeFile(filePath, "aaa bbb aaa bbb aaa\n", "utf-8");

      const script = `\
file \`${filePath}\`
select /aaa/
nth -1
replace <<END
xxx
END`;
      const commands = parse(script);
      await executor(commands);
      const content = await fs.readFile(filePath, "utf-8");
      expect(content).toBe("aaa bbb aaa bbb xxx\n");
    });
  });

  it("file: switches file and resets selection to full file", async () => {
    await withTmpDir(async (tmpDir) => {
      const file1 = path.join(tmpDir, "a.txt");
      const file2 = path.join(tmpDir, "b.txt");
      await fs.writeFile(file1, "file one\n", "utf-8");
      await fs.writeFile(file2, "file two\n", "utf-8");

      const script = `\
file \`${file1}\`
select_first /one/
file \`${file2}\`
select_first /two/
replace <<END
TWO
END`;
      const commands = parse(script);
      await executor(commands);
      expect(await fs.readFile(file1, "utf-8")).toBe("file one\n");
      expect(await fs.readFile(file2, "utf-8")).toBe("file TWO\n");
    });
  });

  it("select with line number pattern", async () => {
    await withTmpDir(async (tmpDir) => {
      const filePath = path.join(tmpDir, "test.txt");
      await fs.writeFile(filePath, "line one\nline two\nline three\n", "utf-8");

      const script = `\
file \`${filePath}\`
select 2
replace <<END
replaced
END`;
      const commands = parse(script);
      await executor(commands);
      const content = await fs.readFile(filePath, "utf-8");
      expect(content).toBe("line one\nreplaced\nline three\n");
    });
  });

  it("select with literal heredoc pattern", async () => {
    await withTmpDir(async (tmpDir) => {
      const filePath = path.join(tmpDir, "test.txt");
      await fs.writeFile(filePath, "find /pattern/ here\n", "utf-8");

      const script = `\
file \`${filePath}\`
select <<FIND
/pattern/
FIND
replace <<END
/replaced/
END`;
      const commands = parse(script);
      await executor(commands);
      const content = await fs.readFile(filePath, "utf-8");
      expect(content).toBe("find /replaced/ here\n");
    });
  });

  it("select with bof and eof", async () => {
    await withTmpDir(async (tmpDir) => {
      const filePath = path.join(tmpDir, "test.txt");
      await fs.writeFile(filePath, "hello world\n", "utf-8");

      const script = `\
file \`${filePath}\`
select bof
insert_after <<END
prefix
END`;
      const commands = parse(script);
      await executor(commands);
      const content = await fs.readFile(filePath, "utf-8");
      expect(content).toBe("prefixhello world\n");
    });
  });
});

describe("mutation commands", () => {
  it("delete: removes selected text", async () => {
    await withTmpDir(async (tmpDir) => {
      const filePath = path.join(tmpDir, "test.txt");
      await fs.writeFile(filePath, "line one\nline two\nline three\n", "utf-8");

      const script = `\
file \`${filePath}\`
select_first /line two\\n/
delete`;
      const commands = parse(script);
      const result = await executor(commands);
      const content = await fs.readFile(filePath, "utf-8");
      expect(content).toBe("line one\nline three\n");
      expect(result.mutations.get(filePath)?.deletions).toBe(1);
    });
  });

  it("insert_before: inserts text before selection", async () => {
    await withTmpDir(async (tmpDir) => {
      const filePath = path.join(tmpDir, "test.txt");
      await fs.writeFile(filePath, "hello world\n", "utf-8");

      const script = `\
file \`${filePath}\`
select_first /world/
insert_before <<END
beautiful_
END`;
      const commands = parse(script);
      const result = await executor(commands);
      const content = await fs.readFile(filePath, "utf-8");
      expect(content).toBe("hello beautiful_world\n");
      expect(result.mutations.get(filePath)?.insertions).toBe(1);
    });
  });

  it("insert_after: inserts text after selection", async () => {
    await withTmpDir(async (tmpDir) => {
      const filePath = path.join(tmpDir, "test.txt");
      await fs.writeFile(filePath, "hello world\n", "utf-8");

      const script = `\
file \`${filePath}\`
select_first /hello/
insert_after <<END
 beautiful
END`;
      const commands = parse(script);
      const result = await executor(commands);
      const content = await fs.readFile(filePath, "utf-8");
      expect(content).toBe("hello beautiful world\n");
      expect(result.mutations.get(filePath)?.insertions).toBe(1);
    });
  });

  it("insert_before with multi-select", async () => {
    await withTmpDir(async (tmpDir) => {
      const filePath = path.join(tmpDir, "test.txt");
      await fs.writeFile(filePath, "a b a b a\n", "utf-8");

      const script = `\
file \`${filePath}\`
select /a/
insert_before <<END
[
END`;
      const commands = parse(script);
      await executor(commands);
      const content = await fs.readFile(filePath, "utf-8");
      expect(content).toBe("[a b [a b [a\n");
    });
  });

  it("cut and paste: moves text between locations", async () => {
    await withTmpDir(async (tmpDir) => {
      const filePath = path.join(tmpDir, "test.txt");
      await fs.writeFile(filePath, "first\nsecond\nthird\n", "utf-8");

      const script = `\
file \`${filePath}\`
select_first /second\\n/
cut a
file \`${filePath}\`
select_first /third/
paste a`;
      const commands = parse(script);
      const result = await executor(commands);
      const content = await fs.readFile(filePath, "utf-8");
      expect(content).toBe("first\nthirdsecond\n\n");
      expect(result.mutations.get(filePath)?.deletions).toBe(1);
      expect(result.mutations.get(filePath)?.insertions).toBe(1);
    });
  });

  it("cut and paste: moves text between files", async () => {
    await withTmpDir(async (tmpDir) => {
      const file1 = path.join(tmpDir, "a.txt");
      const file2 = path.join(tmpDir, "b.txt");
      await fs.writeFile(file1, "keep\nremove\nkeep\n", "utf-8");
      await fs.writeFile(file2, "existing\n", "utf-8");

      const script = `\
file \`${file1}\`
select_first /remove\\n/
cut buf
file \`${file2}\`
select eof
paste buf`;
      const commands = parse(script);
      await executor(commands);
      expect(await fs.readFile(file1, "utf-8")).toBe("keep\nkeep\n");
      expect(await fs.readFile(file2, "utf-8")).toBe("existing\nremove\n");
    });
  });

  it("paste: errors when register is empty", async () => {
    await withTmpDir(async (tmpDir) => {
      const filePath = path.join(tmpDir, "test.txt");
      await fs.writeFile(filePath, "hello\n", "utf-8");

      const script = `\
file \`${filePath}\`
select_first /hello/
paste noSuchReg`;
      const commands = parse(script);
      await expect(executor(commands)).rejects.toThrow(
        'register "noSuchReg" is empty',
      );
    });
  });

  it("replace with multi-line heredoc", async () => {
    await withTmpDir(async (tmpDir) => {
      const filePath = path.join(tmpDir, "test.txt");
      await fs.writeFile(filePath, "placeholder\n", "utf-8");

      const script = `\
file \`${filePath}\`
select_first /placeholder/
replace <<END
line one
line two
line three
END`;
      const commands = parse(script);
      await executor(commands);
      const content = await fs.readFile(filePath, "utf-8");
      expect(content).toBe("line one\nline two\nline three\n");
    });
  });

  it("delete with multi-select removes all matches", async () => {
    await withTmpDir(async (tmpDir) => {
      const filePath = path.join(tmpDir, "test.txt");
      await fs.writeFile(filePath, "a1 b a2 b a3\n", "utf-8");

      const script = `\
file \`${filePath}\`
select /b /
delete`;
      const commands = parse(script);
      const result = await executor(commands);
      const content = await fs.readFile(filePath, "utf-8");
      expect(content).toBe("a1 a2 a3\n");
      expect(result.mutations.get(filePath)?.deletions).toBe(2);
    });
  });
});

describe("error handling", () => {
  it("errors when no file is selected", async () => {
    const script = `select /hello/`;
    const commands = parse(script);
    await expect(executor(commands)).rejects.toThrow("No file selected");
  });

  it("errors when file does not exist", async () => {
    const script = "file `/tmp/magenta-test/nonexistent-file-xyz.txt`";
    const commands = parse(script);
    await expect(executor(commands)).rejects.toThrow("Failed to read file");
  });
});

describe("transactional behavior", () => {
  it("does not write any files if a later command fails", async () => {
    await withTmpDir(async (tmpDir) => {
      const file1 = path.join(tmpDir, "a.txt");
      const file2 = path.join(tmpDir, "b.txt");
      await fs.writeFile(file1, "original content\n", "utf-8");
      await fs.writeFile(file2, "file two\n", "utf-8");

      const script = `\
file \`${file1}\`
select_first /original/
replace <<END
modified
END
file \`${file2}\`
select /nonexistent_pattern/`;
      const commands = parse(script);
      await expect(executor(commands)).rejects.toThrow("no matches");
      expect(await fs.readFile(file1, "utf-8")).toBe("original content\n");
      expect(await fs.readFile(file2, "utf-8")).toBe("file two\n");
    });
  });
});
