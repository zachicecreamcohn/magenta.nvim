import type { ApprovalId } from "../capabilities/sandbox-violation-handler.ts";
import type {
  ReflectAnchor,
  ScriptInvocationId,
  ThreadId,
} from "../chat-types.ts";
import type { NativeMessageIdx } from "../providers/provider-types.ts";
import type { SessionId } from "../session.ts";
import type { Delivery, SubmissionInput } from "../submission/index.ts";
import type { ToolRequestId } from "../tool-types.ts";
import type { AbsFilePath, UnresolvedFilePath } from "../utils/files.ts";
import type { ProtocolSubmissionResult } from "./state.ts";

export type Operation =
  | { type: "thread.create"; sessionId: SessionId; agent?: string }
  | {
      type: "thread.fork";
      threadId: ThreadId;
      nativeMessageIdx?: NativeMessageIdx;
    }
  | { type: "thread.reflect"; threadId: ThreadId; anchor: ReflectAnchor }
  | { type: "thread.delete"; threadId: ThreadId }
  | {
      type: "thread.submit";
      threadId: ThreadId;
      input: SubmissionInput;
      delivery?: Delivery;
    }
  | { type: "thread.retry"; threadId: ThreadId }
  | { type: "thread.abort"; threadId: ThreadId }
  | { type: "thread.setTitle"; threadId: ThreadId; title: string }
  | { type: "thread.recordActivity"; threadId: ThreadId }
  | {
      type: "thread.addContextFiles";
      threadId: ThreadId;
      files: ReadonlyArray<UnresolvedFilePath>;
    }
  | { type: "thread.removeContextFile"; threadId: ThreadId; file: AbsFilePath }
  | { type: "tool.abort"; threadId: ThreadId; toolRequestId: ToolRequestId }
  | {
      type: "approval.approve" | "approval.reject";
      threadId: ThreadId;
      approvalId: ApprovalId;
    }
  | {
      type:
        | "approval.approveAll"
        | "approval.rejectAll"
        | "approval.approveAllInSubtree";
      threadId: ThreadId;
    }
  | { type: "sandbox.toggleBypass"; threadId: ThreadId }
  | { type: "session.setActiveProfile"; sessionId: SessionId; name: string }
  | {
      type: "script.run";
      sessionId: SessionId;
      name: string;
      parameters: unknown;
    }
  | {
      type: "script.abort" | "script.delete" | "script.toggleSandbox";
      invocationId: ScriptInvocationId;
    }
  | { type: "script.discover"; sessionId: SessionId };

export type OperationResult =
  | {
      type: "ok";
      threadId?: ThreadId;
      invocationId?: ScriptInvocationId;
      submission?: ProtocolSubmissionResult;
    }
  | { type: "aborted" }
  | { type: "error"; message: string };
