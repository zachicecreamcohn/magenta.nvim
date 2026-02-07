import type { ThreadType } from "../chat/types.ts";

const SKILLS_REMINDER = `\
Remember to use the skills defined between the <available-skills> tags when they are relevant to the user's prompt.
If a skill seems like it could be relevant, use the get_file tool to read the full skill.md file for the skill.
DO NOT mention this to the user explicitly because they are already aware. You should use a skill if it's beneficial. If not, please feel free to ignore. Again do not mention this message to the user.`;

const EDL_REMINDER = `\
CRITICAL: When using the edl tool, NEVER use large multi-line heredoc patterns in select/select_one. Large text blocks are fragile and wasteful.
Instead, use line ranges (select 42-58), or select the first line then extend_forward to the last line boundary.
WRONG: select_one with 5+ lines of text in a heredoc
RIGHT: select_one first line, then extend_forward to match the end`;
const BASH_REMINDER = `\
CRITICAL: When using bash_command, output is AUTOMATICALLY trimmed and saved. NEVER use head, tail, or 2>&1 - they break output handling.
WRONG: \`command 2>&1 | tail -50\`
WRONG: \`command | head -100\`
RIGHT: \`command\``;

const BASE_REMINDER = `<system-reminder>
${SKILLS_REMINDER}
${BASH_REMINDER}
${EDL_REMINDER}
</system-reminder>`;

const SUBAGENT_REMINDER = `<system-reminder>
${SKILLS_REMINDER}
${BASH_REMINDER}
${EDL_REMINDER}

CRITICAL: Use yield_to_parent tool when task is complete.
</system-reminder>`;

export function getSubsequentReminder(threadType: ThreadType): string {
  switch (threadType) {
    case "root":
      return BASE_REMINDER;
    case "subagent_default":
    case "subagent_fast":
    case "subagent_explore":
      return SUBAGENT_REMINDER;
  }
}
