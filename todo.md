# Sandboxes

- we should patch sandbox runtime some more to allow projects to further customize their setup. I haven't been able to get puppeteer tests against localhost to work through the sandbox for example (though running in docker works, thankfully).

# Prompt tuning

- often a subagent will yield using <yield> tags in the message, and not a yield tool call. Probably should update the reminder for subagents to yield using the tool.
- the lead agent is still asking explore subagents to read full file contents.

# customization

- All agents should be customizable via the agents directory, including default, explore etc. If these are present in ~ or the project, they should fully replace the system ones
- we should consolidate all the learn articles in the neovim docs, and allow the user to specify their own articles discoverable via the learn tool (kinda like skills, but passed to docker subagents)

# docker

- we're still referencing skills and such from the host, which the agent can't actually read
- contextFiles from the host are not available at the same paths on the docker container (we need to remap them or fail the contextFile inclusion)

# UX

- make the user messages more visually distinct. Background highlight maybe?
- we don't need ``` in the display buffer. Just drop those
- collapse threads in the thread overview by default, and only show subthreads when expanded via "="
- show pending permissions / sandbox failures in the thread overview
- can we amend the terminal or tmux's view to notify them that the agent is waiting or stopped?
- startup time still occasionally slow. Need debugging
- drop the full context listing, instead just show the pending context updates
- when the AI ends its turn, show a summary of all the edited files, so we can easily navigate to them
- when we have pending @async messages, we should show the text of the message instead of just the message count
- fork a conversation from any previous message

# bug fixes, misc

- there's errors/warnings when we switch threads during streaming
- this periodic error:

```
[ERROR] job# 3:
[Thread 019d65c4-5c0a-70bb-9882-732030e3427c] myUpdate: tool-progress
```
