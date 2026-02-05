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
narrow /world/
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
narrow /aaa/
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
narrow /zzz/`;
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
narrow /aaa/
retain_first
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
narrow /aaa/
retain_last
replace <<END
xxx
END`;
      const commands = parse(script);
      await executor(commands);
      const content = await fs.readFile(filePath, "utf-8");
      expect(content).toBe("aaa bbb aaa bbb xxx\n");
    });
  });

  it("narrow_one: selects when exactly one match", async () => {
    await withTmpDir(async (tmpDir) => {
      const filePath = path.join(tmpDir, "test.txt");
      await fs.writeFile(filePath, "aaa bbb ccc\n", "utf-8");

      const script = `\
file \`${filePath}\`
narrow_one /bbb/
replace <<END
xxx
END`;
      const commands = parse(script);
      await executor(commands);
      const content = await fs.readFile(filePath, "utf-8");
      expect(content).toBe("aaa xxx ccc\n");
    });
  });

  it("narrow_one: errors when multiple matches", async () => {
    await withTmpDir(async (tmpDir) => {
      const filePath = path.join(tmpDir, "test.txt");
      await fs.writeFile(filePath, "aaa bbb aaa\n", "utf-8");

      const script = `\
file \`${filePath}\`
narrow_one /aaa/`;
      const commands = parse(script);
      await expect(executor(commands)).rejects.toThrow(
        "expected 1 match, got 2",
      );
    });
  });

  it("select_next: searches from end of current selection (non-overlapping)", async () => {
    await withTmpDir(async (tmpDir) => {
      const filePath = path.join(tmpDir, "test.txt");
      await fs.writeFile(filePath, "aaabbbbbb", "utf-8");

      // Selection is "aaabbb" (positions 0-6), searching for "bbb"
      // Should find "bbb" at positions 6-9, not re-match within the selection
      const script = `\
file \`${filePath}\`
narrow /aaabbb/
retain_first
select_next /bbb/
replace <<END2
xxx
END2`;
      const commands = parse(script);
      await executor(commands);
      const content = await fs.readFile(filePath, "utf-8");
      expect(content).toBe("aaabbbxxx");
    });
  });

  it("select_next: does not find overlapping match within current selection", async () => {
    await withTmpDir(async (tmpDir) => {
      const filePath = path.join(tmpDir, "test.txt");
      await fs.writeFile(filePath, "aaabbbccc", "utf-8");

      // Selection is "aaabbb" (positions 0-6), searching for "bbb"
      // "bbb" exists at positions 3-6 but overlaps with selection
      // No match exists after position 6, so this should error
      const script = `\
file \`${filePath}\`
narrow /aaabbb/
retain_first
select_next /bbb/`;
      const commands = parse(script);
      await expect(executor(commands)).rejects.toThrow(
        "no matches after selection",
      );
    });
  });

  it("select_prev: searches up to start of current selection (non-overlapping)", async () => {
    await withTmpDir(async (tmpDir) => {
      const filePath = path.join(tmpDir, "test.txt");
      await fs.writeFile(filePath, "bbbbbbaaa", "utf-8");

      // Selection is "bbbaaa" (positions 3-9), searching for "bbb"
      // Should find "bbb" at positions 0-3, not re-match within the selection
      const script = `\
file \`${filePath}\`
narrow /bbbaaa/
retain_last
select_prev /bbb/
replace <<END2
xxx
END2`;
      const commands = parse(script);
      await executor(commands);
      const content = await fs.readFile(filePath, "utf-8");
      expect(content).toBe("xxxbbbaaa");
    });
  });

  it("select_prev: does not find overlapping match within current selection", async () => {
    await withTmpDir(async (tmpDir) => {
      const filePath = path.join(tmpDir, "test.txt");
      await fs.writeFile(filePath, "cccbbbaaa", "utf-8");

      // Selection is "bbbaaa" (positions 3-9), searching for "bbb"
      // "bbb" exists at positions 3-6 but overlaps with selection
      // No match exists before position 3, so this should error
      const script = `\
file \`${filePath}\`
narrow /bbbaaa/
retain_last
select_prev /bbb/`;
      const commands = parse(script);
      await expect(executor(commands)).rejects.toThrow(
        "no matches before selection",
      );
    });
  });

  it("extend_forward: searches from end of current selection (non-overlapping)", async () => {
    await withTmpDir(async (tmpDir) => {
      const filePath = path.join(tmpDir, "test.txt");
      await fs.writeFile(filePath, "aaabbbbbb", "utf-8");

      // Selection is "aaabbb" (positions 0-6), extending forward to "bbb"
      // Should extend to include positions 6-9, giving "aaabbbbbb"
      const script = `\
file \`${filePath}\`
narrow /aaabbb/
retain_first
extend_forward /bbb/
replace <<END2
xxx
END2`;
      const commands = parse(script);
      await executor(commands);
      const content = await fs.readFile(filePath, "utf-8");
      expect(content).toBe("xxx");
    });
  });

  it("extend_back: searches up to start of current selection (non-overlapping)", async () => {
    await withTmpDir(async (tmpDir) => {
      const filePath = path.join(tmpDir, "test.txt");
      await fs.writeFile(filePath, "bbbbbbaaa", "utf-8");

      // Selection is "bbbaaa" (positions 3-9), extending back to "bbb"
      // Should extend to include positions 0-3, giving "bbbbbbaaa"
      const script = `\
file \`${filePath}\`
narrow /bbbaaa/
retain_last
extend_back /bbb/
replace <<END2
xxx
END2`;
      const commands = parse(script);
      await executor(commands);
      const content = await fs.readFile(filePath, "utf-8");
      expect(content).toBe("xxx");
    });
  });
  it("select_next: selects next occurrence after current selection", async () => {
    await withTmpDir(async (tmpDir) => {
      const filePath = path.join(tmpDir, "test.txt");
      await fs.writeFile(filePath, "aaa bbb aaa bbb aaa\n", "utf-8");

      const script = `\
file \`${filePath}\`
narrow /bbb/
retain_first
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
narrow /bbb/
retain_last
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
narrow /function hello/
retain_first
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
narrow /}/
retain_first
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
narrow /aaa/
retain_nth 1
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
narrow /aaa/
retain_nth -1
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
narrow /one/
retain_first
file \`${file2}\`
narrow /two/
retain_first
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
narrow 2
replace <<END
replaced
END`;
      const commands = parse(script);
      await executor(commands);
      const content = await fs.readFile(filePath, "utf-8");
      expect(content).toBe("line one\nreplaced\nline three\n");
    });
  });

  it("select literal backslash via regex", async () => {
    await withTmpDir(async (tmpDir) => {
      const filePath = path.join(tmpDir, "test.txt");
      await fs.writeFile(
        filePath,
        'import x from "\\path\\to\\file";\n',
        "utf-8",
      );

      const scriptTemplate = await fs.readFile(
        path.join(__dirname, "fixtures/backslash-regex.edl"),
        "utf-8",
      );
      const script = scriptTemplate.replace("{{FILE}}", filePath);
      const commands = parse(script);
      await executor(commands);
      const content = await fs.readFile(filePath, "utf-8");
      expect(content).toBe('import x from "/newpath\\to\\file";\n');
    });
  });
  it("select escaped backtick via heredoc", async () => {
    await withTmpDir(async (tmpDir) => {
      const filePath = path.join(tmpDir, "test.txt");
      await fs.writeFile(filePath, "const s = `hello \\`world\\``;\n", "utf-8");

      const scriptTemplate = await fs.readFile(
        path.join(__dirname, "fixtures/escaped-backtick-heredoc.edl"),
        "utf-8",
      );
      const script = scriptTemplate.replace("{{FILE}}", filePath);
      const commands = parse(script);
      await executor(commands);
      const content = await fs.readFile(filePath, "utf-8");
      expect(content).toBe("const s = `hello \\`planet\\``;\n");
    });
  });

  it("select escaped backtick via regex", async () => {
    await withTmpDir(async (tmpDir) => {
      const filePath = path.join(tmpDir, "test.txt");
      await fs.writeFile(filePath, "const s = `hello \\`world\\``;\n", "utf-8");

      const scriptTemplate = await fs.readFile(
        path.join(__dirname, "fixtures/escaped-backtick-regex.edl"),
        "utf-8",
      );
      const script = scriptTemplate.replace("{{FILE}}", filePath);
      const commands = parse(script);
      await executor(commands);
      const content = await fs.readFile(filePath, "utf-8");
      expect(content).toBe("const s = `hello \\`planet\\``;\n");
    });
  });

  it("select with literal heredoc pattern", async () => {
    await withTmpDir(async (tmpDir) => {
      const filePath = path.join(tmpDir, "test.txt");
      await fs.writeFile(filePath, "find /pattern/ here\n", "utf-8");

      const script = `\
file \`${filePath}\`
narrow <<FIND
/pattern/
FIND
replace <<END2
/replaced/
END2`;
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
narrow bof
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
narrow /line two\\n/
retain_first
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
narrow /world/
retain_first
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
narrow /hello/
retain_first
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
narrow /a/
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
narrow /second\\n/
retain_first
cut a
file \`${filePath}\`
narrow /third/
retain_first
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
narrow /remove\\n/
retain_first
cut buf
file \`${file2}\`
narrow eof
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
narrow /hello/
retain_first
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
narrow /placeholder/
retain_first
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
narrow /b /
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
    const script = `narrow /hello/`;
    const commands = parse(script);
    await expect(executor(commands)).rejects.toThrow("No file selected");
  });

  it("errors when file does not exist", async () => {
    const script = "file `/tmp/magenta-test/nonexistent-file-xyz.txt`";
    const commands = parse(script);
    await expect(executor(commands)).rejects.toThrow("Failed to read file");
  });

  it("includes pattern in error message for regex", async () => {
    await withTmpDir(async (tmpDir) => {
      const filePath = path.join(tmpDir, "test.txt");
      await fs.writeFile(filePath, "hello world\n", "utf-8");

      const script = `\
file \`${filePath}\`
narrow_one /nonexistent_pattern/`;
      const commands = parse(script);
      await expect(executor(commands)).rejects.toThrow(
        "narrow_one: no matches for pattern /nonexistent_pattern/",
      );
    });
  });

  it("includes pattern in error message for heredoc", async () => {
    await withTmpDir(async (tmpDir) => {
      const filePath = path.join(tmpDir, "test.txt");
      await fs.writeFile(filePath, "hello world\n", "utf-8");

      const script = `\
file \`${filePath}\`
narrow_one <<FIND
this text does not exist
FIND`;
      const commands = parse(script);
      await expect(executor(commands)).rejects.toThrow(
        "narrow_one: no matches for pattern <<HEREDOC",
      );
    });
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
narrow /original/
retain_first
replace <<END
modified
END
file \`${file2}\`
narrow /nonexistent_pattern/`;
      const commands = parse(script);
      await expect(executor(commands)).rejects.toThrow("no matches");
      expect(await fs.readFile(file1, "utf-8")).toBe("original content\n");
      expect(await fs.readFile(file2, "utf-8")).toBe("file two\n");
    });
  });
});

describe("newfile", () => {
  it("should create a new file and write content", async () => {
    await withTmpDir(async (tmpDir) => {
      const filePath = path.join(tmpDir, "new.txt");

      const script = `\
newfile \`${filePath}\`
insert_after <<CONTENT
hello new file
CONTENT`;
      const commands = parse(script);
      const result = await executor(commands);

      const content = await fs.readFile(filePath, "utf-8");
      expect(content).toBe("hello new file");
      expect(result.mutations.get(filePath)).toMatchObject({
        insertions: 1,
        linesAdded: 1,
      });
    });
  });

  it("should create an empty file when no mutations follow", async () => {
    await withTmpDir(async (tmpDir) => {
      const filePath = path.join(tmpDir, "empty.txt");

      const script = `newfile \`${filePath}\``;
      const commands = parse(script);
      await executor(commands);

      const content = await fs.readFile(filePath, "utf-8");
      expect(content).toBe("");
    });
  });

  it("should error if file already exists on disk", async () => {
    await withTmpDir(async (tmpDir) => {
      const filePath = path.join(tmpDir, "existing.txt");
      await fs.writeFile(filePath, "existing content", "utf-8");

      const script = `newfile \`${filePath}\``;
      const commands = parse(script);
      await expect(executor(commands)).rejects.toThrow(
        "file already exists on disk",
      );
    });
  });

  it("should error if file was already loaded in the same script", async () => {
    await withTmpDir(async (tmpDir) => {
      const filePath = path.join(tmpDir, "test.txt");
      await fs.writeFile(filePath, "content", "utf-8");

      const script = `\
file \`${filePath}\`
newfile \`${filePath}\``;
      const commands = parse(script);
      await expect(executor(commands)).rejects.toThrow("file already loaded");
    });
  });

  it("should create parent directories if they don't exist", async () => {
    await withTmpDir(async (tmpDir) => {
      const filePath = path.join(tmpDir, "a", "b", "new.txt");

      const script = `\
newfile \`${filePath}\`
insert_after <<CONTENT
nested file
CONTENT`;
      const commands = parse(script);
      await executor(commands);

      const content = await fs.readFile(filePath, "utf-8");
      expect(content).toBe("nested file");
    });
  });
});
