import type { Logger } from "./logger.ts";
import type { ProviderProfile } from "./provider-options.ts";
import type { ThreadType, ThreadId } from "./chat-types.ts";
import type { SystemPrompt } from "./providers/system-prompt.ts";
import { MCPToolManager as MCPToolManagerImpl } from "./tools/mcp/manager.ts";
import type { ContextManager } from "./context/context-manager.ts";
import type { ThreadManager } from "./capabilities/thread-manager.ts";
import type { FileIO } from "./capabilities/file-io.ts";
import type { Shell } from "./capabilities/shell.ts";
import type { LspClient } from "./capabilities/lsp-client.ts";
import type { DiagnosticsProvider } from "./capabilities/diagnostics-provider.ts";
import type { ContextTracker } from "./capabilities/context-tracker.ts";
import type { ContainerConfig } from "./container/types.ts";
import type { NvimCwd, HomeDir } from "./utils/files.ts";
import type { ToolCapability } from "./tools/tool-registry.ts";
import type {
  Provider,
  ProviderMessage,
  ProviderMessageContent,
  Agent,
  AgentInput,
  AgentStatus,
  AgentMsg,
  ProviderToolResult,
  StopReason,
} from "./providers/provider-types.ts";
import type {
  ToolRequestId,
  ToolName,
  ToolRequest,
  ToolInvocation,
} from "./tool-types.ts";
import type { EdlRegisters } from "./edl/index.ts";
import type {
  CompactionResult,
  CompactionStep,
  CompactionRecord,
} from "./compaction-controller.ts";
import { CompactionManager } from "./compaction-manager.ts";
import type { ThreadSupervisor } from "./thread-supervisor.ts";
import { Emitter } from "./emitter.ts";

import { getToolSpecs } from "./tools/toolManager.ts";
import { createTool, type CreateToolContext } from "./tools/create-tool.ts";
import { provisionContainer } from "./container/provision.ts";
import { getSubsequentReminder } from "./providers/system-reminders.ts";
import { getContextWindowForModel } from "./providers/anthropic-agent.ts";
import { assertUnreachable } from "./utils/assertUnreachable.ts";
import * as ThreadTitle from "./tools/thread-title.ts";

export type InputMessage =
  | {
      type: "user";
      text: string;
    }
  | {
      type: "system";
      text: string;
    };

export type ActiveToolEntry = {
  handle: ToolInvocation;
  progress: unknown;
  toolName: ToolName;
  request: ToolRequest;
};

export type ToolCache = {
  results: Map<ToolRequestId, ProviderToolResult>;
};

export type ThreadMode =
  | { type: "normal" }
  | { type: "tool_use"; activeTools: Map<ToolRequestId, ActiveToolEntry> }
  | { type: "compacting" }
  | {
      type: "yielded";
      response: string;
      tornDown?: boolean;
      teardownMessage?: string;
    };

export type EnvironmentConfig =
  | { type: "local" }
  | { type: "docker"; container: string; cwd: string };

export type ThreadCoreEvents = {
  update: [];
  playChime: [];
  scrollToLastMessage: [];
  setupResubmit: [lastUserMessage: string];
  agentMsg: [msg: AgentMsg];
  contextUpdatesSent: [updates: Record<string, unknown>];
};

export interface ThreadCoreContext {
  logger: Logger;
  profile: ProviderProfile;
  cwd: NvimCwd;
  homeDir: HomeDir;
  threadType: ThreadType;
  systemPrompt: SystemPrompt;
  mcpToolManager: MCPToolManagerImpl;
  contextManager: ContextManager;
  threadManager: ThreadManager;
  fileIO: FileIO;
  shell: Shell;
  lspClient: LspClient;
  diagnosticsProvider: DiagnosticsProvider;
  availableCapabilities: Set<ToolCapability>;
  environmentConfig: EnvironmentConfig;
  maxConcurrentSubagents: number;
  container?: ContainerConfig | undefined;
  getProvider: (profile: ProviderProfile) => Provider;

  resetContextManager: (contextFiles?: string[]) => Promise<ContextManager>;
}

/** Minimum output tokens between system reminders during auto-respond loops */
const SYSTEM_REMINDER_MIN_TOKEN_INTERVAL = 2000;

export type ThreadCoreAction =
  | { type: "set-title"; title: string }
  | { type: "set-mode"; mode: ThreadMode }
  | { type: "rebuild-tool-cache" }
  | { type: "cache-tool-result"; id: ToolRequestId; result: ProviderToolResult }
  | { type: "increment-output-tokens"; tokens: number }
  | { type: "reset-output-tokens" }
  | { type: "set-teardown-message"; message: string }
  | { type: "push-pending-messages"; messages: InputMessage[] }
  | { type: "drain-pending-messages" }
  | { type: "push-compaction-record"; record: CompactionRecord }
  | { type: "reset-after-compaction" };

export class ThreadCore extends Emitter<ThreadCoreEvents> {
  public state: {
    title?: string;
    threadType: ThreadType;
    systemPrompt: SystemPrompt;
    pendingMessages: InputMessage[];
    mode: ThreadMode;
    toolCache: ToolCache;
    edlRegisters: EdlRegisters;
    outputTokensSinceLastReminder: number;
    compactionHistory: CompactionRecord[];
  };

  public agent: Agent;
  public compactionController: CompactionManager | undefined;
  public supervisor: ThreadSupervisor | undefined;

  constructor(
    public id: ThreadId,
    private context: ThreadCoreContext,
    clonedAgent?: Agent,
  ) {
    super();
    this.state = {
      threadType: context.threadType,
      systemPrompt: context.systemPrompt,
      pendingMessages: [],
      mode: { type: "normal" },
      toolCache: { results: new Map() },
      edlRegisters: { registers: new Map(), nextSavedId: 0 },
      outputTokensSinceLastReminder: 0,
      compactionHistory: [],
    };

    if (clonedAgent) {
      this.agent = clonedAgent;
    } else {
      this.agent = this.createFreshAgent();
    }
  }

  /** Process a state mutation. Calls onUpdate() unless silent is true.
   *  Use silent for internal bookkeeping that doesn't need a view re-render.
   */
  update(
    action: ThreadCoreAction,
    { silent }: { silent?: boolean } = {},
  ): void {
    switch (action.type) {
      case "set-title":
        this.state.title = action.title;
        break;
      case "set-mode":
        this.state.mode = action.mode;
        break;
      case "rebuild-tool-cache": {
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
        break;
      }
      case "cache-tool-result":
        this.state.toolCache.results.set(action.id, action.result);
        break;
      case "increment-output-tokens":
        this.state.outputTokensSinceLastReminder += action.tokens;
        break;
      case "reset-output-tokens":
        this.state.outputTokensSinceLastReminder = 0;
        break;
      case "set-teardown-message":
        if (this.state.mode.type === "yielded") {
          this.state.mode.teardownMessage = action.message;
        }
        break;
      case "push-pending-messages":
        this.state.pendingMessages.push(...action.messages);
        break;
      case "drain-pending-messages":
        this.state.pendingMessages = [];
        break;
      case "push-compaction-record":
        this.state.compactionHistory.push(action.record);
        break;
      case "reset-after-compaction":
        this.state.toolCache = { results: new Map() };
        this.state.edlRegisters = { registers: new Map(), nextSavedId: 0 };
        this.state.outputTokensSinceLastReminder = 0;
        break;
      default:
        assertUnreachable(action);
    }
    if (!silent) {
      this.emit("update");
    }
  }

  private createFreshAgent(): Agent {
    const provider = this.context.getProvider(this.context.profile);
    return provider.createAgent(
      {
        model: this.context.profile.model,
        systemPrompt: this.state.systemPrompt,
        tools: getToolSpecs(
          this.state.threadType,
          this.context.mcpToolManager,
          this.context.availableCapabilities,
        ),
        ...(this.context.profile.thinking &&
          (this.context.profile.provider === "anthropic" ||
            this.context.profile.provider === "mock") && {
            thinking: this.context.profile.thinking,
          }),
        ...(this.context.profile.reasoning &&
          (this.context.profile.provider === "openai" ||
            this.context.profile.provider === "mock") && {
            reasoning: this.context.profile.reasoning,
          }),
      },
      (msg) => this.emit("agentMsg", msg),
    );
  }

  getProviderStatus(): AgentStatus {
    return this.agent.getState().status;
  }

  getProviderMessages(): ReadonlyArray<ProviderMessage> {
    return this.agent.getState().messages ?? [];
  }

  getMessages(): ProviderMessage[] {
    return [...this.getProviderMessages()];
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

  handleAgentMsg(msg: AgentMsg): void {
    switch (msg.type) {
      case "agent-content-updated":
        this.rebuildToolCache();
        return;
      case "agent-stopped":
        this.handleProviderStopped(msg.stopReason);
        return;
      case "agent-error":
        this.handleErrorState(msg.error);
        return;
      default:
        return assertUnreachable(msg);
    }
  }

  setTitle(title: string): void {
    this.update({ type: "set-title", title });
  }

  private rebuildToolCache(): void {
    this.update({ type: "rebuild-tool-cache" }, { silent: true });
  }

  private handleProviderStopped(stopReason: StopReason): void {
    const latestUsage = this.agent.getState().latestUsage;
    if (latestUsage) {
      this.update(
        { type: "increment-output-tokens", tokens: latestUsage.outputTokens },
        { silent: true },
      );
    }

    if (stopReason === "tool_use") {
      this.handleProviderStoppedWithToolUse();
      return;
    }

    this.update({ type: "set-mode", mode: { type: "normal" } });

    const autoRespondResult = this.maybeAutoRespond();

    if (autoRespondResult.type === "no-action-needed" && this.supervisor) {
      const action = this.supervisor.onEndTurnWithoutYield(stopReason);
      if (action.type === "send-message") {
        this.sendMessage([{ type: "system", text: action.text }]).catch(
          this.handleSendMessageError.bind(this),
        );
        return;
      }
    }

    if (autoRespondResult.type !== "did-autorespond") {
      this.emit("playChime");
    }
  }

  private handleProviderStoppedWithToolUse(): void {
    const messages = this.getProviderMessages();
    const lastMessage = messages[messages.length - 1];

    if (!lastMessage || lastMessage.role !== "assistant") {
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
        logger: this.context.logger,
        lspClient: this.context.lspClient,
        cwd: this.context.cwd,
        homeDir: this.context.homeDir,
        maxConcurrentSubagents: this.context.maxConcurrentSubagents,
        contextTracker: this.context.contextManager as ContextTracker,
        onToolApplied: (absFilePath, tool, fileTypeInfo) => {
          this.context.contextManager.toolApplied(
            absFilePath,
            tool,
            fileTypeInfo,
          );
        },
        diagnosticsProvider: this.context.diagnosticsProvider,
        edlRegisters: this.state.edlRegisters,
        fileIO: this.context.fileIO,
        shell: this.context.shell,
        threadManager: this.context.threadManager,
        containerProvisioner: this.context.container
          ? {
              containerConfig: this.context.container,
              provision: (opts: {
                repoPath: string;
                branch: string;
                containerConfig: ContainerConfig;
                onProgress?: (message: string) => void;
              }) => provisionContainer(opts),
            }
          : undefined,
        requestRender: () => this.emit("update"),
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
          this.update({ type: "cache-tool-result", id: request.id, result });
        })
        .catch((err: Error) => {
          this.update({
            type: "cache-tool-result",
            id: request.id,
            result: {
              type: "tool_result",
              id: request.id,
              result: {
                status: "error",
                error: `Tool execution failed: ${err.message}`,
              },
            },
          });
        })
        .then(() => {
          this.maybeAutoRespond();
        });
    }

    this.update({ type: "set-mode", mode: { type: "tool_use", activeTools } });

    const autoRespondResult = this.maybeAutoRespond();

    if (autoRespondResult.type !== "did-autorespond") {
      this.emit("playChime");
    }
  }

  private handleErrorState(error: Error): void {
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
        setTimeout(() => this.emit("setupResubmit", textContent), 1);
      }
    }
    this.context.logger.error(error);
  }

  async abort(): Promise<void> {
    // Synchronously mark all tool invocations as aborted
    if (this.state.mode.type === "tool_use") {
      for (const [, entry] of this.state.mode.activeTools) {
        entry.handle.abort();
      }
    }
    await this.abortAndWait();
  }

  private async abortAndWait(): Promise<void> {
    await this.agent.abort();

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

      this.agent.abortToolUse();
      this.rebuildToolCache();
    }

    this.update({ type: "set-mode", mode: { type: "normal" } });
  }

  async sendMessage(inputMessages?: InputMessage[]): Promise<void> {
    if (this.state.mode.type === "yielded" && this.state.mode.tornDown) {
      throw new Error(
        "This thread's container has been torn down. No further messages can be sent.",
      );
    }

    const { content, hasContent } = this.prepareUserContent(inputMessages);

    const { content: contextContent, updates: contextUpdates } =
      await this.getAndPrepareContextUpdates();

    if (!hasContent && contextContent.length === 0) {
      return;
    }

    if (contextUpdates) {
      this.emit("contextUpdatesSent", contextUpdates);
    }

    const contentToSend: AgentInput[] = [...contextContent];

    for (const c of content) {
      if (c.type === "text") {
        contentToSend.push({ type: "text", text: c.text });
      } else if (c.type === "image") {
        contentToSend.push(c);
      } else if (c.type === "document") {
        contentToSend.push(c);
      } else if (c.type === "system_reminder") {
        contentToSend.push({ type: "text", text: c.text });
      }
    }

    if (this.shouldAutoCompact()) {
      const rawText = inputMessages
        ?.filter((m) => m.type === "user")
        .map((m) => m.text)
        .join("\n");
      this.startCompaction(rawText || undefined);
      return;
    }

    this.agent.appendUserMessage(contentToSend);
    this.agent.continueConversation();
  }

  async handleSendMessageRequest(
    messages: InputMessage[],
    isAsync?: boolean,
  ): Promise<void> {
    if (this.state.threadType === "compact") {
      this.sendRawMessage(messages);
      return;
    }

    const agentStatus = this.agent.getState().status;
    const isBusy =
      agentStatus.type === "streaming" || this.state.mode.type === "tool_use";

    if (isBusy) {
      if (isAsync) {
        this.update(
          { type: "push-pending-messages", messages },
          { silent: true },
        );
        return;
      } else {
        await this.abortAndWait();
      }
    }

    await this.sendMessage(messages);

    if (!this.state.title) {
      this.setThreadTitle(messages.map((m) => m.text).join("\n")).catch(
        (err: Error) =>
          this.context.logger.error(
            "Error getting thread title: " + err.message + "\n" + err.stack,
          ),
      );
    }

    if (messages.length) {
      setTimeout(() => this.emit("scrollToLastMessage"), 100);
    }
  }

  maybeAutoRespond():
    | { type: "did-autorespond" }
    | { type: "waiting-for-tool-input" }
    | { type: "yielded-to-parent" }
    | { type: "no-action-needed" } {
    const mode = this.state.mode;
    const agentStatus = this.agent.getState().status;

    if (this.state.mode.type === "yielded") {
      return { type: "yielded-to-parent" };
    }
    if (
      agentStatus.type === "stopped" &&
      agentStatus.stopReason === "aborted"
    ) {
      return { type: "no-action-needed" };
    }

    if (mode.type === "compacting") {
      return { type: "no-action-needed" };
    }

    if (mode.type === "tool_use") {
      const completedTools: Array<{
        id: ToolRequestId;
        result: ProviderToolResult;
      }> = [];
      let yieldResult: string | undefined;
      for (const [toolId, entry] of mode.activeTools) {
        if (entry.toolName === "yield_to_parent") {
          yieldResult = (entry.request.input as { result: string }).result;
          completedTools.push({
            id: toolId,
            result: {
              type: "tool_result",
              id: toolId,
              result: {
                status: "ok",
                value: [
                  {
                    type: "text",
                    text: "Yield accepted. Your result has been sent to the parent thread.",
                  },
                ],
              },
            },
          });
          continue;
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

      if (yieldResult !== undefined) {
        this.submitToolResultsAndStop(completedTools, yieldResult).catch(
          this.handleSendMessageError.bind(this),
        );
        this.rebuildToolCache();
        return { type: "yielded-to-parent" };
      }

      const pendingMessages = this.state.pendingMessages;
      this.update({ type: "drain-pending-messages" }, { silent: true });

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
      this.update({ type: "drain-pending-messages" }, { silent: true });
      this.sendMessage(pendingMessages).catch(
        this.handleSendMessageError.bind(this),
      );
      return { type: "did-autorespond" };
    }
    return { type: "no-action-needed" };
  }

  private async submitToolResultsAndStop(
    toolResults: Array<{ id: ToolRequestId; result: ProviderToolResult }>,
    yieldResult: string,
  ): Promise<void> {
    for (const { id, result } of toolResults) {
      this.agent.toolResult(id, result);
    }
    this.update({ type: "set-mode", mode: { type: "normal" } });

    if (this.supervisor) {
      const action = await this.supervisor.onYield(yieldResult);
      switch (action.type) {
        case "accept":
          this.update({
            type: "set-mode",
            mode: { type: "yielded", response: yieldResult, tornDown: true },
          });
          break;
        case "none":
          this.update({
            type: "set-mode",
            mode: { type: "yielded", response: yieldResult },
          });
          break;
        case "reject":
          await this.sendMessage([{ type: "system", text: action.message }]);
          return;
        case "send-message":
          await this.sendMessage([{ type: "system", text: action.text }]);
          return;
      }
    } else {
      this.update({
        type: "set-mode",
        mode: { type: "yielded", response: yieldResult },
      });
    }
  }

  private async getAndPrepareContextUpdates(): Promise<{
    content: AgentInput[];
    updates: Record<string, unknown> | undefined;
  }> {
    const contextUpdates = await this.context.contextManager.getContextUpdate();
    if (Object.keys(contextUpdates).length === 0) {
      return { content: [], updates: undefined };
    }

    const contextContent =
      this.context.contextManager.contextUpdatesToContent(contextUpdates);
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
    for (const { id, result } of toolResults) {
      this.agent.toolResult(id, result);
    }

    this.update({ type: "set-mode", mode: { type: "normal" } });

    if (pendingMessages.length > 0) {
      await this.sendMessage(pendingMessages);
      return;
    }

    const { content: contextContent, updates: contextUpdates } =
      await this.getAndPrepareContextUpdates();

    const contentToSend: AgentInput[] = [...contextContent];

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
      this.update({ type: "reset-output-tokens" }, { silent: true });
    }

    if (contextUpdates) {
      this.emit("contextUpdatesSent", contextUpdates);
    }

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
    this.context.logger.error(error);
  };

  private prepareUserContent(inputMessages?: InputMessage[]): {
    content: ProviderMessageContent[];
    hasContent: boolean;
  } {
    const messageContent: ProviderMessageContent[] = [];

    for (const m of inputMessages || []) {
      messageContent.push({
        type: "text",
        text: m.text,
      });
    }

    if (inputMessages?.length) {
      this.update({ type: "reset-output-tokens" }, { silent: true });
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

  private sendRawMessage(messages: InputMessage[]): void {
    const contentToSend: AgentInput[] = messages.map((m) => ({
      type: "text" as const,
      text: m.text,
    }));

    if (contentToSend.length === 0) return;

    this.agent.appendUserMessage(contentToSend);
    this.agent.continueConversation();
  }

  startCompaction(nextPrompt?: string, contextFiles?: string[]): void {
    const manager = new CompactionManager({
      logger: this.context.logger,
      profile: this.context.profile,
      mcpToolManager: this.context.mcpToolManager,
      threadId: this.id,
      cwd: this.context.cwd,
      homeDir: this.context.homeDir,
      lspClient: this.context.lspClient,
      diagnosticsProvider: this.context.diagnosticsProvider,
      availableCapabilities: this.context.availableCapabilities,
      contextManager: this.context.contextManager,
      shell: this.context.shell,
      threadManager: this.context.threadManager,
      maxConcurrentSubagents: this.context.maxConcurrentSubagents,
      getProvider: this.context.getProvider,
      requestRender: () => this.emit("update"),
    });
    manager.on("transition", (_prev, next) => {
      if (next.type === "complete") {
        this.handleCompactionResult(next.result, contextFiles);
      } else if (next.type === "error") {
        this.handleCompactionResult(
          { type: "error", steps: next.steps },
          contextFiles,
        );
      }
    });
    this.compactionController = manager;
    this.update({ type: "set-mode", mode: { type: "compacting" } });
    manager.start(this.getProviderMessages(), nextPrompt);
  }

  private handleCompactionResult(
    result: CompactionResult,
    contextFiles?: string[],
  ): void {
    this.compactionController = undefined;
    this.update({ type: "set-mode", mode: { type: "normal" } });

    if (result.type === "complete") {
      this.handleCompactComplete(
        result.summary,
        result.nextPrompt,
        result.steps,
        contextFiles,
      ).catch((e: Error) => {
        this.context.logger.error(
          `Failed during compact-complete: ${e.message}`,
        );
      });
    } else {
      this.update({
        type: "push-compaction-record",
        record: { steps: result.steps, finalSummary: undefined },
      });
    }
  }

  private async handleCompactComplete(
    summary: string,
    nextPrompt: string | undefined,
    steps: CompactionStep[],
    contextFiles?: string[],
  ): Promise<void> {
    this.update({
      type: "push-compaction-record",
      record: { steps, finalSummary: summary },
    });

    const newContextManager =
      await this.context.resetContextManager(contextFiles);
    this.context.contextManager = newContextManager;

    this.agent = this.createFreshAgent();

    this.update({ type: "reset-after-compaction" });

    const summaryText = `<conversation-summary>\n${summary}\n</conversation-summary>`;
    this.agent.appendUserMessage([{ type: "text", text: summaryText }]);

    if (nextPrompt) {
      await this.sendMessage([{ type: "user", text: nextPrompt }]);
    } else {
      await this.sendMessage([
        { type: "user", text: "Please continue from where you left off." },
      ]);
    }
  }

  private shouldAutoCompact(): boolean {
    const inputTokenCount = this.agent.getState().inputTokenCount;
    if (inputTokenCount === undefined) return false;
    if (this.state.threadType === "compact") return false;

    const contextWindow = getContextWindowForModel(this.context.profile.model);
    return inputTokenCount >= contextWindow * 0.8;
  }

  async setThreadTitle(userMessage: string): Promise<void> {
    const profileForRequest: ProviderProfile = {
      ...this.context.profile,
      thinking: undefined,
      reasoning: undefined,
    };

    const request = this.context.getProvider(profileForRequest).forceToolUse({
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
      this.setTitle(
        (result.toolRequest.value.input as ThreadTitle.Input).title,
      );
    }
  }
}
