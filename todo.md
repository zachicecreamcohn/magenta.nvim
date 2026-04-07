# Sandboxes

- add option to always require permissions for certain commands in sandbox. Right now, some commands like git commit && git push will always fail sandbox containment, but the first part of the command runs twice. This should make the command ask for user permission right away if it matches the given regex (like git push), so we don't run the command twice and pointlessly confuse the agent
- when we APPROVE a command, we don't show the live stream for the second attempt
- we should patch sandbox runtime some more to allow projects to further customize their setup. I haven't been able to get puppeteer tests against localhost to work through the sandbox for example (though docker works, thankfully).

# Prompt tuning

- often a subagent will yield using <yield> tags in the message, and not a yield tool call. Probably should update the reminder for subagents to yield using the tool.
- we're still asking explore subagents to read full file contents.

# customization

- All agents should be customizable via the agents directory, including default, explore etc. If these are present in ~ or the project, they should fully replace the system ones
- we should allow the user to specify their own articles discoverable via the learn tool (kinda like skills, but passed to docker subagents)

# docker

- we're still referencing skills and such from the host, which the agent can't actually read
- contextFiles from the host are not available at the same paths on the docker container (we need to remap them or fail the contextFile inclusion)
- instead of providing the docker container setting in magenta options, we should just add it to the tool (so it can select which dir, which dockerfile to use to launch the container, and what the workdir is inside the container). This will let us provide multiple containers for multiple tasks, like separate containers for frontend vs backend testing

# UX

- make the user messages more visually distinct. Background highlight maybe?
- we don't need ``` in the display buffer. Just drop those
- move towards having separate buffers for each thread, so jump navigation works properly
- collapse threads in the thread overview by default, and only show subthreads when expanded via "="
- show pending permissions / sandbox failures in the thread overview
- can we amend the terminal or tmux's view to notify them that the agent is waiting or stopped?
- startup time still occasionally slow. Need debugging
- drop the full context listing, instead just show the pending context updates
- when the AI ends its turn, show a summary of all the edited files, so we can easily navigate to them
- when we have pending @async messages, we should show the text of the message instead of just the message count

# bug fixes, misc

- there's errors/warnings when we switch threads during streaming
- let's drop the compose mode to just be a special subagent. We should just create a way to start a new (root) thread from one of the subagents
- fork a conversation from any previous message

- this periodic error:

```
[ERROR] job# 3:
[Thread 019d65c4-5c0a-70bb-9882-732030e3427c] myUpdate: tool-progress
```
