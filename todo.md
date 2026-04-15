# Sandboxes

- we should patch sandbox runtime some more to allow projects to further customize their setup. I haven't been able to get puppeteer tests against localhost to work through the sandbox for example (though running in docker works, thankfully).

# Prompt tuning

# customization

# docker

- we're still referencing some files from the host, which the agent can't actually read

# UX

- make the user messages more visually distinct. Background highlight maybe?
- we don't need ``` in the display buffer. Just drop those
- collapse threads in the thread overview by default, and only show subthreads when expanded via "="
- show pending permissions / sandbox failures in the thread overview
- startup time still occasionally slow. Need debugging
- drop the full context listing, instead just show the pending context updates
- when the AI ends its turn, show a summary of all the edited files, so we can easily navigate to them
- when we have pending @async messages, we should show the text of the message instead of just the message count

# features

- fork a conversation from any previous message
- add context tracking for the state of git. When we change branches, commit, etc...

# bug fixes, misc

- when we abort during a "sandbox blocked" message, it stays up even as the conversation continues
  - this has broken a few times already, make sure we have a good test for it
- when we error upon a user message send, we should pop the user message off the agent's history, otherwise we end up sending it twice
- this periodic error:

```
[ERROR] job# 3:
[Thread 019d65c4-5c0a-70bb-9882-732030e3427c] myUpdate: tool-progress
```
