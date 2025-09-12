import type { Command } from "./types.ts";
import type { ProviderMessageContent } from "../../providers/provider-types.ts";
import { getBuffersList } from "../../utils/listBuffers.ts";

const createBuffersCommand = (name: string, pattern: RegExp): Command => ({
  name,
  description: "Add all open buffers to context",
  pattern,
  async execute(_match, context): Promise<ProviderMessageContent[]> {
    try {
      const buffersList = await getBuffersList(context.nvim);
      return [
        {
          type: "text",
          text: `Current buffers list:\n${buffersList}`,
        },
      ];
    } catch (error) {
      context.nvim.logger.error(
        `Failed to fetch buffers list for message: ${error instanceof Error ? error.message : String(error)}`,
      );
      return [
        {
          type: "text",
          text: `Error fetching buffers list: ${error instanceof Error ? error.message : String(error)}`,
        },
      ];
    }
  },
});

export const bufCommand: Command = createBuffersCommand("@buf", /@buf\b/);

export const buffersCommand: Command = createBuffersCommand(
  "@buffers",
  /@buffers\b/,
);
