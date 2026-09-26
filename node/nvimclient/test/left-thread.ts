import type { Chat } from "../chat/chat.ts";
import type { NvimThread } from "../chat/thread.ts";

/** The thread the sidebar's left column shows (or last showed). Tests only:
 * production commands resolve their thread from the invoking buffer. */
export function leftThread(chat: Chat): NvimThread {
  const id = chat.state.activeThreadId;
  if (!id) throw new Error(`Chat is not initialized yet... no active thread`);
  return chat.getThread(id);
}
