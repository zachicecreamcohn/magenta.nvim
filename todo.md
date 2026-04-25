# Sandboxes

- we should patch sandbox runtime some more to allow projects to further customize their setup. I haven't been able to get puppeteer tests against localhost to work through the sandbox for example (though running in docker works, thankfully).
- sandboxes on osx still trip up when running sandbox tests... seems like node phones home intermittently? Why?

# Prompt tuning

- the agent is still prone to re-read the file (even force-re-read) before making further edits... maybe we jsut drop the context.md "this file is in your context already" round trip. Also, maybe _reading_ is just a lot cheaper than _generating_ so we could think about having edl send the full edited section back. Something like "the file now reads <full contents of edited section of file>"

# customization

# docker

- we're still referencing some files from the host, which the agent can't actually read

# UX

- when a thread is titled, we should use that title somehow in the buffer name (instead of just using an opaque id, though still need to make sure it's unique)
- make the spawn_subagents preview the command as it's streaming in
- = on spawn_subagents is showing "\n" ... we should probably format that more nicely
- let's make = vs <CR> more consistent. "=" should always toggle expand. "<CR>" should always "enter / select"
- compaction takes a while and doesn't show progress... we should show something like `X / Y chunks` as it's going along

# misc features

- fork a conversation from any previous message
- add context tracking for the state of git. When we change branches, commit, etc...
- we should be able to @fork during the assistant's turn, tool use, etc... without aborting the thread we're in

# bug fixes, etc

- when we abort during a "sandbox blocked" message, it stays up even as the conversation continues
  - this has broken a few times already, make sure we have a good test for it
- thread overview and other thread buffers not showing up in the buffer list
- revisit the buffer handling. Keep getting stuck in buffer not matching the file state
  - try to write buffer before agent reads, but read from the disk with warning even if it doesn't work
  - try to read buffer after agent writes, but let the agent write to the file and surface a warning even if it doesn't work
- when we error upon a user message send, we should pop the user message off the agent's history, otherwise we end up sending it twice
- this periodic error:

```
[ERROR] job# 3:
[Thread 019d65c4-5c0a-70bb-9882-732030e3427c] myUpdate: tool-progress
```

- overloaded handling / exponential backoff not working correctly
