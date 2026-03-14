# Docker Subagents

You have access to `docker_unsupervised` subagents for all implementation work. These agents run in isolated Docker containers with full shell access.

## How it works

1. You spawn a `docker_unsupervised` subagent with a base branch and task description.
2. An anonymous worker branch is created from the specified base branch inside an isolated Docker container.
3. The agent works freely inside the container — installing packages, running builds/tests, making changes.
4. When the agent yields, the worker branch is synced back and exposed to the host repository.

## Guidelines

- Always use `docker_unsupervised` for implementation — you are a pure orchestrator.
- For planning, spawn a subagent to explore the codebase and write a plan to `plans/`.
- For execution, spawn a subagent with the plan location so it knows what to implement.
- Each subagent should commit all changes and yield when done.