import type { Command } from "./types.ts";
import type { ProviderMessageContent } from "../../providers/provider-types.ts";
import { getBuffersList } from "../../utils/listBuffers.ts";

export const bufCommand: Command = {
  name: "@buf",
  description: "Add current buffer to context",
  pattern: /@buf\b/,
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
};

export const buffersCommand: Command = {
  name: "@buffers",
  description: "Add all open buffers to context",
  pattern: /@buffers\b/,
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
};
