import { describe, it, expect } from "vitest";
import Anthropic from "@anthropic-ai/sdk";
import {
  AnthropicProviderThread,
  type AnthropicThreadOptions,
} from "./anthropic-thread.ts";
import type {
  ProviderThreadAction,
  ProviderThreadInput,
  ProviderToolResult,
  ProviderToolSpec,
} from "./provider-types.ts";
import type { ToolRequestId } from "../tools/toolManager.ts";
import { MockAnthropicClient } from "./mock-anthropic-client.ts";
import type { ToolName } from "../tools/types.ts";
import { delay } from "../utils/async.ts";

const defaultOptions = {
  model: "claude-sonnet-4-20250514",
  systemPrompt: "You are a helpful assistant.",
  tools: [] as ProviderToolSpec[],
};

const defaultAnthropicOptions: AnthropicThreadOptions = {
  authType: "max",
  includeWebSearch: true,
  disableParallelToolUseFlag: true,
};

describe("appendUserMessage", () => {
  it("does not add assistant message until first content block completes", async () => {
    const mockClient = new MockAnthropicClient();
    const thread = new AnthropicProviderThread(
      defaultOptions,
      () => {},
      mockClient as unknown as Anthropic,
      defaultAnthropicOptions,
    );

    thread.appendUserMessage([{ type: "text", text: "Hello" }], true);

    const stream = await mockClient.awaitStream();

    // Before any content blocks, should only have user message
    expect(thread.getState().messages).toHaveLength(1);
    expect(thread.getState().messages[0].role).toBe("user");

    // Start a text block
    const blockIndex = stream.nextBlockIndex();
    stream.emitEvent({
      type: "content_block_start",
      index: blockIndex,
      content_block: { type: "text", text: "", citations: null },
    });

    // Still only user message - assistant message not added yet
    expect(thread.getState().messages).toHaveLength(1);

    // Add some text delta
    stream.emitEvent({
      type: "content_block_delta",
      index: blockIndex,
      delta: { type: "text_delta", text: "Hello world" },
    });

    // Still only user message
    expect(thread.getState().messages).toHaveLength(1);

    // Complete the block
    stream.emitEvent({
      type: "content_block_stop",
      index: blockIndex,
    });

    // Now assistant message should be added
    expect(thread.getState().messages).toHaveLength(2);
    expect(thread.getState().messages[1].role).toBe("assistant");
    expect(thread.getState().messages[1].content).toHaveLength(1);

    stream.finishResponse("end_turn");
    await stream.finalMessage();
  });

  it("appends text message without dispatching", () => {
    const mockClient = {} as Anthropic;
    const actions: ProviderThreadAction[] = [];
    const thread = new AnthropicProviderThread(
      defaultOptions,
      (action) => actions.push(action),
      mockClient,
      defaultAnthropicOptions,
    );

    const content: ProviderThreadInput[] = [
      { type: "text", text: "Hello, world!" },
    ];
    thread.appendUserMessage(content, false);

    const state = thread.getState();
    expect(state.messages).toHaveLength(1);
    expect(state.messages[0].role).toBe("user");
    expect(state.messages[0].content).toHaveLength(1);
    expect(state.messages[0].content[0]).toEqual({
      type: "text",
      text: "Hello, world!",
    });

    // No dispatch when respond=false
    expect(actions).toHaveLength(0);
  });

  it("appends image message correctly", () => {
    const mockClient = {} as Anthropic;
    const thread = new AnthropicProviderThread(
      defaultOptions,
      () => {},
      mockClient,
      defaultAnthropicOptions,
    );

    const content: ProviderThreadInput[] = [
      {
        type: "image",
        source: {
          type: "base64",
          media_type: "image/png",
          data: "base64data",
        },
      },
    ];
    thread.appendUserMessage(content, false);

    const state = thread.getState();
    expect(state.messages[0].content[0]).toEqual({
      type: "image",
      source: {
        type: "base64",
        media_type: "image/png",
        data: "base64data",
      },
    });
  });

  it("appends document message correctly", () => {
    const mockClient = {} as Anthropic;
    const thread = new AnthropicProviderThread(
      defaultOptions,
      () => {},
      mockClient,
      defaultAnthropicOptions,
    );

    const content: ProviderThreadInput[] = [
      {
        type: "document",
        source: {
          type: "base64",
          media_type: "application/pdf",
          data: "pdfdata",
        },
        title: "My Document",
      },
    ];
    thread.appendUserMessage(content, false);

    const state = thread.getState();
    expect(state.messages[0].content[0]).toEqual({
      type: "document",
      source: {
        type: "base64",
        media_type: "application/pdf",
        data: "pdfdata",
      },
      title: "My Document",
    });
  });
});

describe("toolResult", () => {
  it("throws when not in stopped state with tool_use reason", () => {
    const mockClient = {} as Anthropic;
    const thread = new AnthropicProviderThread(
      defaultOptions,
      () => {},
      mockClient,
      defaultAnthropicOptions,
    );

    const toolUseId = "tool-123" as ToolRequestId;
    const result: ProviderToolResult = {
      type: "tool_result",
      id: toolUseId,
      result: {
        status: "ok",
        value: [{ type: "text", text: "Tool output" }],
      },
    };

    expect(() => thread.toolResult(toolUseId, result, false)).toThrow(
      "Cannot provide tool result: expected status stopped with stopReason tool_use",
    );
  });

  it("appends tool result when in correct state", async () => {
    const mockClient = new MockAnthropicClient();
    const thread = new AnthropicProviderThread(
      defaultOptions,
      () => {},
      mockClient as unknown as Anthropic,
      defaultAnthropicOptions,
    );

    const toolUseId = "tool-123" as ToolRequestId;

    // Send a message to trigger streaming, then respond with tool_use
    thread.appendUserMessage([{ type: "text", text: "Hello" }], true);

    const stream = await mockClient.awaitStream();
    stream.streamToolUse(toolUseId, "get_file" as ToolName, {
      filePath: "test.ts",
    });
    stream.finishResponse("tool_use");

    // Wait for the stream to complete
    await stream.finalMessage();
    // Give time for the promise handler to run
    await new Promise((resolve) => setTimeout(resolve, 0));

    const result: ProviderToolResult = {
      type: "tool_result",
      id: toolUseId,
      result: {
        status: "ok",
        value: [{ type: "text", text: "Tool output" }],
      },
    };

    thread.toolResult(toolUseId, result, false);

    const state = thread.getState();
    expect(state.messages).toHaveLength(3);
    expect(state.messages[2].role).toBe("user");

    const toolResult = state.messages[2].content[0];
    expect(toolResult.type).toBe("tool_result");
  });
});

describe("dispatch", () => {
  it("dispatches when stream updates state", async () => {
    const mockClient = new MockAnthropicClient();
    const actions: ProviderThreadAction[] = [];
    const thread = new AnthropicProviderThread(
      defaultOptions,
      (action) => actions.push(action),
      mockClient as unknown as Anthropic,
      defaultAnthropicOptions,
    );

    // appendUserMessage with respond=false should not dispatch
    thread.appendUserMessage([{ type: "text", text: "Test" }], false);
    expect(actions).toHaveLength(0);

    // appendUserMessage with respond=true triggers streaming which dispatches
    thread.appendUserMessage([{ type: "text", text: "Test 2" }], true);

    const stream = await mockClient.awaitStream();
    stream.streamText("Hello");
    expect(actions.length).toBeGreaterThan(0);
    expect(actions.some((a) => a.type === "status-changed")).toBe(true);
    stream.finishResponse("end_turn");

    await stream.finalMessage();
    await delay(0);

    // Should have dispatched status-changed, streaming-block-updated, etc.
    expect(actions.length).toBeGreaterThan(0);
    expect(actions.some((a) => a.type === "status-changed")).toBe(true);
    expect(actions.some((a) => a.type === "messages-updated")).toBe(true);
  });
});

describe("abort", () => {
  it("does nothing when no active request", () => {
    const mockClient = {} as Anthropic;
    const actions: ProviderThreadAction[] = [];
    const thread = new AnthropicProviderThread(
      defaultOptions,
      (action) => actions.push(action),
      mockClient,
      defaultAnthropicOptions,
    );

    thread.abort();

    expect(actions).toHaveLength(0);
    expect(thread.getState().status).toEqual({ type: "idle" });
  });

  it("sets stopped status with aborted reason when stream is active", async () => {
    const mockClient = new MockAnthropicClient();
    const actions: ProviderThreadAction[] = [];
    const thread = new AnthropicProviderThread(
      defaultOptions,
      (action) => actions.push(action),
      mockClient as unknown as Anthropic,
      defaultAnthropicOptions,
    );

    thread.appendUserMessage([{ type: "text", text: "Hello" }], true);

    const stream = await mockClient.awaitStream();

    // Start streaming some text
    stream.streamText("Partial response");

    // Abort the request
    thread.abort();

    // Wait for the catch block to execute
    await delay(0);

    const state = thread.getState();
    expect(state.status).toEqual({
      type: "stopped",
      stopReason: "aborted",
      usage: { inputTokens: 0, outputTokens: 0 },
    });

    expect(
      actions.some(
        (a) =>
          a.type === "status-changed" &&
          a.status.type === "stopped" &&
          a.status.stopReason === "aborted",
      ),
    ).toBe(true);
  });

  it("adds tool_result with abort message when aborting during tool_use", async () => {
    const mockClient = new MockAnthropicClient();
    const thread = new AnthropicProviderThread(
      defaultOptions,
      () => {},
      mockClient as unknown as Anthropic,
      defaultAnthropicOptions,
    );

    thread.appendUserMessage([{ type: "text", text: "Hello" }], true);

    const stream = await mockClient.awaitStream();

    // Stream a tool_use block but don't finish the response
    const toolUseId = "tool-abort-test" as ToolRequestId;
    stream.streamToolUse(toolUseId, "get_file" as ToolName, {
      filePath: "test.ts",
    });

    // Abort while tool_use is the last block
    thread.abort();

    await new Promise((resolve) => setTimeout(resolve, 0));

    const state = thread.getState();

    // Should have: user message, assistant with tool_use, user with tool_result
    expect(state.messages).toHaveLength(3);
    expect(state.messages[2].role).toBe("user");

    const toolResult = state.messages[2].content[0];
    expect(toolResult.type).toBe("tool_result");
    if (toolResult.type === "tool_result") {
      expect(toolResult.id).toBe(toolUseId);
      expect(toolResult.result.status).toBe("error");
      if (toolResult.result.status === "error") {
        expect(toolResult.result.error).toContain("aborted");
      }
    }
  });

  it("removes server_tool_use block when aborting during web search", async () => {
    const mockClient = new MockAnthropicClient();
    const thread = new AnthropicProviderThread(
      defaultOptions,
      () => {},
      mockClient as unknown as Anthropic,
      defaultAnthropicOptions,
    );

    thread.appendUserMessage([{ type: "text", text: "Search for info" }], true);

    const stream = await mockClient.awaitStream();

    // Stream some text first
    stream.streamText("Let me search for that.");

    // Stream a server_tool_use block (web search)
    stream.streamServerToolUse("server-tool-1", "web_search", {
      query: "test query",
    });

    // Abort while waiting for web search results
    thread.abort();

    await new Promise((resolve) => setTimeout(resolve, 0));

    const state = thread.getState();

    // Should have: user message, assistant with just text (server_tool_use removed)
    expect(state.messages).toHaveLength(2);
    expect(state.messages[1].role).toBe("assistant");
    expect(state.messages[1].content).toHaveLength(1);
    expect(state.messages[1].content[0].type).toBe("text");
  });
});

describe("streaming block", () => {
  it("exposes text streaming block during streaming", async () => {
    const mockClient = new MockAnthropicClient();
    const thread = new AnthropicProviderThread(
      defaultOptions,
      () => {},
      mockClient as unknown as Anthropic,
      defaultAnthropicOptions,
    );

    thread.appendUserMessage([{ type: "text", text: "Hello" }], true);

    const stream = await mockClient.awaitStream();

    // Start a text block
    const blockIndex = stream.nextBlockIndex();
    stream.emitEvent({
      type: "content_block_start",
      index: blockIndex,
      content_block: { type: "text", text: "", citations: null },
    });

    // Check streaming block is exposed
    let streamingBlock = thread.getProviderStreamingBlock();
    expect(streamingBlock).toBeDefined();
    expect(streamingBlock?.type).toBe("text");

    // Add some text
    stream.emitEvent({
      type: "content_block_delta",
      index: blockIndex,
      delta: { type: "text_delta", text: "Hello world" },
    });

    streamingBlock = thread.getProviderStreamingBlock();
    expect(streamingBlock?.type).toBe("text");
    if (streamingBlock?.type === "text") {
      expect(streamingBlock.text).toBe("Hello world");
    }

    // Stop the block
    stream.emitEvent({
      type: "content_block_stop",
      index: blockIndex,
    });

    // Streaming block should be cleared
    expect(thread.getProviderStreamingBlock()).toBeUndefined();

    // Clean up
    stream.finishResponse("end_turn");
    await stream.finalMessage();
  });

  it("exposes tool_use streaming block during streaming", async () => {
    const mockClient = new MockAnthropicClient();
    const thread = new AnthropicProviderThread(
      defaultOptions,
      () => {},
      mockClient as unknown as Anthropic,
      defaultAnthropicOptions,
    );

    thread.appendUserMessage([{ type: "text", text: "Hello" }], true);

    const stream = await mockClient.awaitStream();

    const toolUseId = "tool-stream-test" as ToolRequestId;
    const blockIndex = stream.nextBlockIndex();

    // Start a tool_use block
    stream.emitEvent({
      type: "content_block_start",
      index: blockIndex,
      content_block: {
        type: "tool_use",
        id: toolUseId,
        name: "get_file",
        input: {},
      },
    });

    let streamingBlock = thread.getProviderStreamingBlock();
    expect(streamingBlock?.type).toBe("tool_use");

    // Add input JSON
    stream.emitEvent({
      type: "content_block_delta",
      index: blockIndex,
      delta: { type: "input_json_delta", partial_json: '{"filePath":' },
    });

    stream.emitEvent({
      type: "content_block_delta",
      index: blockIndex,
      delta: { type: "input_json_delta", partial_json: '"test.ts"}' },
    });

    streamingBlock = thread.getProviderStreamingBlock();
    if (streamingBlock?.type === "tool_use") {
      expect(streamingBlock.inputJson).toBe('{"filePath":"test.ts"}');
    }

    // Stop the block
    stream.emitEvent({
      type: "content_block_stop",
      index: blockIndex,
    });

    expect(thread.getProviderStreamingBlock()).toBeUndefined();

    stream.finishResponse("tool_use");
    await stream.finalMessage();
  });

  it("returns undefined for server_tool_use blocks", async () => {
    const mockClient = new MockAnthropicClient();
    const thread = new AnthropicProviderThread(
      defaultOptions,
      () => {},
      mockClient as unknown as Anthropic,
      defaultAnthropicOptions,
    );

    thread.appendUserMessage([{ type: "text", text: "Search" }], true);

    const stream = await mockClient.awaitStream();

    const blockIndex = stream.nextBlockIndex();

    // Start a server_tool_use block
    stream.emitEvent({
      type: "content_block_start",
      index: blockIndex,
      content_block: {
        type: "server_tool_use",
        id: "server-tool-1",
        name: "web_search",
        input: {},
      } as unknown as Anthropic.Messages.ContentBlock,
    });

    // server_tool_use should not be exposed via getProviderStreamingBlock
    expect(thread.getProviderStreamingBlock()).toBeUndefined();

    stream.emitEvent({
      type: "content_block_stop",
      index: blockIndex,
    });

    stream.finishResponse("end_turn");
    await stream.finalMessage();
  });

  it("dispatches streaming-block-updated events during streaming", async () => {
    const mockClient = new MockAnthropicClient();
    const actions: ProviderThreadAction[] = [];
    const thread = new AnthropicProviderThread(
      defaultOptions,
      (action) => actions.push(action),
      mockClient as unknown as Anthropic,
      defaultAnthropicOptions,
    );

    thread.appendUserMessage([{ type: "text", text: "Hello" }], true);

    const stream = await mockClient.awaitStream();

    // Clear actions from the initial status change
    actions.length = 0;

    stream.streamText("Hello world");

    // Should have dispatched streaming-block-updated events
    const streamingUpdates = actions.filter(
      (a) => a.type === "streaming-block-updated",
    );
    expect(streamingUpdates.length).toBeGreaterThan(0);

    stream.finishResponse("end_turn");
    await stream.finalMessage();
  });
});

describe("error handling with cleanup", () => {
  it("adds tool_result with error message when stream errors during tool_use", async () => {
    const mockClient = new MockAnthropicClient();
    const thread = new AnthropicProviderThread(
      defaultOptions,
      () => {},
      mockClient as unknown as Anthropic,
      defaultAnthropicOptions,
    );

    thread.appendUserMessage([{ type: "text", text: "Hello" }], true);

    const stream = await mockClient.awaitStream();

    // Stream a tool_use block
    const toolUseId = "tool-error-test" as ToolRequestId;
    stream.streamToolUse(toolUseId, "get_file" as ToolName, {
      filePath: "test.ts",
    });

    // Simulate a stream error
    stream.respondWithError(new Error("Connection lost"));

    await new Promise((resolve) => setTimeout(resolve, 0));

    const state = thread.getState();

    // Should have: user message, assistant with tool_use, user with tool_result
    expect(state.messages).toHaveLength(3);
    expect(state.messages[2].role).toBe("user");

    const toolResult = state.messages[2].content[0];
    expect(toolResult.type).toBe("tool_result");
    if (toolResult.type === "tool_result") {
      expect(toolResult.id).toBe(toolUseId);
      expect(toolResult.result.status).toBe("error");
      if (toolResult.result.status === "error") {
        expect(toolResult.result.error).toContain("Connection lost");
      }
    }

    expect(state.status.type).toBe("error");
  });

  it("removes server_tool_use block when stream errors during web search", async () => {
    const mockClient = new MockAnthropicClient();
    const thread = new AnthropicProviderThread(
      defaultOptions,
      () => {},
      mockClient as unknown as Anthropic,
      defaultAnthropicOptions,
    );

    thread.appendUserMessage([{ type: "text", text: "Search for info" }], true);

    const stream = await mockClient.awaitStream();

    // Stream some text first
    stream.streamText("Let me search for that.");

    // Stream a server_tool_use block
    stream.streamServerToolUse("server-tool-2", "web_search", {
      query: "test query",
    });

    // Simulate a stream error
    stream.respondWithError(new Error("API timeout"));

    await new Promise((resolve) => setTimeout(resolve, 0));

    const state = thread.getState();

    // Should have: user message, assistant with just text (server_tool_use removed)
    expect(state.messages).toHaveLength(2);
    expect(state.messages[1].role).toBe("assistant");
    expect(state.messages[1].content).toHaveLength(1);
    expect(state.messages[1].content[0].type).toBe("text");

    expect(state.status.type).toBe("error");
  });
});
