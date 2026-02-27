import {
  ContextManager,
  type Msg as ContextManagerMsg,
  type FileUpdates,
} from "../context/context-manager.ts";
import { openFileInNonMagentaWindow } from "../nvim/openFileInNonMagentaWindow.ts";

import { type Dispatch } from "../tea/tea.ts";

import {
  type ToolRequestId,
  getToolSpecs,
  createTool,
  type CreateToolContext,
  type ToolInvocation,
  type ToolName,
  type ToolRequest,
  MCPToolManagerImpl,
  ThreadTitle,
  type EdlRegisters,
  type FileIO,
  type ContextTracker,
  provisionContainer,
  type ContainerConfig,
} from "@magenta/core";

import type { Nvim } from "../nvim/nvim-node/index.ts";

import {
  getProvider as getProvider,
  type ProviderMessage,
  type ProviderMessageContent,
  type Agent,
  type AgentInput,
  type AgentStatus,
  type AgentMsg,
  type ProviderToolResult,
  type StopReason,
} from "../providers/provider.ts";
import { assertUnreachable } from "../utils/assertUnreachable.ts";
import { type MagentaOptions, type Profile } from "../options.ts";
import type { RootMsg } from "../root-msg.ts";
import {
  type HomeDir,
  type NvimCwd,
  type UnresolvedFilePath,
} from "../utils/files.ts";

import type { Chat } from "./chat.ts";
import type { ThreadId, ThreadType } from "./types.ts";
import type { SystemPrompt } from "../providers/system-prompt.ts";

import { join, dirname } from "path";
import { fileURLToPath } from "url";
import player from "play-sound";
import { CommandRegistry } from "./commands/registry.ts";
import { getSubsequentReminder } from "../providers/system-reminders.ts";

import type { PermissionCheckingFileIO } from "../capabilities/permission-file-io.ts";
import type { PermissionCheckingShell } from "../capabilities/permission-shell.ts";
import type { Shell } from "../capabilities/shell.ts";
import type { Environment } from "../environment.ts";

import { getContextWindowForModel } from "../providers/anthropic-agent.ts";
import {
  CompactionManager,
  type CompactionResult,
} from "./compaction-manager.ts";
import type { ThreadSupervisor } from "./thread-supervisor.ts";

export type InputMessage =
  | {
      type: "user";
      text: string;
    }
  | {
      type: "system";
      text: string;
    };

export type Msg =
  | { type: "set-title"; title: string }
  | { type: "update-profile"; profile: Profile }
  | {
      type: "send-message";
      messages: InputMessage[];
    }
  | {
      type: "abort";
    }
  | {
      type: "context-manager-msg";
      msg: ContextManagerMsg;
    }
  | {
      type: "toggle-system-prompt";
    }
  // View state messages
  | {
      type: "toggle-expand-content";
      messageIdx: number;
      contentIdx: number;
    }
  | {
      type: "toggle-expand-update";
      messageIdx: number;
      filePath: string;
    }
  | {
      type: "toggle-tool-details";
      toolRequestId: ToolRequestId;
    }
  | {
      type: "open-edit-file";
      filePath: UnresolvedFilePath;
    }
  | {
      type: "agent-msg";
      msg: AgentMsg;
    }
  | {
      type: "compact-agent-msg";
      msg: AgentMsg;
    }
  | {
      type: "permission-pending-change";
    }
  | {
      type: "tool-progress";
    }
  | {
      type: "toggle-compaction-record";
      recordIdx: number;
    }
  | {
      type: "toggle-compaction-step";
      recordIdx: number;
      stepIdx: number;
    };

export type ThreadMsg = {
  type: "thread-msg";
  id: ThreadId;
  msg: Msg;
};

/** View state for a single message, stored separately from provider thread content */
export type MessageViewState = {
  /** For user messages: context updates that were sent with this message */
  contextUpdates?: FileUpdates;
  /** Expansion state for context update entries */
  expandedUpdates?: { [absFilePath: string]: boolean };
  /** Expansion state for content blocks (e.g., thinking blocks) */
  expandedContent?: { [contentIdx: number]: boolean };
};

/** View state for tools, keyed by tool request ID */
export type ToolViewState = {
  details: boolean;
};

export type ActiveToolEntry = {
  handle: ToolInvocation;
  progress: unknown;
  toolName: ToolName;
  request: ToolRequest;
};

/** Cached lookup maps for tool results */
export type ToolCache = {
  results: Map<ToolRequestId, ProviderToolResult>;
};

export type CompactionStep = {
  chunkIndex: number;
  totalChunks: number;
  messages: ProviderMessage[];
};

export type CompactionRecord = {
  steps: CompactionStep[];
  finalSummary: string | undefined;
};
/** Thread-specific conversation mode (agent status is read directly from agent) */
export type ConversationMode =
  | { type: "normal" }
  | { type: "tool_use"; activeTools: Map<ToolRequestId, ActiveToolEntry> }
  | { type: "compacting" };

/** Minimum output tokens between system reminders during auto-respond loops */
const SYSTEM_REMINDER_MIN_TOKEN_INTERVAL = 2000;
export class Thread {
  public state: {
    title?: string | undefined;
    profile: Profile;
    threadType: ThreadType;
    systemPrompt: SystemPrompt;
    pendingMessages: InputMessage[];
    showSystemPrompt: boolean;
    /** View state per message, keyed by message index in agent */
    messageViewState: { [messageIdx: number]: MessageViewState };
    /** View state per tool, keyed by tool request ID */
    toolViewState: { [toolRequestId: ToolRequestId]: ToolViewState };

    /** Thread-specific mode (agent status is read directly from agent.getState().status) */
    mode: ConversationMode;
    /** Cached lookup maps for tool requests and results */
    toolCache: ToolCache;
    edlRegisters: EdlRegisters;
    outputTokensSinceLastReminder: number;
    yieldedResponse?: string;
    teardownMessage?: string;
    compactionHistory: CompactionRecord[];
    compactionViewState: {
      [recordIdx: number]: {
        expanded: boolean;
        expandedSteps: { [stepIdx: number]: boolean };
      };
    };
  };

  private myDispatch: Dispatch<Msg>;
  public contextManager: ContextManager;
  private commandRegistry: CommandRegistry;
  public agent: Agent;
  public permissionFileIO: PermissionCheckingFileIO | undefined;
  public fileIO: FileIO;
  public permissionShell: PermissionCheckingShell | undefined;
  public shell: Shell;
  public compactionManager: CompactionManager | undefined;
  public supervisor: ThreadSupervisor | undefined;

  constructor(
    public id: ThreadId,
    threadType: ThreadType,
    systemPrompt: SystemPrompt,
    public context: {
      dispatch: Dispatch<RootMsg>;
      chat: Chat;
      mcpToolManager: MCPToolManagerImpl;
      profile: Profile;
      nvim: Nvim;
      cwd: NvimCwd;
      homeDir: HomeDir;
      contextManager: ContextManager;
      options: MagentaOptions;
      getDisplayWidth: () => number;
      environment: Environment;
    },
    clonedAgent?: Agent,
  ) {
    this.myDispatch = (msg) =>
      this.context.dispatch({
        type: "thread-msg",
        id: this.id,
        msg,
      });

    this.contextManager = this.context.contextManager;
    const env = this.context.environment;
    this.fileIO = env.fileIO;
    this.permissionFileIO = env.permissionFileIO;
    this.shell = env.shell;
    this.permissionShell = env.permissionShell;

    this.commandRegistry = new CommandRegistry();
    // Register custom commands from options
    if (this.context.options.customCommands) {
      for (const customCommand of this.context.options.customCommands) {
        this.commandRegistry.registerCustomCommand(customCommand);
      }
    }

    this.state = {
      profile: this.context.profile,
      threadType: threadType,
      systemPrompt: systemPrompt,
      pendingMessages: [],
      showSystemPrompt: false,
      messageViewState: {},
      toolViewState: {},
      mode: { type: "normal" },
      toolCache: { results: new Map() },
      edlRegisters: { registers: new Map(), nextSavedId: 0 },
      outputTokensSinceLastReminder: 0,
      compactionHistory: [],
      compactionViewState: {},
    };

    if (clonedAgent) {
      this.agent = clonedAgent;
    } else {
      this.agent = this.createFreshAgent();
    }
  }

  private createFreshAgent(): Agent {
    const provider = getProvider(this.context.nvim, this.state.profile);
    return provider.createAgent(
      {
        model: this.state.profile.model,
        systemPrompt: this.state.systemPrompt,
        tools: getToolSpecs(
          this.state.threadType,
          this.context.mcpToolManager,
          this.context.environment.availableCapabilities,
        ),
        ...(this.state.profile.thinking &&
          (this.state.profile.provider === "anthropic" ||
            this.state.profile.provider === "mock") && {
            thinking: this.state.profile.thinking,
          }),
        ...(this.state.profile.reasoning &&
          (this.state.profile.provider === "openai" ||
            this.state.profile.provider === "mock") && {
            reasoning: this.state.profile.reasoning,
          }),
      },
      (msg) => this.myDispatch({ type: "agent-msg", msg }),
    );
  }
  getProviderStatus(): AgentStatus {
    return this.agent.getState().status;
  }

  getProviderMessages(): ReadonlyArray<ProviderMessage> {
    return this.agent.getState().messages ?? [];
  }

  update(msg: RootMsg): void {
    if (msg.type == "thread-msg" && msg.id == this.id) {
      this.myUpdate(msg.msg);
    }
  }

  private myUpdate(msg: Msg): void {
    switch (msg.type) {
      case "update-profile":
        this.state.profile = msg.profile;
        break;

      case "send-message": {
        this.handleSendMessageMsg(msg.messages).catch(
          this.handleSendMessageError.bind(this),
        );
        break;
      }

      case "context-manager-msg": {
        this.contextManager.update(msg.msg);
        return;
      }

      case "abort": {
        // Synchronously mark all tool invocations as aborted BEFORE the async
        // abortAndWait runs. This ensures the abort flag is set before
        // resolveThreadWaiters can fire (from child thread abort in chat.update).
        if (this.state.mode.type === "tool_use") {
          for (const [, entry] of this.state.mode.activeTools) {
            entry.handle.abort();
          }
        }
        this.abortAndWait().catch((e: Error) => {
          this.context.nvim.logger.error(`Error during abort: ${e.message}`);
        });
        return;
      }

      case "set-title": {
        this.state.title = msg.title;
        return;
      }

      case "toggle-system-prompt": {
        this.state.showSystemPrompt = !this.state.showSystemPrompt;
        return;
      }

      // View state messages
      case "toggle-expand-content": {
        const viewState = this.state.messageViewState[msg.messageIdx] || {};
        viewState.expandedContent = viewState.expandedContent || {};
        viewState.expandedContent[msg.contentIdx] =
          !viewState.expandedContent[msg.contentIdx];
        this.state.messageViewState[msg.messageIdx] = viewState;
        return;
      }

      case "toggle-expand-update": {
        const viewState = this.state.messageViewState[msg.messageIdx] || {};
        viewState.expandedUpdates = viewState.expandedUpdates || {};
        viewState.expandedUpdates[msg.filePath] =
          !viewState.expandedUpdates[msg.filePath];
        this.state.messageViewState[msg.messageIdx] = viewState;
        return;
      }

      case "toggle-tool-details": {
        const toolState = this.state.toolViewState[msg.toolRequestId] || {
          details: false,
        };
        toolState.details = !toolState.details;
        this.state.toolViewState[msg.toolRequestId] = toolState;
        return;
      }

      case "open-edit-file": {
        openFileInNonMagentaWindow(msg.filePath, this.context).catch(
          (e: Error) => this.context.nvim.logger.error(e.message),
        );
        return;
      }

      case "agent-msg": {
        switch (msg.msg.type) {
          case "agent-content-updated":
            this.rebuildToolCache();
            return;
          case "agent-stopped":
            this.handleProviderStopped(msg.msg.stopReason);
            return;
          case "agent-error":
            this.handleErrorState(msg.msg.error);
            return;
          default:
            return assertUnreachable(msg.msg);
        }
      }

      case "permission-pending-change":
      case "tool-progress":
        // no-op: re-render is triggered by the dispatch itself
        return;
      case "compact-agent-msg":
        this.compactionManager?.handleAgentMsg(msg.msg);
        return;

      case "toggle-compaction-record": {
        const vs = this.state.compactionViewState[msg.recordIdx] || {
          expanded: false,
          expandedSteps: {},
        };
        vs.expanded = !vs.expanded;
        this.state.compactionViewState[msg.recordIdx] = vs;
        return;
      }

      case "toggle-compaction-step": {
        const vs = this.state.compactionViewState[msg.recordIdx] || {
          expanded: false,
          expandedSteps: {},
        };
        vs.expandedSteps[msg.stepIdx] = !vs.expandedSteps[msg.stepIdx];
        this.state.compactionViewState[msg.recordIdx] = vs;
        return;
      }

      default:
        assertUnreachable(msg);
    }
  }

  private rebuildToolCache(): void {
    const results = new Map<ToolRequestId, ProviderToolResult>();

    for (const message of this.getProviderMessages()) {
      if (message.role !== "user") continue;

      for (const content of message.content) {
        if (content.type === "tool_result") {
          results.set(content.id, content);
        }
      }
    }

    this.state.toolCache = { results };
  }

  private handleProviderStoppedWithToolUse(): void {
    // Extract tool_use blocks from last assistant message
    const messages = this.getProviderMessages();
    const lastMessage = messages[messages.length - 1];

    if (!lastMessage || lastMessage.role !== "assistant") {
      // Shouldn't happen, but fall back to stopped state
      throw new Error(
        `Cannot handleProviderStoppedWithToolUse when the last message is not of type assistant`,
      );
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
        threadId: this.id,
        logger: this.context.nvim.logger,
        lspClient: this.context.environment.lspClient,
        cwd: this.context.environment.cwd,
        homeDir: this.context.environment.homeDir,
        maxConcurrentSubagents:
          this.context.options.maxConcurrentSubagents || 3,
        contextTracker: this.contextManager as ContextTracker,
        onToolApplied: (absFilePath, tool, fileTypeInfo) => {
          this.contextManager.update({
            type: "tool-applied",
            absFilePath,
            tool,
            fileTypeInfo,
          });
        },
        diagnosticsProvider: this.context.environment.diagnosticsProvider,
        edlRegisters: this.state.edlRegisters,
        fileIO: this.fileIO,
        shell: this.shell,
        threadManager: this.context.chat,
        containerProvisioner: this.context.options.container
          ? {
              containerConfig: this.context.options.container,
              provision: (opts: {
                repoPath: string;
                branch: string;
                containerConfig: ContainerConfig;
                onProgress?: (message: string) => void;
              }) => provisionContainer(opts),
            }
          : undefined,
        requestRender: () =>
          this.context.dispatch({
            type: "thread-msg",
            id: this.id,
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
          this.state.toolCache.results.set(request.id, result);
        })
        .catch((err: Error) => {
          this.state.toolCache.results.set(request.id, {
            type: "tool_result",
            id: request.id,
            result: {
              status: "error",
              error: `Tool execution failed: ${err.message}`,
            },
          });
        })
        .then(() => {
          this.maybeAutoRespond();
        });
    }

    this.state.mode = {
      type: "tool_use",
      activeTools,
    };

    const autoRespondResult = this.maybeAutoRespond();

    if (autoRespondResult.type !== "did-autorespond") {
      this.playChimeIfNeeded();
    }
  }

  private async handleCompactComplete(
    summary: string,
    nextPrompt: string | undefined,
    steps: CompactionStep[],
  ): Promise<void> {
    this.state.compactionHistory.push({ steps, finalSummary: summary });
    await this.resetContextManager();

    this.agent = this.createFreshAgent();

    // Reset thread state for the fresh agent
    this.state.messageViewState = {};
    this.state.toolViewState = {};
    this.state.toolCache = { results: new Map() };
    this.state.edlRegisters = { registers: new Map(), nextSavedId: 0 };
    this.state.outputTokensSinceLastReminder = 0;

    // Send the summary as a raw message (no command processing)
    const summaryText = `<conversation-summary>\n${summary}\n</conversation-summary>`;
    this.agent.appendUserMessage([{ type: "text", text: summaryText }]);

    // Send the nextPrompt through normal sendMessage so commands like @file get processed
    if (nextPrompt) {
      await this.sendMessage([{ type: "user", text: nextPrompt }]);
    } else {
      await this.sendMessage([
        { type: "user", text: "Please continue from where you left off." },
      ]);
    }
  }

  /** Reset the context manager, optionally adding specified files */
  private async resetContextManager(contextFiles?: string[]): Promise<void> {
    const env = this.context.environment;
    const isDocker = env.environmentConfig.type === "docker";
    this.contextManager = new ContextManager(
      (msg) =>
        this.context.dispatch({
          type: "thread-msg",
          id: this.id,
          msg: { type: "context-manager-msg", msg },
        }),
      {
        dispatch: this.context.dispatch,
        fileIO: this.fileIO,
        cwd: isDocker ? env.cwd : this.context.cwd,
        homeDir: isDocker ? env.homeDir : this.context.homeDir,
        nvim: this.context.nvim,
        options: this.context.options,
      },
    );

    if (contextFiles && contextFiles.length > 0) {
      await this.contextManager.addFiles(contextFiles as UnresolvedFilePath[]);
    }

    this.context.contextManager = this.contextManager;
  }

  private startCompaction(nextPrompt?: string): void {
    this.compactionManager = new CompactionManager({
      profile: this.state.profile,
      mcpToolManager: this.context.mcpToolManager,
      environment: this.context.environment,
      contextManager: this.contextManager,
      threadId: this.id,
      dispatch: this.context.dispatch,
      nvim: this.context.nvim,
      options: this.context.options,
      shell: this.shell,
      chat: this.context.chat,
      onComplete: (result) => this.handleCompactionResult(result),
    });
    this.state.mode = { type: "compacting" };
    this.compactionManager.start(this.getProviderMessages(), nextPrompt);
  }

  private handleCompactionResult(result: CompactionResult): void {
    this.compactionManager = undefined;
    this.state.mode = { type: "normal" };

    if (result.type === "complete") {
      this.handleCompactComplete(
        result.summary,
        result.nextPrompt,
        result.steps,
      ).catch((e: Error) => {
        this.context.nvim.logger.error(
          `Failed during compact-complete: ${e.message}`,
        );
      });
    } else {
      this.state.compactionHistory.push({
        steps: result.steps,
        finalSummary: undefined,
      });
    }
  }
  private shouldAutoCompact(): boolean {
    const inputTokenCount = this.agent.getState().inputTokenCount;
    if (inputTokenCount === undefined) return false;
    if (this.state.threadType === "compact") return false;

    const contextWindow = getContextWindowForModel(this.state.profile.model);
    return inputTokenCount >= contextWindow * 0.8;
  }

  private handleProviderStopped(stopReason: StopReason): void {
    // Accumulate output tokens for system reminder throttling
    const latestUsage = this.agent.getState().latestUsage;
    if (latestUsage) {
      this.state.outputTokensSinceLastReminder += latestUsage.outputTokens;
    }

    // Handle tool_use stop reason specially
    if (stopReason === "tool_use") {
      this.handleProviderStoppedWithToolUse();
      return;
    }

    this.state.mode = { type: "normal" };

    // Handle stopped state - check for pending messages
    const autoRespondResult = this.maybeAutoRespond();

    if (autoRespondResult.type === "no-action-needed" && this.supervisor) {
      const action = this.supervisor.onEndTurnWithoutYield();
      if (action.type === "send-message") {
        this.sendMessage([{ type: "system", text: action.text }]).catch(
          this.handleSendMessageError.bind(this),
        );
        return;
      }
    }

    if (autoRespondResult.type !== "did-autorespond") {
      this.playChimeIfNeeded();
    }
  }

  private handleErrorState(error: Error): void {
    // On error, set up resubmit if we have a last user message
    const messages = this.getProviderMessages();
    const lastMessage = messages[messages.length - 1];
    if (lastMessage?.role === "user") {
      const textContent = lastMessage.content
        .filter(
          (c): c is Extract<typeof c, { type: "text" }> => c.type === "text",
        )
        .map((c) => c.text)
        .join("");
      if (textContent) {
        setTimeout(
          () =>
            this.context.dispatch({
              type: "sidebar-msg",
              msg: {
                type: "setup-resubmit",
                lastUserMessage: textContent,
              },
            }),
          1,
        );
      }
    }
    this.context.nvim.logger.error(error);
  }

  /** Abort in-progress operations and wait for completion.
   * Returns a promise that resolves when the agent is in a stable state.
   */
  async abortAndWait(): Promise<void> {
    // Abort the provider thread if streaming and wait for it to complete
    await this.agent.abort();

    // If we're in tool_use mode, abort all active tools and insert their results
    if (this.state.mode.type === "tool_use") {
      for (const [toolId, entry] of this.state.mode.activeTools) {
        entry.handle.abort();
        if (!this.state.toolCache.results.has(toolId)) {
          this.agent.toolResult(toolId, {
            type: "tool_result",
            id: toolId,
            result: {
              status: "error",
              error: "Request was aborted by the user.",
            },
          });
        }
      }

      // Mark agent as aborted after inserting all error tool results
      this.agent.abortToolUse();
      this.rebuildToolCache();
    }

    // Clear any pending permission checks so they don't block after abort
    this.permissionFileIO?.denyAll();
    this.permissionShell?.denyAll();

    // Transition to normal mode (agent status already reflects aborted)
    this.state.mode = { type: "normal" };
  }

  /** Handle send-message action - async handler for the entire flow */
  private async handleSendMessageMsg(messages: InputMessage[]): Promise<void> {
    // For compact threads, skip all command processing and send raw text
    if (this.state.threadType === "compact") {
      this.sendRawMessage(messages);
      return;
    }

    // Check if the first user message starts with @fork
    const firstUserMessage = messages.find((m) => m.type === "user");
    if (firstUserMessage?.text.trim().startsWith("@fork")) {
      // Strip @fork from the message and dispatch to Chat
      const strippedMessages = messages.map((m) => ({
        ...m,
        text: m.type === "user" ? m.text.replace(/^\s*@fork\s*/, "") : m.text,
      }));

      this.context.dispatch({
        type: "chat-msg",
        msg: {
          type: "fork-thread",
          sourceThreadId: this.id,
          strippedMessages,
        },
      });
      return;
    }

    // Check if the first user message starts with @compact
    if (firstUserMessage?.text.trim().startsWith("@compact")) {
      const nextPrompt = firstUserMessage.text
        .replace(/^\s*@compact\s*/, "")
        .trim();
      this.startCompaction(nextPrompt || undefined);
      return;
    }

    // Check if any message starts with @async
    const isAsync = messages.some(
      (m) => m.type === "user" && m.text.trim().startsWith("@async"),
    );

    const agentStatus = this.agent.getState().status;
    const isBusy =
      agentStatus.type === "streaming" || this.state.mode.type === "tool_use";

    if (isBusy) {
      if (isAsync) {
        const processedMessages = messages.map((m) => ({
          ...m,
          text:
            m.type === "user" ? m.text.replace(/^\s*@async\s*/, "") : m.text,
        }));
        this.state.pendingMessages.push(...processedMessages);
        return;
      } else {
        await this.abortAndWait();
      }
    }

    await this.sendMessage(messages);

    if (!this.state.title) {
      this.setThreadTitle(messages.map((m) => m.text).join("\n")).catch(
        (err: Error) =>
          this.context.nvim.logger.error(
            "Error getting thread title: " + err.message + "\n" + err.stack,
          ),
      );
    }

    if (messages.length) {
      setTimeout(() => {
        this.context.dispatch({
          type: "sidebar-msg",
          msg: {
            type: "scroll-to-last-user-message",
          },
        });
      }, 100);
    }
  }

  maybeAutoRespond():
    | { type: "did-autorespond" }
    | { type: "waiting-for-tool-input" }
    | { type: "yielded-to-parent" }
    | { type: "no-action-needed" } {
    const mode = this.state.mode;
    const agentStatus = this.agent.getState().status;

    // Don't auto-respond if yielded or aborted
    if (this.state.yieldedResponse !== undefined) {
      return { type: "yielded-to-parent" };
    }
    if (
      agentStatus.type === "stopped" &&
      agentStatus.stopReason === "aborted"
    ) {
      return { type: "no-action-needed" };
    }

    // Don't auto-respond while compact subagent is running
    if (mode.type === "compacting") {
      return { type: "no-action-needed" };
    }

    if (mode.type === "tool_use") {
      // Collect completed tools and check for blocking ones
      const completedTools: Array<{
        id: ToolRequestId;
        result: ProviderToolResult;
      }> = [];
      for (const [toolId, entry] of mode.activeTools) {
        if (entry.toolName === "yield_to_parent") {
          const yieldResult = (entry.request.input as { result: string })
            .result;

          if (this.supervisor) {
            this.handleSupervisedYield(yieldResult).catch(
              this.handleSendMessageError.bind(this),
            );
            return { type: "yielded-to-parent" };
          }

          this.state.yieldedResponse = yieldResult;
          return { type: "yielded-to-parent" };
        }

        const cachedResult = this.state.toolCache.results.get(toolId);
        if (!cachedResult) {
          return { type: "waiting-for-tool-input" };
        }

        completedTools.push({
          id: toolId,
          result: cachedResult,
        });
      }

      const pendingMessages = this.state.pendingMessages;
      this.state.pendingMessages = [];

      // Send tool results, then continue the conversation
      this.sendToolResultsAndContinue(completedTools, pendingMessages).catch(
        this.handleSendMessageError.bind(this),
      );
      this.rebuildToolCache();
      return { type: "did-autorespond" };
    } else if (
      agentStatus.type === "stopped" &&
      agentStatus.stopReason === "end_turn" &&
      this.state.pendingMessages.length
    ) {
      const pendingMessages = this.state.pendingMessages;
      this.state.pendingMessages = [];
      this.sendMessage(pendingMessages).catch(
        this.handleSendMessageError.bind(this),
      );
      return { type: "did-autorespond" };
    }
    return { type: "no-action-needed" };
  }

  private async handleSupervisedYield(yieldResult: string): Promise<void> {
    const action = await this.supervisor!.onYield(yieldResult);
    switch (action.type) {
      case "accept":
        this.state.yieldedResponse = yieldResult;
        this.dispatchYieldComplete();
        break;
      case "reject":
        this.state.mode = { type: "normal" };
        await this.sendMessage([{ type: "system", text: action.message }]);
        break;
      case "send-message":
        this.state.mode = { type: "normal" };
        await this.sendMessage([{ type: "system", text: action.text }]);
        break;
      case "none":
        this.state.yieldedResponse = yieldResult;
        this.dispatchYieldComplete();
        break;
    }
  }

  private dispatchYieldComplete(): void {
    this.context.dispatch({
      type: "thread-msg",
      id: this.id,
      msg: { type: "tool-progress" },
    });
  }

  private async getAndPrepareContextUpdates(): Promise<{
    content: AgentInput[];
    updates: FileUpdates | undefined;
  }> {
    const contextUpdates = await this.contextManager.getContextUpdate();
    if (Object.keys(contextUpdates).length === 0) {
      return { content: [], updates: undefined };
    }

    const contextContent =
      this.contextManager.contextUpdatesToContent(contextUpdates);
    const content: AgentInput[] = [];
    for (const c of contextContent) {
      if (c.type === "text") {
        content.push({ type: "text", text: c.text });
      }
    }

    return { content, updates: contextUpdates };
  }

  private async sendToolResultsAndContinue(
    toolResults: Array<{ id: ToolRequestId; result: ProviderToolResult }>,
    pendingMessages: InputMessage[],
  ): Promise<void> {
    // Send all tool results to the provider thread
    for (const { id, result } of toolResults) {
      this.agent.toolResult(id, result);
    }

    // Reset mode as we transition away from tool_use
    this.state.mode = { type: "normal" };

    // If we have pending messages, send them via sendMessage
    if (pendingMessages.length > 0) {
      await this.sendMessage(pendingMessages);
      return;
    }

    // No pending messages - check for context updates
    const { content: contextContent, updates: contextUpdates } =
      await this.getAndPrepareContextUpdates();

    // Build content for the follow-up user message with system reminder
    const contentToSend: AgentInput[] = [...contextContent];

    // Only add system reminder if enough tokens have been generated since the last one
    if (
      this.state.outputTokensSinceLastReminder >=
      SYSTEM_REMINDER_MIN_TOKEN_INTERVAL
    ) {
      const reminder = getSubsequentReminder(this.state.threadType);
      if (reminder) {
        contentToSend.push({
          type: "text",
          text: reminder,
        });
      }
      this.state.outputTokensSinceLastReminder = 0;
    }

    if (contextUpdates) {
      const newMessageIdx = this.getProviderMessages().length;
      this.state.messageViewState[newMessageIdx] = {
        contextUpdates,
      };
    }

    // Auto-compact if approaching context window limit
    if (this.shouldAutoCompact()) {
      this.startCompaction();
      return;
    }

    if (contentToSend.length > 0) {
      this.agent.appendUserMessage(contentToSend);
    }
    this.agent.continueConversation();
  }

  private handleSendMessageError = (error: Error): void => {
    // Log the error - the provider thread will emit the error state
    this.context.nvim.logger.error(error);
  };

  private playChimeIfNeeded(): void {
    // Play chime when we need the user to do something:
    // 1. Agent stopped with end_turn (user needs to respond)
    // 2. We're blocked on a tool use that requires user action
    const agentStatus = this.agent.getState().status;

    if (
      agentStatus.type === "stopped" &&
      agentStatus.stopReason === "end_turn"
    ) {
      this.playChimeSound();
      return;
    }
  }

  private playChimeSound(): void {
    const actualVolume = this.context.options.chimeVolume;

    if (!actualVolume) {
      return;
    }

    try {
      const play = player();
      const chimeFile = join(
        dirname(fileURLToPath(import.meta.url)),
        "..",
        "..",
        "chime.wav",
      );

      // Play sound with volume control (platform-specific options)
      const playOptions = {
        // For macOS afplay: volume range is 0-1, where 1 is full volume
        afplay: ["-v", actualVolume.toString()],
        // For Linux aplay: volume range is 0-100%
        aplay: ["-v", Math.round(actualVolume * 100).toString() + "%"],
        // For mpg123: volume range is 0-32768
        mpg123: ["-f", Math.round(actualVolume * 32768).toString()],
      };

      play.play(chimeFile, playOptions, (err: Error | null) => {
        if (err) {
          this.context.nvim.logger.error(
            `Failed to play chime sound: ${err.message}`,
          );
        }
      });
    } catch (error) {
      this.context.nvim.logger.error(
        `Error setting up chime sound: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /** Prepare user message content for sending to provider thread */
  private async prepareUserContent(inputMessages?: InputMessage[]): Promise<{
    content: ProviderMessageContent[];
    hasContent: boolean;
  }> {
    // Process messages to handle @file commands
    const messageContent: ProviderMessageContent[] = [];

    for (const m of inputMessages || []) {
      if (m.type === "user") {
        const { processedText, additionalContent } =
          await this.commandRegistry.processMessage(m.text, {
            nvim: this.context.nvim,
            cwd: this.context.environment.cwd,
            homeDir: this.context.environment.homeDir,
            contextManager: this.contextManager,
            options: this.context.options,
          });

        messageContent.push({
          type: "text",
          text: processedText,
        });

        // Add any additional content from commands
        messageContent.push(...additionalContent);
      } else {
        messageContent.push({
          type: "text",
          text: m.text,
        });
      }
    }

    // Always add system reminder for user-submitted messages and reset counter
    if (inputMessages?.length) {
      this.state.outputTokensSinceLastReminder = 0;
      const reminder = getSubsequentReminder(this.state.threadType);
      if (reminder) {
        messageContent.push({
          type: "system_reminder",
          text: reminder,
        });
      }
    }

    return {
      content: messageContent,
      hasContent: (inputMessages?.length ?? 0) > 0,
    };
  }

  async sendMessage(inputMessages?: InputMessage[]): Promise<void> {
    // Prepare user content
    const { content, hasContent } =
      await this.prepareUserContent(inputMessages);

    // Get context updates
    const { content: contextContent, updates: contextUpdates } =
      await this.getAndPrepareContextUpdates();

    if (!hasContent && contextContent.length === 0) {
      // No content to send - this shouldn't normally happen
      return;
    }

    // Store context updates in view state for the new user message
    const currentMessageCount = this.getProviderMessages().length;
    if (contextUpdates) {
      this.state.messageViewState[currentMessageCount] = {
        contextUpdates,
      };
    }

    // Build content to send to provider thread
    // Include context as text content, then user content
    const contentToSend: AgentInput[] = [...contextContent];

    // Add user content (filter to input types only)
    for (const c of content) {
      if (c.type === "text") {
        contentToSend.push({ type: "text", text: c.text });
      } else if (c.type === "image") {
        contentToSend.push(c);
      } else if (c.type === "document") {
        contentToSend.push(c);
      } else if (c.type === "system_reminder") {
        // Convert system_reminder to text for the provider
        contentToSend.push({ type: "text", text: c.text });
      }
    }

    // Auto-compact if approaching context window limit
    if (this.shouldAutoCompact()) {
      const rawText = inputMessages
        ?.filter((m) => m.type === "user")
        .map((m) => m.text)
        .join("\n");
      this.startCompaction(rawText || undefined);
      return;
    }

    // Send to provider thread and start response
    this.agent.appendUserMessage(contentToSend);
    this.agent.continueConversation();
  }

  /** Send messages as raw text, bypassing command processing and context updates.
   * Used for compact threads where message content should not be transformed.
   */
  private sendRawMessage(messages: InputMessage[]): void {
    const contentToSend: AgentInput[] = messages.map((m) => ({
      type: "text" as const,
      text: m.text,
    }));

    if (contentToSend.length === 0) return;

    this.agent.appendUserMessage(contentToSend);
    this.agent.continueConversation();
  }

  /** Get messages in provider format - delegates to provider thread */
  getMessages(): ProviderMessage[] {
    return [...this.getProviderMessages()];
  }

  async setThreadTitle(userMessage: string) {
    // Create a profile with reasoning/thinking disabled for fast model
    const profileForRequest: Profile = {
      ...this.context.profile,
      thinking: undefined,
      reasoning: undefined,
    };

    const request = getProvider(
      this.context.nvim,
      profileForRequest,
    ).forceToolUse({
      model: this.context.profile.fastModel,
      input: [
        {
          type: "text",
          text: `\
The user has provided the following prompt:
${userMessage}

Come up with a succinct thread title for this prompt. It should be less than 80 characters long.
`,
        },
      ],
      spec: ThreadTitle.spec,
      systemPrompt: this.state.systemPrompt,
      disableCaching: true,
    });
    const result = await request.promise;
    if (result.toolRequest.status == "ok") {
      this.myDispatch({
        type: "set-title",
        title: (result.toolRequest.value.input as ThreadTitle.Input).title,
      });
    }
  }

  getLastStopTokenCount(): number {
    const state = this.agent.getState();
    if (state.inputTokenCount != undefined) {
      return state.inputTokenCount;
    }

    const latestUsage = state.latestUsage;
    if (!latestUsage) {
      return 0;
    }

    return (
      latestUsage.inputTokens +
      latestUsage.outputTokens +
      (latestUsage.cacheHits || 0) +
      (latestUsage.cacheMisses || 0)
    );
  }
}
