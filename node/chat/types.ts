export type Role = "user" | "assistant";

export type ThreadId = number & { __threadId: true };

export type MessageIdx = number & { __messageIdx: true };

export type ThreadType = "subagent_default" | "subagent_fast" | "root";
