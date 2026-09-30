import type {
  PendingApproval,
  ProtocolSessionState,
  SessionThreadSummary,
  ThreadId,
  ThreadOrigin,
} from "@magenta/server";

/** The latest delivered session state plus the hierarchy lookups views need.
 * Chat replaces `state` on every delivery; readers keep a reference to this
 * holder so they always see the latest state. */
export class SessionView {
  private byId = new Map<ThreadId, SessionThreadSummary>();

  constructor(private current: ProtocolSessionState) {
    this.set(current);
  }

  get state(): ProtocolSessionState {
    return this.current;
  }

  set(state: ProtocolSessionState): void {
    this.current = state;
    this.byId = new Map(state.threads.map((t) => [t.id, t]));
  }

  listThreads(): ReadonlyArray<SessionThreadSummary> {
    return this.current.threads;
  }

  getThread(id: ThreadId): SessionThreadSummary | undefined {
    return this.byId.get(id);
  }

  getOrigin(id: ThreadId): ThreadOrigin | undefined {
    return this.byId.get(id)?.origin;
  }

  getRootAncestorId(id: ThreadId): ThreadId {
    return this.byId.get(id)?.rootAncestorId ?? id;
  }

  /** Threads derived from `id` by `type`, in creation order. */
  listDerived<T extends ThreadOrigin["type"]>(
    id: ThreadId,
    type: T,
  ): Array<{ threadId: ThreadId; origin: Extract<ThreadOrigin, { type: T }> }> {
    const isType = (
      o: ThreadOrigin | undefined,
    ): o is Extract<ThreadOrigin, { type: T }> => o?.type === type;
    const derived: Array<{
      threadId: ThreadId;
      origin: Extract<ThreadOrigin, { type: T }>;
    }> = [];
    for (const t of this.current.threads) {
      if (isType(t.origin) && t.origin.sourceThreadId === id) {
        derived.push({ threadId: t.id, origin: t.origin });
      }
    }
    return derived;
  }

  buildChildrenMap(): Map<ThreadId, ThreadId[]> {
    const map = new Map<ThreadId, ThreadId[]>();
    for (const t of this.current.threads) {
      if (t.parentThreadId === undefined) continue;
      map.set(t.parentThreadId, [...(map.get(t.parentThreadId) ?? []), t.id]);
    }
    return map;
  }

  getPendingApprovals(threadId: ThreadId): PendingApproval[] {
    return this.current.pendingApprovals.filter((a) => a.threadId === threadId);
  }

  isSandboxBypassed(id: ThreadId): boolean {
    return this.byId.get(id)?.sandboxBypassed ?? false;
  }
}
