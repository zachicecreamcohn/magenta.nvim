import { d, withBindings } from "../tea/view";
import { assertUnreachable } from "../utils/assertUnreachable";
import type { ProviderMessage } from "../providers/provider";
import type { Nvim } from "nvim-node";
import type { MessageId } from "../chat/message";
import { BufferAndFileManager } from "./file-and-buffer-manager";
import { glob } from "glob";
import path from "node:path";
import fs from "node:fs";
import type { MagentaOptions } from "../options";
import { getcwd } from "../nvim/nvim";
import type { Dispatch } from "../tea/tea";
import type { RootMsg } from "../root-msg";
import { openFileInNonMagentaWindow } from "../nvim/openFileInNonMagentaWindow";
import type { AbsFilePath, RelFilePath } from "../utils/files";

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
    };

export class ContextManager {
  public dispatch: Dispatch<RootMsg>;
  public files: {
    [absFilePath: AbsFilePath]: {
      relFilePath: RelFilePath;
      initialMessageId: MessageId;
    };
  };
  private bufferAndFileManager: BufferAndFileManager;
  private nvim: Nvim;
  private options: MagentaOptions;

  private constructor(
    public myDispatch: Dispatch<Msg>,
    {
      dispatch,
      nvim,
      options,
      initialFiles = {},
    }: {
      dispatch: Dispatch<RootMsg>;
      nvim: Nvim;
      options: MagentaOptions;
      initialFiles?: {
        [absFilePath: AbsFilePath]: {
          relFilePath: RelFilePath;
          initialMessageId: MessageId;
        };
      };
    },
  ) {
    this.dispatch = dispatch;
    this.nvim = nvim;
    this.options = options;
    this.bufferAndFileManager = new BufferAndFileManager(nvim);
    this.files = initialFiles;
  }

  static async create(
    myDispatch: Dispatch<Msg>,
    {
      dispatch,
      nvim,
      options,
    }: {
      dispatch: Dispatch<RootMsg>;
      nvim: Nvim;
      options: MagentaOptions;
    },
  ): Promise<ContextManager> {
    const initialFiles = await ContextManager.loadAutoContext(nvim, options);
    return new ContextManager(myDispatch, {
      dispatch,
      nvim,
      options,
      initialFiles,
    });
  }

  update(msg: Msg): void {
    switch (msg.type) {
      case "add-file-context":
        this.files[msg.absFilePath] = {
          relFilePath: msg.relFilePath,
          initialMessageId: msg.messageId,
        };
        return;
      case "remove-file-context":
        console.log(`remove-file-context ${msg.absFilePath}`);
        delete this.files[msg.absFilePath];
        return;
      case "open-file":
        openFileInNonMagentaWindow(msg.absFilePath, {
          nvim: this.nvim,
          options: this.options,
        }).catch((e: Error) => this.nvim.logger?.error(e.message));

        return;
      default:
        assertUnreachable(msg);
    }
  }

  isContextEmpty(): boolean {
    return Object.keys(this.files).length == 0;
  }

  async getContextMessages(
    currentMessageId: MessageId,
  ): Promise<{ messageId: MessageId; message: ProviderMessage }[] | undefined> {
    if (this.isContextEmpty()) {
      return undefined;
    }

    return await Promise.all(
      Object.keys(this.files).map((absFilePath) =>
        this.getFileMessage({
          absFilePath: absFilePath as AbsFilePath,
          currentMessageId,
        }),
      ),
    );
  }

  private async getFileMessage({
    absFilePath,
    currentMessageId,
  }: {
    absFilePath: AbsFilePath;
    currentMessageId: MessageId;
  }): Promise<{ messageId: MessageId; message: ProviderMessage }> {
    const res = await this.bufferAndFileManager.getFileContents(
      absFilePath,
      currentMessageId,
    );

    switch (res.status) {
      case "ok":
        return {
          messageId: res.value.messageId,
          message: {
            role: "user",
            content: this.renderFile({
              relFilePath: res.value.relFilePath,
              content: res.value.content,
            }),
          },
        };

      case "error":
        return {
          messageId: currentMessageId,
          message: {
            role: "user",
            content: `Error reading file \`${absFilePath}\`: ${res.error}`,
          },
        };
      default:
        assertUnreachable(res);
    }
  }

  private static async loadAutoContext(
    nvim: Nvim,
    options: MagentaOptions,
  ): Promise<{
    [absFilePath: AbsFilePath]: {
      relFilePath: RelFilePath;
      initialMessageId: MessageId;
    };
  }> {
    const files: {
      [absFilePath: AbsFilePath]: {
        relFilePath: RelFilePath;
        initialMessageId: MessageId;
      };
    } = {};

    if (!options.autoContext || options.autoContext.length === 0) {
      return files;
    }

    try {
      const cwd = await getcwd(nvim);
      // Use a placeholder message ID since we don't have a current message during initialization
      const initialMessageId = 0 as MessageId;

      // Find all files matching the glob patterns
      const matchedFiles = await this.findFilesCrossPlatform(
        options.autoContext,
        cwd,
        nvim,
      );

      // Convert to the expected format
      for (const matchInfo of matchedFiles) {
        files[matchInfo.absFilePath as AbsFilePath] = {
          relFilePath: matchInfo.relFilePath as RelFilePath,
          initialMessageId,
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
  ): Promise<Array<{ absFilePath: string; relFilePath: string }>> {
    const allMatchedPaths: Array<{ absFilePath: string; relFilePath: string }> =
      [];

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
            if (fs.existsSync(path.resolve(cwd, match))) {
              allMatchedPaths.push({
                absFilePath: path.resolve(cwd, match),
                relFilePath: match,
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
      { absFilePath: string; relFilePath: string }
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

  private renderFile({
    relFilePath,
    content,
  }: {
    relFilePath: string;
    content: string;
  }) {
    return `\
Here are the contents of file \`${relFilePath}\`:
\`\`\`
${content}
\`\`\``;
  }

  view() {
    const fileContext = [];
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
