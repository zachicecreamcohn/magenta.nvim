import { assertUnreachable } from "../utils/assertUnreachable.ts";
import type { Logger } from "../logger.ts";
import type { FileIO } from "../capabilities/file-io.ts";
import type {
  ToolApplied,
  ContextTracker,
  TrackedFileInfo,
} from "../capabilities/context-tracker.ts";
import {
  relativePath,
  resolveFilePath,
  detectFileType,
  FileCategory,
  type AbsFilePath,
  type HomeDir,
  type NvimCwd,
  type RelFilePath,
  type UnresolvedFilePath,
  type FileTypeInfo,
} from "../utils/files.ts";
import type { Result } from "../utils/result.ts";
import type { ProviderMessageContent } from "../providers/provider-types.ts";
import { getSummaryAsProviderContent } from "../utils/pdf-pages.ts";
import * as diff from "diff";

export type Patch = string & { __patch: true };

export type WholeFileUpdate = {
  type: "whole-file";
  content: ProviderMessageContent[];
  pdfPage?: number;
  pdfSummary?: boolean;
};

export type DiffUpdate = {
  type: "diff";
  patch: Patch;
};

export type FileDeletedUpdate = {
  type: "file-deleted";
};

export type FileUpdate = WholeFileUpdate | DiffUpdate | FileDeletedUpdate;

export type FileUpdates = {
  [absFilePath: AbsFilePath]: {
    absFilePath: AbsFilePath;
    relFilePath: RelFilePath;
    update: Result<FileUpdate>;
  };
};

export type Files = {
  [absFilePath: AbsFilePath]: {
    relFilePath: RelFilePath;
    fileTypeInfo: FileTypeInfo;
    agentView: TrackedFileInfo["agentView"];
  };
};

export class ContextManager implements ContextTracker {
  public files: Files;

  constructor(
    private logger: Logger,
    private fileIO: FileIO,
    private cwd: NvimCwd,
    private homeDir: HomeDir,
    initialFiles: Files = {},
  ) {
    this.files = initialFiles;
  }

  addFileContext(
    absFilePath: AbsFilePath,
    relFilePath: RelFilePath,
    fileTypeInfo: FileTypeInfo,
  ): void {
    if (fileTypeInfo.category === FileCategory.UNSUPPORTED) {
      throw new Error(
        `Cannot add ${relFilePath} to context: ${fileTypeInfo.category} files are not supported in context (detected MIME type: ${fileTypeInfo.mimeType})`,
      );
    }
    this.files[absFilePath] = {
      relFilePath,
      fileTypeInfo,
      agentView: undefined,
    };
  }

  removeFileContext(absFilePath: AbsFilePath): void {
    delete this.files[absFilePath];
  }

  toolApplied(
    absFilePath: AbsFilePath,
    tool: ToolApplied,
    fileTypeInfo: FileTypeInfo,
  ): void {
    const relFilePath = relativePath(this.cwd, absFilePath, this.homeDir);

    if (!this.files[absFilePath]) {
      this.files[absFilePath] = {
        relFilePath,
        fileTypeInfo,
        agentView: undefined,
      };
    }

    this.updateAgentsViewOfFiles(absFilePath, tool);
  }

  async addFiles(filePaths: UnresolvedFilePath[]): Promise<void> {
    for (const filePath of filePaths) {
      const absFilePath = resolveFilePath(this.cwd, filePath, this.homeDir);
      const relFilePath = relativePath(this.cwd, absFilePath, this.homeDir);

      const fileTypeInfo = await detectFileType(absFilePath);
      if (!fileTypeInfo) {
        this.logger.warn(
          `File ${filePath} does not exist, skipping in context`,
        );
        continue;
      }

      if (fileTypeInfo.category === FileCategory.UNSUPPORTED) {
        this.logger.warn(`Skipping ${filePath}: unsupported file type`);
        continue;
      }

      this.files[absFilePath] = {
        relFilePath,
        fileTypeInfo,
        agentView: undefined,
      };
    }
  }

  reset(): void {
    for (const absFilePath in this.files) {
      this.files[absFilePath as AbsFilePath].agentView = undefined;
    }
  }

  isContextEmpty(): boolean {
    return Object.keys(this.files).length === 0;
  }

  async getContextUpdate(): Promise<FileUpdates> {
    if (this.isContextEmpty()) {
      return {};
    }

    const keys = Object.keys(this.files) as AbsFilePath[];
    const entries = await Promise.all(
      keys.map(async (absFilePath) => {
        const result = await this.getFileMessageAndUpdateAgentViewOfFile({
          absFilePath,
        });
        return { absFilePath, result };
      }),
    );

    const results: FileUpdates = {};
    for (const { absFilePath, result } of entries) {
      if (result?.update) {
        results[absFilePath] = result;
      }
    }

    return results;
  }

  contextUpdatesToContent(
    contextUpdates: FileUpdates,
  ): ProviderMessageContent[] {
    const textParts: string[] = [];
    const filePathEntries: string[] = [];

    for (const path in contextUpdates) {
      const absFilePath = path as AbsFilePath;
      const update = contextUpdates[absFilePath];

      if (update.update.status === "ok") {
        switch (update.update.value.type) {
          case "whole-file": {
            let lineCount = 0;
            for (const c of update.update.value.content) {
              if (c.type === "text") {
                textParts.push(c.text);
                lineCount = (c.text.match(/\n/g) || []).length + 1;
              }
            }
            filePathEntries.push(`${update.relFilePath} (${lineCount} lines)`);
            break;
          }
          case "diff": {
            const patch = update.update.value.patch;
            const additions = (patch.match(/^\+[^+]/gm) || []).length;
            const deletions = (patch.match(/^-[^-]/gm) || []).length;
            filePathEntries.push(
              `${update.relFilePath} (+${additions}/-${deletions})`,
            );
            textParts.push(`\
- \`${absFilePath}\`
\`\`\`diff
${update.update.value.patch}
\`\`\``);
            break;
          }
          case "file-deleted": {
            filePathEntries.push(`${update.relFilePath} (deleted)`);
            textParts.push(`\
- \`${absFilePath}\`
This file has been deleted and removed from context.`);
            break;
          }
          default:
            assertUnreachable(update.update.value);
        }
      } else {
        filePathEntries.push(`${update.relFilePath} (error)`);
        textParts.push(`\
- \`${absFilePath}\`
Error fetching update: ${update.update.error}`);
      }
    }

    if (textParts.length === 0) {
      return [];
    }

    const header = `\
These files are part of your context. This is the latest information about the content of each file.
From now on, whenever any of these files are updated by the user, you will get a message letting you know.`;
    const fileList = `<file_paths>\n${filePathEntries.join("\n")}\n</file_paths>`;

    return [
      {
        type: "text",
        text: `<context_update>\n${fileList}\n${header}\n${textParts.join("\n")}\n</context_update>`,
      },
    ];
  }

  private async getFileMessageAndUpdateAgentViewOfFile({
    absFilePath,
  }: {
    absFilePath: AbsFilePath;
  }): Promise<FileUpdates[keyof FileUpdates] | undefined> {
    const relFilePath = relativePath(this.cwd, absFilePath, this.homeDir);
    const fileInfo = this.files[absFilePath];

    if (!fileInfo) {
      return undefined;
    }

    if (!(await this.fileIO.fileExists(absFilePath))) {
      delete this.files[absFilePath];
      return {
        absFilePath,
        relFilePath,
        update: {
          status: "ok",
          value: { type: "file-deleted" },
        },
      };
    }

    if (fileInfo.fileTypeInfo.category === FileCategory.TEXT) {
      return await this.handleTextFileUpdate(
        absFilePath,
        relFilePath,
        fileInfo,
      );
    } else {
      return this.handleBinaryFileUpdate(absFilePath, relFilePath, fileInfo);
    }
  }

  private async handleTextFileUpdate(
    absFilePath: AbsFilePath,
    relFilePath: RelFilePath,
    fileInfo: Files[AbsFilePath],
  ): Promise<FileUpdates[keyof FileUpdates] | undefined> {
    let currentFileContent: string;
    try {
      currentFileContent = await this.fileIO.readFile(absFilePath);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        delete this.files[absFilePath];
        return {
          absFilePath,
          relFilePath,
          update: {
            status: "ok",
            value: { type: "file-deleted" },
          },
        };
      }
      return {
        absFilePath,
        relFilePath,
        update: {
          status: "error",
          error: `Error reading file ${absFilePath}: ${(err as Error).message}\n${(err as Error).stack}`,
        },
      };
    }

    const prevContent =
      fileInfo.agentView?.type === "text"
        ? fileInfo.agentView.content
        : undefined;

    fileInfo.agentView = {
      type: "text",
      content: currentFileContent,
    };

    if (!prevContent) {
      return {
        absFilePath,
        relFilePath,
        update: {
          status: "ok",
          value: {
            type: "whole-file",
            content: [
              { type: "text", text: `File \`${relFilePath}\`` },
              { type: "text", text: currentFileContent },
            ],
          },
        },
      };
    }

    if (prevContent === currentFileContent) {
      return undefined;
    }

    const patch = diff.createPatch(
      relFilePath,
      prevContent,
      currentFileContent,
      "previous",
      "current",
      { context: 2 },
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

  private async handleBinaryFileUpdate(
    absFilePath: AbsFilePath,
    relFilePath: RelFilePath,
    fileInfo: Files[AbsFilePath],
  ): Promise<FileUpdates[keyof FileUpdates] | undefined> {
    try {
      if (fileInfo.agentView != undefined) {
        switch (fileInfo.agentView.type) {
          case "text":
            throw new Error(
              `Unexpected text agentView type in handleBinaryFileUpdate`,
            );
          case "binary":
            return;
          case "pdf": {
            if (!fileInfo.agentView.summary) {
              try {
                const summaryResult =
                  await getSummaryAsProviderContent(absFilePath);
                if (summaryResult.status === "ok") {
                  fileInfo.agentView.summary = true;
                  return {
                    absFilePath,
                    relFilePath,
                    update: {
                      status: "ok",
                      value: {
                        type: "whole-file",
                        content: summaryResult.value,
                        pdfSummary: true,
                      },
                    },
                  };
                } else {
                  return {
                    absFilePath,
                    relFilePath,
                    update: {
                      status: "error",
                      error: `Error generating PDF summary for ${absFilePath}: ${summaryResult.error}`,
                    },
                  };
                }
              } catch (err) {
                return {
                  absFilePath,
                  relFilePath,
                  update: {
                    status: "error",
                    error: `Error generating PDF summary for ${absFilePath}: ${(err as Error).message}`,
                  },
                };
              }
            }
            break;
          }
        }
      } else {
        if (fileInfo.fileTypeInfo.category == FileCategory.PDF) {
          try {
            const summaryResult =
              await getSummaryAsProviderContent(absFilePath);
            if (summaryResult.status === "ok") {
              fileInfo.agentView = {
                type: "pdf",
                summary: true,
                pages: [],
                supportsPageExtraction: true,
              };
              return {
                absFilePath,
                relFilePath,
                update: {
                  status: "ok",
                  value: {
                    type: "whole-file",
                    content: summaryResult.value,
                    pdfSummary: true,
                  },
                },
              };
            } else {
              return {
                absFilePath,
                relFilePath,
                update: {
                  status: "error",
                  error: `Error generating PDF summary for ${absFilePath}: ${summaryResult.error}`,
                },
              };
            }
          } catch (err) {
            return {
              absFilePath,
              relFilePath,
              update: {
                status: "error",
                error: `Error generating PDF summary for ${absFilePath}: ${(err as Error).message}`,
              },
            };
          }
        } else if (fileInfo.fileTypeInfo.category == FileCategory.IMAGE) {
          try {
            const buffer = await this.fileIO.readBinaryFile(absFilePath);
            fileInfo.agentView = { type: "binary" };
            return {
              absFilePath,
              relFilePath,
              update: {
                status: "ok",
                value: {
                  type: "whole-file",
                  content: [
                    {
                      type: "image",
                      source: {
                        type: "base64",
                        media_type: fileInfo.fileTypeInfo.mimeType as
                          | "image/jpeg"
                          | "image/png"
                          | "image/gif"
                          | "image/webp",
                        data: buffer.toString("base64"),
                      },
                    },
                  ],
                },
              },
            };
          } catch (err) {
            return {
              absFilePath,
              relFilePath,
              update: {
                status: "error",
                error: `Error reading image file ${absFilePath}: ${(err as Error).message}`,
              },
            };
          }
        }
      }
    } catch (err) {
      return {
        absFilePath,
        relFilePath,
        update: {
          status: "error",
          error: `Error checking file stats for ${absFilePath}: ${(err as Error).message}`,
        },
      };
    }
  }

  private updateAgentsViewOfFiles(
    absFilePath: AbsFilePath,
    tool: ToolApplied,
  ): void {
    const fileInfo = this.files[absFilePath];
    if (!fileInfo) {
      throw new Error(`File ${absFilePath} not found in context`);
    }

    switch (tool.type) {
      case "get-file":
        if (fileInfo.fileTypeInfo.category === FileCategory.PDF) {
          throw new Error(
            `PDF file ${absFilePath} should use get-file-pdf action`,
          );
        } else {
          fileInfo.agentView = { type: "text", content: tool.content };
        }
        return;

      case "get-file-binary":
        fileInfo.agentView = { type: "binary" };
        return;

      case "get-file-pdf": {
        if (fileInfo.agentView?.type === "pdf") {
          if (tool.content.type == "summary") {
            fileInfo.agentView.summary = true;
          } else {
            if (!fileInfo.agentView.pages.includes(tool.content.pdfPage)) {
              fileInfo.agentView.pages.push(tool.content.pdfPage);
              fileInfo.agentView.pages.sort((a, b) => a - b);
            }
          }
        } else {
          fileInfo.agentView = {
            type: "pdf",
            summary: tool.content.type == "summary",
            pages: tool.content.type == "page" ? [tool.content.pdfPage] : [],
            supportsPageExtraction: true,
          };
        }
        return;
      }

      case "edl-edit":
        fileInfo.agentView = { type: "text", content: tool.content };
        return;

      default:
        assertUnreachable(tool);
    }
  }
}
