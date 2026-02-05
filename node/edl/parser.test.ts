import { describe, expect, it } from "vitest";
import { parse } from "./parser.ts";

describe("edl parser", () => {
  it("parses narrow with regex", () => {
    const cmds = parse(`narrow /hello/`);
    expect(cmds).toEqual([
      {
        type: "narrow",
        pattern: { type: "regex", pattern: /hello/g },
      },
    ]);
  });

  it("parses narrow with line number", () => {
    const cmds = parse(`narrow 55`);
    expect(cmds).toEqual([
      { type: "narrow", pattern: { type: "line", line: 55 } },
    ]);
  });

  it("parses narrow with line:col", () => {
    const cmds = parse(`narrow 55:10`);
    expect(cmds).toEqual([
      { type: "narrow", pattern: { type: "lineCol", line: 55, col: 10 } },
    ]);
  });

  it("parses narrow with heredoc literal", () => {
    const cmds = parse(`narrow <<FIND
exact text
FIND`);
    expect(cmds).toEqual([
      {
        type: "narrow",
        pattern: { type: "literal", text: "exact text" },
      },
    ]);
  });

  it("parses bof and eof", () => {
    const cmds = parse(`narrow bof\nnarrow eof`);
    expect(cmds).toEqual([
      { type: "narrow", pattern: { type: "bof" } },
      { type: "narrow", pattern: { type: "eof" } },
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

  it("parses retain_nth", () => {
    const cmds = parse(`retain_nth 2`);
    expect(cmds).toEqual([{ type: "retain_nth", n: 2 }]);
  });

  it("parses retain_first and retain_last", () => {
    const cmds = parse(`retain_first\nretain_last`);
    expect(cmds).toEqual([{ type: "retain_first" }, { type: "retain_last" }]);
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
    const cmds = parse(`narrow /foo\\/bar/`);
    expect(cmds).toEqual([
      { type: "narrow", pattern: { type: "regex", pattern: /foo\/bar/g } },
    ]);
  });

  it("parses regex with special characters", () => {
    const cmds = parse(`narrow /\\d+\\.\\d+/`);
    expect(cmds).toEqual([
      { type: "narrow", pattern: { type: "regex", pattern: /\d+\.\d+/g } },
    ]);
  });

  it("parses regex with flags", () => {
    const cmds = parse(`narrow /hello/i`);
    expect(cmds).toEqual([
      { type: "narrow", pattern: { type: "regex", pattern: /hello/gi } },
    ]);
  });

  it("parses regex with escaped newline followed by another command", () => {
    const cmds = parse(`narrow /abc\\ndef/\nnarrow /somethingelse/`);
    expect(cmds).toEqual([
      { type: "narrow", pattern: { type: "regex", pattern: /abc\ndef/g } },
      {
        type: "narrow",
        pattern: { type: "regex", pattern: /somethingelse/g },
      },
    ]);
  });

  it("parses narrow_one", () => {
    const cmds = parse(`narrow_one /hello/`);
    expect(cmds).toEqual([
      { type: "narrow_one", pattern: { type: "regex", pattern: /hello/g } },
    ]);
  });
});
