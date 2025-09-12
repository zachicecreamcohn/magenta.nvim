import type { Command } from "./types.ts";
import type { ProviderMessageContent } from "../../providers/provider-types.ts";
import { getQuickfixList, quickfixListToString } from "../../nvim/nvim.ts";

const createQuickfixCommand = (name: string, pattern: RegExp): Command => ({
  name,
  description: "Add quickfix entries to context",
  pattern,
  async execute(_match, context): Promise<ProviderMessageContent[]> {
    try {
      const qflist = await getQuickfixList(context.nvim);
      const quickfixStr = await quickfixListToString(qflist, context.nvim);
      return [
        {
          type: "text",
          text: `Current quickfix list:\n${quickfixStr}`,
        },
      ];
    } catch (error) {
      context.nvim.logger.error(
        `Failed to fetch quickfix list for message: ${error instanceof Error ? error.message : String(error)}`,
      );
      return [
        {
          type: "text",
          text: `Error fetching quickfix list: ${error instanceof Error ? error.message : String(error)}`,
        },
      ];
    }
  },
});

export const qfCommand: Command = createQuickfixCommand("@qf", /@qf\b/);

export const quickfixCommand: Command = createQuickfixCommand(
  "@quickfix",
  /@quickfix\b/,
);
