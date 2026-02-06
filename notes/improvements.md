# general

- @fork should work at any time - when the agent is streaming, aborted, executing tools, etc...
- fixup issue where empty thinking blocks break resuming after abort. Add the partially streamed thinking block to the thread so we don't have to start over

# subagents

- improve subagent display (what type of agent is it? Prompt?
- when subagents block, show the blocking operation in the parent agent, so you don't have to go into the subagent to unblock the operation
- show preview of what the subagent is doing while it's working

# edl

- Remap lines as we do the edits. So if we specify lines in the initial coordinate system of the file, resolve the lines differently for future changes below the first changes
- economy
  - encourage the agent to not re-print large sections of the file to make its selections, but instead to just select the beginning and then extend to the end.
  - when we fail to do large replaces or inserts, save the replace in a register that can be used in a retry. Log this as part of the trace
- when streaming the edl tool, only show the last N lines of the streamed text.
- improve the trace by displaying line numbers and context
- approve or deny each file access separately
- integrate with context manager
- maybe add special command to fully print the contents of selection, to aid in exploration
- maybe elaborate on output to make it easier to tell when the selection was messed up?
- investigate treesitter query syntax / matryoshka style file exploration

# polish

- context manager flicker messes with scrolling
- tools briefly flash as having no response when they complete
- when a subagent yields, it looks funky (no tool result, etc...)
