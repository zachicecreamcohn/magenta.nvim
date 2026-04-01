import type Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it } from "vitest";
import type { ThreadId, ThreadType } from "./chat-types.ts";
import type { Logger } from "./logger.ts";
import type { ProviderProfile } from "./provider-options.ts";
import {
  AnthropicAgent,
  type AnthropicAgentOptions,
} from "./providers/anthropic-agent.ts";
import { MockAnthropicClient } from "./providers/mock-anthropic-client.ts";
import type {
  Agent,
  AgentOptions,
  Provider,
} from "./providers/provider-types.ts";
import type { SystemPrompt } from "./providers/system-prompt.ts";
import { ThreadCore, type ThreadCoreContext } from "./thread-core.ts";
import type { ToolName, ToolRequestId } from "./tool-types.ts";
import { validateInput } from "./tools/helpers.ts";
import type { MCPToolManager } from "./tools/mcp/manager.ts";
import { pollUntil } from "./utils/async.ts";

const noopLogger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  trace: () => {},
} as Logger;

const defaultAnthropicOptions: AnthropicAgentOptions = {
  authType: "max",
  includeWebSearch: false,
  disableParallelToolUseFlag: true,
  logger: noopLogger,
  validateInput,
};

function createMockProvider(mockClient: MockAnthropicClient): Provider {
  return {
    createAgent(options: AgentOptions): Agent {
      return new AnthropicAgent(
        options,
        mockClient as unknown as Anthropic,
        defaultAnthropicOptions,
      );
    },
    forceToolUse() {
      throw new Error("Not implemented in mock");
    },
  };
}

function createThreadCoreWithMock(overrides?: Partial<ThreadCoreContext>): {
  core: ThreadCore;
  mockClient: MockAnthropicClient;
} {
  const mockClient = new MockAnthropicClient();
  const provider = createMockProvider(mockClient);
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
    getAgents: () => ({}),
    getProvider: () => provider,
    ...overrides,
  };

  return {
    core: new ThreadCore("test-thread" as ThreadId, context),
    mockClient,
  };
}

describe("ThreadCore.handleProviderStopped", () => {
  it("max_tokens with completed tool_use block routes through handleProviderStoppedWithToolUse", async () => {
    const { core, mockClient } = createThreadCoreWithMock({
      threadType: "subagent" as ThreadType,
    });

    core.sendMessage([{ type: "user", text: "do the task" }]);
    const stream = await mockClient.awaitStream();

    const toolUseId = "tool-yield-1" as ToolRequestId;

    // Stream a yield_to_parent tool_use, then stop with max_tokens
    stream.streamToolUse(toolUseId, "yield_to_parent" as ToolName, {
      result: "Here is the result of my work",
    });
    stream.finishResponse("max_tokens");

    // ThreadCore should route to handleProviderStoppedWithToolUse,
    // which executes the yield tool, and maybeAutoRespond transitions to yielded mode
    await pollUntil(() => {
      if (core.state.mode.type === "yielded") return true;
      throw new Error(
        `waiting for yielded mode, currently: ${core.state.mode.type}`,
      );
    });

    expect(core.state.mode.type).toBe("yielded");
    if (core.state.mode.type === "yielded") {
      expect(core.state.mode.response).toBe("Here is the result of my work");
    }
  });

  it("max_tokens with truncated (incomplete) tool_use block sends error tool_result and auto-continues", async () => {
    const { core, mockClient } = createThreadCoreWithMock();

    core.sendMessage([{ type: "user", text: "hello" }]);
    const stream = await mockClient.awaitStream();

    const toolUseId = "tool-1" as ToolRequestId;

    // Stream a tool_use block with incomplete JSON input.
    // The real API always sends content_block_stop even at max_tokens.
    // partialParse will produce {} for the truncated JSON, which fails validation.
    const blockIndex = stream.nextBlockIndex();
    stream.emitEvent({
      type: "content_block_start",
      index: blockIndex,
      content_block: {
        type: "tool_use",
        id: toolUseId,
        name: "get_file" as ToolName,
        input: {},
      },
    });
    stream.emitEvent({
      type: "content_block_delta",
      index: blockIndex,
      delta: { type: "input_json_delta", partial_json: '{"filePath":' },
    });
    stream.emitEvent({ type: "content_block_stop", index: blockIndex });
    stream.finishResponse("max_tokens");

    // The truncated tool_use should be visible and get an error tool_result,
    // then the agent should auto-continue
    // Wait for at least one more stream to appear
    await pollUntil(() => {
      if (mockClient.streams.length > 1) return true;
      throw new Error("waiting for next stream");
    });

    // The second stream should contain the tool_result in its messages.
    // It may not be in the very last user message (system reminders follow),
    // so search backwards for a user message containing tool_result.
    const secondStream = mockClient.streams[1];
    let toolResult: Anthropic.Messages.ToolResultBlockParam | undefined;
    for (let i = secondStream.messages.length - 1; i >= 0; i--) {
      const msg = secondStream.messages[i];
      if (msg.role !== "user" || typeof msg.content === "string") continue;
      toolResult = (
        msg.content as Anthropic.Messages.ToolResultBlockParam[]
      ).find(
        (b): b is Anthropic.Messages.ToolResultBlockParam =>
          b.type === "tool_result" && b.tool_use_id === toolUseId,
      );
      if (toolResult) break;
    }
    expect(
      toolResult,
      `Expected tool_result in stream messages: ${JSON.stringify(
        secondStream.messages.map((m) => ({
          role: m.role,
          content: m.content,
        })),
        null,
        2,
      )}`,
    ).toBeDefined();
    expect(toolResult!.is_error).toBe(true);
  });

  it("max_tokens with text-only content sends continuation prompt", async () => {
    const { core, mockClient } = createThreadCoreWithMock();

    core.sendMessage([{ type: "user", text: "hello" }]);
    const stream = await mockClient.awaitStream();

    // Stream only text, then stop with max_tokens
    stream.streamText("Here is a long response that got");
    stream.finishResponse("max_tokens");

    // ThreadCore should send a continuation system message and auto-continue
    const nextStream = await pollUntil(() => {
      const s = mockClient.streams[mockClient.streams.length - 1];
      if (s && s !== stream) return s;
      throw new Error("waiting for next stream");
    });

    // The next stream should contain the continuation prompt
    const lastUserMsg = nextStream.messages[nextStream.messages.length - 1];
    expect(lastUserMsg.role).toBe("user");
    const textBlocks = (
      lastUserMsg.content as Anthropic.Messages.ContentBlockParam[]
    ).filter((b): b is Anthropic.Messages.TextBlockParam => b.type === "text");
    expect(textBlocks.some((b) => b.text.includes("truncated"))).toBe(true);
  });
});
