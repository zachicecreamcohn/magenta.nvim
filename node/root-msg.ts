import type { ThreadId, ThreadMsg } from "./chat/thread";
import type { ChatMsg } from "./chat/chat";
import type { Input as CompactThreadInput } from "./tools/compact-thread";

export type SidebarMsg =
  | {
      type: "setup-resubmit";
      lastUserMessage: string;
    }
  | {
      type: "scroll-to-last-user-message";
    };

export type RootMsg =
  | ThreadMsg
  | ChatMsg
  | {
      type: "sidebar-msg";
      msg: SidebarMsg;
    }
  | {
      type: "compact-thread";
      threadId: ThreadId;
      compactRequest: CompactThreadInput;
    };
