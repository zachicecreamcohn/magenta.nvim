# Context

The goal is to let Bedrock users configure a shell command that refreshes their AWS credentials (typically `aws sso login --profile X`) and have the plugin run that command automatically when an inference request fails with an expired-credentials error, then retry the request once.

The user-reported failure mode: SSO tokens expire, and the next request fails with a plain `Error: Token is expired. To refresh this SSO session run 'aws sso login' with the corresponding profile.` thrown from the AWS SDK credential provider chain (`@smithy/property-provider`'s `TokenProviderError`). This happens before any HTTP request is made, so the existing `isRetryableError` (which only handles 429/529 and a specific `AnthropicError`) does not cover it.

## Behavior spec

1. When an inference request fails with an auth/credentials error AND the active profile has a `tokenRefreshCommand` configured:
   - Run the command.
   - If the command exits non-zero, surface the original auth error plus the command stderr to the user (do not retry).
   - If the command exits zero, retry the inference request once.
2. The refresh function tracks the timestamp of its last successful run. If called again within 30s of the last attempt, it rejects immediately with a message like `"token refresh was attempted Ns ago; not retrying"`. This prevents tight refresh loops when the command silently "succeeds" but the next request still fails with an auth error.
3. Concurrent callers (e.g. two streams hitting the auth error at the same time) are coalesced: a single in-flight refresh promise is shared by all callers.
4. If no `tokenRefreshCommand` is configured, behavior is unchanged — auth errors propagate as today.
5. For non-Bedrock providers the field is ignored (anthropic/openai don't use it).

## Relevant files and entities

- `node/options.ts` — defines `Profile`; runtime parser must accept `tokenRefreshCommand?: string`.
- `node/core/src/provider-options.ts` — defines `ProviderProfile`; needs the same field.
- `node/core/src/providers/bedrock.ts` — `BedrockProvider` constructor; receives the command via `BedrockProviderOptions` and builds the `refreshAuth` closure.
- `node/core/src/providers/provider.ts` — `getProvider`; plumbs `profile.tokenRefreshCommand` into `BedrockProviderOptions`.
- `node/core/src/providers/anthropic.ts` — `AnthropicProvider` constructor and `forceToolUse` retry loop; needs to accept `refreshAuth` and invoke it on auth errors.
- `node/core/src/providers/anthropic-agent.ts` — `AnthropicAgent.continueConversation` retry loop and `AnthropicAgentOptions`; needs `refreshAuth` plumbed in and invoked.
- `node/options.test.ts` — add validator tests for the new field.
- `node/core/src/providers/anthropic-agent.test.ts` and `node/providers/anthropic-agent.test.ts` — locations for refresh-on-auth-error tests (the second is the root-project shadow of the core test file; new tests go in the core file).
- `doc/magenta-providers.txt` and `doc/magenta-config.txt` — user-facing config docs.

## Key types

Additive change to `Profile` / `ProviderProfile`:

```ts
tokenRefreshCommand?: string;
```

New `BedrockProviderOptions` field:

```ts
tokenRefreshCommand?: string;
```

New refresh callback type (internal, shared by `AnthropicProvider` and `AnthropicAgent`):

```ts
export type RefreshAuth = () => Promise<void>;
```

New helper module `node/core/src/providers/auth-refresh.ts`:

```ts
export function makeRefreshAuth(command: string, logger: Logger): RefreshAuth;
export function isAuthError(error: unknown): boolean;
```

`makeRefreshAuth` returns a closure that:
- Coalesces concurrent calls via an `inProgress: Promise<void> | undefined` field.
- Tracks `lastAttempt: number | undefined`.
- If `Date.now() - lastAttempt < 30_000`, throws `Error("Token refresh was attempted ${seconds}s ago; not retrying")`.
- Otherwise sets `lastAttempt = Date.now()` and runs the command via `child_process.exec` with the current process env, default shell (`/bin/sh -c`), and a 60s timeout. Logs stdout/stderr.
- On non-zero exit, rejects with a combined error message including the command and the captured stderr.

`isAuthError` matches:
- `Error` with `name === "TokenProviderError"` or `"CredentialsProviderError"`.
- `Error` with message containing `"Token is expired"`, `"ExpiredToken"`, `"ExpiredTokenException"`, `"InvalidSignatureException"`, `"UnrecognizedClientException"`, or `"Could not load credentials"` (case-insensitive).
- `APIError` with `status` of 401 or 403.

# Implementation

- [ ] add `tokenRefreshCommand?: string` to `ProviderProfile` in `node/core/src/provider-options.ts` and to `Profile` in `node/options.ts`
  - update the runtime validator in `node/options.ts` to accept the field; warn and drop if it is not a non-empty string
  - run `npx tsgo -b` and fix type errors

- [ ] add a unit test for the validator in `node/options.test.ts`
  - Behavior: parsing a profile with `tokenRefreshCommand = "aws sso login"` yields `Profile.tokenRefreshCommand === "aws sso login"`; an invalid value (number, empty string) warns and produces no field
  - Setup: construct raw profile objects with the field set to a valid string, a number, and an empty string
  - Actions: call the profiles parser with a capturing logger
  - Expected output: valid case keeps the field; invalid cases produce a warning and drop the field
  - Assertions: `expect(profile.tokenRefreshCommand).toBe("aws sso login")` etc.

- [ ] create `node/core/src/providers/auth-refresh.ts` exporting `RefreshAuth`, `makeRefreshAuth`, and `isAuthError`
  - implement command execution via `child_process.exec` wrapped in a `Promise`; include stdout/stderr in the rejected error message
  - log via the passed `Logger` (info on start, info on success, warn on failure)
  - unit tests for the closure in `node/core/src/providers/auth-refresh.test.ts`:
    - Behavior: command success — first call runs and resolves
      - Setup: `makeRefreshAuth("true", mockLogger)` (POSIX `true` always exits 0)
      - Actions: call the closure once
      - Expected output: promise resolves
      - Assertions: `await expect(refresh()).resolves.toBeUndefined()`
    - Behavior: command failure — promise rejects with stderr text
      - Setup: `makeRefreshAuth("sh -c 'echo boom >&2; exit 1'", mockLogger)`
      - Actions: call the closure
      - Expected output: rejects with an error whose message contains `"boom"`
      - Assertions: `await expect(refresh()).rejects.toThrow(/boom/)`
    - Behavior: 30s window guard — second call within 30s rejects without running command
      - Setup: same as success, mock `Date.now` to return controlled timestamps
      - Actions: call refresh twice, second call 10s after the first
      - Expected output: second call rejects with a message containing `"30"` or `"not retrying"`; the command does NOT run a second time
      - Assertions: use a spy on the command (replace `exec` via vitest module mock or via an injected `runCommand` for testability) and assert it was called exactly once
    - Behavior: window expires — call after 30s+ runs the command again
      - Setup: same with advanced timestamps
      - Actions: call refresh, advance time by 31s, call again
      - Expected output: both calls resolve; command ran twice
      - Assertions: spy invoked twice
    - Behavior: concurrent coalescing — two simultaneous calls share one command invocation
      - Setup: command takes 50ms (e.g. `sleep 0.05`)
      - Actions: call refresh twice without awaiting between calls; await both
      - Expected output: both resolve; command invoked exactly once
      - Assertions: spy invoked once; both promises resolve

  Note: for testability, factor the `exec` call out of `makeRefreshAuth` (e.g. accept an injectable `runCommand?: (cmd: string) => Promise<{ stdout: string; stderr: string }>` parameter, defaulting to the real `child_process.exec` wrapper). This avoids needing to spawn real processes in unit tests.

- [ ] thread `tokenRefreshCommand` through the provider construction chain
  - in `node/core/src/providers/bedrock.ts`, add `tokenRefreshCommand?: string` to `BedrockProviderOptions`. Build `this.refreshAuth = makeRefreshAuth(...)` when configured and assign it to `this` (the inherited `AnthropicProvider` field).
  - in `node/core/src/providers/anthropic.ts`, add a `protected refreshAuth: RefreshAuth | undefined` field on `AnthropicProvider`. Subclass `BedrockProvider` sets it after `super()`. Pass it down to `createAgent` via `AnthropicAgentOptions`.
  - in `node/core/src/providers/anthropic-agent.ts`, add `refreshAuth?: RefreshAuth` to `AnthropicAgentOptions`; store on the agent.
  - in `node/core/src/providers/provider.ts`, pass `profile.tokenRefreshCommand` into the `BedrockProviderOptions` when constructing the BedrockProvider.
  - run `npx tsgo -b` to confirm.

- [ ] update `AnthropicAgent.continueConversation` retry logic in `node/core/src/providers/anthropic-agent.ts`
  - after `attemptStream()` returns `type: "error"`, BEFORE the existing `isRetryableError`/`MAX_RETRY_DURATION` check, do:
    - if `this.anthropicOptions.refreshAuth` is set AND `isAuthError(result.error)`:
      - try `await this.anthropicOptions.refreshAuth()`
      - on success: do not increment `attempt`, do not bump retry delay, continue the loop immediately to retry
      - on failure: build a combined error (`"Auth refresh failed: <refresh err>. Original error: <auth err>"`), call `this.update({ type: "stream-error", error: combined })`, return
    - else fall through to the existing logic
  - this means auth-error retries are independent of the 429/529 backoff retry budget (they are bounded by the 30s guard inside `refreshAuth`).
  - tests in `node/core/src/providers/anthropic-agent.test.ts`:
    - Behavior: a TokenProviderError on first stream triggers `refreshAuth` and the retry succeeds
      - Setup: stub the Anthropic client to return a stream that errors with `new Error("Token is expired. ...")` on first `finalMessage()` and resolves on second. Configure `refreshAuth` as a vitest spy that resolves.
      - Actions: call `agent.continueConversation()` and await `getStreamingEndPromise` (or `stopped` event)
      - Expected output: agent ends in `stopped/end_turn`; spy called exactly once
      - Assertions: spy call count, agent status, and final response
    - Behavior: `refreshAuth` rejection surfaces a combined error to the user
      - Setup: stub first stream to throw the same auth error; configure `refreshAuth` to reject with `Error("aws sso login failed: bad config")`
      - Actions: same as above
      - Expected output: agent status is `error` with a message containing both `"Token is expired"` (or `"aws sso login failed"`) and the refresh failure
      - Assertions: error message substring assertions
    - Behavior: second auth error within 30s window stops retrying
      - Setup: stub stream to always throw the auth error; the `refreshAuth` closure (real `makeRefreshAuth`) is configured with an injectable `runCommand` that always resolves
      - Actions: trigger one `continueConversation`; the agent does refresh+retry, second auth error comes back, refresh closure rejects with 30s guard
      - Expected output: agent surfaces combined error; `runCommand` called exactly once
      - Assertions: spy count, error message

- [ ] mirror the same logic in `AnthropicProvider.forceToolUse` retry loop in `node/core/src/providers/anthropic.ts`
  - in the catch branch, before the existing `isRetryableError`/`aborted` checks, do the same `refreshAuth`+retry dance
  - on success continue the loop (do not increment `attempt`); on failure throw a combined error
  - test in the same file with the existing `forceToolUse` test patterns:
    - Behavior: a forced tool-use request that fails with an auth error refreshes and retries successfully
    - Setup, actions, expected output, assertions: analogous to the agent test

- [ ] update documentation
  - `doc/magenta-providers.txt`: under the Bedrock section, add a `tokenRefreshCommand` field with an example (`tokenRefreshCommand = "aws sso login --profile myprofile"`), and note the 30s retry guard
  - `doc/magenta-config.txt`: one-line pointer to the new option
  - mention this is currently Bedrock-only

- [ ] run `TEST_MODE=sandbox npx vitest run node/core/src/providers/ node/options.test.ts` and iterate until green
- [ ] run `npx tsgo -b` and `npx biome check .` and fix any issues
