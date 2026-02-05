import { describe, expect, it } from "vitest";
import { parse } from "./parser.ts";

describe("edl parser", () => {
  it("parses select with regex", () => {
    const cmds = parse(`select_first /hello/`);
    expect(cmds).toEqual([
      {
        type: "select_first",
        pattern: { type: "regex", pattern: /hello/g },
      },
    ]);
  });

  it("parses select with line number", () => {
    const cmds = parse(`select 55`);
    expect(cmds).toEqual([
      { type: "select", pattern: { type: "line", line: 55 } },
    ]);
  });

  it("parses select with line:col", () => {
    const cmds = parse(`select 55:10`);
    expect(cmds).toEqual([
      { type: "select", pattern: { type: "lineCol", line: 55, col: 10 } },
    ]);
  });

  it("parses select with heredoc literal", () => {
    const cmds = parse(`select_first <<FIND
exact text
FIND`);
    expect(cmds).toEqual([
      {
        type: "select_first",
        pattern: { type: "literal", text: "exact text" },
      },
    ]);
  });

  it("parses bof and eof", () => {
    const cmds = parse(`select_first bof\nselect_first eof`);
    expect(cmds).toEqual([
      { type: "select_first", pattern: { type: "bof" } },
      { type: "select_first", pattern: { type: "eof" } },
    ]);
  });

  it("parses replace with heredoc", () => {
    const cmds = parse(`replace <<END
new text
END`);
    expect(cmds).toEqual([{ type: "replace", text: "new text" }]);
  });

  it("parses delete", () => {
    expect(parse(`delete`)).toEqual([{ type: "delete" }]);
  });

  it("parses insert_before and insert_after", () => {
    const cmds = parse(`insert_before <<END
before
END
insert_after <<END
after
END`);
    expect(cmds).toEqual([
      { type: "insert_before", text: "before" },
      { type: "insert_after", text: "after" },
    ]);
  });

  it("parses cut and paste", () => {
    const cmds = parse(`cut my_reg\npaste my_reg`);
    expect(cmds).toEqual([
      { type: "cut", register: "my_reg" },
      { type: "paste", register: "my_reg" },
    ]);
  });

  it("parses file command", () => {
    const cmds = parse(`file src/app.ts`);
    expect(cmds).toEqual([{ type: "file", path: "src/app.ts" }]);
  });

  it("parses nth", () => {
    const cmds = parse(`nth 2`);
    expect(cmds).toEqual([{ type: "nth", n: 2 }]);
  });

  it("skips comments and blank lines", () => {
    const cmds = parse(`# comment\n\ndelete\n# another`);
    expect(cmds).toEqual([{ type: "delete" }]);
  });

  it("errors on unknown command", () => {
    expect(() => parse(`bogus`)).toThrow("Unknown command");
  });

  it("errors on unterminated heredoc", () => {
    expect(() => parse(`replace <<END\nsome text`)).toThrow(
      "Unterminated heredoc",
    );
  });

  it("parses regex with escaped slash", () => {
    const cmds = parse(`select /foo\\/bar/`);
    expect(cmds).toEqual([
      { type: "select", pattern: { type: "regex", pattern: /foo\/bar/g } },
    ]);
  });

  it("parses regex with special characters", () => {
    const cmds = parse(`select /\\d+\\.\\d+/`);
    expect(cmds).toEqual([
      { type: "select", pattern: { type: "regex", pattern: /\d+\.\d+/g } },
    ]);
  });

  it("parses regex with flags", () => {
    const cmds = parse(`select /hello/i`);
    expect(cmds).toEqual([
      { type: "select", pattern: { type: "regex", pattern: /hello/gi } },
    ]);
  });

  it("parses regex with escaped newline followed by another command", () => {
    const cmds = parse(`select /abc\\ndef/\nselect /somethingelse/`);
    expect(cmds).toEqual([
      { type: "select", pattern: { type: "regex", pattern: /abc\ndef/g } },
      {
        type: "select",
        pattern: { type: "regex", pattern: /somethingelse/g },
      },
    ]);
  });
});
