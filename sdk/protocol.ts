/**
 * Shared IPC protocol types exchanged over the child-process IPC channel
 * between the SDK (child) and magenta's ScriptManager (parent).
 *
 * This module is fully self-contained: it imports nothing (no node/core, no
 * root project, no third-party package). The root project imports these types
 * FROM here; the SDK never imports back.
 */

/** A JSON Schema object. Kept permissive to avoid a third-party dependency. */
export type JSONSchema = { [key: string]: unknown };

export type Result<T> =
  | { status: "ok"; value: T }
  | { status: "error"; error: string };

/**
 * Options for a thread() invocation. Designed to be extended later; unknown or
 * omitted fields fall back to the active profile and magenta cwd.
 */
export type ThreadOptions = {
  profile?: string;
  model?: string;
  tools?: string[];
  cwd?: string;
};

export type ScriptMeta = {
  name: string;
  description: string;
  parameterSchema: JSONSchema;
};

/** Messages sent from the SDK (child) to ScriptManager (parent). */
export type ChildToParent =
  | { type: "register"; scripts: ScriptMeta[] }
  | {
      type: "invoke-thread";
      requestId: number;
      prompt: string;
      yieldSchema: JSONSchema;
      options?: ThreadOptions;
    }
  | { type: "log"; message: string }
  | { type: "done" }
  | { type: "error"; message: string };

/** Messages sent from ScriptManager (parent) to the SDK (child). */
export type ParentToChild =
  | { type: "invoke"; scriptName: string; parameters: unknown }
  | { type: "thread-result"; requestId: number; result: Result<unknown> };
