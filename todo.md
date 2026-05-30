- openai agent
- agent(prompt, yield_schema) api, exposed via typescript scripts & lua

# Sandboxes

- we should patch sandbox runtime some more to allow projects to further customize their setup. I haven't been able to get puppeteer tests against localhost to work through the sandbox for example (though running in docker works, thankfully).
- sandboxes on osx still trip up when running sandbox tests... seems like node phones home intermittently? Why?

# Prompt tuning

- the agent is still prone to re-read the file (even force-re-read) before making further edits... maybe we jsut drop the context.md "this file is in your context already" round trip. Also, maybe _reading_ is just a lot cheaper than _generating_ so we could think about having edl send the full edited section back. Something like "the file now reads <full contents of edited section of file>"
- try trimming things down in general...

# token efficiency

- Let's revisit how we summarize files.
- summarize large files even when they're pulled in via contextFiles

# docker

- we're still referencing some files from the host, which the agent can't actually read

# UX

- Animate the dot on "streaming" independent of partial stream results
- when a thread is titled, we should use that title somehow in the buffer name (instead of just using an opaque id, though still need to make sure it's unique)
- thread display buffers should be listed
- deleting a thread display or input buffer (via :bd) should remove that thread from magenta state
- tmux integration (update tab title with active thread title, thread state)
- toggling sandbox to off should auto-approve any current dialogues

# misc features

- add context tracking for the state of git. When we change branches, commit, etc...
- asking aside/followup questions about things is a bit awkward... it would be cool to allow one to select a part of the display buffer, and then ask a question about it, with the output appearing within the flow of the original thread
- support for oil buffers for adding files to context

# bug fixes, etc

- when we abort during a "sandbox blocked" message, it stays up even as the conversation continues
  - this has broken a few times already, make sure we have a good test for it
- thread overview and other thread buffers not showing up in the buffer list
- revisit the buffer handling. Keep getting stuck in buffer not matching the file state
  - try to write buffer before agent reads, but read from the disk with warning even if it doesn't work
  - try to read buffer after agent writes, but let the agent write to the file and surface a warning even if it doesn't work
- when we error upon a user message send, we should pop the user message off the agent's history, otherwise we end up sending it twice
- overloaded handling / exponential backoff not working correctly
- when we terminate/error, the reset for the message places it in the wrong buffer (currently open one, not the one corresponding to the thread that the error happened in)

- this token counting bug:
  Full output (~5 tok): `/tmp/magenta/threads/019e7a92-f92a-73be-a919-a7e706cfae9c/tools/toolu_01P9m7eaCFDv6btvs4USGMDJ/bashCommand.log`
