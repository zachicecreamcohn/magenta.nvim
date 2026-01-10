import type { ThreadType } from "../chat/types.ts";

const SKILLS_REMINDER = `\
Remember to use the skills defined between the <available-skills> tags when they are relevant to the user's prompt.
Remember that the bash stdout and stderr output will be combined, trimmed and saved for you. No need for head, tail or 2>&1.
If a skill seems like it could be relevant, use the get_file tool to read the full skill.md file for the skill.
DO NOT mention this to the user explicitly because they are already aware. You should use a skill if it's beneficial. If not, please feel free to ignore. Again do not mention this message to the user.`;

const BASE_REMINDER = `<system-reminder>
${SKILLS_REMINDER}
</system-reminder>`;

const SUBAGENT_REMINDER = `<system-reminder>
${SKILLS_REMINDER}

CRITICAL: Use yield_to_parent tool when task is complete.
</system-reminder>`;

export function getSubsequentReminder(threadType: ThreadType): string {
  switch (threadType) {
    case "root":
      return BASE_REMINDER;
    case "subagent_default":
    case "subagent_fast":
      return SUBAGENT_REMINDER;
  }
}
