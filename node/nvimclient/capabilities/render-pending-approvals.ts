import {
  deduplicateViolations,
  type SandboxViolationHandler,
  type Session,
  type ThreadId,
} from "@magenta/server";
import {
  d,
  type VDOMNode,
  withBindings,
  withExtmark,
  withInlineCode,
} from "../tea/view.ts";

/** What an approvals view reads and acts on. Pending approvals are session
 * state; the view only renders them and routes the user's decision back. */
export type ApprovalActions = Pick<
  SandboxViolationHandler,
  "getPendingViolations" | "approve" | "reject" | "approveAll" | "rejectAll"
>;

export function sessionApprovals(
  session: Session,
  threadId: ThreadId,
): ApprovalActions {
  return {
    getPendingViolations: () => session.getPendingApprovals(threadId),
    approve: (id) => session.approve(threadId, id),
    reject: (id) => session.reject(threadId, id),
    approveAll: () => session.approveAll(threadId),
    rejectAll: () => session.rejectAll(threadId),
  };
}

export function renderPendingApprovals(
  session: Session,
  threadId: ThreadId,
): VDOMNode | undefined {
  if (session.getPendingApprovals(threadId).size === 0) return undefined;
  return d`\n${renderApprovals(sessionApprovals(session, threadId))}`;
}
export function renderApprovals(handler: ApprovalActions): VDOMNode {
  const pending = handler.getPendingViolations();
  if (pending.size === 0) {
    return d``;
  }

  const entries = [...pending.entries()];

  return d`
${entries.map(([id, entry]) => {
  if (entry.prompt.kind === "violation") {
    const dedupedViolations = deduplicateViolations(
      entry.prompt.violation.violations,
    );
    return d`🔒 Sandbox blocked: ${withInlineCode(d`\`${entry.prompt.violation.command}\``)}
${dedupedViolations.map(
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
