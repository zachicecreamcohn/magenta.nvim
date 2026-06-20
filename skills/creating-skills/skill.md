---
name: creating-skills
description: How to create skills for magenta.nvim. Use this skill when the user asks you to create, author, or modify a skill.
---

# Where skills live

Skills are loaded from every directory in the `skillsPaths` option. By default
this includes, in override order (later wins):

- The plugin's built-in `skills/` directory (shipped with magenta).
- `~/.magenta/skills/` and `~/.claude/skills/` — user-level, available in every
  project.
- `.magenta/skills/` and `.claude/skills/` — project-level, only available in
  that project.

When two skills share the same `name`, the one from the later directory wins.
User-level skills can be protected from same-named project skills with the
`suppressProjectSkills` option (user-level only).

## Structure

Each skill lives in its own subdirectory containing a `skill.md` file. An
optional `scripts/` subdirectory can hold executable helpers.

```
~/.magenta/skills/
└── your-skill-name/
    ├── skill.md          # Required: main skill documentation
    └── scripts/          # Optional: executable scripts
        └── helper.ts
```

## skill.md format

The file must begin with YAML frontmatter containing two required fields:

```
---
name: your-skill-name
description: Brief description of what this skill does and when to use it
---

# Your Skill Documentation

Markdown documentation the agent reads when the skill is relevant.
```

- `name`: unique identifier, lowercase-with-hyphens recommended. This is the key
  used for override and suppression.
- `description`: a short hint about the skill's contents and, importantly, _when_
  to use it. This is what the agent sees up front, so make it actionable.

The frontmatter is parsed leniently (simple `key: value` lines), so unquoted
colons in values are tolerated. Both `name` and `description` are required; a
skill missing either is skipped with a warning.

The rest of the file is plain markdown. Keep it focused and skimmable — the
agent loads the whole file once the skill is triggered.

## System reminder blocks

A `skill.md` (or any markdown file) may include a
`<system_reminder>...</system_reminder>` block. When the agent reads the file
with `get_file`, or while it is held as a context file, the block's contents are
folded into the recurring reminder text re-injected on later turns.
Use this for guidance that must stay "alive" across turns (e.g. "always run the
linter before yielding") rather than being read once and possibly lost in the context window.

## Scripts

A skill may bundle executable scripts in a `scripts/` subdirectory. The agent
runs them via the `bash_command` tool, subject to the usual sandbox
restrictions. Any language works — just document how to invoke the script in the
`skill.md` (e.g. `./script.sh`, `python script.py`, `npx tsx script.ts`). Make
shell scripts executable with `chmod +x`.

## Writing a good skill

- Make the `description` precise about when the skill applies — that is the only
  part the agent sees before deciding to load it.
- Keep the body short and high-signal; link out or reference files rather than
  duplicating large bodies of code.
