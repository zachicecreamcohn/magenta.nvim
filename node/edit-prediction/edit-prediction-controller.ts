import type { Dispatch } from "../tea/tea.ts";
import type { RootMsg } from "../root-msg.ts";
import type { Nvim } from "../nvim/nvim-node";
import type { ChangeTracker } from "../change-tracker.ts";
import { assertUnreachable } from "../utils/assertUnreachable.ts";
import { getCurrentBuffer, getpos } from "../nvim/nvim.ts";
import type { NvimCwd, UnresolvedFilePath } from "../utils/files.ts";
import * as diff from "diff";
import { getProvider } from "../providers/provider.ts";
import type { Profile } from "../options.ts";
import { spec } from "../tools/predict-edit.ts";
import { relativePath } from "../utils/files.ts";

export type EditPredictionMsg = {
  type: "trigger-prediction";
};

export type EditPredictionId = number & { __editPredictionId: true };

export class EditPredictionController {
  constructor(
    public id: EditPredictionId,
    private context: {
      dispatch: Dispatch<RootMsg>;
      nvim: Nvim;
      changeTracker: ChangeTracker;
      cwd: NvimCwd;
      getActiveProfile: () => Profile;
    },
  ) {}

  update(msg: RootMsg): void {
    if (msg.type === "edit-prediction-msg" && msg.id === this.id) {
      this.myUpdate(msg.msg);
    }
  }

  private myUpdate(msg: EditPredictionMsg): void {
    switch (msg.type) {
      case "trigger-prediction":
        this.triggerPrediction().catch((error) => {
          this.context.nvim.logger.error(
            "Failed to trigger edit prediction:",
            error,
          );
        });
        return;
      default:
        assertUnreachable(msg.type);
    }
  }

  private async captureContextWindow(): Promise<{
    contextLines: string[];
    cursorLine: number;
    cursorCol: number;
    bufferName: string;
    startLine: number;
    endLine: number;
    totalLines: number;
  }> {
    const buffer = await getCurrentBuffer(this.context.nvim);
    const pos = await getpos(this.context.nvim, ".");
    const totalLines = await this.context.nvim.call("nvim_buf_line_count", [
      buffer.id,
    ]);
    const bufferName = await this.context.nvim.call("nvim_buf_get_name", [
      buffer.id,
    ]);

    // Capture ~20 lines around cursor (10 before, 10 after)
    const contextSize = 10;
    const startLine = Math.max(0, pos.row - contextSize);
    const endLine = Math.min(totalLines - 1, pos.row + contextSize);

    const contextLines = await buffer.getLines({
      start: startLine,
      end: endLine + 1,
    });

    return {
      contextLines: contextLines as string[],
      cursorLine: pos.row - startLine, // Relative position within context
      cursorCol: pos.col,
      bufferName: bufferName,
      startLine,
      endLine,
      totalLines: totalLines,
    };
  }

  async composeUserMessage(): Promise<string> {
    // Capture context window
    const {
      contextLines,
      cursorLine,
      cursorCol,
      bufferName,
      startLine,
      endLine,
    } = await this.captureContextWindow();

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

    return `Recent changes:
${recentChangesDiffs}

Current context ( │ marks cursor position):
${bufferRelPath}:${startLine + 1}:${endLine + 1}
${contextWithCursor.join("\n")}

Predict the most likely next edit the user will make.`;
  }

  private async triggerPrediction(): Promise<void> {
    const profile = this.context.getActiveProfile();
    const provider = getProvider(this.context.nvim, profile);

    const userMessage = await this.composeUserMessage();

    const systemPrompt = `You have to do your best to predict the user's next edit based on their recent changes and current cursor position. Respond with find/replace parameters that are scoped only to the context window provided.`;
    // Force tool use for prediction
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

    // For now, just log that we made the request
    request.promise
      .then((response) => {
        this.context.nvim.logger.info(
          `Edit prediction completed with usage: ${JSON.stringify(response.usage)}`,
        );
      })
      .catch((error) => {
        this.context.nvim.logger.error("Edit prediction failed:", error);
      });
  }
}
