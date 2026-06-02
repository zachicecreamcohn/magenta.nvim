import type Anthropic from "@anthropic-ai/sdk";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Logger } from "../logger.ts";
import { validateInput } from "../tools/helpers.ts";
import {
  AnthropicAgent,
  type AnthropicAgentOptions,
} from "./anthropic-agent.ts";
import { MockAnthropicClient } from "./mock-anthropic-client.ts";
import type { ProviderToolSpec } from "./provider-types.ts";
import { PLACEHOLDER_NATIVE_MESSAGE_IDX } from "./provider-types.ts";

const noopLogger: Logger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
};

const defaultOptions = {
  model: "claude-sonnet-4-20250514",
  systemPrompt: "test",
  tools: [] as ProviderToolSpec[],
  skipPostFlightTokenCount: true,
};

const defaultAnthropicOptions: AnthropicAgentOptions = {
  authType: "key",
  includeWebSearch: false,
  disableParallelToolUseFlag: true,
  logger: noopLogger,
  validateInput,
};

function createAgent(mockClient: MockAnthropicClient) {
  return new AnthropicAgent(
    defaultOptions,
    mockClient as unknown as Anthropic,
    defaultAnthropicOptions,
  );
}

function appendAndStart(agent: AnthropicAgent) {
  agent.appendUserMessage([
    {
      type: "text",
      text: "hello",
      nativeMessageIdx: PLACEHOLDER_NATIVE_MESSAGE_IDX,
    },
  ]);
  agent.continueConversation();
}

describe("AnthropicAgent streaming ticker", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("emits didUpdate ~1/sec while waiting and stops after the turn settles", async () => {
    const mockClient = new MockAnthropicClient();
    const agent = createAgent(mockClient);
    let didUpdate = 0;
    agent.on("didUpdate", () => {
      didUpdate++;
    });

    appendAndStart(agent);
    const stream = await mockClient.awaitStream();

    // Dead air: no stream events, only the heartbeat should fire.
    const before = didUpdate;
    await vi.advanceTimersByTimeAsync(3000);
    expect(didUpdate - before).toBeGreaterThanOrEqual(3);

    // Complete the turn.
    stream.respond({ text: "done", toolRequests: [], stopReason: "end_turn" });
    await vi.advanceTimersByTimeAsync(0);

    // Ticker must be cleared: no further emissions after the turn settles.
    const afterSettle = didUpdate;
    await vi.advanceTimersByTimeAsync(5000);
    expect(didUpdate).toBe(afterSettle);
  });

  it("clears the ticker on abort", async () => {
    const mockClient = new MockAnthropicClient();
    const agent = createAgent(mockClient);
    let didUpdate = 0;
    agent.on("didUpdate", () => {
      didUpdate++;
    });

    appendAndStart(agent);
    await mockClient.awaitStream();

    await vi.advanceTimersByTimeAsync(2000);
    await agent.abort();
    await vi.advanceTimersByTimeAsync(0);

    const afterAbort = didUpdate;
    await vi.advanceTimersByTimeAsync(5000);
    expect(didUpdate).toBe(afterAbort);
  });

  it("advances lastEventTime on each stream event", async () => {
    const mockClient = new MockAnthropicClient();
    const agent = createAgent(mockClient);

    appendAndStart(agent);
    const stream = await mockClient.awaitStream();

    const initial = agent.getState().status;
    expect(initial.type).toBe("streaming");
    if (initial.type !== "streaming") return;
    const startEventTime = initial.lastEventTime.getTime();

    // Dead air: lastEventTime should not advance.
    await vi.advanceTimersByTimeAsync(2000);
    const duringWait = agent.getState().status;
    if (duringWait.type !== "streaming") throw new Error("expected streaming");
    expect(duringWait.lastEventTime.getTime()).toBe(startEventTime);

    // A stream event arrives: lastEventTime should advance to now.
    stream.emitEvent({
      type: "content_block_start",
      index: 0,
      content_block: { type: "text", text: "", citations: null },
    });
    await stream.settle();

    const afterEvent = agent.getState().status;
    if (afterEvent.type !== "streaming") throw new Error("expected streaming");
    expect(afterEvent.lastEventTime.getTime()).toBeGreaterThan(startEventTime);
  });
});
