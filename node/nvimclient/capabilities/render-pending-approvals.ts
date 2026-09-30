import type {
  ApprovalId,
  MagentaServer,
  PendingApproval,
  ThreadId,
} from "@magenta/server";
import type { SessionView } from "../chat/session-view.ts";
import {
  d,
  type VDOMNode,
  withBindings,
  withExtmark,
  withInlineCode,
} from "../tea/view.ts";

/** What an approvals view reads and acts on. Pending approvals are session
 * state; the view only renders them and routes the user's decision back. */
export type ApprovalActions = {
  pending: ReadonlyArray<PendingApproval>;
  approve: (id: ApprovalId) => void;
  reject: (id: ApprovalId) => void;
  approveAll: () => void;
  rejectAll: () => void;
};

export function sessionApprovals(
  session: SessionView,
  server: MagentaServer,
  threadId: ThreadId,
): ApprovalActions {
  return {
    pending: session.getPendingApprovals(threadId),
    approve: (approvalId) =>
      void server.execute({ type: "approval.approve", threadId, approvalId }),
    reject: (approvalId) =>
      void server.execute({ type: "approval.reject", threadId, approvalId }),
    approveAll: () =>
      void server.execute({ type: "approval.approveAll", threadId }),
    rejectAll: () =>
      void server.execute({ type: "approval.rejectAll", threadId }),
  };
}

export function renderPendingApprovals(
  session: SessionView,
  server: MagentaServer,
  threadId: ThreadId,
): VDOMNode | undefined {
  if (session.getPendingApprovals(threadId).length === 0) return undefined;
  return d`\n${renderApprovals(sessionApprovals(session, server, threadId))}`;
}
export function renderApprovals(handler: ApprovalActions): VDOMNode {
  const entries = handler.pending;
  if (entries.length === 0) {
    return d``;
  }

  return d`
${entries.map((entry) => {
  const { id } = entry;
  if (entry.prompt.kind === "violation") {
    return d`🔒 Sandbox blocked: ${withInlineCode(d`\`${entry.prompt.command}\``)}
${entry.prompt.violations.map(
  (v) =>
    d`${withExtmark(d`> ${v.line}${v.count > 1 ? ` (x${v.count})` : ""}`, {
      hl_group: "WarningMsg",
    })}\n`,
)}
${withBindings(
  withExtmark(d`> APPROVE`, {
    hl_group: ["String", "@markup.strong.markdown"],
  }),
  {
    "<CR>": () => handler.approve(id),
  },
)}
${withBindings(
  withExtmark(d`> REJECT`, {
    hl_group: ["ErrorMsg", "@markup.strong.markdown"],
  }),
  {
    "<CR>": () => handler.reject(id),
  },
)}
`;
  }
  if (entry.prompt.kind === "network-access") {
    const target =
      entry.prompt.port !== undefined
        ? `${entry.prompt.host}:${entry.prompt.port}`
        : entry.prompt.host;
    return d`🌐 Allow network access to ${withInlineCode(d`\`${target}\``)}?
${withBindings(
  withExtmark(d`> REJECT`, {
    hl_group: ["ErrorMsg", "@markup.strong.markdown"],
  }),
  {
    "<CR>": () => handler.reject(id),
  },
)}
${withBindings(
  withExtmark(d`> APPROVE`, {
    hl_group: ["String", "@markup.strong.markdown"],
  }),
  {
    "<CR>": () => handler.approve(id),
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
    "<CR>": () => handler.reject(id),
  },
)}
${withBindings(
  withExtmark(d`> YES`, {
    hl_group: ["String", "@markup.strong.markdown"],
  }),
  {
    "<CR>": () => handler.approve(id),
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
    "<CR>": () => handler.reject(id),
  },
)}
${withBindings(
  withExtmark(d`> YES`, {
    hl_group: ["String", "@markup.strong.markdown"],
  }),
  {
    "<CR>": () => handler.approve(id),
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
          "<CR>": () => handler.rejectAll(),
        },
      )}
${withBindings(
  withExtmark(d`> APPROVE ALL`, {
    hl_group: ["String", "@markup.strong.markdown"],
  }),
  {
    "<CR>": () => handler.approveAll(),
  },
)}
`
    : d``
}`;
}
