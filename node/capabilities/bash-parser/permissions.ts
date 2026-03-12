import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { FilePermission } from "../../options.ts";
import {
  type AbsFilePath,
  expandTilde,
  type HomeDir,
  MAGENTA_TEMP_DIR,
  type NvimCwd,
  resolveFilePath,
  type UnresolvedFilePath,
} from "../../utils/files.ts";
import {
  getEffectivePermissions,
  hasNewSecretSegment,
} from "../permissions.ts";
import { LexerError } from "./lexer.ts";
import type { ParsedCommand, ParsedCommandList } from "./parser.ts";
import { ParserError, parse } from "./parser.ts";

/** A single argument specification */
export type ArgSpec =
  | string // Exact literal argument
  | { type: "file" } // Single file path argument (checks both read and write - for backwards compat)
  | { type: "readFile" } // Single file path that will be read
  | { type: "writeFile" } // Single file path that will be written
  | { type: "restFiles" } // Zero or more file paths (must be last, checks read)
  | { type: "restAny" } // Zero or more arguments of any type (must be last)
  | { type: "any" } // Any single argument (wildcard)
  | { type: "pattern"; pattern: string } // Argument matching a regex pattern
  | { type: "group"; args: ArgSpec[]; optional?: boolean; anyOrder?: boolean };

/** Top-level command permissions configuration */
export type CommandPermissions = {
  commands: ArgSpec[][]; // Array of allowed command patterns (e.g. ['git', 'status', {type: 'restAny'}])
  pipeCommands: ArgSpec[][]; // Array of allowed patterns when receiving pipe input
};

export class PermissionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PermissionError";
  }
}

/**
 * Check if a file requires secret permissions (has hidden segments after all applicable permission paths).
 * This is a local version for the bash parser to avoid circular dependency issues.
 */
function fileRequiresSecretPermission(
  absFilePath: AbsFilePath,
  filePermissions: FilePermission[],
  cwd: NvimCwd,
  homeDir: HomeDir,
): boolean {
  // Check the absolute path segments for hidden segments
  const pathSegments = absFilePath.split(path.sep).filter((s) => s.length > 0);
  if (!pathSegments.some((segment) => segment.startsWith("."))) {
    return false;
  }

  // Check all permission paths that cover this file
  // If any permission path covers the hidden segments, then it doesn't need secret permission
  const cwdPermission: FilePermission = { path: cwd, read: true, write: true };
  const allPermissions = [cwdPermission, ...filePermissions];

  for (const perm of allPermissions) {
    const permPath = expandTilde(perm.path, homeDir);
    const normalizedPermPath = path.isAbsolute(permPath)
      ? permPath
      : path.join(cwd, permPath);

    // Check if this permission path covers the file
    if (
      absFilePath === normalizedPermPath ||
      absFilePath.startsWith(normalizedPermPath + path.sep)
    ) {
      // If there are no new secret segments after this permission path, then the file
      // can be accessed without secret permission via this rule
      if (!hasNewSecretSegment(absFilePath, perm.path, cwd, homeDir)) {
        return false;
      }
    }
  }

  // All covering permission paths have new secret segments after them
  return true;
}

/** Check if a path can be read (using the filePermissions system) */
function canReadPath(
  filePath: string,
  currentCwd: NvimCwd,
  projectCwd: NvimCwd,
  filePermissions: FilePermission[],
  homeDir: HomeDir,
): { safe: boolean; reason?: string } {
  const expandedPath = expandTilde(filePath, homeDir);
  // Resolve the path relative to current working directory
  const absPath = resolveFilePath(
    currentCwd,
    expandedPath as UnresolvedFilePath,
    homeDir,
  );

  // Magenta temp files (e.g., bash command logs) are always safe
  if (absPath.startsWith(MAGENTA_TEMP_DIR + path.sep)) {
    return { safe: true };
  }

  // Get effective permissions from filePermissions config
  const effectivePerms = getEffectivePermissions(
    absPath,
    filePermissions,
    projectCwd,
    homeDir,
  );

  // Check if this file requires secret permissions
  const needsSecret = fileRequiresSecretPermission(
    absPath,
    filePermissions,
    projectCwd,
    homeDir,
  );

  if (needsSecret) {
    if (!effectivePerms.readSecret) {
      return {
        safe: false,
        reason: `path "${filePath}" is a secret file (requires readSecret permission)`,
      };
    }
  } else {
    if (!effectivePerms.read && !effectivePerms.readSecret) {
      return {
        safe: false,
        reason: `path "${filePath}" is not readable (no read permission)`,
      };
    }
  }

  return { safe: true };
}

/** Check if a path can be written (using the filePermissions system) */
function canWritePath(
  filePath: string,
  currentCwd: NvimCwd,
  projectCwd: NvimCwd,
  filePermissions: FilePermission[],
  homeDir: HomeDir,
): { safe: boolean; reason?: string } {
  const expandedPath = expandTilde(filePath, homeDir);
  // Resolve the path relative to current working directory
  const absPath = resolveFilePath(
    currentCwd,
    expandedPath as UnresolvedFilePath,
    homeDir,
  );

  // Get effective permissions from filePermissions config
  const effectivePerms = getEffectivePermissions(
    absPath,
    filePermissions,
    projectCwd,
    homeDir,
  );

  // Check if this file requires secret permissions
  const needsSecret = fileRequiresSecretPermission(
    absPath,
    filePermissions,
    projectCwd,
    homeDir,
  );

  if (needsSecret) {
    if (!effectivePerms.writeSecret) {
      return {
        safe: false,
        reason: `path "${filePath}" is a secret file (requires writeSecret permission)`,
      };
    }
  } else {
    if (!effectivePerms.write && !effectivePerms.writeSecret) {
      return {
        safe: false,
        reason: `path "${filePath}" is not writable (no write permission)`,
      };
    }
  }

  return { safe: true };
}

/** Check if a path is within a skills directory */
function isWithinSkillsDir(
  scriptPath: string,
  skillsPaths: string[],
  cwd: NvimCwd,
  homeDir: HomeDir,
): boolean {
  const expandedScriptPath = expandTilde(scriptPath, homeDir);
  const resolvedScript = resolveFilePath(
    cwd,
    expandedScriptPath as UnresolvedFilePath,
    homeDir,
  );

  for (const skillsPath of skillsPaths) {
    const expandedSkillsPath = expandTilde(skillsPath, homeDir);
    const resolvedSkillsPath = resolveFilePath(
      cwd,
      expandedSkillsPath as UnresolvedFilePath,
      homeDir,
    );

    const normalizedSkillsPath = resolvedSkillsPath.endsWith(path.sep)
      ? resolvedSkillsPath
      : resolvedSkillsPath + path.sep;

    if (resolvedScript.startsWith(normalizedSkillsPath)) {
      return true;
    }
  }

  return false;
}

/** Check if script file exists and is a regular file */
function isExecutableScript(
  scriptPath: string,
  cwd: NvimCwd,
  homeDir: HomeDir,
): boolean {
  try {
    const expandedPath = expandTilde(scriptPath, homeDir);
    const resolvedPath = resolveFilePath(
      cwd,
      expandedPath as UnresolvedFilePath,
      homeDir,
    );
    const stats = fs.statSync(resolvedPath);
    return stats.isFile();
  } catch {
    return false;
  }
}

/** Script runner patterns that can execute scripts */
const SCRIPT_RUNNERS: Record<string, RegExp> = {
  bash: /^(?:ba)?sh$/,
  zsh: /^zsh$/,
  python: /^python[23]?$/,
  node: /^(?:node|nodejs)$/,
  npx: /^npx$/,
  pkgx: /^pkgx$/,
};

/** Check if a command is executing a skills script */
function isSkillsScriptExecution(
  command: ParsedCommand,
  skillsPaths: string[],
  cwd: NvimCwd,
  homeDir: HomeDir,
): boolean {
  if (skillsPaths.length === 0) {
    return false;
  }

  const { executable, args } = command;

  // Direct script execution: ./script.sh or /path/to/script
  if (
    executable.startsWith("./") ||
    executable.startsWith("/") ||
    executable.startsWith("~/")
  ) {
    if (isExecutableScript(executable, cwd, homeDir)) {
      return isWithinSkillsDir(executable, skillsPaths, cwd, homeDir);
    }
    return false;
  }

  // bash/sh/zsh script.sh
  if (
    SCRIPT_RUNNERS.bash.test(executable) ||
    SCRIPT_RUNNERS.zsh.test(executable)
  ) {
    if (args.length > 0) {
      const scriptPath = args[0];
      if (isExecutableScript(scriptPath, cwd, homeDir)) {
        return isWithinSkillsDir(scriptPath, skillsPaths, cwd, homeDir);
      }
    }
    return false;
  }

  // python script.py
  if (SCRIPT_RUNNERS.python.test(executable)) {
    if (args.length > 0) {
      const scriptPath = args[0];
      if (isExecutableScript(scriptPath, cwd, homeDir)) {
        return isWithinSkillsDir(scriptPath, skillsPaths, cwd, homeDir);
      }
    }
    return false;
  }

  // node script.js
  if (SCRIPT_RUNNERS.node.test(executable)) {
    if (args.length > 0) {
      const scriptPath = args[0];
      if (isExecutableScript(scriptPath, cwd, homeDir)) {
        return isWithinSkillsDir(scriptPath, skillsPaths, cwd, homeDir);
      }
    }
    return false;
  }

  // npx tsx script.ts
  if (SCRIPT_RUNNERS.npx.test(executable)) {
    if (args.length >= 2 && args[0] === "tsx") {
      const scriptPath = args[1];
      if (isExecutableScript(scriptPath, cwd, homeDir)) {
        return isWithinSkillsDir(scriptPath, skillsPaths, cwd, homeDir);
      }
    }
    return false;
  }

  // pkgx <interpreter> script.ext (e.g., pkgx tsx script.ts, pkgx python script.py)
  if (SCRIPT_RUNNERS.pkgx.test(executable)) {
    if (args.length >= 2) {
      const interpreter = args[0];
      // Check if the interpreter is a known script runner
      if (
        interpreter === "tsx" ||
        SCRIPT_RUNNERS.python.test(interpreter) ||
        SCRIPT_RUNNERS.node.test(interpreter) ||
        SCRIPT_RUNNERS.bash.test(interpreter) ||
        SCRIPT_RUNNERS.zsh.test(interpreter)
      ) {
        const scriptPath = args[1];
        if (isExecutableScript(scriptPath, cwd, homeDir)) {
          return isWithinSkillsDir(scriptPath, skillsPaths, cwd, homeDir);
        }
      }
    }
    return false;
  }

  return false;
}

type MatchContext = {
  currentCwd: NvimCwd;
  projectCwd: NvimCwd;
  filePermissions: FilePermission[];
  homeDir: HomeDir;
};

function processCdCommand(
  command: ParsedCommand,
  currentCwd: NvimCwd,
  homeDir: HomeDir,
): NvimCwd | undefined {
  if (command.executable !== "cd") {
    return undefined;
  }

  if (command.args.length === 0) {
    // cd with no args goes to home
    return homeDir as unknown as NvimCwd;
  }

  const targetDir = command.args[0];
  const expandedDir = expandTilde(targetDir, homeDir);
  const newCwd = resolveFilePath(
    currentCwd,
    expandedDir as UnresolvedFilePath,
    homeDir,
  );

  return newCwd as NvimCwd;
}

export type PermissionCheckResult = {
  allowed: boolean;
  reason?: string;
};

/** Check if a parsed command list is allowed */

// New JSON-based command permission types and matching engine
// =====================================================================

/** Value type for an option that takes a value */
export type OptionValueType =
  | "any"
  | "readFile"
  | "writeFile"
  | { pattern: string };

/** Positional argument type */
export type ArgType =
  | "any"
  | "readFile"
  | "writeFile"
  | { pattern: string }
  | { type: "any" | "readFile" | "writeFile"; optional?: boolean };

/** A single command rule — recursive tree structure */
export type CommandRule = {
  cmd: string;
  flags?: string[];
  options?: Record<string, OptionValueType>;
  subcommands?: CommandRule[];
  args?: ArgType[];
  rest?: "any" | "readFiles" | "writeFiles";
  pipe?: boolean;
};

/** The full permissions config */
export type CommandPermissionsConfig = {
  rules: CommandRule[];
};

/** Check an option value against its declared type */
function checkOptionValue(
  value: string,
  valueType: OptionValueType,
  ctx: MatchContext,
): { ok: boolean; reason?: string } {
  if (valueType === "any") {
    return { ok: true };
  }
  if (valueType === "readFile") {
    const result = canReadPath(
      value,
      ctx.currentCwd,
      ctx.projectCwd,
      ctx.filePermissions,
      ctx.homeDir,
    );
    return result.safe
      ? { ok: true }
      : { ok: false, reason: result.reason ?? "invalid file path" };
  }
  if (valueType === "writeFile") {
    const result = canWritePath(
      value,
      ctx.currentCwd,
      ctx.projectCwd,
      ctx.filePermissions,
      ctx.homeDir,
    );
    return result.safe
      ? { ok: true }
      : { ok: false, reason: result.reason ?? "invalid file path" };
  }
  // { pattern: string }
  const regex = new RegExp(`^${valueType.pattern}$`);
  if (!regex.test(value)) {
    return {
      ok: false,
      reason: `option value "${value}" does not match pattern "${valueType.pattern}"`,
    };
  }
  return { ok: true };
}

/** Check a positional argument against its declared type */
function checkPositionalArg(
  value: string,
  argType: ArgType,
  ctx: MatchContext,
): { ok: boolean; reason?: string } {
  if (argType === "any") {
    return { ok: true };
  }
  if (argType === "readFile") {
    const result = canReadPath(
      value,
      ctx.currentCwd,
      ctx.projectCwd,
      ctx.filePermissions,
      ctx.homeDir,
    );
    return result.safe
      ? { ok: true }
      : { ok: false, reason: result.reason ?? "invalid file path" };
  }
  if (argType === "writeFile") {
    const result = canWritePath(
      value,
      ctx.currentCwd,
      ctx.projectCwd,
      ctx.filePermissions,
      ctx.homeDir,
    );
    return result.safe
      ? { ok: true }
      : { ok: false, reason: result.reason ?? "invalid file path" };
  }
  if ("pattern" in argType) {
    const regex = new RegExp(`^${argType.pattern}$`);
    if (!regex.test(value)) {
      return {
        ok: false,
        reason: `argument "${value}" does not match pattern "${argType.pattern}"`,
      };
    }
    return { ok: true };
  }
  // { type, optional }
  return checkPositionalArg(value, argType.type, ctx);
}

/** Get whether an ArgType is optional */
function isArgOptional(argType: ArgType): boolean {
  if (typeof argType === "string") return false;
  if ("pattern" in argType) return false;
  return argType.optional === true;
}

/**
 * Try to match remaining args against a CommandRule (after cmd has been consumed).
 * Returns { matches: true } or { matches: false, reason }.
 */
function matchRuleBody(
  remaining: string[],
  rule: CommandRule,
  ctx: MatchContext,
): { matches: boolean; reason?: string } {
  // Phase 1: Extract flags and options, leaving unrecognized args in place
  const knownFlags = new Set(rule.flags ?? []);
  const knownOptions: Record<string, OptionValueType> = rule.options ?? {};
  const leftover: string[] = [];

  let i = 0;
  while (i < remaining.length) {
    const arg = remaining[i];

    // Check if it's a known flag
    if (knownFlags.has(arg)) {
      i++;
      continue;
    }

    // Check if it's a known option key
    if (arg in knownOptions) {
      if (i + 1 >= remaining.length) {
        return {
          matches: false,
          reason: `option "${arg}" requires a value`,
        };
      }
      const valueCheck = checkOptionValue(
        remaining[i + 1],
        knownOptions[arg],
        ctx,
      );
      if (!valueCheck.ok) {
        return {
          matches: false,
          reason: valueCheck.reason ?? "invalid option value",
        };
      }
      i += 2;
      continue;
    }

    // Check --key=value syntax
    if (arg.startsWith("--") && arg.includes("=")) {
      const eqIndex = arg.indexOf("=");
      const key = arg.slice(0, eqIndex);
      const value = arg.slice(eqIndex + 1);
      if (key in knownOptions) {
        const valueCheck = checkOptionValue(value, knownOptions[key], ctx);
        if (!valueCheck.ok) {
          return {
            matches: false,
            reason: valueCheck.reason ?? "invalid option value",
          };
        }
        i++;
        continue;
      }
    }

    // Unrecognized — pass through to positional matching
    leftover.push(arg);
    i++;
  }

  // Phase 2: Branch — subcommands vs leaf
  if (rule.subcommands !== undefined && rule.subcommands.length > 0) {
    if (leftover.length === 0) {
      return {
        matches: false,
        reason: `expected a subcommand for "${rule.cmd}"`,
      };
    }
    const subcmd = leftover[0];
    const matchingSubcommand = rule.subcommands.find((s) => s.cmd === subcmd);
    if (!matchingSubcommand) {
      return {
        matches: false,
        reason: `unknown subcommand "${subcmd}" for "${rule.cmd}"`,
      };
    }
    return matchRuleBody(leftover.slice(1), matchingSubcommand, ctx);
  }

  // Phase 3: Positional matching (leaf node)
  const positionals = rule.args ?? [];
  let posIdx = 0;
  let leftIdx = 0;

  while (posIdx < positionals.length && leftIdx < leftover.length) {
    const argType = positionals[posIdx];
    const check = checkPositionalArg(leftover[leftIdx], argType, ctx);
    if (!check.ok) {
      // If this positional is optional, skip it and try the next positional
      if (isArgOptional(argType)) {
        posIdx++;
        continue;
      }
      return { matches: false, reason: check.reason ?? "argument mismatch" };
    }
    posIdx++;
    leftIdx++;
  }

  // Skip remaining optional positionals
  while (posIdx < positionals.length && isArgOptional(positionals[posIdx])) {
    posIdx++;
  }

  // Check all required positionals were consumed
  if (posIdx < positionals.length) {
    return {
      matches: false,
      reason: `missing required positional argument`,
    };
  }

  // Phase 4: Rest handling
  if (leftIdx < leftover.length) {
    if (rule.rest === undefined) {
      return {
        matches: false,
        reason: `unexpected extra arguments: ${leftover.slice(leftIdx).join(" ")}`,
      };
    }
    if (rule.rest === "any") {
      // Accept everything
      return { matches: true };
    }
    // Validate remaining args as files
    while (leftIdx < leftover.length) {
      if (rule.rest === "readFiles") {
        const check = canReadPath(
          leftover[leftIdx],
          ctx.currentCwd,
          ctx.projectCwd,
          ctx.filePermissions,
          ctx.homeDir,
        );
        if (!check.safe) {
          return {
            matches: false,
            reason: check.reason ?? "invalid file path",
          };
        }
      } else if (rule.rest === "writeFiles") {
        const check = canWritePath(
          leftover[leftIdx],
          ctx.currentCwd,
          ctx.projectCwd,
          ctx.filePermissions,
          ctx.homeDir,
        );
        if (!check.safe) {
          return {
            matches: false,
            reason: check.reason ?? "invalid file path",
          };
        }
      }
      leftIdx++;
    }
  }

  return { matches: true };
}

/** Check a single parsed command against a CommandRule */
export function checkCommandAgainstRule(
  command: ParsedCommand,
  rule: CommandRule,
  ctx: MatchContext,
): { matches: boolean; reason?: string } {
  // Check cmd matches executable
  if (command.executable !== rule.cmd) {
    return {
      matches: false,
      reason: `expected "${rule.cmd}" but got "${command.executable}"`,
    };
  }

  return matchRuleBody(command.args, rule, ctx);
}

/** Check a single parsed command against all rules */
function checkCommandAgainstRules(
  command: ParsedCommand,
  config: CommandPermissionsConfig,
  ctx: MatchContext,
): { allowed: boolean; reason?: string } {
  const applicableRules = config.rules.filter((rule) => {
    if (command.receivingPipe) {
      return rule.pipe === true;
    }
    return rule.pipe !== true;
  });

  let lastReason: string | undefined;
  for (const rule of applicableRules) {
    const result = checkCommandAgainstRule(command, rule, ctx);
    if (result.matches) {
      return { allowed: true };
    }
    lastReason = result.reason;
  }

  return {
    allowed: false,
    reason:
      lastReason ??
      `command "${command.executable}" does not match any allowed rule`,
  };
}

/** Check if a parsed command list is allowed (new rule-based engine) */
export function checkCommandListPermissionsByRules(
  commandList: ParsedCommandList,
  config: CommandPermissionsConfig,
  options: {
    cwd: NvimCwd;
    homeDir: HomeDir;
    skillsPaths?: string[];
    filePermissions?: FilePermission[];
  },
): PermissionCheckResult {
  const projectCwd = options.cwd;
  let currentCwd = options.cwd;
  const homeDir = options.homeDir;
  const skillsPaths = options.skillsPaths ?? [];
  const filePermissions = options.filePermissions ?? [];

  for (const command of commandList.commands) {
    const newCwd = processCdCommand(command, currentCwd, homeDir);
    if (newCwd !== undefined) {
      currentCwd = newCwd;
      continue;
    }

    if (isSkillsScriptExecution(command, skillsPaths, currentCwd, homeDir)) {
      continue;
    }

    const ctx: MatchContext = {
      currentCwd,
      projectCwd,
      filePermissions,
      homeDir,
    };

    const result = checkCommandAgainstRules(command, config, ctx);
    if (!result.allowed) {
      return {
        allowed: false,
        reason: `command "${command.executable} ${command.args.join(" ")}": ${result.reason}`,
      };
    }

    for (const redirect of command.fileRedirects) {
      if (redirect.target !== "/dev/null") {
        return {
          allowed: false,
          reason: `file redirection to "${redirect.target}" is not auto-approved`,
        };
      }
    }
  }

  return { allowed: true };
}

const BUILTIN_PERMISSIONS_PATH = path.join(
  path.join(path.dirname(fileURLToPath(import.meta.url))),
  "builtin-permissions.json",
);

/** Load builtin permissions from the JSON file */
export function loadBuiltinPermissions(): CommandPermissionsConfig {
  const content = fs.readFileSync(BUILTIN_PERMISSIONS_PATH, "utf-8");
  const parsed = JSON.parse(content) as CommandPermissionsConfig;
  return parsed;
}

/** Cached builtin permissions with mtime tracking */
let _cachedBuiltinRules: CommandPermissionsConfig | undefined;
let _builtinMtime: number | undefined;

/** Get builtin permissions (reloads when file mtime changes) */
export function getBuiltinPermissions(): CommandPermissionsConfig {
  try {
    const stat = fs.statSync(BUILTIN_PERMISSIONS_PATH);
    const mtime = stat.mtimeMs;
    if (_cachedBuiltinRules === undefined || mtime !== _builtinMtime) {
      _builtinMtime = mtime;
      _cachedBuiltinRules = loadBuiltinPermissions();
    }
  } catch {
    if (_cachedBuiltinRules === undefined) {
      _cachedBuiltinRules = loadBuiltinPermissions();
    }
  }
  return _cachedBuiltinRules;
}
/** Main entry point for rule-based permissions checking */
export function isCommandAllowedByRules(
  command: string,
  config: CommandPermissionsConfig,
  options: {
    cwd: NvimCwd;
    homeDir: HomeDir;
    skillsPaths?: string[];
    filePermissions?: FilePermission[];
  },
): PermissionCheckResult {
  try {
    const parsed = parse(command);
    return checkCommandListPermissionsByRules(parsed, config, options);
  } catch (error) {
    if (error instanceof LexerError || error instanceof ParserError) {
      return {
        allowed: false,
        reason: `failed to parse command: ${error.message}`,
      };
    }
    throw error;
  }
}
