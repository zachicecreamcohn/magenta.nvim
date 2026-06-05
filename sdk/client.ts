import type {
  ChildToParent,
  JSONSchema,
  ParentToChild,
  ThreadOptions,
} from "./protocol.ts";
import { getRegistry } from "./registry.ts";

let activated = false;
let nextRequestId = 1;
const pendingThreads = new Map<
  number,
  { resolve: (value: unknown) => void; reject: (error: Error) => void }
>();

function send(msg: ChildToParent): void {
  process.send?.(msg);
}

function invokeThread<T>(
  prompt: string,
  yieldSchema: JSONSchema,
  options?: ThreadOptions,
): Promise<T> {
  const requestId = nextRequestId++;
  return new Promise<T>((resolve, reject) => {
    pendingThreads.set(requestId, {
      resolve: (value) => resolve(value as T),
      reject,
    });
    send({
      type: "invoke-thread",
      requestId,
      prompt,
      yieldSchema,
      ...(options !== undefined ? { options } : {}),
    });
  });
}

async function handleMessage(msg: ParentToChild): Promise<void> {
  switch (msg.type) {
    case "invoke": {
      const script = getRegistry().get(msg.scriptName);
      if (!script) {
        send({ type: "error", message: `unknown script ${msg.scriptName}` });
        return;
      }
      const log = (message: string) => send({ type: "log", message });
      try {
        await script.runner(msg.parameters, invokeThread, log);
        send({ type: "done" });
      } catch (err) {
        send({
          type: "error",
          message: err instanceof Error ? err.message : String(err),
        });
      }
      return;
    }
    case "thread-result": {
      const pending = pendingThreads.get(msg.requestId);
      if (!pending) return;
      pendingThreads.delete(msg.requestId);
      if (msg.result.status === "ok") {
        pending.resolve(msg.result.value);
      } else {
        pending.reject(new Error(msg.result.error));
      }
      return;
    }
  }
}

/**
 * Activate the IPC client. No-op unless this process was forked with an IPC
 * channel (i.e. `process.send` exists). Sends the registration catalog once the
 * current tick's top-level `registerScript` calls have completed, then listens
 * for `invoke` / `thread-result` messages.
 */
export function activate(): void {
  if (activated) return;
  if (process.env.MAGENTA_SDK_CHILD !== "1") return;
  if (typeof process.send !== "function") return;
  activated = true;

  process.on("message", (raw: ParentToChild) => {
    handleMessage(raw).catch((err) => {
      send({
        type: "error",
        message: err instanceof Error ? err.message : String(err),
      });
    });
  });

  setImmediate(() => {
    const scripts = [...getRegistry().values()].map(
      ({ name, description, parameterSchema }) => ({
        name,
        description,
        parameterSchema,
      }),
    );
    send({ type: "register", scripts });
  });
}
