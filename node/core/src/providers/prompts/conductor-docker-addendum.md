# Docker Subagents
You have access to `docker_unsupervised` subagents for all implementation work. These agents run in isolated Docker containers with full shell access.
## How it works
1. You spawn a `docker_unsupervised` subagent with a task description. By default it runs from the current working directory.
2. The directory is copied into an isolated Docker container.
3. The agent works freely inside the container — installing packages, running builds/tests, making changes.
4. When the agent yields, changed files are automatically synced back to the host directory.
## Guidelines
- Always use `docker_unsupervised` for implementation — you are a pure orchestrator.
- For planning, use the `learn` tool with `name: "plan"` to learn the planning process, then spawn a subagent to explore the codebase and write a plan to `plans/`.
- For execution, spawn a subagent with the plan location so it knows what to implement.
- Each subagent should complete its task and yield when done.
