import type { Command } from "./types.ts";
import type { ProviderMessageContent } from "../../providers/provider-types.ts";
import type { UnresolvedFilePath } from "../../utils/files.ts";
import {
  resolveFilePath,
  relativePath,
  detectFileType,
} from "../../utils/files.ts";

export const fileCommand: Command = {
  name: "@file:",
  pattern: /@file:(\S+)/g,
  async execute(match, context): Promise<ProviderMessageContent[]> {
    const filePath = match[1] as UnresolvedFilePath;
    try {
      const absFilePath = resolveFilePath(context.cwd, filePath);
      const relFilePath = relativePath(context.cwd, absFilePath);
      const fileTypeInfo = await detectFileType(absFilePath);

      if (!fileTypeInfo) {
        throw new Error(`File ${filePath} does not exist`);
      }

      context.contextManager.update({
        type: "add-file-context",
        relFilePath,
        absFilePath,
        fileTypeInfo,
      });

      return []; // File context is handled by contextManager
    } catch (error) {
      context.nvim.logger.error(
        `Failed to add file to context for ${filePath}: ${error instanceof Error ? error.message : String(error)}`,
      );
      return [
        {
          type: "text",
          text: `Error adding file to context for ${filePath}: ${error instanceof Error ? error.message : String(error)}`,
        },
      ];
    }
  },
};
