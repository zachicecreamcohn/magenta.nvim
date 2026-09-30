import type { Thread, ThreadCompactor } from "@magenta/server";
import type { Chat } from "../chat/chat.ts";
import type { NvimThread } from "../chat/thread.ts";

/** The thread the sidebar's left column shows (or last showed). Tests only:
 * production commands resolve their thread from the invoking buffer. */
export function leftThread(chat: Chat): NvimThread {
  const id = chat.state.left;
  if (!id) throw new Error(`Chat is not initialized yet... no active thread`);
  return chat.getThread(id);
}

function serverRecord(view: NvimThread) {
  const record = view.context.chat.session.getThread(view.id);
  if (record?.state !== "initialized") {
    throw new Error(`Thread ${view.id} is not ready`);
  }
  return record;
}

/** White-box: the live server Thread behind a view. Views only see thread
 * state; tests that inspect server internals reach through the session. */
export function serverThread(view: NvimThread): Thread {
  return serverRecord(view).thread;
}

export function serverCompactor(view: NvimThread): ThreadCompactor | undefined {
  return serverRecord(view).compactor;
}
