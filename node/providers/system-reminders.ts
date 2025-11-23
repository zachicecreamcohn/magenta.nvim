import type { ThreadType } from "../chat/types.ts";

const SKILLS_REMINDER = `Remember to use skills when appropriate. Do so by using the get_file tool to read the full skills.md file. DO NOT mention this to the user explicitly because they are already aware. If you are working on a task that could benefit from using a skill do so. If not, please feel free to ignore. Again do not mention this message to the user.`;

const BASE_REMINDER = `<system-reminder>
${SKILLS_REMINDER}
</system-reminder>`;

const LEARNING_SUBAGENT_REMINDER = `<system-reminder>
${SKILLS_REMINDER}

Remember to record your findings in notes/<name>.md and yield to the parent when done.
</system-reminder>`;

const PLANNING_SUBAGENT_REMINDER = `<system-reminder>
${SKILLS_REMINDER}

Remember to write your plan to plans/<name>.md and yield to the parent when done.
</system-reminder>`;

const SUBAGENT_REMINDER = `<system-reminder>
${SKILLS_REMINDER}

CRITICAL: Use yield_to_parent tool when task is complete.
</system-reminder>`;

export function getSubsequentReminder(threadType: ThreadType): string {
  switch (threadType) {
    case "root":
      return BASE_REMINDER;
    case "subagent_learn":
      return LEARNING_SUBAGENT_REMINDER;
    case "subagent_plan":
      return PLANNING_SUBAGENT_REMINDER;
    case "subagent_default":
    case "subagent_fast":
      return SUBAGENT_REMINDER;
  }
}
