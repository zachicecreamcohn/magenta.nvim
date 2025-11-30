Right now planning and learning prompts are implemented as specialized subagent types. I want to make them skills instead, and simplify the subagent tool.

Skills currently live in user-provided directories, but I want these two skills to be packaged with the plugin itself.

# Context

## Relevant Files

### Skills System

- `node/providers/skills.ts` - Contains `loadSkills()` and `formatSkillsIntroduction()`
  - Discovers skills from `skillsPaths` directories
  - Parses YAML frontmatter from skill.md files
  - Generates skills introduction text appended to system prompt

### Options

- `node/options.ts` - Contains `MagentaOptions` type and parsing
  - `skillsPaths: string[]` defaults to `["~/.claude/skills", ".claude/skills"]`
  - Skills paths are merged (not replaced) when project settings override base settings

### System Prompts

- `node/providers/system-prompt.ts` - Contains all system prompts
  - `LEARN_SUBAGENT_SYSTEM_PROMPT` - Learning/research prompt with discovery process
  - `PLAN_SUBAGENT_SYSTEM_PROMPT` - Planning prompt with plan format instructions
  - `AGENT_TYPES = ["learn", "plan", "default", "fast"]`
  - `createSystemPrompt()` assembles base prompt + system info + skills

### Subagent Tool

- `node/tools/spawn-subagent.ts` - Spawn subagent tool
  - Maps `agentType` to `ThreadType`: learn → subagent_learn, plan → subagent_plan, etc.
  - Tool spec describes when to use each agent type

### Chat Types

- `node/chat/types.ts` - Contains `ThreadType` including subagent variants

## Current Flow

1. User spawns subagent with `agentType: "learn"` or `"plan"`
2. `spawn-subagent.ts` maps to `ThreadType` (e.g., `subagent_learn`)
3. Thread created with that type
4. `createSystemPrompt()` returns specialized prompt based on type
5. Subagent runs with specialized prompt

## Target Flow

1. User spawns subagent (no specialized agentType needed)
2. Skills (including built-in learn/plan skills) appear in system prompt
3. LLM reads skill file when relevant using get_file tool
4. Subagent follows skill instructions

# Implementation Plan

## 1. Create built-in skills directory

- [ ] Create `node/skills/` directory for built-in skills
- [ ] Create `node/skills/learn/skill.md` with learning instructions from `LEARN_SUBAGENT_SYSTEM_PROMPT`
- [ ] Create `node/skills/plan/skill.md` with planning instructions from `PLAN_SUBAGENT_SYSTEM_PROMPT`

## 2. Update skills loading to include built-in skills

- [ ] Prepend built-in skills directory to `skillsPaths` in options
  - Determine path to `node/skills/` at runtime using `__dirname` or similar
  - Add to front of `skillsPaths` array so user skills can override built-in ones
  - do this in `parseOptions()`
- [ ] Ensure the path resolution works correctly for the bundled plugin location

## 3. Simplify subagent system

- [ ] Remove `"learn"` and `"plan"` from `AGENT_TYPES` (keep `"default"` and `"fast"`)
- [ ] Simplify `ThreadType` to remove `subagent_learn` and `subagent_plan`
- [ ] Update `spawn-subagent.ts` to only support `default` and `fast` agent types
- [ ] Update tool spec to remove references to specialized agent types
- [ ] Remove `LEARN_SUBAGENT_SYSTEM_PROMPT` and `PLAN_SUBAGENT_SYSTEM_PROMPT` from system-prompt.ts
- [ ] Clean up system prompt text about how to use the subagent tool for learning / planning
- [ ] Update `createSystemPrompt()` to only return `DEFAULT_SUBAGENT_SYSTEM_PROMPT` for all subagents

## 4. Update skill content

- [ ] Adapt `LEARN_SUBAGENT_SYSTEM_PROMPT` content into skill.md format with YAML frontmatter
- [ ] Adapt `PLAN_SUBAGENT_SYSTEM_PROMPT` content into skill.md format with YAML frontmatter
- [ ] Ensure skills reference using get_file tool to read full instructions

### Skill File Format

Skills are markdown files with YAML frontmatter. Required fields:

- `name`: Skill identifier (used in skills listing)
- `description`: Brief description shown in system prompt

Example structure for `node/skills/learn/skill.md`:

```markdown
---
name: learn
description: Guide for learning and researching parts of a codebase before implementing changes
---

# Learning Process

...etc...
```

## 5. Testing

- [ ] Verify built-in skills are discovered and listed in system prompt
- [ ] Ensure user skills can override built-in skills (later directories win)
