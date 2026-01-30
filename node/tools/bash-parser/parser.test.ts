import { describe, expect, it } from "vitest";
import { parse } from "./parser.ts";

describe("bash parser", () => {
  describe("simple commands", () => {
    it("should parse a simple command with no args", () => {
      const result = parse("ls");
      expect(result).toEqual({
        commands: [{ executable: "ls", args: [], receivingPipe: false }],
      });
    });

    it("should parse a command with arguments", () => {
      const result = parse("echo hello world");
      expect(result).toEqual({
        commands: [
          {
            executable: "echo",
            args: ["hello", "world"],
            receivingPipe: false,
          },
        ],
      });
    });

    it("should parse a command with flags", () => {
      const result = parse("npx tsc --noEmit");
      expect(result).toEqual({
        commands: [
          {
            executable: "npx",
            args: ["tsc", "--noEmit"],
            receivingPipe: false,
          },
        ],
      });
    });

    it("should handle quoted arguments", () => {
      const result = parse('echo "hello world"');
      expect(result).toEqual({
        commands: [
          { executable: "echo", args: ["hello world"], receivingPipe: false },
        ],
      });
    });

    it("should handle empty input", () => {
      const result = parse("");
      expect(result).toEqual({ commands: [] });
    });

    it("should handle whitespace-only input", () => {
      const result = parse("   ");
      expect(result).toEqual({ commands: [] });
    });
  });

  describe("command sequences with &&", () => {
    it("should parse two commands with &&", () => {
      const result = parse("cmd1 && cmd2");
      expect(result).toEqual({
        commands: [
          { executable: "cmd1", args: [], receivingPipe: false },
          { executable: "cmd2", args: [], receivingPipe: false },
        ],
      });
    });

    it("should parse commands with args separated by &&", () => {
      const result = parse("cd /some/dir && cat file.txt");
      expect(result).toEqual({
        commands: [
          { executable: "cd", args: ["/some/dir"], receivingPipe: false },
          { executable: "cat", args: ["file.txt"], receivingPipe: false },
        ],
      });
    });

    it("should parse multiple && commands", () => {
      const result = parse("cmd1 && cmd2 && cmd3");
      expect(result).toEqual({
        commands: [
          { executable: "cmd1", args: [], receivingPipe: false },
          { executable: "cmd2", args: [], receivingPipe: false },
          { executable: "cmd3", args: [], receivingPipe: false },
        ],
      });
    });
  });

  describe("command sequences with ||", () => {
    it("should parse two commands with ||", () => {
      const result = parse("cmd1 || cmd2");
      expect(result).toEqual({
        commands: [
          { executable: "cmd1", args: [], receivingPipe: false },
          { executable: "cmd2", args: [], receivingPipe: false },
        ],
      });
    });
  });

  describe("command sequences with ;", () => {
    it("should parse two commands with ;", () => {
      const result = parse("cmd1; cmd2");
      expect(result).toEqual({
        commands: [
          { executable: "cmd1", args: [], receivingPipe: false },
          { executable: "cmd2", args: [], receivingPipe: false },
        ],
      });
    });

    it("should handle trailing semicolon", () => {
      const result = parse("cmd1;");
      expect(result).toEqual({
        commands: [{ executable: "cmd1", args: [], receivingPipe: false }],
      });
    });
  });

  describe("pipelines", () => {
    it("should parse a simple pipeline", () => {
      const result = parse("cat file.txt | grep pattern");
      expect(result).toEqual({
        commands: [
          { executable: "cat", args: ["file.txt"], receivingPipe: false },
          { executable: "grep", args: ["pattern"], receivingPipe: true },
        ],
      });
    });

    it("should parse a multi-stage pipeline", () => {
      const result = parse("cat file.txt | grep pattern | head -10");
      expect(result).toEqual({
        commands: [
          { executable: "cat", args: ["file.txt"], receivingPipe: false },
          { executable: "grep", args: ["pattern"], receivingPipe: true },
          { executable: "head", args: ["-10"], receivingPipe: true },
        ],
      });
    });
  });

  describe("mixed operators", () => {
    it("should parse commands with mixed operators", () => {
      const result = parse("cmd1 && cmd2 | cmd3 || cmd4; cmd5");
      expect(result).toEqual({
        commands: [
          { executable: "cmd1", args: [], receivingPipe: false },
          { executable: "cmd2", args: [], receivingPipe: false },
          { executable: "cmd3", args: [], receivingPipe: true },
          { executable: "cmd4", args: [], receivingPipe: false },
          { executable: "cmd5", args: [], receivingPipe: false },
        ],
      });
    });
  });

  describe("fd redirections", () => {
    it("should strip 2>&1 redirection", () => {
      const result = parse("npm install 2>&1");
      expect(result).toEqual({
        commands: [
          { executable: "npm", args: ["install"], receivingPipe: false },
        ],
      });
    });

    it("should strip fd redirections between args", () => {
      const result = parse("cmd arg1 2>&1 arg2");
      expect(result).toEqual({
        commands: [
          { executable: "cmd", args: ["arg1", "arg2"], receivingPipe: false },
        ],
      });
    });

    it("should handle multiple redirections", () => {
      const result = parse("cmd 2>&1 1>&2");
      expect(result).toEqual({
        commands: [{ executable: "cmd", args: [], receivingPipe: false }],
      });
    });
  });

  describe("complex real-world commands", () => {
    it("should parse cd && command pattern", () => {
      const result = parse("cd /project && npx tsc --noEmit");
      expect(result).toEqual({
        commands: [
          { executable: "cd", args: ["/project"], receivingPipe: false },
          {
            executable: "npx",
            args: ["tsc", "--noEmit"],
            receivingPipe: false,
          },
        ],
      });
    });

    it("should parse vitest run with files", () => {
      const result = parse(
        "npx vitest run src/test1.spec.ts src/test2.spec.ts",
      );
      expect(result).toEqual({
        commands: [
          {
            executable: "npx",
            args: ["vitest", "run", "src/test1.spec.ts", "src/test2.spec.ts"],
            receivingPipe: false,
          },
        ],
      });
    });

    it("should parse git commands", () => {
      const result = parse("git add . && git commit -m 'fix'");
      expect(result).toEqual({
        commands: [
          { executable: "git", args: ["add", "."], receivingPipe: false },
          {
            executable: "git",
            args: ["commit", "-m", "fix"],
            receivingPipe: false,
          },
        ],
      });
    });

    it("should parse script execution", () => {
      const result = parse("./script.sh arg1 arg2");
      expect(result).toEqual({
        commands: [
          {
            executable: "./script.sh",
            args: ["arg1", "arg2"],
            receivingPipe: false,
          },
        ],
      });
    });

    it("should parse bash script execution", () => {
      const result = parse("bash scripts/run.sh");
      expect(result).toEqual({
        commands: [
          {
            executable: "bash",
            args: ["scripts/run.sh"],
            receivingPipe: false,
          },
        ],
      });
    });

    it("should parse npx tsx script execution", () => {
      const result = parse("npx tsx scripts/generate.ts");
      expect(result).toEqual({
        commands: [
          {
            executable: "npx",
            args: ["tsx", "scripts/generate.ts"],
            receivingPipe: false,
          },
        ],
      });
    });

    it("should parse cd to script dir and execute", () => {
      const result = parse("cd /path/to/scripts && ./run.sh");
      expect(result).toEqual({
        commands: [
          {
            executable: "cd",
            args: ["/path/to/scripts"],
            receivingPipe: false,
          },
          { executable: "./run.sh", args: [], receivingPipe: false },
        ],
      });
    });
  });
});
