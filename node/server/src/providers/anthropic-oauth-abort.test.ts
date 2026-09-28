import { afterEach, describe, expect, it, vi } from "vitest";
import type { AnthropicAuth } from "../anthropic-auth.ts";
import type { AuthUI } from "../auth-ui.ts";
import type { Logger } from "../logger.ts";
import { AnthropicProvider } from "./anthropic.ts";

const noopLogger: Logger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
};

describe("anthropic shared OAuth flow", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("is cancelled by the signal of the request that started it", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("{}", { status: 200 })),
    );
    let authenticated = false;
    const auth: AnthropicAuth = {
      isAuthenticated: async () => authenticated,
      authorize: async () => ({ url: "https://x", verifier: "v" }),
      exchange: async () => ({
        type: "oauth",
        refresh: "r",
        access: "a",
        expires: Date.now() + 3_600_000,
      }),
      storeTokens: async () => {
        authenticated = true;
      },
      getAccessToken: async () => "a",
    };
    const flowSignals: (AbortSignal | undefined)[] = [];
    const authUI: AuthUI = {
      showOAuthFlow: (_url, abortSignal) => {
        flowSignals.push(abortSignal);
        if (flowSignals.length > 1) return Promise.resolve("code");
        return new Promise((_resolve, reject) => {
          abortSignal?.addEventListener("abort", () =>
            reject(new Error("aborted while waiting for a client")),
          );
        });
      },
      showError: () => {},
      showLoginProgress: () => {},
    };
    const provider = new AnthropicProvider(
      noopLogger,
      authUI,
      () => ({ status: "ok", value: {} }) as never,
      auth,
      { authType: "max" },
    );
    const oauthFetch = provider["createOAuthFetch"]();

    const first = new AbortController();
    const second = new AbortController();
    const firstReq = oauthFetch("https://api", { signal: first.signal });
    const secondReq = oauthFetch("https://api", { signal: second.signal });
    await vi.waitFor(() => expect(flowSignals).toHaveLength(1));
    first.abort();
    await expect(firstReq).rejects.toThrow(/OAuth authentication failed/);
    await expect(secondReq).rejects.toThrow(/OAuth authentication failed/);
    expect(flowSignals[0]).toBe(first.signal);

    const third = await oauthFetch("https://api", {});
    expect(third.status).toBe(200);
    expect(flowSignals).toHaveLength(2);
  });
});
