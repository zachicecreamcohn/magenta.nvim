export type Role = "user" | "assistant";

export type ThreadId = string & { __threadId: true };

export type MessageIdx = number & { __messageIdx: true };

export type ThreadType =
  | "subagent"
  | "compact"
  | "root"
  | "docker_root"
  | "conductor";

export type SubagentConfig = {
  agentName?: string | undefined;
  fastModel?: boolean | undefined;
  systemPrompt?: string | undefined;
  systemReminder?: string | undefined;
};
