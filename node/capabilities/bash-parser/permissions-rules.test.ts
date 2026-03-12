import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { HomeDir, NvimCwd } from "../../utils/files.ts";
import { parse } from "./parser.ts";
import {
  type CommandPermissionsConfig,
  type CommandRule,
  checkCommandAgainstRule,
  getBuiltinPermissions,
  isCommandAllowedByRules,
  loadBuiltinPermissions,
} from "./permissions.ts";

const homeDir = "/home/user" as HomeDir;

describe("rule-based permissions", () => {
  let testDir: string;
  let cwd: NvimCwd;
  let skillsDir: string;

  beforeEach(() => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), "bash-rules-test-"));
    cwd = testDir as NvimCwd;
    skillsDir = path.join(testDir, ".magenta", "skills", "test-skill");
    fs.mkdirSync(skillsDir, { recursive: true });
    fs.writeFileSync(
      path.join(skillsDir, "script.sh"),
      "#!/bin/bash\necho hello",
    );
    fs.writeFileSync(path.join(skillsDir, "script.ts"), "console.log('hello')");
    fs.writeFileSync(path.join(testDir, "file.txt"), "test content");
    fs.writeFileSync(path.join(testDir, "other.txt"), "other content");
    fs.mkdirSync(path.join(testDir, "subdir"));
    fs.writeFileSync(path.join(testDir, "subdir", "nested.txt"), "nested");
    fs.mkdirSync(path.join(testDir, ".hidden"));
    fs.writeFileSync(path.join(testDir, ".hidden", "secret.txt"), "secret");
  });

  afterEach(() => {
    fs.rmSync(testDir, { recursive: true, force: true });
  });

  function makeCtx() {
    return {
      currentCwd: cwd,
      projectCwd: cwd,
      filePermissions: [] as never[],
      homeDir,
    };
  }

  function matchRule(commandStr: string, rule: CommandRule) {
    const parsed = parse(commandStr);
    return checkCommandAgainstRule(parsed.commands[0], rule, makeCtx());
  }

  describe("simple commands", () => {
    it("should match a command with no args", () => {
      const result = matchRule("pwd", { cmd: "pwd" });
      expect(result.matches).toBe(true);
    });

    it("should reject wrong command", () => {
      const result = matchRule("ls", { cmd: "pwd" });
      expect(result.matches).toBe(false);
    });

    it("should reject extra args when no rest", () => {
      const result = matchRule("pwd foo", { cmd: "pwd" });
      expect(result.matches).toBe(false);
    });

    it("should allow rest: any", () => {
      const result = matchRule("ls -la /tmp", { cmd: "ls", rest: "any" });
      expect(result.matches).toBe(true);
    });
  });

  describe("flags", () => {
    it("should match with a known flag present", () => {
      const result = matchRule("grep -i pattern", {
        cmd: "grep",
        flags: ["-i"],
        args: ["any"],
      });
      expect(result.matches).toBe(true);
    });

    it("should match when optional flag is absent", () => {
      const result = matchRule("grep pattern", {
        cmd: "grep",
        flags: ["-i"],
        args: ["any"],
      });
      expect(result.matches).toBe(true);
    });

    it("should allow flags in any order relative to args", () => {
      const rule: CommandRule = {
        cmd: "wc",
        flags: ["-l"],
        args: ["readFile"],
      };
      const r1 = matchRule(`wc -l ${path.join(testDir, "file.txt")}`, rule);
      expect(r1.matches).toBe(true);
      const r2 = matchRule(`wc ${path.join(testDir, "file.txt")} -l`, rule);
      // flag after the file gets consumed as positional — design decision
      // Actually the flag extraction happens first, so -l is consumed before positional matching
      expect(r2.matches).toBe(true);
    });
  });

  describe("options", () => {
    it("should match option with value", () => {
      const _result = matchRule("head -n 5 file.txt", {
        cmd: "head",
        options: { "-n": "any" },
        args: ["readFile"],
      });
      // file.txt is relative to cwd which is testDir, but file.txt doesn't exist there
      // Let's use the actual file
      const r = matchRule(`head -n 5 ${path.join(testDir, "file.txt")}`, {
        cmd: "head",
        options: { "-n": "any" },
        args: ["readFile"],
      });
      expect(r.matches).toBe(true);
    });

    it("should reject option missing value", () => {
      const result = matchRule("head -n", {
        cmd: "head",
        options: { "-n": "any" },
      });
      expect(result.matches).toBe(false);
      expect(result.reason).toContain("requires a value");
    });

    it("should match --key=value syntax", () => {
      const result = matchRule("git --config=foo status", {
        cmd: "git",
        options: { "--config": "any" },
        subcommands: [{ cmd: "status", rest: "any" }],
      });
      expect(result.matches).toBe(true);
    });

    it("should check option value type for writeFile", () => {
      const result = matchRule(
        `sort -o ${path.join(testDir, "file.txt")} ${path.join(testDir, "other.txt")}`,
        {
          cmd: "sort",
          options: { "-o": "writeFile" },
          args: ["readFile"],
        },
      );
      expect(result.matches).toBe(true);
    });

    it("should reject write to file outside project", () => {
      const result = matchRule("sort -o /etc/passwd input.txt", {
        cmd: "sort",
        options: { "-o": "writeFile" },
        args: ["readFile"],
      });
      expect(result.matches).toBe(false);
    });

    it("should check option value with pattern type", () => {
      const rule: CommandRule = {
        cmd: "mycommand",
        options: { "--level": { pattern: "[0-9]+" } },
      };
      expect(matchRule("mycommand --level 5", rule).matches).toBe(true);
      expect(matchRule("mycommand --level abc", rule).matches).toBe(false);
    });
  });

  describe("subcommands", () => {
    const gitRule: CommandRule = {
      cmd: "git",
      options: { "-C": "any" },
      subcommands: [
        { cmd: "status", rest: "any" },
        { cmd: "commit", options: { "-m": "any" }, rest: "any" },
      ],
    };

    it("should match a known subcommand", () => {
      expect(matchRule("git status", gitRule).matches).toBe(true);
    });

    it("should match subcommand with rest args", () => {
      expect(matchRule("git status --short", gitRule).matches).toBe(true);
    });

    it("should match parent option before subcommand", () => {
      expect(matchRule("git -C /tmp status", gitRule).matches).toBe(true);
    });

    it("should reject unknown subcommand", () => {
      const result = matchRule("git clone repo", gitRule);
      expect(result.matches).toBe(false);
      expect(result.reason).toContain("unknown subcommand");
    });

    it("should require a subcommand", () => {
      const result = matchRule("git", gitRule);
      expect(result.matches).toBe(false);
      expect(result.reason).toContain("expected a subcommand");
    });

    it("should match subcommand options", () => {
      expect(matchRule('git commit -m "message"', gitRule).matches).toBe(true);
    });
  });

  describe("positional args", () => {
    it("should match readFile arg", () => {
      const result = matchRule(`cat ${path.join(testDir, "file.txt")}`, {
        cmd: "cat",
        args: ["readFile"],
      });
      expect(result.matches).toBe(true);
    });

    it("should reject missing required arg", () => {
      const result = matchRule("cat", { cmd: "cat", args: ["readFile"] });
      expect(result.matches).toBe(false);
    });

    it("should match pattern arg", () => {
      const rule: CommandRule = {
        cmd: "head",
        args: [{ pattern: "-[0-9]+" }, "readFile"],
      };
      expect(
        matchRule(`head -10 ${path.join(testDir, "file.txt")}`, rule).matches,
      ).toBe(true);
    });

    it("should reject non-matching pattern", () => {
      const rule: CommandRule = {
        cmd: "head",
        args: [{ pattern: "-[0-9]+" }, "readFile"],
      };
      expect(
        matchRule(`head -abc ${path.join(testDir, "file.txt")}`, rule).matches,
      ).toBe(false);
    });

    it("should handle optional args", () => {
      const rule: CommandRule = {
        cmd: "fd",
        options: { "-t": "any", "-e": "any" },
        args: [{ type: "any", optional: true }],
        rest: "readFiles",
      };
      expect(matchRule("fd", rule).matches).toBe(true);
      expect(matchRule("fd pattern", rule).matches).toBe(true);
      expect(
        matchRule(`fd pattern ${path.join(testDir, "subdir")}`, rule).matches,
      ).toBe(true);
    });
  });

  describe("rest: readFiles", () => {
    it("should check read permission on all rest files", () => {
      const rule: CommandRule = {
        cmd: "rg",
        args: ["any"],
        rest: "readFiles",
      };
      const result = matchRule(
        `rg pattern ${path.join(testDir, "file.txt")} ${path.join(testDir, "other.txt")}`,
        rule,
      );
      expect(result.matches).toBe(true);
    });

    it("should reject rest file outside project", () => {
      const rule: CommandRule = {
        cmd: "rg",
        args: ["any"],
        rest: "readFiles",
      };
      const result = matchRule("rg pattern /etc/passwd", rule);
      expect(result.matches).toBe(false);
    });
  });

  describe("pipe rules", () => {
    it("should match pipe rule when receiving pipe", () => {
      const config: CommandPermissionsConfig = {
        rules: [
          { cmd: "echo", rest: "any" },
          { cmd: "grep", rest: "any", pipe: true },
        ],
      };
      const result = isCommandAllowedByRules(
        "echo hello | grep hello",
        config,
        {
          cwd,
          homeDir,
        },
      );
      expect(result.allowed).toBe(true);
    });

    it("should not match pipe rule for standalone command", () => {
      const config: CommandPermissionsConfig = {
        rules: [{ cmd: "grep", rest: "any", pipe: true }],
      };
      const result = isCommandAllowedByRules("grep hello", config, {
        cwd,
        homeDir,
      });
      expect(result.allowed).toBe(false);
    });

    it("should match non-pipe rule for standalone command", () => {
      const config: CommandPermissionsConfig = {
        rules: [
          { cmd: "echo", rest: "any" },
          { cmd: "grep", args: ["any"], rest: "readFiles" },
          { cmd: "grep", rest: "any", pipe: true },
        ],
      };
      const result = isCommandAllowedByRules(
        `echo hello | grep pattern`,
        config,
        { cwd, homeDir },
      );
      expect(result.allowed).toBe(true);
    });
  });

  describe("unrecognized flags pass through to positionals", () => {
    it("should allow -10 as positional via pattern", () => {
      const rule: CommandRule = {
        cmd: "head",
        args: [{ pattern: "-[0-9]+" }, "readFile"],
      };
      expect(
        matchRule(`head -10 ${path.join(testDir, "file.txt")}`, rule).matches,
      ).toBe(true);
    });
  });

  describe("builtin permissions JSON", () => {
    it("should load and parse the JSON file", () => {
      const config = loadBuiltinPermissions();
      expect(config.rules).toBeDefined();
      expect(config.rules.length).toBeGreaterThan(0);
    });

    it("should cache builtin permissions", () => {
      const a = getBuiltinPermissions();
      const b = getBuiltinPermissions();
      expect(a).toBe(b);
    });

    it("should allow basic builtins", () => {
      const config = loadBuiltinPermissions();
      expect(
        isCommandAllowedByRules("ls -la", config, { cwd, homeDir }).allowed,
      ).toBe(true);
      expect(
        isCommandAllowedByRules("pwd", config, { cwd, homeDir }).allowed,
      ).toBe(true);
      expect(
        isCommandAllowedByRules("echo hello world", config, { cwd, homeDir })
          .allowed,
      ).toBe(true);
    });

    it("should allow cat with readable file", () => {
      const config = loadBuiltinPermissions();
      expect(
        isCommandAllowedByRules(
          `cat ${path.join(testDir, "file.txt")}`,
          config,
          {
            cwd,
            homeDir,
          },
        ).allowed,
      ).toBe(true);
    });

    it("should allow head with -n option", () => {
      const config = loadBuiltinPermissions();
      expect(
        isCommandAllowedByRules(
          `head -n 5 ${path.join(testDir, "file.txt")}`,
          config,
          { cwd, homeDir },
        ).allowed,
      ).toBe(true);
    });

    it("should allow head with numeric flag pattern", () => {
      const config = loadBuiltinPermissions();
      expect(
        isCommandAllowedByRules(
          `head -10 ${path.join(testDir, "file.txt")}`,
          config,
          { cwd, homeDir },
        ).allowed,
      ).toBe(true);
    });

    it("should allow git subcommands", () => {
      const config = loadBuiltinPermissions();
      expect(
        isCommandAllowedByRules("git status --short", config, { cwd, homeDir })
          .allowed,
      ).toBe(true);
      expect(
        isCommandAllowedByRules("git -C /tmp status", config, {
          cwd,
          homeDir,
        }).allowed,
      ).toBe(true);
      expect(
        isCommandAllowedByRules('git commit -m "message"', config, {
          cwd,
          homeDir,
        }).allowed,
      ).toBe(true);
    });

    it("should reject unknown git subcommands", () => {
      const config = loadBuiltinPermissions();
      expect(
        isCommandAllowedByRules("git clone repo", config, { cwd, homeDir })
          .allowed,
      ).toBe(false);
    });

    it("should allow pipe commands when piped", () => {
      const config = loadBuiltinPermissions();
      expect(
        isCommandAllowedByRules("echo hello | grep hello", config, {
          cwd,
          homeDir,
        }).allowed,
      ).toBe(true);
      expect(
        isCommandAllowedByRules("echo hello | sort | uniq", config, {
          cwd,
          homeDir,
        }).allowed,
      ).toBe(true);
    });

    it("should allow rg with flags and options", () => {
      const config = loadBuiltinPermissions();
      expect(
        isCommandAllowedByRules(
          `rg -l --type ts pattern ${path.join(testDir, "subdir")}`,
          config,
          { cwd, homeDir },
        ).allowed,
      ).toBe(true);
    });

    it("should allow fd with optional pattern and options", () => {
      const config = loadBuiltinPermissions();
      expect(
        isCommandAllowedByRules("fd -e ts", config, { cwd, homeDir }).allowed,
      ).toBe(true);
      expect(
        isCommandAllowedByRules(
          `fd -t f pattern ${path.join(testDir, "subdir")}`,
          config,
          {
            cwd,
            homeDir,
          },
        ).allowed,
      ).toBe(true);
    });

    it("should allow grep with -i flag and readFiles rest", () => {
      const config = loadBuiltinPermissions();
      expect(
        isCommandAllowedByRules(
          `grep -i pattern ${path.join(testDir, "file.txt")} ${path.join(testDir, "other.txt")}`,
          config,
          { cwd, homeDir },
        ).allowed,
      ).toBe(true);
    });

    it("should allow cut with options", () => {
      const config = loadBuiltinPermissions();
      expect(
        isCommandAllowedByRules(
          `cut -d , -f 1 ${path.join(testDir, "file.txt")}`,
          config,
          { cwd, homeDir },
        ).allowed,
      ).toBe(true);
    });

    it("should reject file redirect", () => {
      const config = loadBuiltinPermissions();
      expect(
        isCommandAllowedByRules("echo hello > output.txt", config, {
          cwd,
          homeDir,
        }).allowed,
      ).toBe(false);
    });

    it("should allow redirect to /dev/null", () => {
      const config = loadBuiltinPermissions();
      expect(
        isCommandAllowedByRules("echo hello > /dev/null", config, {
          cwd,
          homeDir,
        }).allowed,
      ).toBe(true);
    });

    it("should handle parse errors gracefully", () => {
      const config = loadBuiltinPermissions();
      const result = isCommandAllowedByRules("echo $(whoami)", config, {
        cwd,
        homeDir,
      });
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain("failed to parse");
    });

    it("should allow skills script execution", () => {
      const config = loadBuiltinPermissions();
      const scriptPath = path.join(skillsDir, "script.sh");
      const result = isCommandAllowedByRules(`bash ${scriptPath}`, config, {
        cwd,
        homeDir,
        skillsPaths: [path.join(testDir, ".magenta", "skills")],
      });
      expect(result.allowed).toBe(true);
    });
  });

  describe("chaining security", () => {
    it("should reject chaining with non-allowlisted command", () => {
      const config: CommandPermissionsConfig = {
        rules: [{ cmd: "echo", rest: "any" }],
      };
      const result = isCommandAllowedByRules("echo hello; rm -rf /", config, {
        cwd,
        homeDir,
      });
      expect(result.allowed).toBe(false);
    });

    it("should allow chaining allowlisted commands", () => {
      const config: CommandPermissionsConfig = {
        rules: [{ cmd: "echo", rest: "any" }, { cmd: "pwd" }],
      };
      const result = isCommandAllowedByRules("echo hello; pwd", config, {
        cwd,
        homeDir,
      });
      expect(result.allowed).toBe(true);
    });
  });

  describe("cd tracking", () => {
    it("should track cwd changes for file resolution", () => {
      fs.mkdirSync(path.join(testDir, "sub"));
      fs.writeFileSync(path.join(testDir, "sub", "data.txt"), "data");
      const config: CommandPermissionsConfig = {
        rules: [{ cmd: "cat", args: ["readFile"] }],
      };
      const result = isCommandAllowedByRules("cd sub; cat data.txt", config, {
        cwd,
        homeDir,
      });
      expect(result.allowed).toBe(true);
    });
  });
});
