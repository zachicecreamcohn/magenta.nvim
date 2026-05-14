import type Anthropic from "@anthropic-ai/sdk";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Logger } from "../logger.ts";
import { validateInput } from "../tools/helpers.ts";
import {
  AnthropicAgent,
  type AnthropicAgentOptions,
} from "./anthropic-agent.ts";
import {
  makeRefreshAuth,
  type RefreshAuth,
  type RunCommand,
} from "./auth-refresh.ts";
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

function createAgent(
  mockClient: MockAnthropicClient,
  refreshAuth: RefreshAuth | undefined,
): AnthropicAgent {
  const opts: AnthropicAgentOptions = {
    authType: "key",
    includeWebSearch: false,
    disableParallelToolUseFlag: true,
    logger: noopLogger,
    validateInput,
    refreshAuth,
  };
  return new AnthropicAgent(
    defaultOptions,
    mockClient as unknown as Anthropic,
    opts,
  );
}

function makeTokenExpiredError(): Error {
  const err = new Error(
    "Token is expired. To refresh this SSO session run 'aws sso login'.",
  );
  err.name = "TokenProviderError";
  return err;
}

function trackEvents(agent: AnthropicAgent) {
  const events: {
    stopped: Array<{ stopReason: string }>;
    errors: Error[];
  } = { stopped: [], errors: [] };
  agent.on("stopped", (stopReason) => {
    events.stopped.push({ stopReason });
  });
  agent.on("error", (error) => {
    events.errors.push(error);
  });
  return events;
}

describe("AnthropicAgent auth refresh", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("refreshes auth on TokenProviderError and retries successfully", async () => {
    const mockClient = new MockAnthropicClient();
    const refreshAuth = vi.fn().mockResolvedValue(undefined);
    const agent = createAgent(mockClient, refreshAuth);
    const events = trackEvents(agent);

    agent.appendUserMessage([
      {
        type: "text",
        text: "hello",
        nativeMessageIdx: PLACEHOLDER_NATIVE_MESSAGE_IDX,
      },
    ]);
    agent.continueConversation();

    let stream = await mockClient.awaitStream();
    stream.respondWithError(makeTokenExpiredError());
    await vi.advanceTimersByTimeAsync(0);

    stream = await mockClient.awaitStream();
    stream.respond({
      text: "hi back",
      toolRequests: [],
      stopReason: "end_turn",
    });
    await vi.advanceTimersByTimeAsync(0);

    expect(refreshAuth).toHaveBeenCalledTimes(1);
    expect(events.stopped.length).toBe(1);
    expect(events.stopped[0].stopReason).toBe("end_turn");
    expect(events.errors.length).toBe(0);
  });

  it("surfaces a combined error when refresh fails", async () => {
    const mockClient = new MockAnthropicClient();
    const refreshAuth = vi
      .fn()
      .mockRejectedValue(new Error("aws sso login failed: bad config"));
    const agent = createAgent(mockClient, refreshAuth);
    const events = trackEvents(agent);

    agent.appendUserMessage([
      {
        type: "text",
        text: "hello",
        nativeMessageIdx: PLACEHOLDER_NATIVE_MESSAGE_IDX,
      },
    ]);
    agent.continueConversation();

    const stream = await mockClient.awaitStream();
    stream.respondWithError(makeTokenExpiredError());
    await vi.advanceTimersByTimeAsync(0);

    expect(refreshAuth).toHaveBeenCalledTimes(1);
    expect(events.errors.length).toBe(1);
    expect(events.errors[0].message).toContain("Auth refresh failed");
    expect(events.errors[0].message).toContain("bad config");
    expect(events.errors[0].message).toContain("Token is expired");
  });

  it("30s window prevents a second refresh after a repeated auth error", async () => {
    const mockClient = new MockAnthropicClient();
    const runCommand = vi
      .fn<RunCommand>()
      .mockResolvedValue({ stdout: "", stderr: "" });
    const refreshAuth = makeRefreshAuth(
      "aws sso login",
      noopLogger,
      runCommand,
    );
    const agent = createAgent(mockClient, refreshAuth);
    const events = trackEvents(agent);

    agent.appendUserMessage([
      {
        type: "text",
        text: "hello",
        nativeMessageIdx: PLACEHOLDER_NATIVE_MESSAGE_IDX,
      },
    ]);
    agent.continueConversation();

    let stream = await mockClient.awaitStream();
    stream.respondWithError(makeTokenExpiredError());
    await vi.advanceTimersByTimeAsync(0);

    stream = await mockClient.awaitStream();
    stream.respondWithError(makeTokenExpiredError());
    await vi.advanceTimersByTimeAsync(0);

    expect(runCommand).toHaveBeenCalledTimes(1);
    expect(events.errors.length).toBe(1);
    expect(events.errors[0].message).toContain("Auth refresh failed");
    expect(events.errors[0].message).toContain("not retrying");
  });
});
