import { type ToolRequest } from "../tools/toolManager.ts";
import { type Result } from "../utils/result.ts";
import { Defer, pollUntil } from "../utils/async.ts";
import {
  setClient,
  type Provider,
  type ProviderMessage,
  type StopReason,
} from "./provider.ts";

type MockRequest = {
  messages: Array<ProviderMessage>;
  onText: (text: string) => void;
  onError: (error: Error) => void;
  defer: Defer<{
    toolRequests: Result<ToolRequest, { rawRequest: unknown }>[];
    stopReason: StopReason;
  }>;
};

export class MockProvider implements Provider {
  public requests: MockRequest[] = [];

  async sendMessage(
    messages: Array<ProviderMessage>,
    onText: (text: string) => void,
    onError: (error: Error) => void,
  ): Promise<{
    toolRequests: Result<ToolRequest, { rawRequest: unknown }>[];
    stopReason: StopReason;
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
    stopReason: StopReason;
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

export async function withMockClient(
  fn: (mock: MockProvider) => Promise<void>,
) {
  const mock = new MockProvider();
  setClient(mock);
  try {
    await fn(mock);
  } finally {
    setClient(undefined);
  }
}
