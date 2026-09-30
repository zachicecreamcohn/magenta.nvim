import type { ScriptInvocationId, ThreadId } from "../chat-types.ts";
import type { ScriptManager } from "../scripts/script-manager.ts";
import type { Session, SessionEvents, SessionId } from "../session.ts";
import type { Thread } from "../thread.ts";
import { ABORTED, type Aborted } from "../thread-api.ts";
import type { ClientEffectHandler } from "./client.ts";
import type { Operation, OperationResult } from "./operations.ts";
import {
  globalState,
  type ProtocolGlobalState,
  type ProtocolScriptState,
  type ProtocolSessionState,
  type ProtocolThreadState,
  scriptState,
  sessionState,
  submissionResult,
  threadState,
} from "./state.ts";

type TopicFields = {
  global: object;
  session: { sessionId: SessionId };
  script: { invocationId: ScriptInvocationId };
  thread: { threadId: ThreadId };
};
type StateMap = {
  global: ProtocolGlobalState;
  session: ProtocolSessionState;
  script: ProtocolScriptState;
  thread: ProtocolThreadState;
};
type TopicType = keyof StateMap;
type TopicOf<K extends TopicType> = { type: K } & TopicFields[K];

export type Topic = { [K in TopicType]: TopicOf<K> }[TopicType];
export type StateFor<T extends Topic> = StateMap[T["type"]];

export interface MagentaServer {
  /** Delivers the current state immediately and after every change
   * (coalesced per microtask). `undefined` means the target is gone; it is
   * delivered once and the subscription ends. */
  subscribe<K extends TopicType>(
    topic: TopicOf<K>,
    listener: (state: StateMap[K] | undefined) => void,
  ): () => void;
  /** The current state, or `undefined` if the target is gone or not ready. */
  getState<K extends TopicType>(topic: TopicOf<K>): StateMap[K] | undefined;
  execute(op: Operation): Promise<OperationResult>;
  attachClient(client: ClientEffectHandler): void;
  detachClient(): void;
  dispose(): Promise<void>;
}

export type InProcessServerDeps = {
  session: Session;
  scripts?: ScriptManager;
};

/** Thrown for unknown ids; `execute` reports it as an error result. */
class UnknownTarget extends Error {}

/** Projected state for a topic: a value, `undefined` once gone, or `waiting`
 * while a thread is still being created (nothing to deliver yet). */
type Projection<S> = S | undefined | "waiting";

export function createInProcessServer({
  session,
  scripts,
}: InProcessServerDeps): MagentaServer {
  const closers = new Set<() => void>();

  const projectors: {
    [K in TopicType]: (topic: TopicOf<K>) => Projection<StateMap[K]>;
  } = {
    global: () => globalState(session),
    session: (topic) =>
      topic.sessionId === session.id
        ? sessionState(session, scripts)
        : undefined,
    script: (topic) =>
      scripts ? scriptState(scripts, topic.invocationId) : undefined,
    thread: (topic) => {
      const record = session.getThread(topic.threadId);
      if (!record || record.state === "error") return undefined;
      if (record.state === "pending") return "waiting";
      return threadState(record.thread, record.compactor, session);
    },
  };

  function project<K extends TopicType>(
    topic: TopicOf<K>,
  ): Projection<StateMap[K]> {
    return projectors[topic.type](topic);
  }

  /** Registers the change sources for a topic, returning detach functions. */
  type Watcher<K extends TopicType> = (
    topic: TopicOf<K>,
    schedule: () => void,
  ) => Array<() => void>;

  function listen<E extends keyof SessionEvents>(
    event: E,
    handler: (...args: SessionEvents[E]) => void,
  ): () => void {
    session.on(event, handler);
    return () => session.off(event, handler);
  }

  function listenScripts(
    handler: (id?: ScriptInvocationId) => void,
  ): Array<() => void> {
    if (!scripts) return [];
    const events = [
      "catalogChanged",
      "invocationChanged",
      "invocationRemoved",
    ] as const;
    return events.map((event) => {
      scripts.on(event, handler);
      return () => scripts.off(event, handler);
    });
  }

  const sessionWide = (schedule: () => void) => [
    listen("changed", schedule),
    listen("removed", schedule),
    listen("settings-changed", schedule),
  ];

  const watchers: { [K in TopicType]: Watcher<K> } = {
    global: (_topic, schedule) => sessionWide(schedule),
    session: (_topic, schedule) => [
      ...sessionWide(schedule),
      ...listenScripts(schedule),
    ],
    script: (topic, schedule) => [
      ...sessionWide(schedule),
      ...listenScripts((id) => {
        if (id === topic.invocationId) schedule();
      }),
    ],
    thread: (topic, schedule) => {
      let detachCompactor: (() => void) | undefined;
      // The compactor only exists once the thread is ready.
      const attachCompactor = () => {
        if (detachCompactor) return;
        const record = session.getThread(topic.threadId);
        if (record?.state !== "initialized") return;
        const compactor = record.compactor;
        compactor?.on("transition", schedule);
        detachCompactor = () => compactor?.off("transition", schedule);
      };
      const onThread = (id: ThreadId) => {
        if (id !== topic.threadId) return;
        attachCompactor();
        schedule();
      };
      attachCompactor();
      return [
        listen("changed", onThread),
        listen("removed", onThread),
        () => detachCompactor?.(),
      ];
    },
  };

  function watch<K extends TopicType>(
    topic: TopicOf<K>,
    schedule: () => void,
  ): Array<() => void> {
    return watchers[topic.type](topic, schedule);
  }

  function subscribe<K extends TopicType>(
    topic: TopicOf<K>,
    listener: (state: StateMap[K] | undefined) => void,
  ): () => void {
    let closed = false;
    let scheduled = false;
    const close = () => {
      if (closed) return;
      closed = true;
      closers.delete(close);
      for (const d of detach) d();
    };
    const deliver = () => {
      if (closed) return;
      const state = project(topic);
      if (state === "waiting") return;
      listener(state);
      if (state === undefined) close();
    };
    function schedule() {
      if (scheduled || closed) return;
      scheduled = true;
      queueMicrotask(() => {
        scheduled = false;
        deliver();
      });
    }
    const detach = watch(topic, schedule);
    closers.add(close);
    deliver();
    return close;
  }

  function getState<K extends TopicType>(
    topic: TopicOf<K>,
  ): StateMap[K] | undefined {
    const state = project(topic);
    return state === "waiting" ? undefined : state;
  }

  function readyThread(id: ThreadId): Thread {
    const record = session.getThread(id);
    if (record?.state !== "initialized") {
      throw new UnknownTarget(`Unknown thread ${id}`);
    }
    return record.thread;
  }

  function knownThread(id: ThreadId): void {
    if (!session.getThread(id)) throw new UnknownTarget(`Unknown thread ${id}`);
  }

  function requireSession(id: SessionId): void {
    if (id !== session.id) throw new UnknownTarget(`Unknown session ${id}`);
  }

  function requireScripts(): ScriptManager {
    if (!scripts) throw new UnknownTarget("Scripts are not available");
    return scripts;
  }

  function requireInvocation(id: ScriptInvocationId): ScriptManager {
    const manager = requireScripts();
    if (!manager.getInvocation(id)) {
      throw new UnknownTarget(`Unknown script invocation ${id}`);
    }
    return manager;
  }

  function created(id: ThreadId | Aborted): OperationResult {
    return id === ABORTED
      ? { type: "aborted" }
      : { type: "created", threadId: id };
  }

  async function dispatch(op: Operation): Promise<OperationResult> {
    switch (op.type) {
      case "thread.create":
        requireSession(op.sessionId);
        return created(
          await (op.agent
            ? session.createAgentThread(op.agent)
            : session.createRootThread()),
        );
      case "thread.fork":
        return created(
          await session.forkThread(op.threadId, op.nativeMessageIdx),
        );
      case "thread.reflect":
        return created(await session.reflectThread(op.threadId, op.anchor));
      case "thread.delete":
        knownThread(op.threadId);
        session.deleteThread(op.threadId);
        return { type: "ok" };
      case "thread.submit": {
        const thread = readyThread(op.threadId);
        if (op.delivery === "async" || op.delivery === "next") {
          thread.enqueue(op.input, op.delivery);
          return { type: "queued" };
        }
        return {
          type: "submitted",
          submission: submissionResult(await thread.submit(op.input)),
        };
      }
      case "thread.retry":
        return {
          type: "submitted",
          submission: submissionResult(await readyThread(op.threadId).retry()),
        };
      case "thread.abort":
        knownThread(op.threadId);
        await session.abortThread(op.threadId);
        return { type: "ok" };
      case "thread.setTitle":
        readyThread(op.threadId).setTitle(op.title);
        return { type: "ok" };
      case "thread.recordActivity":
        knownThread(op.threadId);
        session.recordActivity(op.threadId);
        return { type: "ok" };
      case "thread.addContextFiles":
        await readyThread(op.threadId).contextFiles.addFiles(op.files);
        return { type: "ok" };
      case "thread.removeContextFile":
        readyThread(op.threadId).contextFiles.removeFileContext(op.file);
        return { type: "ok" };
      case "tool.abort": {
        const state = readyThread(op.threadId).state;
        const entry =
          state.type === "running" &&
          state.activity.type === "running_tools" &&
          state.activity.tools.type === "running"
            ? state.activity.tools.activeTools.get(op.toolRequestId)
            : undefined;
        if (!entry) {
          throw new UnknownTarget(`No running tool ${op.toolRequestId}`);
        }
        entry.handle.abort();
        return { type: "ok" };
      }
      case "approval.approve":
      case "approval.reject":
        if (!session.getPendingApprovals(op.threadId).has(op.approvalId)) {
          throw new UnknownTarget(`Unknown approval ${op.approvalId}`);
        }
        if (op.type === "approval.approve") {
          session.approve(op.threadId, op.approvalId);
        } else {
          session.reject(op.threadId, op.approvalId);
        }
        return { type: "ok" };
      case "approval.approveAll":
        knownThread(op.threadId);
        session.approveAll(op.threadId);
        return { type: "ok" };
      case "approval.rejectAll":
        knownThread(op.threadId);
        session.rejectAll(op.threadId);
        return { type: "ok" };
      case "approval.approveAllInSubtree":
        knownThread(op.threadId);
        session.approveAllPendingInSubtree(op.threadId);
        return { type: "ok" };
      case "sandbox.toggleBypass":
        knownThread(op.threadId);
        session.toggleSandboxBypass(op.threadId);
        return { type: "ok" };
      case "session.setActiveProfile":
        requireSession(op.sessionId);
        session.setActiveProfile(op.name);
        return { type: "ok" };
      case "script.run": {
        requireSession(op.sessionId);
        const invocationId = requireScripts().startScript(
          op.name,
          op.parameters,
          { sandboxBypassed: false },
        );
        return { type: "started", invocationId };
      }
      case "script.abort":
        requireInvocation(op.invocationId).abortInvocation(op.invocationId);
        return { type: "ok" };
      case "script.delete":
        requireInvocation(op.invocationId).deleteInvocation(op.invocationId);
        return { type: "ok" };
      case "script.toggleSandbox":
        requireInvocation(op.invocationId).toggleInvocationSandbox(
          op.invocationId,
        );
        return { type: "ok" };
      case "script.discover":
        requireSession(op.sessionId);
        await requireScripts().discover();
        return { type: "ok" };
    }
  }

  return {
    subscribe,
    getState,
    async execute(op) {
      try {
        return await dispatch(op);
      } catch (error) {
        return {
          type: "error",
          message: error instanceof Error ? error.message : String(error),
        };
      }
    },
    attachClient: (client) => session.attachClient(client),
    detachClient: () => session.detachClient(),
    // The composition root still owns the session and script manager in this
    // stage; disposing the server only ends subscriptions.
    async dispose() {
      for (const close of [...closers]) close();
    },
  };
}
