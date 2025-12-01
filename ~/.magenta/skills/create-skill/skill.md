---
name: create-skill
description: Guide for creating new Claude skills in magenta.nvim, including file structure, frontmatter format, and TypeScript script execution
---

# Creating Skills for magenta.nvim

This guide explains how to create custom skills that extend Claude's capabilities in magenta.nvim.

## Skill Locations

Skills can be placed in two locations:

### Global Skills
- **Location**: `~/.magenta/skills/`
- **Usage**: Available across all projects
- **Use case**: General-purpose skills you want in every project

### Project-Specific Skills
- **Location**: `.claude/skills/` (in your project root)
- **Usage**: Only available in that specific project
- **Use case**: Project-specific workflows, conventions, or documentation

You can configure additional skill paths in your magenta.nvim options by setting the `skillsPaths` option.

## Skill Structure

Each skill lives in its own subdirectory with a `skill.md` file:

```
~/.magenta/skills/
└── your-skill-name/
    ├── skill.md          # Required: main skill documentation
    └── scripts/          # Optional: executable scripts
        └── helper.ts     # Optional: TypeScript scripts
```

## skill.md Format

The `skill.md` file must include YAML frontmatter with required fields:

```markdown
---
name: your-skill-name
description: Brief description of what this skill does and when to use it
---

# Your Skill Documentation

Write your skill documentation here in markdown format.

This can include:
- Detailed explanations
- Code examples
- Best practices
- Step-by-step instructions
- References to other files or resources
```

### Required Frontmatter Fields

- **name**: Unique identifier for the skill (lowercase with hyphens recommended)
- **description**: Short description shown in the skills list (one sentence recommended)

### Frontmatter Notes

- The frontmatter must be at the very beginning of the file
- Use three dashes (`---`) to delimit the YAML block
- The filename `skill.md` is case-insensitive (SKILL.MD, Skill.md also work)

## How Skills Are Used

When a thread is created in magenta.nvim:

1. All skills are discovered and indexed
2. On the first user message, Claude receives a list of available skills
3. The list includes each skill's name, file path, and description
4. Claude is instructed to use `get_file` to read full skill content when relevant

## Writing Effective Skills

### Good Skill Topics

- Project-specific conventions and patterns
- Complex workflows or multi-step processes
- Domain-specific knowledge bases
- Testing patterns and helpers
- Deployment procedures
- Architecture documentation

### Skill Content Tips

- Be specific and actionable
- Include concrete examples
- Reference actual file paths when relevant
- Explain "why" not just "what"
- Keep it focused on one topic or workflow

## TypeScript Scripts in Skills

Skills can include executable TypeScript scripts using Node.js's built-in type stripping.

### Creating a Script

1. Create a `scripts/` directory in your skill folder
2. Add a `.ts` file with a shebang:

```typescript
#!/usr/bin/env node --experimental-strip-types

// Your TypeScript code here
console.log("Hello from a skill script!");

// You can use TypeScript features directly
interface Config {
  name: string;
  value: number;
}

const config: Config = {
  name: "example",
  value: 42
};

console.log(config);
```

3. Make the script executable:

```bash
chmod +x scripts/your-script.ts
```

4. Run it directly:

```bash
./scripts/your-script.ts
# or
~/.magenta/skills/your-skill-name/scripts/your-script.ts
```

### Script Requirements

- **Node.js version**: v22 or higher (for `--experimental-strip-types` support)
- **Shebang**: Must use `#!/usr/bin/env node --experimental-strip-types`
- **File extension**: Use `.ts` for TypeScript files
- **Permissions**: Make executable with `chmod +x`

### Script Limitations

The `--experimental-strip-types` flag provides basic TypeScript support by stripping types:

- ✅ Type annotations
- ✅ Interfaces
- ✅ Type aliases
- ✅ Enums
- ❌ Advanced TypeScript features that require transpilation
- ❌ External dependencies (without additional setup)

For more complex scripts, consider using a proper build setup with `ts-node` or compiling to JavaScript.

## Example: Complete Skill

Here's a complete example of a skill with a script:

**~/.magenta/skills/git-workflow/skill.md**:
```markdown
---
name: git-workflow
description: Team's standard git branching and commit workflow
---

# Git Workflow

Our team uses the following git workflow:

1. Create feature branch from `main`
2. Make changes with atomic commits
3. Run tests before pushing
4. Create PR with description template
5. Squash merge to main

## Branch Naming

- Feature: `feature/short-description`
- Fix: `fix/short-description`
- Chore: `chore/short-description`

## Commit Messages

Follow conventional commits:
- `feat: add new feature`
- `fix: resolve bug`
- `docs: update documentation`
- `test: add tests`
- `refactor: restructure code`

Use the helper script to validate commit messages:
```bash
~/.magenta/skills/git-workflow/scripts/validate-commit.ts "feat: add user login"
```
```

**~/.magenta/skills/git-workflow/scripts/validate-commit.ts**:
```typescript
#!/usr/bin/env node --experimental-strip-types

const message: string = process.argv[2];

const validPrefixes: string[] = ['feat', 'fix', 'docs', 'test', 'refactor', 'chore'];
const pattern: RegExp = /^(feat|fix|docs|test|refactor|chore):\s.+/;

if (!message) {
  console.error('Usage: validate-commit.ts "commit message"');
  process.exit(1);
}

if (pattern.test(message)) {
  console.log('✓ Valid commit message');
  process.exit(0);
} else {
  console.error('✗ Invalid commit message');
  console.error(`Must start with one of: ${validPrefixes.join(', ')}`);
  process.exit(1);
}
```

## Troubleshooting

### Skill Not Found

- Check the skill is in a directory configured in `skillsPaths`
- Verify `skill.md` filename (case-insensitive but must be exact)
- Check YAML frontmatter syntax

### Script Won't Execute

- Verify Node.js version: `node --version` (must be v22+)
- Check shebang is correct
- Verify file is executable: `ls -l scripts/your-script.ts`
- Test the flag: `node --experimental-strip-types --version`

### Skill Not Appearing

- Restart magenta.nvim to reload skills
- Check nvim logs for parsing errors
- Validate YAML frontmatter at [yaml-online-parser.appspot.com](https://yaml-online-parser.appspot.com/)
