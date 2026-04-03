# context

## Objective

Segment tests by the system capabilities they require (docker, process management, etc.) so tests can run locally in a sandboxed environment by default, skipping tests that need elevated privileges. Tests declare their requirements; the runner checks which capabilities are available via `TEST_CAPABILITIES` env var.

## Current state

Some test files already use ad-hoc `skipIf(!dockerAvailable)` checks:

- `node/core/src/container/container.test.ts` — checks `docker info` at top level
- `node/capabilities/docker-environment.test.ts` — same pattern
- `node/render-tools/docker-sync.test.ts` — same pattern

These will be unified under the new system.

## Capabilities needed

| Capability | What it guards                                                | Test files                                                                                                                                                                                |
| ---------- | ------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `docker`   | Docker daemon access (socket, config, container lifecycle)    | `node/core/src/container/container.test.ts`, `node/capabilities/docker-environment.test.ts`, `node/render-tools/docker-sync.test.ts`                                                      |
| `process`  | Process tree management (kill signals, `/proc` reads, sysctl) | `node/tools/bashCommand.test.ts` (3 tests: "terminates process with SIGTERM", "escalates to SIGKILL when process ignores SIGTERM", "kills entire process tree including child processes") |

## Key files

- `node/test/capabilities.ts` — **new**, capability declaration and checking
- `node/core/src/container/container.test.ts` — has `skipIf(!dockerAvailable)`, migrate to `hasCapability`
- `node/capabilities/docker-environment.test.ts` — has `skipIf(!dockerAvailable)`, migrate
- `node/render-tools/docker-sync.test.ts` — has `skipIf(!DOCKER_AVAILABLE)`, migrate
- `node/tools/bashCommand.test.ts` — 3 tests at lines 963, 1050, 1142 need `process` capability
- `vitest.config.ts` — vitest configuration (no changes needed)

## API design

```typescript
// node/test/capabilities.ts
type TestMode = "all" | "sandbox";

const testMode: TestMode =
  (process.env.TEST_MODE as TestMode | undefined) ?? "all";

export const FULL_CAPABILITIES = testMode === "all";
```

Usage: `describe.runIf(FULL_CAPABILITIES)("...", () => { ... })` or `it.runIf(FULL_CAPABILITIES)("...", () => { ... })`

Running:

- `npx vitest run` — all tests (default)
- `TEST_MODE=sandbox npx vitest run` — only sandbox-safe tests

# implementation

- [ ] Create `node/test/capabilities.ts` with `FULL_CAPABILITIES` export
  - Simple module: reads `TEST_MODE` env var, exports `FULL_CAPABILITIES` boolean
  - Default is `"all"` (full capabilities), `"sandbox"` skips privileged tests

- [ ] Migrate `node/core/src/container/container.test.ts`
  - Remove the `isDockerAvailable()` function and `dockerAvailable` variable
  - Change `describe.skipIf(!dockerAvailable)` → `describe.runIf(FULL_CAPABILITIES)`
  - Import `FULL_CAPABILITIES` from `node/test/capabilities.ts`

- [ ] Migrate `node/capabilities/docker-environment.test.ts`
  - Remove `isDockerAvailable()` call and variable
  - Change `describe.skipIf(!dockerAvailable)` → `describe.runIf(FULL_CAPABILITIES)`

- [ ] Migrate `node/render-tools/docker-sync.test.ts`
  - Remove the `DOCKER_AVAILABLE` IIFE and its `execFileSync` call
  - Change `describe.skipIf(!DOCKER_AVAILABLE)` → `describe.runIf(FULL_CAPABILITIES)`

- [ ] Tag process-management tests in `node/tools/bashCommand.test.ts`
  - Wrap the 3 process tests (SIGTERM, SIGKILL escalation, process tree kill) with `it.runIf(FULL_CAPABILITIES)`

- [ ] Update `context.md`
  - Document `TEST_MODE` env var and `FULL_CAPABILITIES` flag
  - Update testing guidance: run tests locally on host by default (`TEST_MODE=sandbox`). If full capabilities are needed (docker, process management), use the `tests-in-docker` subagent which runs with `TEST_MODE=all` (the default)

- [ ] Verify
  - Run `TEST_MODE=sandbox npx vitest run` locally — all capability-gated tests should show as skipped, no sandbox violations
  - Run `npx vitest run` in docker — all tests should run (default mode is "all")
