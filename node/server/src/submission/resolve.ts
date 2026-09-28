import type { FileIO } from "../capabilities/file-io.ts";
import type { Logger } from "../logger.ts";
import type { AgentInput } from "../providers/provider-types.ts";
import type { ContextFileAccess } from "../thread.ts";
import type { Cwd, HomeDir } from "../utils/files.ts";
import { CommandRegistry } from "./commands/registry.ts";
import type { CustomCommand } from "./commands/types.ts";
import {
  type PendingMessage,
  parseCompact,
  type ResolvedSubmission,
} from "./index.ts";

export type ResolveSubmissionContext = {
  cwd: Cwd;
  homeDir: HomeDir;
  fileIO: FileIO;
  logger: Logger;
  customCommands: CustomCommand[];
  getContextFiles: () => ContextFileAccess;
  /** A compact thread has no compactor, so `@compact` is ordinary text. */
  canCompact: boolean;
};

/** Expands the fs/git commands of a raw message at delivery time. Editor
 * commands (`@buf`, `@qf`, `@diag`) were already expanded by the client. */
export async function resolveSubmission(
  message: PendingMessage,
  context: ResolveSubmissionContext,
): Promise<ResolvedSubmission> {
  const { compact, rest } = context.canCompact
    ? parseCompact(message)
    : { compact: false, rest: message };
  const registry = new CommandRegistry();
  for (const custom of context.customCommands) {
    registry.registerCustomCommand(custom);
  }
  const { processedText, additionalContent, reminders } =
    await registry.processMessage(rest, {
      cwd: context.cwd,
      homeDir: context.homeDir,
      fileIO: context.fileIO,
      logger: context.logger,
      fileSupervisor: context.getContextFiles(),
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
