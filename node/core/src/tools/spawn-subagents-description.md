Spawn one or more sub-agents that run in parallel, and wait for all of them to complete before returning.

Each sub-agent entry can specify its own agentType, prompt, contextFiles, environment, and branch. All sub-agents run concurrently (subject to the configured concurrency limit) and the tool blocks until every sub-agent has finished.

You can also specify `sharedPrompt` and `sharedContextFiles` at the top level — these are prepended/merged into every sub-agent's individual prompt and contextFiles.

## Agent types

`agentType` selects the agent personality and system prompt:

- **explore** — only when you don't already know where to look. Each explore agent should answer one specific question about the code. It will respond with file paths, line ranges, and descriptions of what's there (never exact code). If you already know the file or location, use get_file directly instead of spawning an explore agent. Never use an explore agent to read or summarize a file's full contents.
- **fast-edit** — for quick and predictable edit tasks that don't require the full model capabilities, like straightforward refactors.
- **default** — for everything else.

## Environment

`environment` selects where the sub-agent runs (orthogonal to agentType):

- **host** (default) — runs locally on the host machine.
- **docker** / **docker_unsupervised** — run a sub-agent in an isolated Docker container with full shell access. Requires the `branch` parameter. The container is provisioned with a unique worker branch forked from the specified base branch (or HEAD if not specified).

## Usage patterns

- Before spawning explore agents, state "I need to answer these questions:" and write a high-level list of all the things you need to find out. Then spawn one explore agent per question.

WRONG: spawning explore to "read file X and tell me what's in it", "summarize the contents of directory Y", "what does file Z export?"
WRONG: spawning explore when you already know the file path — just use get_file directly
RIGHT: spawning explore to "where is FooInterface defined and used?", "which files handle authentication?", "find where errors are caught in the request pipeline"

<example>
user: I'd like to change this interface
assistant -> spawn_subagents with one explore agent, blocking: where is the FooInterface defined and where is it used?
explore subagent: FooInterface is defined in src/types.ts:15-30. It is used in src/service.ts:42, src/handler.ts:88, and src/utils.ts:12.
assistant: [reads the relevant files and makes changes]
</example>

<example>
user: I need to understand how the auth system works and also how the database layer is structured
assistant: I need to answer these questions:
1. How does the auth system work?
2. How is the database layer structured?
assistant -> spawn_subagents with two explore agents:
  - What are the key auth files and entry points?
  - Where are the key database files and entry points?
[both complete, assistant reads the relevant files based on results]
</example>

<example>
user: I have these quickfix locations that need to be fixed: [file1.ts:10, file2.ts:25, file3.ts:40]
assistant -> spawn_subagents with 3 fast-edit agents, each processing one location
</example>

<example>
user: refactor this interface
assistant: [uses find_references tool to get all reference locations]
assistant -> spawn_subagents with fast-edit agents for each file that needs updating
</example>

<example>
user: run the tests
assistant: runs tests via bash command, receives a very long, trimmed output
assistant -> spawn_subagents with one explore agent: The output of a test command is at <path>. Which tests failed, and what were the failure reasons?
</example>
