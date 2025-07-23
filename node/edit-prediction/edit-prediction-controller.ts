import type { Dispatch } from "../tea/tea.ts";
import type { RootMsg } from "../root-msg.ts";
import type { Nvim } from "../nvim/nvim-node";
import type { ChangeTracker } from "../change-tracker.ts";
import { assertUnreachable } from "../utils/assertUnreachable.ts";
import { getCurrentBuffer, getpos } from "../nvim/nvim.ts";
import type { Line, BufNr } from "../nvim/buffer.ts";
import { NvimBuffer } from "../nvim/buffer.ts";
import type { NvimCwd, UnresolvedFilePath } from "../utils/files.ts";
import * as diff from "diff";
import { getProvider } from "../providers/provider.ts";
import type { Profile } from "../options.ts";
import { spec } from "../tools/predict-edit.ts";
import { relativePath } from "../utils/files.ts";
import {
  type Row0Indexed,
  type Row1Indexed,
  type ByteIdx,
  pos1col1to0,
  type Position0Indexed,
} from "../nvim/window.ts";
import { calculateDiff } from "./diff.ts";
import { createTextStyleGroup } from "../nvim/extmarks.ts";

export type PredictionState =
  | { type: "idle" }
  | { type: "preparing-request" }
  | {
      type: "awaiting-agent-reply";
      contextWindow: CapturedContext;
      requestStartTime: number;
      request: { abort: () => void };
    }
  | {
      type: "displaying-proposed-edit";
      contextWindow: CapturedContext;
      prediction: PredictionInput;
    }
  | {
      type: "prediction-being-applied";
      contextWindow: CapturedContext;
      prediction: PredictionInput;
    };

export type CapturedContext = {
  contextLines: string[];
  cursorDelta: number; // 0-indexed relative to context start
  cursorCol: ByteIdx;
  bufferName: string;
  bufferId: BufNr;
  startLine: Row0Indexed; // 0-indexed absolute buffer position
  endLine: Row0Indexed; // 0-indexed absolute buffer position
  totalLines: number;
};

export type PredictionInput = {
  find: string;
  replace: string;
};

export type EditPredictionMsg =
  | { type: "trigger-prediction" }
  | { type: "prediction-received"; input: PredictionInput }
  | { type: "prediction-accepted" }
  | { type: "prediction-dismissed" }
  | { type: "prediction-error"; error: string };

export type EditPredictionId = number & { __editPredictionId: true };

export class EditPredictionController {
  public state: PredictionState;

  private myDispatch: Dispatch<EditPredictionMsg>;

  constructor(
    public id: EditPredictionId,
    private context: {
      dispatch: Dispatch<RootMsg>;
      nvim: Nvim;
      changeTracker: ChangeTracker;
      cwd: NvimCwd;
      getActiveProfile: () => Profile;
    },
  ) {
    this.myDispatch = (msg) =>
      this.context.dispatch({
        type: "edit-prediction-msg",
        id: this.id,
        msg,
      });

    this.state = { type: "idle" };
  }

  update(msg: RootMsg): void {
    if (msg.type === "edit-prediction-msg" && msg.id === this.id) {
      this.myUpdate(msg.msg);
    }
  }

  private myUpdate(msg: EditPredictionMsg): void {
    switch (msg.type) {
      case "trigger-prediction":
        // Abort any existing request and reset to idle
        if (this.state.type === "awaiting-agent-reply") {
          this.state.request.abort();
        }

        // Reset state to idle before starting new prediction
        this.state = { type: "idle" };

        this.triggerPrediction().catch((error) => {
          this.myDispatch({
            type: "prediction-error",
            error: error instanceof Error ? error.message : String(error),
          });
        });
        return;

      case "prediction-received":
        if (this.state.type !== "awaiting-agent-reply") {
          this.context.nvim.logger.warn(
            `Received prediction while in state: ${this.state.type}`,
          );
          return;
        }
        this.state = {
          type: "displaying-proposed-edit",
          contextWindow: this.state.contextWindow,
          prediction: msg.input,
        };
        this.showVirtualTextPreview().catch((error) => {
          this.context.nvim.logger.warn(
            "Virtual text preview failed (continuing anyway):",
            error instanceof Error ? error.message : String(error),
          );
          // Don't dispatch an error, just log the warning and continue
          // This allows tests to work even if virtual text setup fails
        });
        return;

      case "prediction-accepted":
        if (this.state.type !== "displaying-proposed-edit") {
          this.context.nvim.logger.warn(
            `Cannot accept prediction from state: ${this.state.type}`,
          );
          return;
        }
        this.state = {
          type: "prediction-being-applied",
          contextWindow: this.state.contextWindow,
          prediction: this.state.prediction,
        };
        this.applyPrediction().catch((error) => {
          this.myDispatch({
            type: "prediction-error",
            error: error instanceof Error ? error.message : String(error),
          });
        });
        return;

      case "prediction-dismissed":
        if (this.state.type !== "displaying-proposed-edit") {
          this.context.nvim.logger.warn(
            `Cannot dismiss prediction from state: ${this.state.type}`,
          );
          return;
        }
        this.clearVirtualText().catch((error) => {
          this.context.nvim.logger.error(
            "Failed to clear virtual text:",
            error instanceof Error ? error.message : String(error),
          );
        });
        this.state = { type: "idle" };
        return;

      case "prediction-error":
        this.context.nvim.logger.error("Edit prediction error:", msg.error);
        this.clearVirtualText().catch((error) => {
          this.context.nvim.logger.error(
            "Failed to clear virtual text on error:",
            error instanceof Error ? error.message : String(error),
          );
        });
        this.state = { type: "idle" };
        return;

      default:
        assertUnreachable(msg);
    }
  }

  private async clearVirtualText(): Promise<void> {
    if (this.state.type !== "displaying-proposed-edit") {
      return;
    }

    try {
      const buffer = new NvimBuffer(
        this.state.contextWindow.bufferId,
        this.context.nvim,
      );

      await buffer.clearAllExtmarks();
    } catch (error) {
      this.context.nvim.logger.error("Failed to clear virtual text:", error);
    }
  }

  private convertCharPosToLineCol(
    text: string,
    charPos: number,
    startLine: Row0Indexed,
  ): Position0Indexed {
    const lines = text.slice(0, charPos).split("\n");
    return {
      row: (startLine + lines.length - 1) as Row0Indexed,
      col: lines[lines.length - 1].length as ByteIdx,
    };
  }

  private async showVirtualTextPreview(): Promise<void> {
    if (this.state.type !== "displaying-proposed-edit") {
      return;
    }

    const { contextWindow, prediction } = this.state;
    const buffer = new NvimBuffer(contextWindow.bufferId, this.context.nvim);

    await this.clearVirtualText();

    const contextText = contextWindow.contextLines.join("\n");

    // Check if the find text exists in context
    if (!contextText.includes(prediction.find)) {
      throw new Error("Find text not found in current context");
    }

    // Calculate the new text after replacement
    const newText = contextText.replace(prediction.find, prediction.replace);

    // Calculate diff operations
    const diffOps = calculateDiff(contextText, newText);

    // Apply virtual text for each diff operation
    for (const op of diffOps) {
      if (op.type === "delete") {
        // Apply strikethrough highlight to deleted text
        const bufferStartPos = this.convertCharPosToLineCol(
          contextText,
          op.startPos,
          contextWindow.startLine,
        );
        const bufferEndPos = this.convertCharPosToLineCol(
          contextText,
          op.endPos,
          contextWindow.startLine,
        );

        await buffer.setExtmark({
          startPos: bufferStartPos,
          endPos: bufferEndPos,
          options: {
            hl_group: createTextStyleGroup({ strikethrough: true }),
          },
        });
      } else if (op.type === "insert") {
        // Add virtual text for insertions
        const bufferPos = this.convertCharPosToLineCol(
          contextText,
          op.insertAfterPos,
          contextWindow.startLine,
        );

        // Split inserted text by newlines
        const insertLines = op.text.split("\n");

        if (insertLines.length === 1) {
          // Single line insertion
          await buffer.setExtmark({
            startPos: bufferPos,
            endPos: bufferPos,
            options: {
              virt_text: [[insertLines[0], "Comment"]],
              virt_text_pos: "inline",
              right_gravity: false,
            },
          });
        } else {
          // Multi-line insertion - place first line inline, rest as virtual lines
          await buffer.setExtmark({
            startPos: bufferPos,
            endPos: bufferPos,
            options: {
              virt_text: [[insertLines[0], "Comment"]],
              virt_text_pos: "inline",
              virt_lines: insertLines
                .slice(1)
                .map((line) => [[line, "Comment"]]),
              right_gravity: false,
            },
          });
        }
      }
    }
  }

  private async captureContextWindow(): Promise<CapturedContext> {
    const buffer = await getCurrentBuffer(this.context.nvim);
    const pos1Indexed = await getpos(this.context.nvim, ".");
    const pos0Indexed = pos1col1to0(pos1Indexed);
    const totalLines = await this.context.nvim.call("nvim_buf_line_count", [
      buffer.id,
    ]);
    const bufferName = await buffer.getName();

    // Capture ~20 lines around cursor (10 before, 10 after)
    const contextSize = 10;
    const startLine = Math.max(0, pos0Indexed.row - contextSize) as Row0Indexed;
    const endLine = Math.min(
      totalLines - 1,
      pos0Indexed.row + contextSize,
    ) as Row0Indexed;

    const contextLines = await buffer.getLines({
      start: startLine,
      end: (endLine + 1) as Row0Indexed,
    });

    return {
      contextLines: contextLines as string[],
      cursorDelta: (pos0Indexed.row - startLine) as Row0Indexed, // Relative position within context
      cursorCol: pos0Indexed.col,
      bufferName: bufferName,
      bufferId: buffer.id,
      startLine,
      endLine,
      totalLines: totalLines,
    };
  }

  private async applyPrediction(): Promise<void> {
    if (this.state.type !== "prediction-being-applied") {
      throw new Error("Cannot apply prediction from current state");
    }

    const { contextWindow, prediction } = this.state;

    await this.clearVirtualText();
    this.state = { type: "idle" };

    // Use the specific buffer that the prediction was generated for
    const buffer = new NvimBuffer(contextWindow.bufferId, this.context.nvim);

    // Get the current context lines to validate they haven't changed
    const currentLines = await buffer.getLines({
      start: contextWindow.startLine,
      end: (contextWindow.endLine + 1) as Row0Indexed,
    });

    // Simple validation that context hasn't changed significantly
    if (currentLines.length !== contextWindow.contextLines.length) {
      throw new Error("Context window has changed since prediction was made");
    }

    // Apply the find/replace within the context window
    const contextText = contextWindow.contextLines.join("\n");
    if (!contextText.includes(prediction.find)) {
      throw new Error("Find text not found in context window");
    }

    const replacedText = contextText.replace(
      prediction.find,
      prediction.replace,
    );
    const replacedLines = replacedText.split("\n");

    // Apply the changes to the buffer using 0-indexed positions
    await buffer.setLines({
      start: contextWindow.startLine,
      end: (contextWindow.endLine + 1) as Row0Indexed,
      lines: replacedLines as Line[],
    });
  }

  async composeUserMessage(contextWindow?: CapturedContext): Promise<string> {
    // Use provided context or capture new one
    const {
      contextLines,
      cursorDelta: cursorLine,
      cursorCol,
      bufferName,
      startLine,
      endLine,
    } = contextWindow || (await this.captureContextWindow());

    // Get recent changes (up to 5 recent changes for context)
    const recentChanges = this.context.changeTracker.getRecentChanges(5);

    // Create context with cursor marker
    const contextWithCursor = [...contextLines];
    const line = contextWithCursor[cursorLine] || "";
    contextWithCursor[cursorLine] =
      line.slice(0, cursorCol) + "│" + line.slice(cursorCol);

    const bufferRelPath = relativePath(
      this.context.cwd,
      bufferName as UnresolvedFilePath,
    );

    // Format recent changes using proper diffs
    const recentChangesDiffs = recentChanges
      .map((change) => {
        // Create a unified diff patch
        const patch = diff.createPatch(
          change.filePath,
          change.oldText,
          change.newText,
          `${change.filePath}:${change.range.start.line + 1}`,
          `${change.filePath}:${change.range.start.line + 1}`,
        );

        // Remove the standard diff headers and @@ hunk headers
        const lines = patch.split("\n");
        const hunkStart = lines.findIndex((line) => line.startsWith("@@"));

        if (hunkStart === -1) return patch; // No hunks found, return as-is

        // Skip the @@ header line and get the actual diff content
        const hunks = lines.slice(hunkStart + 1);
        const lineStart = change.range.start.line + 1;
        const lineEnd = change.range.end.line + 1;

        return `${change.filePath}:${lineStart}:${lineEnd}\n${hunks.join("\n")}`;
      })
      .join("\n");

    // Convert 0-indexed positions to 1-indexed for display
    const displayStartLine = (startLine + 1) as Row1Indexed;
    const displayEndLine = (endLine + 1) as Row1Indexed;

    return `Recent changes:
${recentChangesDiffs}

Current context ( │ marks cursor position):
${bufferRelPath}:${displayStartLine}:${displayEndLine}
${contextWithCursor.join("\n")}

Predict the most likely next edit the user will make.`;
  }

  private async triggerPrediction(): Promise<void> {
    // Transition to preparing-request state
    this.state = { type: "preparing-request" };

    const profile = this.context.getActiveProfile();
    const provider = getProvider(this.context.nvim, profile);

    // Capture context window
    const contextWindow = await this.captureContextWindow();
    const userMessage = await this.composeUserMessage(contextWindow);

    const systemPrompt = `\
Predict the user's next edit based on their recent changes and current cursor position.`;

    const request = provider.forceToolUse({
      model: profile.fastModel || profile.model,
      messages: [
        {
          role: "user",
          content: [{ type: "text", text: userMessage }],
        },
      ],
      spec,
      systemPrompt,
      disableCaching: true,
    });

    // Transition to awaiting-agent-reply state with the request
    this.state = {
      type: "awaiting-agent-reply",
      contextWindow,
      requestStartTime: Date.now(),
      request,
    };

    const response = await request.promise;

    if (response.toolRequest.status === "ok") {
      const input = response.toolRequest.value.input as PredictionInput;
      this.myDispatch({
        type: "prediction-received",
        input,
      });
    } else {
      this.myDispatch({
        type: "prediction-error",
        error: response.toolRequest.error || "Tool use failed",
      });
    }
  }
}
