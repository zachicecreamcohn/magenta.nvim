import type { JSONSchema, ThreadOptions } from "./protocol.ts";
import { getRegistry } from "./registry.ts";

export { clearRegistry } from "./registry.ts";

/**
 * A pending `thread()` invocation captured by the test harness. The test
 * inspects `prompt` / `yieldSchema` / `options` and settles the specific call
 * via `yield(value)` or `reject(error)`.
 */
export type PendingThread = {
  prompt: string;
  yieldSchema: JSONSchema;
  options: ThreadOptions | undefined;
  yield(value: unknown): void;
  reject(error: Error): void;
};

export type ScriptHandle = {
  /** Captured `log()` messages, in order. */
  logs: string[];
  /** Resolves with the next pending `thread()` invocation. */
  nextThread(): Promise<PendingThread>;
};

/**
 * Drive a registered runner in-process with test-double `thread`/`log`. The
 * script module must be statically imported before calling this so its
 * `registerScript` call has populated the registry.
 */
export function runScript(
  scriptName: string,
  parameters: unknown,
): { handle: ScriptHandle; donePromise: Promise<void> } {
  const script = getRegistry().get(scriptName);
  if (!script) {
    throw new Error(`unknown script ${scriptName}`);
  }

  const logs: string[] = [];
  const pendingQueue: PendingThread[] = [];
  const waiters: Array<(t: PendingThread) => void> = [];

  const log = (message: string) => {
    logs.push(message);
  };

  const thread = <T>(
    prompt: string,
    yieldSchema: JSONSchema,
    options?: ThreadOptions,
  ): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      const pending: PendingThread = {
        prompt,
        yieldSchema,
        options,
        yield: (value) => resolve(value as T),
        reject,
      };
      const waiter = waiters.shift();
      if (waiter) {
        waiter(pending);
      } else {
        pendingQueue.push(pending);
      }
    });

  const donePromise = script.runner(parameters, thread, log);

  const handle: ScriptHandle = {
    logs,
    nextThread() {
      return new Promise<PendingThread>((resolve) => {
        const pending = pendingQueue.shift();
        if (pending) {
          resolve(pending);
        } else {
          waiters.push(resolve);
        }
      });
    },
  };

  return { handle, donePromise };
}
