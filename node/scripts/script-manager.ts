import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import type { ScriptCatalogEntry, ThreadId } from "@magenta/core";
import type { JSONSchemaType } from "openai/lib/jsonschema.mjs";
import { v7 as uuidv7 } from "uuid";
import type {
  MagentaToScript,
  ScriptMeta,
  ScriptToMagenta,
  Result as SdkResult,
} from "../../sdk/protocol.ts";
import {
  escalateToSigkill,
  terminateProcess,
} from "../capabilities/shell-utils.ts";
import type { Chat } from "../chat/chat.ts";
import type { SandboxRoot } from "../chat/thread.ts";
import type { Nvim } from "../nvim/nvim-node/index.ts";
import { openFileInNonMagentaWindow } from "../nvim/openFileInNonMagentaWindow.ts";
import type { MagentaOptions } from "../options.ts";
import type { RootMsg } from "../root-msg.ts";
import type { Dispatch } from "../tea/tea.ts";
import { d, type VDOMNode, withBindings } from "../tea/view.ts";
import {
  type AbsFilePath,
  expandTilde,
  type HomeDir,
  type NvimCwd,
} from "../utils/files.ts";

export type ScriptInvocationId = string & { __scriptInvocationId: true };

export type Msg =
  | { type: "catalog-updated" }
  | { type: "invocation-updated"; id: ScriptInvocationId }
  | { type: "toggle-invocation-expand"; id: ScriptInvocationId }
  | { type: "toggle-invocation-sandbox"; id: ScriptInvocationId };

export type ScriptMsg = {
  type: "script-msg";
  msg: Msg;
};

export type ScriptInvocationStatus = "running" | "done" | "error";

export type ScriptInvocation = {
  id: ScriptInvocationId;
  scriptName: string;
  file: string;
  parameters: unknown;
  status: ScriptInvocationStatus;
  logs: string[];
  threadIds: ThreadId[];
  sandboxBypassed: boolean;
  child: ChildProcess;
  pendingThreads: Map<number, ThreadId>;
};

const REGISTRATION_TIMEOUT_MS = 5000;
const SIGKILL_GRACE_MS = 2000;

export class ScriptManager {
  private catalog: Map<string, { file: string; meta: ScriptMeta }> = new Map();
  public invocations: Map<ScriptInvocationId, ScriptInvocation> = new Map();
  private expandedInvocations: Set<ScriptInvocationId> = new Set();
  private myDispatch: Dispatch<Msg>;

  constructor(
    private context: {
      dispatch: Dispatch<RootMsg>;
      chat: Chat;
      nvim: Nvim;
      cwd: NvimCwd;
      homeDir: HomeDir;
      getScriptsPaths: () => string[];
      getOptions: () => MagentaOptions;
    },
  ) {
    this.myDispatch = (msg) =>
      this.context.dispatch({ type: "script-msg", msg });
  }

  update(msg: RootMsg): void {
    // Most state is mutated directly as IPC events arrive; script-msg dispatches
    // exist mainly to trigger a re-render through the central loop. Expand and
    // sandbox-toggle messages are the exception: they mutate state here.
    if (msg.type !== "script-msg") return;
    switch (msg.msg.type) {
      case "toggle-invocation-expand":
        if (this.expandedInvocations.has(msg.msg.id)) {
          this.expandedInvocations.delete(msg.msg.id);
        } else {
          this.expandedInvocations.add(msg.msg.id);
        }
        return;
      case "toggle-invocation-sandbox": {
        const inv = this.invocations.get(msg.msg.id);
        if (inv) inv.sandboxBypassed = !inv.sandboxBypassed;
        return;
      }
      case "catalog-updated":
      case "invocation-updated":
        return;
    }
  }

  getCatalog(): ScriptMeta[] {
    return [...this.catalog.values()].map((c) => c.meta);
  }

  getScriptCatalog(): ScriptCatalogEntry[] {
    return [...this.catalog.values()].map((c) => ({
      ...c.meta,
      file: c.file,
    }));
  }

  private fork(file: string): ChildProcess {
    return spawn(process.execPath, ["--experimental-transform-types", file], {
      stdio: ["inherit", "inherit", "inherit", "ipc"],
      detached: true,
      env: { ...process.env, MAGENTA_SDK_CHILD: "1" },
    });
  }

  /**
   * Resolve the configured `scriptsPaths` to absolute directories, expanding
   * `~` and resolving relative entries against the cwd. Later paths take
   * precedence on name collisions (project scripts override global ones), so we
   * order earlier entries first and let `discover()` overwrite as it goes.
   */
  private resolveScriptsDirs(): string[] {
    const seen = new Set<string>();
    const dirs: string[] = [];
    for (const entry of this.context.getScriptsPaths()) {
      const expanded = expandTilde(entry, this.context.homeDir);
      const abs = path.resolve(this.context.cwd, expanded);
      if (seen.has(abs)) continue;
      seen.add(abs);
      dirs.push(abs);
    }
    return dirs;
  }

  async discover(): Promise<void> {
    // Yield off the synchronous construction stack: discover() is kicked off
    // from the Magenta constructor, and dispatching `catalog-updated` before
    // construction finishes would touch not-yet-assigned fields (bufferManager).
    await Promise.resolve();
    this.catalog.clear();
    for (const dir of this.resolveScriptsDirs()) {
      if (!existsSync(dir)) continue;

      // Each scripts directory holds independent script installations, one per
      // subdirectory, with a single `index.ts` entry point. That file is
      // responsible for importing every script module so all `registerScript`
      // calls run. Other `.ts` files (shared libs, individual script modules)
      // are never forked directly, which keeps discovery and thread creation
      // predictable.
      let entries: { name: string; isDir: boolean }[];
      try {
        entries = readdirSync(dir, { withFileTypes: true }).map((e) => ({
          name: e.name,
          isDir: e.isDirectory(),
        }));
      } catch {
        continue;
      }

      for (const entry of entries) {
        if (!entry.isDir) continue;
        const indexFile = path.join(dir, entry.name, "index.ts");
        if (!existsSync(indexFile)) continue;

        const metas = await this.captureRegistration(indexFile);
        for (const meta of metas) {
          this.catalog.set(meta.name, { file: indexFile, meta });
        }
      }
    }
    this.myDispatch({ type: "catalog-updated" });
  }

  private captureRegistration(file: string): Promise<ScriptMeta[]> {
    return new Promise((resolve) => {
      const child = this.fork(file);
      const timeout = setTimeout(() => {
        terminateProcess(child);
        resolve([]);
      }, REGISTRATION_TIMEOUT_MS);
      child.once("message", (raw) => {
        const msg = raw as ScriptToMagenta;
        clearTimeout(timeout);
        terminateProcess(child);
        resolve(msg.type === "register" ? msg.scripts : []);
      });
      child.once("error", () => {
        clearTimeout(timeout);
        resolve([]);
      });
      // A file that never registers a script (e.g. a shared library module
      // alongside the scripts) exits without sending a message. Resolve
      // immediately on exit rather than waiting out the registration timeout.
      child.once("exit", () => {
        clearTimeout(timeout);
        resolve([]);
      });
    });
  }

  runScript(
    scriptName: string,
    parameters: unknown,
    opts: { sandboxBypassed: boolean },
  ): ScriptInvocationId {
    const entry = this.catalog.get(scriptName);
    if (!entry) {
      throw new Error(`unknown script ${scriptName}`);
    }

    const id = uuidv7() as ScriptInvocationId;
    const child = this.fork(entry.file);
    const invocation: ScriptInvocation = {
      id,
      scriptName,
      file: entry.file,
      parameters,
      status: "running",
      logs: [],
      threadIds: [],
      sandboxBypassed: opts.sandboxBypassed,
      child,
      pendingThreads: new Map(),
    };
    this.invocations.set(id, invocation);

    child.on("message", (raw) => {
      this.handleChildMessage(id, raw as ScriptToMagenta);
    });
    child.on("exit", () => this.handleChildExit(id));

    this.myDispatch({ type: "invocation-updated", id });
    return id;
  }

  private send(invocation: ScriptInvocation, msg: MagentaToScript): void {
    invocation.child.send(msg);
  }

  private getSandboxRoot(id: ScriptInvocationId): SandboxRoot | undefined {
    const invocation = this.invocations.get(id);
    if (!invocation) return undefined;
    return {
      get isSandboxBypassed() {
        return invocation.sandboxBypassed;
      },
      toggle: () => {
        invocation.sandboxBypassed = !invocation.sandboxBypassed;
        this.myDispatch({ type: "invocation-updated", id });
      },
    };
  }

  private handleChildMessage(
    id: ScriptInvocationId,
    msg: ScriptToMagenta,
  ): void {
    const invocation = this.invocations.get(id);
    if (!invocation) return;

    switch (msg.type) {
      case "register":
        this.send(invocation, {
          type: "run-script",
          scriptName: invocation.scriptName,
          parameters: invocation.parameters,
        });
        return;

      case "log":
        invocation.logs.push(msg.message);
        this.myDispatch({ type: "invocation-updated", id });
        return;

      case "create-thread": {
        const requestId = msg.requestId;
        const options = msg.options;
        this.context.chat
          .spawnScriptThread({
            scriptInvocationId: id,
            prompt: msg.prompt,
            yieldSchema: msg.yieldSchema as JSONSchemaType,
            getSandboxRoot: () => this.getSandboxRoot(id),
            ...(options?.cwd ? { cwd: options.cwd } : {}),
            ...(options?.contextFiles
              ? { contextFiles: options.contextFiles }
              : {}),
            ...(options?.systemReminder
              ? { systemReminder: options.systemReminder }
              : {}),
          })
          .then((threadId) => {
            invocation.threadIds.push(threadId);
            invocation.pendingThreads.set(requestId, threadId);
            this.context.chat.onThreadYielded(threadId, () => {
              const result = this.context.chat.getThreadResult(threadId);
              if (result.status === "done") {
                this.resolveThread(id, requestId, result.result);
              }
            });
            this.myDispatch({ type: "invocation-updated", id });
          })
          .catch((err: unknown) => {
            this.send(invocation, {
              type: "thread-result",
              requestId,
              result: {
                status: "error",
                error: err instanceof Error ? err.message : String(err),
              },
            });
          });
        return;
      }

      case "done":
        invocation.status = "done";
        this.myDispatch({ type: "invocation-updated", id });
        this.terminateInvocation(id);
        return;

      case "error":
        invocation.status = "error";
        invocation.logs.push(`error: ${msg.message}`);
        this.myDispatch({ type: "invocation-updated", id });
        this.terminateInvocation(id);
        return;
    }
  }

  private resolveThread(
    id: ScriptInvocationId,
    requestId: number,
    result:
      | { status: "ok"; value: string }
      | { status: "error"; error: string },
  ): void {
    const invocation = this.invocations.get(id);
    if (!invocation) return;
    if (!invocation.pendingThreads.has(requestId)) return;
    invocation.pendingThreads.delete(requestId);

    let sdkResult: SdkResult<unknown>;
    if (result.status === "ok") {
      let value: unknown;
      try {
        value = JSON.parse(result.value);
      } catch {
        value = result.value;
      }
      sdkResult = { status: "ok", value };
    } else {
      sdkResult = { status: "error", error: result.error };
    }

    this.send(invocation, {
      type: "thread-result",
      requestId,
      result: sdkResult,
    });
  }

  private handleChildExit(id: ScriptInvocationId): void {
    const invocation = this.invocations.get(id);
    if (!invocation) return;
    if (invocation.status === "running") {
      invocation.status = "error";
      this.myDispatch({ type: "invocation-updated", id });
    }
  }

  private terminateInvocation(id: ScriptInvocationId): void {
    const invocation = this.invocations.get(id);
    if (!invocation) return;
    terminateProcess(invocation.child);
    const child = invocation.child;
    setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) {
        escalateToSigkill(child);
      }
    }, SIGKILL_GRACE_MS);
  }

  terminateAll(): void {
    for (const id of this.invocations.keys()) {
      this.terminateInvocation(id);
    }
  }

  private openScriptFile(file: string): void {
    openFileInNonMagentaWindow(file as AbsFilePath, {
      nvim: this.context.nvim,
      cwd: this.context.cwd,
      homeDir: this.context.homeDir,
      options: this.context.getOptions(),
    }).catch((e: Error) => this.context.nvim.logger.error(e.message));
  }

  view(): VDOMNode {
    if (this.invocations.size === 0) {
      return d``;
    }

    const rows: VDOMNode[] = [];
    for (const inv of this.invocations.values()) {
      const icon =
        inv.status === "running" ? "⏳" : inv.status === "done" ? "✅" : "❌";
      const sandboxIndicator = inv.sandboxBypassed ? "🔓" : "🔒";
      const hasThreads = inv.threadIds.length > 0;
      const isExpanded = this.expandedInvocations.has(inv.id);
      const expandIndicator = hasThreads ? (isExpanded ? "▼ " : "▶ ") : "";

      rows.push(
        withBindings(
          d`\n${icon} ${expandIndicator}${sandboxIndicator} ${inv.scriptName} (${inv.status})\n  ${inv.file}`,
          {
            "=": () =>
              this.myDispatch({ type: "toggle-invocation-expand", id: inv.id }),
            "<CR>": () => this.openScriptFile(inv.file),
            t: () =>
              this.myDispatch({
                type: "toggle-invocation-sandbox",
                id: inv.id,
              }),
          },
        ),
      );

      for (const line of inv.logs) {
        rows.push(d`\n  • ${line}`);
      }

      if (hasThreads && isExpanded) {
        for (const threadId of inv.threadIds) {
          for (const view of this.context.chat.renderScriptThreadSubtree(
            threadId,
            1,
          )) {
            rows.push(d`\n${view}`);
          }
        }
      } else if (hasThreads && !isExpanded) {
        for (const threadId of inv.threadIds) {
          for (const view of this.context.chat.collectScriptSubtreeViolationViews(
            threadId,
          )) {
            rows.push(d`\n${view}`);
          }
        }
      }
    }

    return d`\n# Scripts\n${rows}`;
  }
}
