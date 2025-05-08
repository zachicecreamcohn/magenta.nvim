import { type ToolRequest } from "../tools/toolManager.ts";
import { type Result } from "../utils/result.ts";
import { Defer, pollUntil } from "../utils/async.ts";
import {
  type Provider,
  type ProviderMessage,
  type ProviderRequest,
  type StopReason,
  type Usage,
  type ProviderToolSpec,
} from "./provider-types.ts";
import { setClient } from "./provider.ts";

type MockRequest = {
  messages: Array<ProviderMessage>;
  onText: (text: string) => void;
  defer: Defer<{
    toolRequests: Result<ToolRequest, { rawRequest: unknown }>[];
    stopReason: StopReason;
    usage: Usage;
  }>;
};

type MockForceToolUseRequest = {
  messages: Array<ProviderMessage>;
  spec: ProviderToolSpec;
  defer: Defer<{
    toolRequests: Result<ToolRequest, { rawRequest: unknown }>[];
    stopReason: StopReason;
    usage: Usage;
  }>;
};

export class MockProvider implements Provider {
  public requests: MockRequest[] = [];
  public forceToolUseRequests: MockForceToolUseRequest[] = [];

  setModel(_model: string): void {}

  createStreamParameters(messages: Array<ProviderMessage>): unknown {
    return messages;
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async countTokens(messages: Array<ProviderMessage>): Promise<number> {
    return messages.length;
  }

  forceToolUse(
    messages: Array<ProviderMessage>,
    spec: ProviderToolSpec,
  ): ProviderRequest {
    const request: MockForceToolUseRequest = {
      messages,
      spec,
      defer: new Defer(),
    };
    this.forceToolUseRequests.push(request);

    return {
      abort: () => {
        if (!request.defer.resolved) {
          request.defer.reject(new Error("request aborted"));
        }
      },
      promise: request.defer.promise,
    };
  }

  sendMessage(
    messages: Array<ProviderMessage>,
    onText: (text: string) => void,
  ): ProviderRequest {
    const request: MockRequest = {
      messages,
      onText,
      defer: new Defer(),
    };
    this.requests.push(request);
    return {
      abort: () => {
        if (!request.defer.resolved) {
          request.defer.reject(new Error("request aborted"));
        }
      },

      promise: request.defer.promise,
    };
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

  async awaitPendingForceToolUseRequest() {
    return pollUntil(() => {
      const lastRequest =
        this.forceToolUseRequests[this.forceToolUseRequests.length - 1];
      if (lastRequest && !lastRequest.defer.resolved) {
        return lastRequest;
      }
      throw new Error(`no pending force tool use requests`);
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
      usage: {
        inputTokens: 0,
        outputTokens: 0,
      },
    });
  }

  async respondWithError(error: Error) {
    const lastRequest = await this.awaitPendingRequest();
    lastRequest.defer.reject(error);
  }

  async respondToForceToolUse({
    toolRequest,
    stopReason,
  }: {
    toolRequest: Result<ToolRequest, { rawRequest: unknown }>;
    stopReason: StopReason;
  }) {
    const lastRequest = await this.awaitPendingForceToolUseRequest();

    lastRequest.defer.resolve({
      toolRequests: [toolRequest],
      stopReason,
      usage: {
        inputTokens: 0,
        outputTokens: 0,
      },
    });
  }
}

export async function withMockClient(
  fn: (mock: MockProvider) => Promise<void>,
) {
  const mock = new MockProvider();
  setClient("anthropic", mock);
  try {
    await fn(mock);
  } finally {
    setClient("anthropic", undefined);
  }
}
