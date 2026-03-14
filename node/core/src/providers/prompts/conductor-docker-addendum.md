# Docker Subagents

You have access to `docker_unsupervised` subagents for all implementation work. These agents run in isolated Docker containers with full shell access.

## How it works

1. You spawn a `docker_unsupervised` subagent with a branch name and task description.
2. The host repo is cloned into the container on a worker branch forked from the specified base branch.
3. The agent works freely inside the container — installing packages, running builds/tests, making changes.
4. When the agent yields, its commits are extracted via `git format-patch` and applied back to the host repository.

## Guidelines

- Always use `docker_unsupervised` for implementation — you are a pure orchestrator.
- For planning, spawn a subagent to explore the codebase and write a plan to `plans/`.
- For execution, spawn a subagent with the plan location so it knows what to implement.
- Each subagent should commit all changes and yield when done.