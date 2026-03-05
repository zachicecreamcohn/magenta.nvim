import {
  type ToolRequestId,
  getToolSpecs,
  createTool,
  type CreateToolContext,
  type EdlRegisters,
  InMemoryFileIO,
  type ContextTracker,
} from "@magenta/core";
import {
  getProvider,
  type Agent,
  type AgentMsg,
  type ProviderMessage,
  type ProviderToolResult,
} from "../providers/provider.ts";
import type { Nvim } from "../nvim/nvim-node/index.ts";
import type { MCPToolManagerImpl } from "@magenta/core";
import type { Profile } from "../options.ts";
import type { ThreadId } from "./types.ts";
import type { Shell } from "../capabilities/shell.ts";
import type { Environment } from "../environment.ts";
import type { ContextManager } from "../context/context-manager.ts";
import type { Chat } from "./chat.ts";
import type { MagentaOptions } from "../options.ts";
import type { Dispatch } from "../tea/tea.ts";
import type { RootMsg } from "../root-msg.ts";
import type { ActiveToolEntry } from "./thread.ts";
import type { CompactionStep, CompactionResult } from "@magenta/core";
import {
  renderThreadToMarkdown,
  chunkMessages,
  CHARS_PER_TOKEN,
  TARGET_CHUNK_TOKENS,
  TOLERANCE_TOKENS,
} from "./compact-renderer.ts";
import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const COMPACT_PROMPT_TEMPLATE = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "compact-system-prompt.md"),
  "utf-8",
);

export type { CompactionResult, CompactionStep } from "@magenta/core";

export class CompactionManager {
  private agent: Agent;
  private fileIO: InMemoryFileIO;
  private edlRegisters: EdlRegisters;
  private activeTools: Map<ToolRequestId, ActiveToolEntry>;
  public chunks: string[];
  public currentChunkIndex: number;
  public steps: CompactionStep[];
  public nextPrompt: string | undefined;
  private toolResults: Map<ToolRequestId, ProviderToolResult>;
  public result: CompactionResult | undefined;

  constructor(
    private context: {
      profile: Profile;
      mcpToolManager: MCPToolManagerImpl;
      environment: Environment;
      contextManager: ContextManager;
      threadId: ThreadId;
      dispatch: Dispatch<RootMsg>;
      nvim: Nvim;
      options: MagentaOptions;
      shell: Shell;
      chat: Chat;
      onComplete: (result: CompactionResult) => void;
    },
  ) {
    this.fileIO = new InMemoryFileIO({ "/summary.md": "" });
    this.edlRegisters = { registers: new Map(), nextSavedId: 0 };
    this.activeTools = new Map();
    this.chunks = [];
    this.currentChunkIndex = 0;
    this.steps = [];
    this.toolResults = new Map();
    this.agent = this.createCompactAgent();
  }

  start(messages: ReadonlyArray<ProviderMessage>, nextPrompt?: string): void {
    const { markdown, messageBoundaries } = renderThreadToMarkdown(messages);

    const targetChunkChars = TARGET_CHUNK_TOKENS * CHARS_PER_TOKEN;
    const toleranceChars = TOLERANCE_TOKENS * CHARS_PER_TOKEN;
    this.chunks = chunkMessages(
      markdown,
      messageBoundaries,
      targetChunkChars,
      toleranceChars,
    );

    if (this.chunks.length === 0) {
      this.context.nvim.logger.warn("No chunks to compact");
      return;
    }

    this.nextPrompt = nextPrompt;
    this.currentChunkIndex = 0;
    this.steps = [];

    this.sendChunkToAgent(this.agent, this.chunks, 0, nextPrompt);
  }

  private createCompactAgent(): Agent {
    const provider = getProvider(this.context.nvim, this.context.profile);
    return provider.createAgent(
      {
        model: this.context.profile.fastModel,
        systemPrompt:
          "You are a conversation compactor. Summarize conversation transcripts into concise summaries that preserve essential information for continuing the work.",
        tools: getToolSpecs(
          "compact",
          this.context.mcpToolManager,
          this.context.environment.availableCapabilities,
        ),
        skipPostFlightTokenCount: true,
      },
      (msg) =>
        this.context.dispatch({
          type: "thread-msg",
          id: this.context.threadId,
          msg: { type: "compact-agent-msg", msg },
        }),
    );
  }

  private sendChunkToAgent(
    agent: Agent,
    chunks: string[],
    chunkIndex: number,
    nextPrompt?: string,
  ): void {
    this.fileIO.writeFileSync("/chunk.md", chunks[chunkIndex]);

    const isLastChunk = chunkIndex === chunks.length - 1;
    const chunkLabel = `chunk ${chunkIndex + 1} of ${chunks.length}`;

    const statusParts = [`This is ${chunkLabel}.`];
    if (chunkIndex === 0) {
      statusParts.push(
        "The file /summary.md is currently empty. Write the initial summary.",
      );
    } else {
      statusParts.push(
        "Fold the essential information from the new chunk into the existing /summary.md. Do NOT rewrite the summary from scratch.",
      );
    }
    if (isLastChunk) {
      statusParts.push(
        "This is the LAST chunk. Make sure the summary is complete and well-organized.",
      );
    }

    const nextPromptText = nextPrompt ?? "Continue from where you left off.";

    const summaryContent =
      chunkIndex > 0 ? (this.fileIO.getFileContents("/summary.md") ?? "") : "";

    const prompt = COMPACT_PROMPT_TEMPLATE.replace(
      "{{status}}",
      statusParts.join(" "),
    )
      .replace("{{next_prompt}}", nextPromptText)
      .replace("{{summary}}", summaryContent)
      .replace("{{chunk}}", chunks[chunkIndex]);

    agent.appendUserMessage([{ type: "text", text: prompt }]);
    agent.continueConversation();
  }

  handleAgentMsg(msg: AgentMsg): void {
    switch (msg.type) {
      case "agent-content-updated":
        return;

      case "agent-error":
        this.context.nvim.logger.error(
          `Compact agent error: ${msg.error.message}`,
        );
        this.complete({ type: "error", steps: this.steps });
        return;

      case "agent-stopped": {
        if (msg.stopReason === "tool_use") {
          this.handleToolUse();
        } else if (msg.stopReason === "end_turn") {
          this.handleChunkComplete();
        } else {
          this.context.nvim.logger.warn(
            `Compact agent stopped with unexpected reason: ${msg.stopReason}`,
          );
          this.complete({ type: "error", steps: this.steps });
        }
        return;
      }
    }
  }

  private complete(result: CompactionResult): void {
    this.result = result;
    this.context.onComplete(result);
  }

  private handleToolUse(): void {
    const messages = this.agent.getState().messages;
    const lastMessage = messages[messages.length - 1];

    if (!lastMessage || lastMessage.role !== "assistant") {
      this.context.nvim.logger.error(
        "Compact agent tool_use but no assistant message",
      );
      this.complete({ type: "error", steps: this.steps });
      return;
    }

    const activeTools = new Map<ToolRequestId, ActiveToolEntry>();

    for (const block of lastMessage.content) {
      if (block.type !== "tool_use") {
        continue;
      }

      if (block.request.status !== "ok") {
        this.agent.toolResult(block.id, {
          type: "tool_result",
          id: block.id,
          result: {
            status: "error",
            error: `Malformed tool_use block: ${block.request.error}`,
          },
        });
        continue;
      }

      const request = block.request.value;
      const toolContext: CreateToolContext = {
        mcpToolManager: this.context.mcpToolManager,
        threadId: this.context.threadId,
        logger: this.context.nvim.logger,
        lspClient: this.context.environment.lspClient,
        cwd: this.context.environment.cwd,
        homeDir: this.context.environment.homeDir,
        maxConcurrentSubagents:
          this.context.options.maxConcurrentSubagents || 3,
        contextTracker: this.context.contextManager as ContextTracker,
        onToolApplied: (absFilePath, tool, fileTypeInfo) => {
          this.context.contextManager.update({
            type: "tool-applied",
            absFilePath,
            tool,
            fileTypeInfo,
          });
        },
        diagnosticsProvider: this.context.environment.diagnosticsProvider,
        edlRegisters: this.edlRegisters,
        fileIO: this.fileIO,
        shell: this.context.shell,
        threadManager: this.context.chat,
        requestRender: () =>
          this.context.dispatch({
            type: "thread-msg",
            id: this.context.threadId,
            msg: { type: "tool-progress" },
          }),
      };

      const invocation = createTool(request, toolContext);
      activeTools.set(request.id, {
        handle: invocation,
        progress: "progress" in invocation ? invocation.progress : undefined,
        toolName: request.toolName,
        request,
      });

      void invocation.promise
        .then((result) => {
          this.toolResults.set(request.id, result);
        })
        .catch((err: Error) => {
          this.toolResults.set(request.id, {
            type: "tool_result",
            id: request.id,
            result: {
              status: "error",
              error: `Tool execution failed: ${err.message}`,
            },
          });
        })
        .then(() => {
          this.handleToolCompletion();
        });
    }

    this.activeTools = activeTools;
  }

  private handleToolCompletion(): void {
    for (const [, entry] of this.activeTools) {
      if (!this.toolResults.has(entry.request.id)) return;
    }

    for (const [toolId, entry] of this.activeTools) {
      const result = this.toolResults.get(entry.request.id);
      if (result) {
        this.agent.toolResult(toolId, result);
      }
    }
    this.activeTools = new Map();
    this.agent.continueConversation();
  }

  private handleChunkComplete(): void {
    const nextChunkIndex = this.currentChunkIndex + 1;

    this.steps.push({
      chunkIndex: this.currentChunkIndex,
      totalChunks: this.chunks.length,
      messages: [...this.agent.getState().messages],
    });

    if (nextChunkIndex < this.chunks.length) {
      const newAgent = this.createCompactAgent();
      this.agent = newAgent;
      this.currentChunkIndex = nextChunkIndex;
      this.activeTools = new Map();
      this.sendChunkToAgent(
        newAgent,
        this.chunks,
        nextChunkIndex,
        this.nextPrompt,
      );
    } else {
      const summary = this.fileIO.getFileContents("/summary.md");
      if (summary === undefined || summary === "") {
        this.context.nvim.logger.error(
          "Compact agent finished but /summary.md is empty",
        );
        this.complete({ type: "error", steps: this.steps });
        return;
      }

      this.complete({
        type: "complete",
        summary,
        steps: this.steps,
        nextPrompt: this.nextPrompt,
      });
    }
  }
}
