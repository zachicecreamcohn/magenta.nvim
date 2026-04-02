import type { SandboxViolationEvent } from "@anthropic-ai/sandbox-runtime";
import type { VDOMNode } from "../tea/view.ts";
import { d, withBindings, withExtmark, withInlineCode } from "../tea/view.ts";
import type { ShellResult } from "./shell.ts";

export type SandboxViolation = {
  command: string;
  violations: SandboxViolationEvent[];
  stderr: string;
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
  absPath: string;
};

type PendingPrompt =
  | PendingApprovalPrompt
  | PendingViolationPrompt
  | PendingWriteApprovalPrompt;

export type PendingViolation = {
  id: string;
  prompt: PendingPrompt;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  resolve: (result: any) => void;
  reject: (err: Error) => void;
};

export class SandboxViolationHandler {
  private pending: Map<string, PendingViolation> = new Map();
  private nextId = 0;

  constructor(private onPendingChange: () => void) {}

  addViolation(
    violation: SandboxViolation,
    retryUnsandboxed: () => Promise<ShellResult>,
  ): Promise<ShellResult> {
    return new Promise<ShellResult>((resolve, reject) => {
      const id = String(this.nextId++);
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
      const id = String(this.nextId++);
      this.pending.set(id, {
        id,
        prompt: { kind: "approval-prompt", command, execute },
        resolve,
        reject,
      });
      this.onPendingChange();
    });
  }

  promptForWriteApproval(absPath: string): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const id = String(this.nextId++);
      this.pending.set(id, {
        id,
        prompt: { kind: "write-approval", absPath },
        resolve,
        reject,
      });
      this.onPendingChange();
    });
  }

  approve(id: string): void {
    const entry = this.pending.get(id);
    if (!entry) return;

    this.pending.delete(id);

    if (entry.prompt.kind === "write-approval") {
      entry.resolve(undefined);
    } else {
      const executeFn =
        entry.prompt.kind === "violation"
          ? entry.prompt.retryUnsandboxed
          : entry.prompt.execute;
      executeFn().then(entry.resolve).catch(entry.reject);
    }

    this.onPendingChange();
  }

  reject(id: string): void {
    const entry = this.pending.get(id);
    if (!entry) return;

    this.pending.delete(id);
    const message =
      entry.prompt.kind === "write-approval"
        ? `The user did not allow writing to ${entry.prompt.absPath}.`
        : "The user did not allow running this command.";
    entry.reject(new Error(message));
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

  getPendingViolations(): Map<string, PendingViolation> {
    return this.pending;
  }

  view(): VDOMNode {
    if (this.pending.size === 0) {
      return d``;
    }

    const entries = [...this.pending.entries()];

    return d`
${entries.map(([id, entry]) => {
  if (entry.prompt.kind === "violation") {
    return d`🔒 Sandbox blocked: ${withInlineCode(d`\`${entry.prompt.violation.command}\``)}
${withExtmark(d`> ${entry.prompt.violation.stderr}`, {
  hl_group: "Comment",
})}
${withBindings(
  withExtmark(d`> APPROVE`, {
    hl_group: ["String", "@markup.strong.markdown"],
  }),
  {
    "<CR>": () => this.approve(id),
  },
)}
${withBindings(
  withExtmark(d`> REJECT`, {
    hl_group: ["ErrorMsg", "@markup.strong.markdown"],
  }),
  {
    "<CR>": () => this.reject(id),
  },
)}
`;
  }
  if (entry.prompt.kind === "write-approval") {
    return d`📝 May I write to ${withInlineCode(d`\`${entry.prompt.absPath}\``)}?
${withBindings(
  withExtmark(d`> NO`, {
    hl_group: ["ErrorMsg", "@markup.strong.markdown"],
  }),
  {
    "<CR>": () => this.reject(id),
  },
)}
${withBindings(
  withExtmark(d`> YES`, {
    hl_group: ["String", "@markup.strong.markdown"],
  }),
  {
    "<CR>": () => this.approve(id),
  },
)}
`;
  }
  return d`⚡ May I run command ${withInlineCode(d`\`${entry.prompt.command}\``)}?
${withBindings(
  withExtmark(d`> NO`, {
    hl_group: ["ErrorMsg", "@markup.strong.markdown"],
  }),
  {
    "<CR>": () => this.reject(id),
  },
)}
${withBindings(
  withExtmark(d`> YES`, {
    hl_group: ["String", "@markup.strong.markdown"],
  }),
  {
    "<CR>": () => this.approve(id),
  },
)}
`;
})}${
  entries.length > 1
    ? d`${withBindings(
        withExtmark(d`> REJECT ALL`, {
          hl_group: ["ErrorMsg", "@markup.strong.markdown"],
        }),
        {
          "<CR>": () => this.rejectAll(),
        },
      )}
${withBindings(
  withExtmark(d`> APPROVE ALL`, {
    hl_group: ["String", "@markup.strong.markdown"],
  }),
  {
    "<CR>": () => this.approveAll(),
  },
)}
`
    : d``
}`;
  }
}
