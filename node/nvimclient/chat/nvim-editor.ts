import {
  type AgentInput,
  type EditorCapabilities,
  type PendingMessage,
  parseCompact,
  type ResolvedSubmission,
  type ResolveSubmissionContext,
} from "@magenta/server";
import type { Lsp } from "../capabilities/lsp.ts";
import { NvimLspClient } from "../capabilities/lsp-client-adapter.ts";
import { NvimLuaExecutor } from "../capabilities/nvim-lua-executor.ts";
import type { Nvim } from "../nvim/nvim-node/index.ts";
import type { MagentaOptions } from "../options.ts";
import { reloadBufferIfOpen } from "../utils/buffers.ts";
import type { HomeDir, NvimCwd } from "../utils/files.ts";
import type { CommandRegistry } from "./commands/registry.ts";

/** The collaborators this Neovim instance lends to threads while attached. */
export async function createNvimEditor({
  nvim,
  lsp,
  cwd,
  homeDir,
}: {
  nvim: Nvim;
  lsp: Lsp;
  cwd: NvimCwd;
  homeDir: HomeDir;
}): Promise<EditorCapabilities> {
  const neovimVersion = String(await nvim.call("nvim_eval", ["v:version"]));
  return {
    neovimVersion,
    createLspClient: (threadCwd, threadHomeDir) =>
      new NvimLspClient(lsp, nvim, threadCwd, threadHomeDir),
    luaExecutor: new NvimLuaExecutor(nvim),
    onFileWritten: (absPath) =>
      reloadBufferIfOpen({ nvim, cwd, homeDir }, absPath),
  };
}

export type SubmissionCommands = {
  nvim: Nvim;
  commandRegistry: Pick<CommandRegistry, "processMessage">;
  getOptions: () => MagentaOptions;
};

export async function resolveSubmission(
  message: PendingMessage,
  commands: SubmissionCommands,
  { cwd, homeDir, getContextFiles, canCompact }: ResolveSubmissionContext,
): Promise<ResolvedSubmission> {
  const { compact, rest } = canCompact
    ? parseCompact(message)
    : { compact: false, rest: message };
  const { processedText, additionalContent, reminders } =
    await commands.commandRegistry.processMessage(rest, {
      nvim: commands.nvim,
      cwd,
      homeDir,
      fileSupervisor: getContextFiles(),
      options: commands.getOptions(),
    });
  const content: AgentInput[] = [{ type: "text", text: processedText }];
  for (const extra of additionalContent) {
    if (
      extra.type === "text" ||
      extra.type === "image" ||
      extra.type === "document"
    ) {
      content.push(extra);
    }
  }
  const prompt = { content, reminders };
  return compact ? { type: "compact", prompt } : { type: "send", prompt };
}
