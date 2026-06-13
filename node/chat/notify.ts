import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import player from "play-sound";
import type { Nvim } from "../nvim/nvim-node/index.ts";
import type { MagentaOptions } from "../options.ts";

export type NotifyContext = {
  nvim: Nvim;
  options: MagentaOptions;
};

/**
 * Notify the user that something needs their attention: play the chime sound
 * (respecting `chimeVolume`) and ring the bell (respecting `bellOnNotify`).
 *
 * The bell is sent both to the host terminal (channel 2) and to the neovim
 * editor itself so the notification surfaces regardless of where the user is
 * looking. The editor bell is triggered by feeding <Esc> in normal mode, which
 * is neovim's standard way of producing an error-bell programmatically (there
 * is no dedicated "beep" API); it respects the user's 'belloff' setting.
 */
export function notifyUser(context: NotifyContext): void {
  playChimeSound(context);
  sendBell(context);
}

function sendBell(context: NotifyContext): void {
  if (context.options.bellOnNotify === false) {
    return;
  }

  context.nvim.call("nvim_chan_send", [2, "\x07"]).catch((err) => {
    context.nvim.logger.error(
      `Failed to send terminal bell: ${err instanceof Error ? err.message : String(err)}`,
    );
  });

  context.nvim.call("nvim_input", ["<Esc>"]).catch((err) => {
    context.nvim.logger.error(
      `Failed to ring editor bell: ${err instanceof Error ? err.message : String(err)}`,
    );
  });
}

function playChimeSound(context: NotifyContext): void {
  const actualVolume = context.options.chimeVolume;

  if (!actualVolume) {
    return;
  }

  try {
    const play = player();
    const chimeFile = join(
      dirname(fileURLToPath(import.meta.url)),
      "..",
      "..",
      "chime.wav",
    );

    const playOptions = {
      afplay: ["-v", actualVolume.toString()],
      aplay: ["-v", `${Math.round(actualVolume * 100).toString()}%`],
      mpg123: ["-f", Math.round(actualVolume * 32768).toString()],
    };

    play.play(chimeFile, playOptions, (err: Error | null) => {
      if (err) {
        context.nvim.logger.error(`Failed to play chime sound: ${err.message}`);
      }
    });
  } catch (error) {
    context.nvim.logger.error(
      `Error setting up chime sound: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}
