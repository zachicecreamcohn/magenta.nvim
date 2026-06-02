import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type {
  ProviderToolResult,
  SubagentConfig,
  ThreadSupervisor,
} from "@magenta/core";
import {
  type ContextFiles,
  type ContextManager,
  type InputMessage,
  loadAgents,
  type MCPToolManagerImpl,
  type NativeMessageIdx,
  ThreadCore,
  type ThreadId,
  type ThreadType,
  type ToolRequestId,
} from "@magenta/core";
import player from "play-sound";
import type { Lsp } from "../capabilities/lsp.ts";
import type { SandboxViolationHandler } from "../capabilities/sandbox-violation-handler.ts";
import type { FileUpdates } from "../context/context-manager.ts";
import { createLocalEnvironment, type Environment } from "../environment.ts";
import type { Nvim } from "../nvim/nvim-node/index.ts";
import { openFileInNonMagentaWindow } from "../nvim/openFileInNonMagentaWindow.ts";
import type { MagentaOptions, Profile } from "../options.ts";
import {
  type Agent,
  type AgentStatus,
  getProvider,
  type ProviderMessage,
} from "../providers/provider.ts";
import type { SystemPrompt } from "../providers/system-prompt.ts";
import type { RootMsg } from "../root-msg.ts";
import type { Sandbox } from "../sandbox-manager.ts";
import type { Dispatch } from "../tea/tea.ts";
import { assertUnreachable } from "../utils/assertUnreachable.ts";
import type { HomeDir, NvimCwd, UnresolvedFilePath } from "../utils/files.ts";
import type { Chat } from "./chat.ts";

export type Msg =
  | { type: "set-title"; title: string }
  | {
      type: "send-message";
      messages: InputMessage[];
      async?: boolean;
      reminders?: string[];
    }
  | {
      type: "abort";
    }
  | {
      type: "start-compaction";
      nextPrompt?: string;
    }
  | {
      type: "toggle-system-prompt";
    }
  | {
      type: "toggle-tool-definitions";
    }
  | {
      type: "toggle-context-files-expanded";
    }
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
      type: "toggle-tool-input-summary";
      toolRequestId: ToolRequestId;
    }
  | {
      type: "toggle-tool-input";
      toolRequestId: ToolRequestId;
    }
  | {
      type: "toggle-tool-progress";
      toolRequestId: ToolRequestId;
    }
  | {
      type: "toggle-tool-result-summary";
      toolRequestId: ToolRequestId;
    }
  | {
      type: "toggle-tool-result";
      toolRequestId: ToolRequestId;
    }
  | {
      type: "toggle-tool-result-item";
      toolRequestId: ToolRequestId;
      itemKey: string;
    }
  | {
      type: "toggle-tool-progress-item";
      toolRequestId: ToolRequestId;
      itemKey: string;
    }
  | {
      type: "open-edit-file";
      filePath: UnresolvedFilePath;
    }
  | {
      type: "permission-pending-change";
    }
  | {
      type: "tool-progress";
    }
  | {
      type: "turn-ended";
    }
  | {
      type: "toggle-compaction-record";
      recordIdx: number;
    }
  | {
      type: "toggle-compaction-step";
      recordIdx: number;
      stepIdx: number;
    }
  | {
      type: "toggle-sandbox-bypass";
    }
  | {
      type: "fork-message";
      nativeMessageIdx: NativeMessageIdx;
      prepopulate?: string[];
    };

export type ThreadMsg = {
  type: "thread-msg";
  id: ThreadId;
  msg: Msg;
};

/** View state for a single message, stored separately from provider thread content */
export type MessageViewState = {
  contextUpdates?: FileUpdates;
  forkedFrom?: ThreadId;
  expandedUpdates?: { [absFilePath: string]: boolean };
  expandedContent?: { [contentIdx: number]: boolean };
};

/** View state for tools, keyed by tool request ID */
export type ToolViewState = {
  inputSummaryExpanded: boolean;
  inputExpanded: boolean;
  progressExpanded: boolean;
  resultSummaryExpanded: boolean;
  resultExpanded: boolean;
  resultItemExpanded?: { [key: string]: boolean };
  progressItemExpanded?: { [key: string]: boolean };
};

export class Thread {
  public state: {
    showSystemPrompt: boolean;
    showToolDefinitions: boolean;
    contextFilesExpanded: boolean;
    messageViewState: { [messageIdx: number]: MessageViewState };
    toolViewState: { [toolRequestId: ToolRequestId]: ToolViewState };
    compactionViewState: {
      [recordIdx: number]: {
        expanded: boolean;
        expandedSteps: { [stepIdx: number]: boolean };
      };
    };
    toolResultMap: Map<ToolRequestId, ProviderToolResult>;
    forkedTo: { childThreadId: ThreadId; atMessageIdx: NativeMessageIdx }[];
  };

  public core: ThreadCore;
  private myDispatch: Dispatch<Msg>;
  private lastAppliedTitle: string | undefined;
  public sandboxViolationHandler: SandboxViolationHandler | undefined;
  public sandboxBypassed = false;

  get contextManager(): ContextManager {
    return this.core.contextManager;
  }

  get agent(): Agent {
    return this.core.agent;
  }

  get supervisor(): ThreadSupervisor | undefined {
    return this.core.supervisor;
  }

  set supervisor(value: ThreadSupervisor | undefined) {
    this.core.supervisor = value;
  }

  get isSandboxBypassed(): boolean {
    const parent = this.context.getParentThread?.();
    if (parent) return parent.isSandboxBypassed;
    return this.sandboxBypassed;
  }

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
      options: MagentaOptions;
      getDisplayWidth: () => number;
      getParentThread?: () => Thread | undefined;
      environment: Environment;
      initialFiles?: ContextFiles;
      subagentConfig?: SubagentConfig;
    },
    clonedAgent?: Agent,
    preBuiltCore?: ThreadCore,
  ) {
    this.myDispatch = (msg) =>
      this.context.dispatch({
        type: "thread-msg",
        id: this.id,
        msg,
      });

    const env = this.context.environment;
    this.sandboxViolationHandler = env.sandboxViolationHandler;

    this.state = {
      showSystemPrompt: false,
      showToolDefinitions: false,
      contextFilesExpanded: false,
      messageViewState: {},
      toolViewState: {},
      compactionViewState: {},
      toolResultMap: new Map(),
      forkedTo: [],
    };

    const isDocker = env.environmentConfig.type === "docker";

    if (preBuiltCore) {
      this.core = preBuiltCore;
    } else {
      this.core = new ThreadCore(
        id,
        {
          logger: context.nvim.logger,
          profile: context.profile,
          cwd: isDocker ? env.cwd : context.cwd,
          homeDir: isDocker ? env.homeDir : context.homeDir,
          threadType,
          ...(context.subagentConfig
            ? { subagentConfig: context.subagentConfig }
            : {}),
          systemPrompt,
          mcpToolManager: context.mcpToolManager,
          threadManager: context.chat,
          fileIO: env.fileIO,
          shell: env.shell,
          lspClient: env.lspClient,
          helpTagsProvider: env.helpTagsProvider,
          availableCapabilities: env.availableCapabilities,
          environmentConfig: env.environmentConfig,
          maxConcurrentSubagents: context.options.maxConcurrentSubagents || 3,
          getAgents: () =>
            loadAgents({
              cwd: isDocker ? env.cwd : context.cwd,
              logger: context.nvim.logger,
              options: context.options,
            }),
          getProvider: (profile) => getProvider(context.nvim, profile),
          ...(context.initialFiles
            ? { initialFiles: context.initialFiles }
            : {}),
        },
        clonedAgent,
      );
    }

    const coreListeners = {
      update: () => {
        this.rebuildToolResultMap();
        const title = this.core.state.title;
        if (title !== undefined && title !== this.lastAppliedTitle) {
          this.lastAppliedTitle = title;
          this.context.dispatch({
            type: "set-thread-title-effect",
            id: this.core.id,
            title,
          });
        }
        this.myDispatch({ type: "tool-progress" });
      },
      pendingUpdatesChanged: () => this.myDispatch({ type: "tool-progress" }),
      turnEnded: (payload: { reason: "end_turn" | "aborted" | "error" }) => {
        this.myDispatch({ type: "turn-ended" });
        if (payload.reason === "end_turn" || payload.reason === "error") {
          this.playChimeSound();
          this.sendTerminalBell();
        }
      },
      setupResubmit: (threadId: ThreadId, lastUserMessage: string) =>
        this.context.dispatch({
          type: "sidebar-msg",
          msg: { type: "setup-resubmit", threadId, lastUserMessage },
        }),
      scrollToLastMessage: () =>
        this.context.dispatch({
          type: "sidebar-msg",
          msg: { type: "scroll-to-last-user-message" },
        }),
      aborting: () => {
        this.sandboxViolationHandler?.rejectAll();
      },
      contextUpdatesSent: (updates: Record<string, unknown>) => {
        const messageCount = this.core.getProviderMessages().length;
        this.state.messageViewState[messageCount] = {
          contextUpdates: updates as FileUpdates,
        };
      },
    };
    this.coreListeners = coreListeners;
    this.core.on("update", coreListeners.update);
    this.core.on("pendingUpdatesChanged", coreListeners.pendingUpdatesChanged);
    this.core.on("turnEnded", coreListeners.turnEnded);
    this.core.on("setupResubmit", coreListeners.setupResubmit);
    this.core.on("scrollToLastMessage", coreListeners.scrollToLastMessage);
    this.core.on("aborting", coreListeners.aborting);
    this.core.on("contextUpdatesSent", coreListeners.contextUpdatesSent);

    this.rebuildToolResultMap();
  }

  /** Walks the agent's provider messages and rebuilds the tool result map.
   * Preserves any pre-existing structuredResult for surviving tool result IDs,
   * since the provider strips structuredResult when serializing to native form
   * but the rich view rendering relies on it. */
  rebuildToolResultMap(): void {
    const next = new Map<ToolRequestId, ProviderToolResult>();
    const prev = this.state.toolResultMap;
    for (const message of this.core.getProviderMessages()) {
      if (message.role !== "user") continue;
      for (const content of message.content) {
        if (content.type === "tool_result") {
          const cached = prev.get(content.id);
          if (
            cached?.result.status === "ok" &&
            content.result.status === "ok"
          ) {
            next.set(content.id, {
              ...content,
              result: {
                ...content.result,
                structuredResult: cached.result.structuredResult,
              },
            });
          } else {
            next.set(content.id, content);
          }
        }
      }
    }
    // Include results from active tool entries whose results haven't yet been
    // submitted back to the agent (e.g. mid tool_use turn while other tools
    // are still running). The rendering layer needs these to display custom
    // result summaries as soon as the tool completes.
    const mode = this.core.state.mode;
    if (mode.type === "tool_use") {
      for (const entry of mode.activeTools.values()) {
        if (entry.result && !next.has(entry.request.id)) {
          next.set(entry.request.id, entry.result);
        }
      }
    }
    this.state.toolResultMap = next;
  }

  /** Build an independent fork of `sourceThread` frozen at `nativeMessageIdx`.
   * The cloned agent is created exactly once (by ThreadCore.clone). The source
   * is not aborted, no auto-context is re-resolved, and no system prompt is
   * regenerated. The result is a new Thread with its own environment and
   * Layer 3 view state, ready to continue from the snapshot. */
  static async cloneFromNativeMessageIdx(args: {
    sourceThread: Thread;
    newThreadId: ThreadId;
    nativeMessageIdx: NativeMessageIdx;
    chat: Chat;
    mcpToolManager: MCPToolManagerImpl;
    dispatch: Dispatch<RootMsg>;
    nvim: Nvim;
    cwd: NvimCwd;
    homeDir: HomeDir;
    lsp: Lsp;
    sandbox: Sandbox;
    getOptions: () => MagentaOptions;
    getDisplayWidth: () => number;
  }): Promise<Thread> {
    const {
      sourceThread,
      newThreadId,
      nativeMessageIdx,
      chat,
      mcpToolManager,
      dispatch,
      nvim,
      cwd,
      homeDir,
      lsp,
      sandbox,
      getOptions,
      getDisplayWidth,
    } = args;

    const sourceEnvConfig = sourceThread.context.environment.environmentConfig;
    if (sourceEnvConfig.type !== "local") {
      throw new Error(
        `Thread.cloneFromNativeMessageIdx only supports local-source forks for MVP (got ${sourceEnvConfig.type}). Docker-source forks are a follow-up.`,
      );
    }

    const bypassRef = { get: () => false as boolean };

    const environment = createLocalEnvironment({
      nvim,
      lsp,
      cwd,
      homeDir,
      getOptions,
      threadId: newThreadId,
      sandbox,
      onPendingChange: () =>
        dispatch({
          type: "thread-msg",
          id: newThreadId,
          msg: { type: "permission-pending-change" },
        }),
      isBypassed: () => bypassRef.get(),
    });

    const sourceCore = sourceThread.core;
    const profile = sourceThread.context.profile;
    const sourceCoreState = sourceCore.state;

    const core = await ThreadCore.clone({
      sourceCore,
      newId: newThreadId,
      nativeMessageIdx,
      context: {
        logger: nvim.logger,
        profile,
        cwd: environment.cwd,
        homeDir: environment.homeDir,
        threadType: sourceCoreState.threadType,
        ...(sourceThread.context.subagentConfig
          ? { subagentConfig: sourceThread.context.subagentConfig }
          : {}),
        systemPrompt: sourceCoreState.systemPrompt,
        mcpToolManager,
        threadManager: chat,
        fileIO: environment.fileIO,
        shell: environment.shell,
        lspClient: environment.lspClient,
        helpTagsProvider: environment.helpTagsProvider,
        availableCapabilities: environment.availableCapabilities,
        environmentConfig: environment.environmentConfig,
        maxConcurrentSubagents: getOptions().maxConcurrentSubagents || 3,
        getAgents: () =>
          loadAgents({
            cwd: environment.cwd,
            logger: nvim.logger,
            options: getOptions(),
          }),
        getProvider: (p) => getProvider(nvim, p),
      },
    });

    const thread = new Thread(
      newThreadId,
      sourceCoreState.threadType,
      sourceCoreState.systemPrompt,
      {
        dispatch,
        chat,
        mcpToolManager,
        profile,
        nvim,
        cwd,
        homeDir,
        options: getOptions(),
        getDisplayWidth,
        environment,
        ...(sourceThread.context.subagentConfig
          ? { subagentConfig: sourceThread.context.subagentConfig }
          : {}),
      },
      undefined,
      core,
    );

    thread.sandboxBypassed = sourceThread.isSandboxBypassed;
    bypassRef.get = () => thread.isSandboxBypassed;

    const survivingToolResults = sourceThread.state.toolResultMap;
    const newMap = new Map<ToolRequestId, ProviderToolResult>();
    for (const message of core.getProviderMessages()) {
      if (message.role !== "user") continue;
      for (const content of message.content) {
        if (content.type === "tool_result") {
          const cached = survivingToolResults.get(content.id);
          if (
            cached?.result.status === "ok" &&
            content.result.status === "ok"
          ) {
            newMap.set(content.id, {
              ...content,
              result: {
                ...content.result,
                structuredResult: cached.result.structuredResult,
              },
            });
          } else {
            newMap.set(content.id, content);
          }
        }
      }
    }
    thread.state.toolResultMap = newMap;

    for (const [idxStr, viewState] of Object.entries(
      sourceThread.state.messageViewState,
    )) {
      const idx = Number(idxStr);
      if (idx <= nativeMessageIdx) {
        thread.state.messageViewState[idx] = {
          ...(viewState.contextUpdates
            ? { contextUpdates: { ...viewState.contextUpdates } }
            : {}),
          ...(viewState.expandedUpdates
            ? { expandedUpdates: { ...viewState.expandedUpdates } }
            : {}),
          ...(viewState.expandedContent
            ? { expandedContent: { ...viewState.expandedContent } }
            : {}),
        };
      }
    }

    return thread;
  }

  private coreListeners:
    | {
        update: () => void;
        pendingUpdatesChanged: () => void;
        turnEnded: (payload: {
          reason: "end_turn" | "aborted" | "error";
        }) => void;
        setupResubmit: (threadId: ThreadId, lastUserMessage: string) => void;
        scrollToLastMessage: () => void;
        aborting: () => void;
        contextUpdatesSent: (updates: Record<string, unknown>) => void;
      }
    | undefined;

  private destroyed = false;

  async destroy(): Promise<void> {
    if (this.destroyed) return;
    this.destroyed = true;

    if (this.coreListeners) {
      this.core.off("update", this.coreListeners.update);
      this.core.off(
        "pendingUpdatesChanged",
        this.coreListeners.pendingUpdatesChanged,
      );
      this.core.off("turnEnded", this.coreListeners.turnEnded);
      this.core.off("setupResubmit", this.coreListeners.setupResubmit);
      this.core.off(
        "scrollToLastMessage",
        this.coreListeners.scrollToLastMessage,
      );
      this.core.off("aborting", this.coreListeners.aborting);
      this.core.off(
        "contextUpdatesSent",
        this.coreListeners.contextUpdatesSent,
      );
      this.coreListeners = undefined;
    }

    await this.core.destroy();
  }

  getProviderStatus(): AgentStatus {
    return this.core.getProviderStatus();
  }

  getProviderMessages(): ReadonlyArray<ProviderMessage> {
    return this.core.getProviderMessages();
  }

  getMessages(): ProviderMessage[] {
    return this.core.getMessages();
  }

  getLastStopTokenCount(): number {
    return this.core.getLastStopTokenCount();
  }

  update(msg: RootMsg): void {
    if (msg.type === "thread-msg" && msg.id === this.id) {
      this.myUpdate(msg.msg);
    }
  }

  private myUpdate(msg: Msg): void {
    switch (msg.type) {
      case "send-message":
        if (msg.reminders) {
          for (const text of msg.reminders) {
            this.core.update({ type: "activate-reminder", text });
          }
        }
        this.core
          .handleSendMessageRequest(msg.messages, msg.async)
          .catch((e: Error) => this.context.nvim.logger.error(e));
        return;

      case "start-compaction":
        this.core.startCompaction(msg.nextPrompt);
        return;

      case "abort": {
        if (this.core.state.mode.type === "tool_use") {
          for (const [, entry] of this.core.state.mode.activeTools) {
            entry.handle.abort();
          }
        }
        this.abortAndWait().catch((e: Error) => {
          this.context.nvim.logger.error(`Error during abort: ${e.message}`);
        });
        return;
      }

      case "set-title":
        this.core.setTitle(msg.title);
        return;

      case "toggle-system-prompt":
        this.state.showSystemPrompt = !this.state.showSystemPrompt;
        return;

      case "toggle-tool-definitions":
        this.state.showToolDefinitions = !this.state.showToolDefinitions;
        return;

      case "toggle-context-files-expanded":
        this.state.contextFilesExpanded = !this.state.contextFilesExpanded;
        return;

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

      case "toggle-tool-input-summary":
      case "toggle-tool-input":
      case "toggle-tool-progress":
      case "toggle-tool-result-summary":
      case "toggle-tool-result": {
        const field = {
          "toggle-tool-input-summary": "inputSummaryExpanded",
          "toggle-tool-input": "inputExpanded",
          "toggle-tool-progress": "progressExpanded",
          "toggle-tool-result-summary": "resultSummaryExpanded",
          "toggle-tool-result": "resultExpanded",
        } as const;
        const toolState = this.state.toolViewState[msg.toolRequestId] || {
          inputSummaryExpanded: false,
          inputExpanded: false,
          progressExpanded: false,
          resultSummaryExpanded: false,
          resultExpanded: false,
        };
        const key = field[msg.type];
        toolState[key] = !toolState[key];
        this.state.toolViewState[msg.toolRequestId] = toolState;
        return;
      }

      case "toggle-tool-progress-item": {
        const toolState = this.state.toolViewState[msg.toolRequestId] || {
          inputSummaryExpanded: false,
          inputExpanded: false,
          progressExpanded: false,
          resultSummaryExpanded: false,
          resultExpanded: false,
        };
        const itemExpanded = toolState.progressItemExpanded || {};
        itemExpanded[msg.itemKey] = !itemExpanded[msg.itemKey];
        toolState.progressItemExpanded = itemExpanded;
        this.state.toolViewState[msg.toolRequestId] = toolState;
        return;
      }

      case "toggle-tool-result-item": {
        const toolState = this.state.toolViewState[msg.toolRequestId] || {
          inputSummaryExpanded: false,
          inputExpanded: false,
          progressExpanded: false,
          resultSummaryExpanded: false,
          resultExpanded: false,
        };
        const itemExpanded = toolState.resultItemExpanded || {};
        itemExpanded[msg.itemKey] = !itemExpanded[msg.itemKey];
        toolState.resultItemExpanded = itemExpanded;
        this.state.toolViewState[msg.toolRequestId] = toolState;
        return;
      }

      case "open-edit-file":
        openFileInNonMagentaWindow(msg.filePath, this.context).catch(
          (e: Error) => this.context.nvim.logger.error(e.message),
        );
        return;

      case "permission-pending-change":
        this.playChimeSound();
        this.sendTerminalBell();
        return;

      case "tool-progress":
        return;

      case "turn-ended":
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

      case "toggle-sandbox-bypass": {
        let root: Thread = this;
        let parentThread = root.context.getParentThread?.();
        while (parentThread) {
          root = parentThread;
          parentThread = root.context.getParentThread?.();
        }
        root.sandboxBypassed = !root.sandboxBypassed;
        return;
      }

      case "fork-message":
        // Handled at the Magenta dispatch level; ignored here.
        return;

      default:
        assertUnreachable(msg);
    }
  }

  async abortAndWait(): Promise<void> {
    await this.core.abort();
  }

  private sendTerminalBell(): void {
    if (this.context.options.bellOnNotify === false) {
      return;
    }
    this.context.nvim.call("nvim_chan_send", [2, "\x07"]).catch((err) => {
      this.context.nvim.logger.error(
        `Failed to send terminal bell: ${err instanceof Error ? err.message : String(err)}`,
      );
    });
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

      const playOptions = {
        afplay: ["-v", actualVolume.toString()],
        aplay: ["-v", `${Math.round(actualVolume * 100).toString()}%`],
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
}
