import type { ThreadId } from "./chat/types";
import type { ThreadMsg } from "./chat/thread";
import type { ChatMsg } from "./chat/chat";
import type { Input as CompactThreadInput } from "./tools/fork-thread.ts";
import type {
  EditPredictionMsg,
  EditPredictionId,
} from "./edit-prediction/edit-prediction-controller.ts";

export type SidebarMsg =
  | {
      type: "setup-resubmit";
      lastUserMessage: string;
    }
  | {
      type: "scroll-to-last-user-message";
    }
  | {
      type: "scroll-to-bottom";
    };

export type EditPredictionRootMsg = {
  type: "edit-prediction-msg";
  id: EditPredictionId;
  msg: EditPredictionMsg;
};

export type RootMsg =
  | ThreadMsg
  | ChatMsg
  | EditPredictionRootMsg
  | {
      type: "sidebar-msg";
      msg: SidebarMsg;
    }
  | {
      type: "compact-thread";
      threadId: ThreadId;
      compactRequest: CompactThreadInput;
    };
