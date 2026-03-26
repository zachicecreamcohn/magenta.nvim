import { describe, expect, it, vi } from "vitest";
import type { ThreadId, ThreadType } from "./chat-types.ts";
import { Emitter } from "./emitter.ts";
import type { Logger } from "./logger.ts";
import type { ProviderProfile } from "./provider-options.ts";
import type {
  Agent,
  AgentEvents,
  AgentInput,
  AgentOptions,
  AgentState,
  AgentStreamingBlock,
  NativeMessageIdx,
  Provider,
  ProviderMessage,
  ProviderToolResult,
  ProviderToolUseContent,
  StopReason,
  Usage,
} from "./providers/provider-types.ts";
import type { SystemPrompt } from "./providers/system-prompt.ts";
import { ThreadCore, type ThreadCoreContext } from "./thread-core.ts";
import type { ToolName, ToolRequestId } from "./tool-types.ts";
import type { MCPToolManager } from "./tools/mcp/manager.ts";

class MockAgent extends Emitter<AgentEvents> implements Agent {
  state: AgentState = {
    status: { type: "stopped", stopReason: "end_turn" },
    messages: [],
  };

  toolResults: Array<{
    id: ToolRequestId;
    result: ProviderToolResult;
  }> = [];
  appendedMessages: AgentInput[][] = [];
  continueCount = 0;

  getState(): AgentState {
    return this.state;
  }

  getStreamingBlock(): AgentStreamingBlock | undefined {
    return this.state.streamingBlock;
  }

  getNativeMessageIdx(): NativeMessageIdx {
    return (this.state.messages.length - 1) as NativeMessageIdx;
  }

  appendUserMessage(content: AgentInput[]): void {
    this.appendedMessages.push(content);
    const userMsg: ProviderMessage = {
      role: "user",
      content: content.map((c) => {
        if (c.type === "text") return { type: "text" as const, text: c.text };
        return c;
      }),
    };
    this.state = {
      ...this.state,
      messages: [...this.state.messages, userMsg],
    };
  }

  toolResult(id: ToolRequestId, result: ProviderToolResult): void {
    this.toolResults.push({ id, result });
    const lastMsg = this.state.messages[this.state.messages.length - 1];
    if (lastMsg?.role === "user") {
      lastMsg.content.push(result);
    } else {
      const userMsg: ProviderMessage = {
        role: "user",
        content: [result],
      };
      this.state = {
        ...this.state,
        messages: [...this.state.messages, userMsg],
      };
    }
  }

  continueConversation(): void {
    this.continueCount++;
    this.state = {
      ...this.state,
      status: { type: "streaming", startTime: new Date() },
    };
  }

  async abort(): Promise<void> {
    this.state = {
      ...this.state,
      status: { type: "stopped", stopReason: "aborted" },
    };
  }

  abortToolUse(): void {
    this.state = {
      ...this.state,
      status: { type: "stopped", stopReason: "aborted" },
    };
  }

  truncateMessages(messageIdx: NativeMessageIdx): void {
    this.state = {
      ...this.state,
      messages: this.state.messages.slice(0, messageIdx + 1),
      status: { type: "stopped", stopReason: "end_turn" },
    };
  }

  clone(): Agent {
    const cloned = new MockAgent();
    cloned.state = {
      ...this.state,
      messages: [...this.state.messages],
      status: { type: "stopped", stopReason: "end_turn" },
    };
    return cloned;
  }

  /** Helper: set messages and stop with a given reason */
  simulateResponse(
    messages: ProviderMessage[],
    stopReason: StopReason,
    usage?: Usage,
  ): void {
    this.state = {
      ...this.state,
      messages,
      status: { type: "stopped", stopReason },
    };
    this.emit("stopped", stopReason, usage);
  }
}

function createMockProvider(mockAgent: MockAgent): Provider {
  return {
    createAgent(_options: AgentOptions): Agent {
      return mockAgent;
    },
    forceToolUse() {
      throw new Error("Not implemented in mock");
    },
  };
}

const noopLogger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  trace: () => {},
} as Logger;

function createThreadCore(mockAgent: MockAgent): ThreadCore {
  const provider = createMockProvider(mockAgent);
  const context: ThreadCoreContext = {
    logger: noopLogger,
    profile: {
      provider: "mock",
      model: "claude-3-5-sonnet-20241022",
    } as ProviderProfile,
    cwd: "/tmp" as ThreadCoreContext["cwd"],
    homeDir: "/home" as ThreadCoreContext["homeDir"],
    threadType: "root" as ThreadType,
    systemPrompt: "test system prompt" as unknown as SystemPrompt,
    mcpToolManager: {
      serverMap: {},
      getToolSpecs: () => [],
    } as unknown as MCPToolManager,
    threadManager: {
      getThread: () => undefined,
      getThreads: () => [],
    } as unknown as ThreadCoreContext["threadManager"],
    fileIO: {
      readFile: async () => "",
      writeFile: async () => {},
      fileExists: async () => false,
    } as unknown as ThreadCoreContext["fileIO"],
    shell: {
      exec: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
    } as unknown as ThreadCoreContext["shell"],
    lspClient: {} as unknown as ThreadCoreContext["lspClient"],
    diagnosticsProvider: {
      getDiagnostics: async () => [],
    } as unknown as ThreadCoreContext["diagnosticsProvider"],
    availableCapabilities: new Set(),
    environmentConfig: { type: "local" },
    maxConcurrentSubagents: 1,
    getProvider: () => provider,
  };

  return new ThreadCore("test-thread" as ThreadId, context);
}

describe("ThreadCore.handleProviderStopped", () => {
  it("max_tokens with tool_use blocks sends error tool_result and auto-continues", async () => {
    const mockAgent = new MockAgent();
    const _core = createThreadCore(mockAgent);

    const toolUseId = "tool-1" as ToolRequestId;
    const malformedToolUse: ProviderToolUseContent = {
      type: "tool_use",
      id: toolUseId,
      name: "get_file" as ToolName,
      request: {
        status: "error",
        error: "Malformed tool_use block: incomplete JSON",
        rawRequest: { filePath: undefined },
      },
    };

    mockAgent.simulateResponse(
      [
        {
          role: "user",
          content: [{ type: "text", text: "hello" }],
        },
        {
          role: "assistant",
          content: [
            { type: "text", text: "Let me get that file" },
            malformedToolUse,
          ],
          stopReason: "max_tokens",
        },
      ],
      "max_tokens",
    );

    // The malformed tool_use should get an error tool_result
    await vi.waitFor(() => {
      expect(mockAgent.toolResults.length).toBeGreaterThanOrEqual(1);
    });

    const errorResult = mockAgent.toolResults.find((r) => r.id === toolUseId);
    expect(errorResult).toBeDefined();
    expect(errorResult!.result.result.status).toBe("error");

    // Should have called continueConversation to auto-respond
    await vi.waitFor(() => {
      expect(mockAgent.continueCount).toBeGreaterThanOrEqual(1);
    });
  });

  it("max_tokens with text-only content sends continuation prompt", async () => {
    const mockAgent = new MockAgent();
    const _core = createThreadCore(mockAgent);

    mockAgent.simulateResponse(
      [
        {
          role: "user",
          content: [{ type: "text", text: "hello" }],
        },
        {
          role: "assistant",
          content: [{ type: "text", text: "Here is a long response that got" }],
          stopReason: "max_tokens",
        },
      ],
      "max_tokens",
    );

    // Should send a continuation system message and auto-continue
    await vi.waitFor(() => {
      expect(mockAgent.appendedMessages.length).toBeGreaterThanOrEqual(1);
    });

    const lastAppended =
      mockAgent.appendedMessages[mockAgent.appendedMessages.length - 1];
    expect(lastAppended.some((c) => c.type === "text")).toBe(true);
    const textContent = lastAppended.find((c) => c.type === "text");
    expect(
      textContent?.type === "text" && textContent.text.includes("truncated"),
    ).toBe(true);

    // Should have continued the conversation
    await vi.waitFor(() => {
      expect(mockAgent.continueCount).toBeGreaterThanOrEqual(1);
    });
  });
});
