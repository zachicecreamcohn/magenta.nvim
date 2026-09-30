import type { SandboxViolationEvent } from "@anthropic-ai/sandbox-runtime";
import type { AbsFilePath } from "../utils/files.ts";
import type { OutputLine, ShellResult } from "./shell.ts";

export type ApprovalId = string & { __approvalId: true };

export type SandboxViolation = {
  command: string;
  violations: SandboxViolationEvent[];
  stderr: string;
  result: ShellResult;
};

type PendingApprovalPrompt = {
  kind: "approval-prompt";
  command: string;
  execute: () => Promise<ShellResult>;
};

type PendingViolationPrompt = {
  kind: "violation";
  violation: SandboxViolation;
  retryUnsandboxed: () => Promise<ShellResult>;
};

type PendingWriteApprovalPrompt = {
  kind: "write-approval";
  absPath: AbsFilePath;
};

type PendingNetworkAccessPrompt = {
  kind: "network-access";
  host: string;
  port: number | undefined;
};

type PendingShellPrompt = PendingApprovalPrompt | PendingViolationPrompt;

// Different prompt kinds resolve to different result types, so the pending
// union encodes each kind's resolve signature directly rather than widening to
// a single shared resolve. Shell prompts resolve to a ShellResult, write
// approvals resolve to void, and network-access resolves to a boolean
// (allow/deny the connection).
export type PendingViolation =
  | {
      id: ApprovalId;
      prompt: PendingShellPrompt;
      resolve: (result: ShellResult) => void;
      reject: (err: Error) => void;
    }
  | {
      id: ApprovalId;
      prompt: PendingWriteApprovalPrompt;
      resolve: () => void;
      reject: (err: Error) => void;
    }
  | {
      id: ApprovalId;
      prompt: PendingNetworkAccessPrompt;
      resolve: (allowed: boolean) => void;
      reject: (err: Error) => void;
    };

type NetworkPending = Extract<
  PendingViolation,
  { prompt: PendingNetworkAccessPrompt }
>;

function isNetworkPending(entry: PendingViolation): entry is NetworkPending {
  return entry.prompt.kind === "network-access";
}

type WritePending = Extract<
  PendingViolation,
  { prompt: PendingWriteApprovalPrompt }
>;

function isWritePending(entry: PendingViolation): entry is WritePending {
  return entry.prompt.kind === "write-approval";
}

function normalizeViolationLine(line: string): string {
  // Strip process-specific PIDs so e.g. "sysctl(77444)" and "sysctl(77445)"
  // are treated as the same violation.
  return line.replace(/\(\d+\)/g, "(*)");
}

export function deduplicateViolations(
  violations: SandboxViolationEvent[],
): { line: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const v of violations) {
    const key = normalizeViolationLine(v.line);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts.entries()].map(([line, count]) => ({ line, count }));
}

export class SandboxViolationHandler {
  private pending: Map<ApprovalId, PendingViolation> = new Map();
  private nextId = 0;

  constructor(private onPendingChange: () => void) {}

  addViolation(
    violation: SandboxViolation,
    retryUnsandboxed: () => Promise<ShellResult>,
  ): Promise<ShellResult> {
    return new Promise<ShellResult>((resolve, reject) => {
      const id = String(this.nextId++) as ApprovalId;
      this.pending.set(id, {
        id,
        prompt: { kind: "violation", violation, retryUnsandboxed },
        resolve,
        reject,
      });
      this.onPendingChange();
    });
  }

  promptForApproval(
    command: string,
    execute: () => Promise<ShellResult>,
  ): Promise<ShellResult> {
    return new Promise<ShellResult>((resolve, reject) => {
      const id = String(this.nextId++) as ApprovalId;
      this.pending.set(id, {
        id,
        prompt: { kind: "approval-prompt", command, execute },
        resolve,
        reject,
      });
      this.onPendingChange();
    });
  }

  promptForWriteApproval(absPath: AbsFilePath): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const id = String(this.nextId++) as ApprovalId;
      this.pending.set(id, {
        id,
        prompt: { kind: "write-approval", absPath },
        resolve,
        reject,
      });
      this.onPendingChange();
    });
  }

  promptForNetworkAccess(params: {
    host: string;
    port: number | undefined;
  }): Promise<boolean> {
    return new Promise<boolean>((resolve, reject) => {
      const id = String(this.nextId++) as ApprovalId;
      this.pending.set(id, {
        id,
        prompt: {
          kind: "network-access",
          host: params.host,
          port: params.port,
        },
        resolve,
        reject,
      });
      this.onPendingChange();
    });
  }

  approve(id: ApprovalId): void {
    const entry = this.pending.get(id);
    if (!entry) return;

    this.pending.delete(id);

    if (isNetworkPending(entry)) {
      entry.resolve(true);
      this.onPendingChange();
      return;
    }

    if (isWritePending(entry)) {
      entry.resolve();
    } else {
      const executeFn =
        entry.prompt.kind === "violation"
          ? entry.prompt.retryUnsandboxed
          : entry.prompt.execute;
      executeFn().then(entry.resolve).catch(entry.reject);
    }

    this.onPendingChange();
  }

  reject(id: ApprovalId): void {
    const entry = this.pending.get(id);
    if (!entry) return;

    this.pending.delete(id);

    if (isNetworkPending(entry)) {
      entry.resolve(false);
      this.onPendingChange();
      return;
    }

    if (entry.prompt.kind === "violation") {
      const { result } = entry.prompt.violation;
      const rejectionNote: OutputLine = {
        stream: "stderr",
        text: "The user rejected re-running this command outside the sandbox.",
      };
      entry.resolve({
        ...result,
        output: [...result.output, rejectionNote],
      });
    } else if (entry.prompt.kind === "write-approval") {
      entry.reject(
        new Error(`The user did not allow writing to ${entry.prompt.absPath}.`),
      );
    } else {
      entry.reject(new Error("The user did not allow running this command."));
    }

    this.onPendingChange();
  }

  approveAll(): void {
    for (const [id] of this.pending) {
      this.approve(id);
    }
  }

  rejectAll(): void {
    for (const [id] of this.pending) {
      this.reject(id);
    }
  }

  getPendingViolations(): ReadonlyMap<ApprovalId, PendingViolation> {
    return this.pending;
  }
}
