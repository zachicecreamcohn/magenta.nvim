import Anthropic from "@anthropic-ai/sdk";
import { type ToolRequest } from "./tools/toolManager.ts";
import { type Result } from "./utils/result.ts";
import { Defer, pollUntil } from "./utils/async.ts";
import * as AnthropicClient from "./anthropic.ts";

type MockRequest = {
  messages: Array<Anthropic.MessageParam>;
  onText: (text: string) => void;
  onError: (error: Error) => void;
  defer: Defer<{
    toolRequests: Result<ToolRequest, { rawRequest: unknown }>[];
    stopReason: AnthropicClient.StopReason;
  }>;
};

export class MockClient implements AnthropicClient.AnthropicClient {
  public requests: MockRequest[] = [];

  async sendMessage(
    messages: Array<Anthropic.MessageParam>,
    onText: (text: string) => void,
    onError: (error: Error) => void,
  ): Promise<{
    toolRequests: Result<ToolRequest, { rawRequest: unknown }>[];
    stopReason: AnthropicClient.StopReason;
  }> {
    const request: MockRequest = {
      messages,
      onText,
      onError,
      defer: new Defer(),
    };
    this.requests.push(request);
    return request.defer.promise;
  }

  async awaitPendingRequest() {
    return pollUntil(() => {
      const lastRequest = this.requests[this.requests.length - 1];
      if (lastRequest && !lastRequest.defer.resolved) {
        return lastRequest;
      }
      throw new Error(`no pending requests`);
    });
  }

  async respond({
    text,
    toolRequests,
    stopReason,
  }: {
    text?: string;
    toolRequests: Result<ToolRequest, { rawRequest: unknown }>[];
    stopReason: AnthropicClient.StopReason;
  }) {
    const lastRequest = await this.awaitPendingRequest();

    if (text) {
      lastRequest.onText(text);
    }

    lastRequest.defer.resolve({
      toolRequests,
      stopReason,
    });
  }
}

export async function withMockClient(fn: (mock: MockClient) => Promise<void>) {
  const mock = new MockClient();
  AnthropicClient.setClient(mock);
  try {
    await fn(mock);
  } finally {
    AnthropicClient.setClient(undefined);
  }
}
