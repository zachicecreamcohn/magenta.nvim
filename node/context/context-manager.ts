import { assertUnreachable } from "../utils/assertUnreachable";
import type { Nvim } from "../nvim/nvim-node";
import type { MessageId } from "../chat/message";
import { glob } from "glob";
import path from "node:path";
import fs from "node:fs";
import type { MagentaOptions } from "../options";
import { getcwd } from "../nvim/nvim";
import type { Dispatch } from "../tea/tea";
import type { RootMsg } from "../root-msg";
import { openFileInNonMagentaWindow } from "../nvim/openFileInNonMagentaWindow";
import {
  relativePath,
  resolveFilePath,
  type AbsFilePath,
  type RelFilePath,
  type UnresolvedFilePath,
} from "../utils/files";
import type { Result } from "../utils/result";
import * as diff from "diff";
import type { BufferTracker } from "../buffer-tracker";
import { NvimBuffer } from "../nvim/buffer";
import { d, withBindings } from "../tea/view";
import type { ProviderMessageContent } from "../providers/provider-types";
import { applyInsert, applyReplace } from "../utils/contentEdits";

export type ToolApplication =
  | {
      type: "get-file";
      content: string;
    }
  | {
      type: "insert";
      insertAfter: string;
      content: string;
    }
  | {
      type: "replace";
      find: string;
      replace: string;
    };

export type Msg =
  | {
      type: "add-file-context";
      relFilePath: RelFilePath;
      absFilePath: AbsFilePath;
      messageId: MessageId;
    }
  | {
      type: "remove-file-context";
      absFilePath: AbsFilePath;
    }
  | {
      type: "open-file";
      absFilePath: AbsFilePath;
    }
  | {
      type: "tool-applied";
      absFilePath: AbsFilePath;
      tool: ToolApplication;
    };

type Files = {
  [absFilePath: AbsFilePath]: {
    relFilePath: RelFilePath;
  };
};

export type Patch = string & { __patch: true };

export type WholeFileUpdate = {
  type: "whole-file";
  content: string;
};

export type DiffUpdate = {
  type: "diff";
  patch: Patch;
};

export type FileUpdate = WholeFileUpdate | DiffUpdate;

export type FileUpdates = {
  [absFilePath: AbsFilePath]: {
    absFilePath: AbsFilePath;
    relFilePath: RelFilePath;
    update: Result<FileUpdate>;
  };
};

export class ContextManager {
  public files: Files;

  /** Tracks what the agent thinks the files in the context look like.
   */
  private agentsViewOfFiles: {
    [absFilePath: AbsFilePath]: string;
  } = {};

  private constructor(
    public myDispatch: Dispatch<Msg>,
    private context: {
      cwd: AbsFilePath;
      dispatch: Dispatch<RootMsg>;
      bufferTracker: BufferTracker;
      nvim: Nvim;
      options: MagentaOptions;
    },
    initialFiles: Files = {},
  ) {
    this.files = initialFiles;

    // until we send the agent updates about the files, it doesn't know anything about them.
    this.agentsViewOfFiles = {};
  }

  static async create(
    myDispatch: Dispatch<Msg>,
    context: {
      dispatch: Dispatch<RootMsg>;
      cwd: AbsFilePath;
      nvim: Nvim;
      options: MagentaOptions;
      bufferTracker: BufferTracker;
    },
  ): Promise<ContextManager> {
    const initialFiles = await ContextManager.loadAutoContext(
      context.nvim,
      context.options,
    );
    return new ContextManager(myDispatch, context, initialFiles);
  }

  reset() {
    this.agentsViewOfFiles = {};
  }

  update(msg: Msg): void {
    switch (msg.type) {
      case "add-file-context":
        this.files[msg.absFilePath] = {
          relFilePath: msg.relFilePath,
        };
        return;

      case "remove-file-context":
        delete this.files[msg.absFilePath];
        return;

      case "open-file":
        openFileInNonMagentaWindow(msg.absFilePath, {
          nvim: this.context.nvim,
          options: this.context.options,
        }).catch((e: Error) => this.context.nvim.logger?.error(e.message));

        return;
      case "tool-applied":
        this.toolApplied(msg.absFilePath, msg.tool);
        return;
      default:
        assertUnreachable(msg);
    }
  }

  isContextEmpty(): boolean {
    return Object.keys(this.files).length == 0;
  }

  /**
   * Called when the agent invokes a tool that causes it to receive an update about the file content.
   * After the tool is applied, the agent's view of the file should match the current buffer state of the file.
   */
  toolApplied(absFilePath: AbsFilePath, tool: ToolApplication) {
    const relFilePath = relativePath(this.context.cwd, absFilePath);

    // make sure we add the file to context
    this.files[absFilePath] = { relFilePath };

    switch (tool.type) {
      case "get-file":
        this.agentsViewOfFiles[absFilePath] = tool.content;
        return;
      case "insert": {
        // We need to update the agent's view of the file to match what the file would be after the edit
        const currentContent = this.agentsViewOfFiles[absFilePath] || "";
        const { insertAfter, content } = tool;

        const result = applyInsert(currentContent, insertAfter, content);
        if (result.status === "ok") {
          this.agentsViewOfFiles[absFilePath] = result.content;
        } else {
          throw new Error(
            `Failed to update agent's view of ${absFilePath}: ${result.error}`,
          );
        }
        return;
      }
      case "replace": {
        const currentContent = this.agentsViewOfFiles[absFilePath] || "";
        const { find, replace } = tool;

        const result = applyReplace(currentContent, find, replace);
        if (result.status === "ok") {
          this.agentsViewOfFiles[absFilePath] = result.content;
        } else {
          throw new Error(
            `Failed to update agent's view of ${absFilePath}: ${result.error}`,
          );
        }
        return;
      }
      default:
        assertUnreachable(tool);
    }
  }

  /** we're about to send a user message to the agent. Find any changes that have happened to the files in context
   * that the agent doesn't know about yet, and update them.
   */
  async getContextUpdate(): Promise<FileUpdates> {
    if (this.isContextEmpty()) {
      return {};
    }

    const results: FileUpdates = {};
    await Promise.all(
      Object.keys(this.files).map(async (absFilePath) => {
        const result = await this.getFileMessageAndUpdateAgentViewOfFile({
          absFilePath: absFilePath as AbsFilePath,
        });
        if (result?.update) {
          results[absFilePath as AbsFilePath] = result;
        }
      }),
    );

    return results;
  }

  private async getFileMessageAndUpdateAgentViewOfFile({
    absFilePath,
  }: {
    absFilePath: AbsFilePath;
  }): Promise<FileUpdates[keyof FileUpdates] | undefined> {
    const bufSyncInfo = this.context.bufferTracker.getSyncInfo(absFilePath);
    let currentFileContent: string;
    const relFilePath = relativePath(this.context.cwd, absFilePath);

    if (bufSyncInfo) {
      // This file is open in a buffer
      try {
        const fileStats = fs.statSync(absFilePath);
        const diskMtime = fileStats.mtime.getTime();

        const buffer = new NvimBuffer(bufSyncInfo.bufnr, this.context.nvim);
        const currentChangeTick = await buffer.getChangeTick();

        const bufferChanged = bufSyncInfo.changeTick !== currentChangeTick;
        const fileChanged = bufSyncInfo.mtime < diskMtime;

        if (bufferChanged && fileChanged) {
          // Both buffer and file on disk have changed - conflict situation
          return {
            absFilePath,
            relFilePath,
            update: {
              status: "error",
              error: `Both the buffer ${bufSyncInfo.bufnr} and the file on disk for ${absFilePath} have changed. Cannot determine which version to use.`,
            },
          };
        }

        if (fileChanged && !bufferChanged) {
          await buffer.attemptEdit();
        }

        // now the buffer should have the latest version of the file
        const lines = await buffer.getLines({ start: 0, end: -1 });
        currentFileContent = lines.join("\n");
      } catch (err) {
        return {
          absFilePath,
          relFilePath,
          update: {
            status: "error",
            error: `Error when trying to grab the context of the file ${absFilePath}: ${(err as Error).message}\n${(err as Error).stack}`,
          },
        };
      }
    } else {
      // This file is only on disk. We need to read the latest version of it and send the diff along to the agent
      currentFileContent = fs.readFileSync(absFilePath).toString();
    }

    const prev = this.agentsViewOfFiles[absFilePath];
    this.agentsViewOfFiles[absFilePath] = currentFileContent;

    if (!prev) {
      return {
        absFilePath,
        relFilePath,
        update: {
          status: "ok",
          value: {
            type: "whole-file",
            content: currentFileContent,
          },
        },
      };
    }

    if (prev == currentFileContent) {
      return undefined;
    }

    const patch = diff.createPatch(
      relFilePath,
      prev,
      currentFileContent,
      "previous",
      "current",
      {
        context: 2,
        ignoreNewlineAtEof: true,
      },
    ) as Patch;

    return {
      absFilePath,
      relFilePath,
      update: {
        status: "ok",
        value: { type: "diff", patch },
      },
    };
  }

  private static async loadAutoContext(
    nvim: Nvim,
    options: MagentaOptions,
  ): Promise<Files> {
    const files: {
      [absFilePath: AbsFilePath]: {
        relFilePath: RelFilePath;
      };
    } = {};

    if (!options.autoContext || options.autoContext.length === 0) {
      return files;
    }

    try {
      const cwd = await getcwd(nvim);

      // Find all files matching the glob patterns
      const matchedFiles = await this.findFilesCrossPlatform(
        options.autoContext,
        cwd,
        nvim,
      );

      // Convert to the expected format
      for (const matchInfo of matchedFiles) {
        files[matchInfo.absFilePath] = {
          relFilePath: matchInfo.relFilePath,
        };
      }
    } catch (err) {
      nvim.logger?.error(
        `Error loading auto context: ${(err as Error).message}`,
      );
    }

    return files;
  }

  private static async findFilesCrossPlatform(
    globPatterns: string[],
    cwd: string,
    nvim: Nvim,
  ): Promise<Array<{ absFilePath: AbsFilePath; relFilePath: RelFilePath }>> {
    const allMatchedPaths: Array<{
      absFilePath: AbsFilePath;
      relFilePath: RelFilePath;
    }> = [];

    await Promise.all(
      globPatterns.map(async (pattern) => {
        try {
          // Use nocase: true for cross-platform case-insensitivity
          const matches = await glob(pattern, {
            cwd,
            nocase: true,
            nodir: true,
          });

          for (const match of matches) {
            const absFilePath = resolveFilePath(
              cwd,
              match as UnresolvedFilePath,
            );
            if (fs.existsSync(absFilePath)) {
              allMatchedPaths.push({
                absFilePath,
                relFilePath: relativePath(cwd, absFilePath),
              });
            }
          }
        } catch (err) {
          nvim.logger?.error(
            `Error processing glob pattern "${pattern}": ${(err as Error).message}`,
          );
        }
      }),
    );

    const uniqueFiles = new Map<
      string,
      { absFilePath: AbsFilePath; relFilePath: RelFilePath }
    >();

    for (const fileInfo of allMatchedPaths) {
      try {
        // Get canonical path to handle symlinks and case differences
        const canonicalPath = fs.realpathSync(fileInfo.absFilePath);
        // Use normalized path as the deduplication key
        const normalizedPath = path.normalize(canonicalPath);

        if (!uniqueFiles.has(normalizedPath)) {
          uniqueFiles.set(normalizedPath, fileInfo);
        }
      } catch {
        // Fallback if realpathSync fails
        const normalizedPath = path.normalize(fileInfo.absFilePath);
        if (!uniqueFiles.has(normalizedPath)) {
          uniqueFiles.set(normalizedPath, fileInfo);
        }
      }
    }

    return Array.from(uniqueFiles.values());
  }

  /** renders a summary of all the files we're tracking, with the ability to delete or navigate to each file.
   */
  view() {
    const fileContext = [];
    if (Object.keys(this.files).length == 0) {
      return "";
    }

    for (const absFilePath in this.files) {
      fileContext.push(
        withBindings(
          d`- \`${this.files[absFilePath as AbsFilePath].relFilePath}\`\n`,
          {
            dd: () =>
              this.myDispatch({
                type: "remove-file-context",
                absFilePath: absFilePath as AbsFilePath,
              }),
            "<CR>": () =>
              this.myDispatch({
                type: "open-file",
                absFilePath: absFilePath as AbsFilePath,
              }),
          },
        ),
      );
    }

    return d`\
# context:
${fileContext}`;
  }
}

export function contextUpdatesToContent(
  contextUpdates: FileUpdates,
): ProviderMessageContent {
  const fileUpdates: string[] = [];
  for (const path in contextUpdates) {
    const absFilePath = path as AbsFilePath;

    const update = contextUpdates[absFilePath];

    if (update.update.status === "ok") {
      switch (update.update.value.type) {
        case "whole-file": {
          fileUpdates.push(`\
- \`${update.relFilePath}\`
\`\`\`
${update.update.value.content}
\`\`\``);
          break;
        }
        case "diff": {
          fileUpdates.push(
            `\
- \`${update.relFilePath}\`
\`\`\`diff
${update.update.value.patch}
\`\`\``,
          );
          break;
        }
        default:
          assertUnreachable(update.update.value);
      }
    } else {
      fileUpdates.push(`\
- \`${update.relFilePath}\`
Error fetching update: ${update.update.error}`);
    }
  }

  return {
    type: "text",
    text: `\
These files are part of your context. This is the latest information about the content of each file.
From now on, whenever any of these files are updated by the user, you will get a message letting you know.
${fileUpdates.join("\n")}`,
  };
}
