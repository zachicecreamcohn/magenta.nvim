import type { ContextFileAccess } from "@magenta/server";
import type { Nvim } from "../../nvim/nvim-node/index.ts";
import type { MagentaOptions } from "../../options.ts";
import type { AgentInput } from "../../providers/provider-types.ts";
import type { Cwd, HomeDir } from "../../utils/files.ts";

export interface MessageContext {
  nvim: Nvim;
  cwd: Cwd;
  homeDir: HomeDir;
  fileSupervisor: ContextFileAccess;
  options: MagentaOptions;
}

export interface Command {
  name: string;
  description?: string;
  // Optional persistent system reminder activated when this command matches.
  systemReminder?: string;
  // Pattern to match the command (e.g., /^@nedit\b/ for simple commands, /^@file:(.+)/ for parameterized)
  pattern: RegExp;
  execute(
    match: RegExpMatchArray,
    context: MessageContext,
  ): Promise<AgentInput[]>;
}

export interface CommandMatch {
  command: Command;
  match: RegExpMatchArray;
  startIndex: number;
  endIndex: number;
}
