# Terminal Bell Notifications

## Goal

Send a terminal bell (`\x07`) when the agent finishes a response, so tmux highlights
the window in the status bar. This works through SSH tunnels and containers because the
bell is just terminal output — no socket forwarding needed.

## Approach

Hook into the existing `playChime` event from `ThreadCore`. When the chime would play,
also send a bell to the terminal via neovim's `nvim_chan_send(2, "\x07")`.

This is intentionally a small, self-contained change. It reuses the same trigger as the
existing chime sound.

## Option

Add a boolean option `bellOnNotify` (default: `true`). This controls whether the
terminal bell is sent. It's separate from `chimeVolume` since users may want bell
without sound or vice versa.

## Changes

### 1. `lua/magenta/options.lua`

Add `bellOnNotify = true` to the default options table.

### 2. `node/options.ts`

- Add `bellOnNotify: boolean` to the `Options` type.
- Parse it in `parseOptions()` with a default of `true`.

### 3. `node/chat/thread.ts`

In `playChimeIfNeeded()`, after the existing chime logic, send the bell:

```typescript
if (this.context.options.bellOnNotify) {
  this.context.nvim.call("nvim_chan_send", [2, "\x07"]).catch((err) => {
    this.context.nvim.logger.error(`Failed to send terminal bell: ${err}`);
  });
}
```

### 4. `doc/magenta.txt`

Add a line documenting `bellOnNotify` in the options section.

## Testing

Manual: run magenta inside a tmux window, switch to another window, trigger the agent,
and verify the window gets flagged with a bell indicator.

No automated test needed — this is a one-liner side-effect that depends on the terminal
environment.

## Why not a separate module?

The tmux-notifier branch created a full `TmuxNotifier` class because it needed to
shell out to `tmux` commands. The bell approach is a single nvim API call, so it
doesn't justify its own module. It fits naturally alongside the existing chime logic
in `thread.ts`.
