import type { JSONSchema, ThreadOptions } from "./protocol.ts";

/** Reports progress, surfaced in the magenta UI. */
export type LogFn = (message: string) => void;

/**
 * Spawns a real, sidebar-visible magenta thread seeded with `prompt`, equips it
 * with a `yield_to_parent` tool whose input_schema is `yieldSchema`, and
 * resolves to the structured value the agent yields. The generic `T` is
 * advisory typing only.
 */
export type ThreadFn = <T>(
  prompt: string,
  yieldSchema: JSONSchema,
  options?: ThreadOptions,
) => Promise<T>;

export type Runner<P = unknown> = (
  parameters: P,
  thread: ThreadFn,
  log: LogFn,
) => Promise<void>;

export type RegisteredScript = {
  name: string;
  description: string;
  parameterSchema: JSONSchema;
  runner: Runner;
};

const registry = new Map<string, RegisteredScript>();

/**
 * Record a script into the module-level registry. Decoupled from how the runner
 * is driven, so both the production IPC client and the test harness can invoke
 * the same runner.
 */
export function registerScript<P = unknown>(
  name: string,
  description: string,
  parameterSchema: JSONSchema,
  runner: Runner<P>,
): void {
  registry.set(name, {
    name,
    description,
    parameterSchema,
    runner: runner as Runner,
  });
}

export function getRegistry(): Map<string, RegisteredScript> {
  return registry;
}

export function clearRegistry(): void {
  registry.clear();
}
