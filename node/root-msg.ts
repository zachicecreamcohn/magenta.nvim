import type { ThreadMsg } from "./chat/thread";
import type { ChatMsg } from "./chat/chat";

export type RootMsg =
  | ThreadMsg
  | ChatMsg
  | {
      type: "sidebar-setup-resubmit";
      lastUserMessage: string;
    };
