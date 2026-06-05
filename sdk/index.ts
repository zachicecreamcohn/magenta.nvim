import { activate } from "./client.ts";

export type {
  ChildToParent,
  JSONSchema,
  ParentToChild,
  Result,
  ScriptMeta,
  ThreadOptions,
} from "./protocol.ts";
export type { LogFn, Runner, ThreadFn } from "./registry.ts";
export { registerScript } from "./registry.ts";

// Auto-activate the IPC client when run as a child process with an IPC channel.
// In-process (e.g. the test harness) this is a no-op.
activate();
