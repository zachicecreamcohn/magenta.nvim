import * as fs from "node:fs";
import * as path from "node:path";
import type { Logger } from "../logger.ts";
import type { Cwd, HomeDir } from "../utils/files.ts";
import {
  loadProjectSettings,
  loadUserOptions,
  mergeOptions,
  type ServerOptions,
} from "./options.ts";

type Cached = {
  options: ServerOptions;
  userMtime: number | undefined;
  projectMtime: number | undefined;
};

function mtime(filePath: string): number | undefined {
  try {
    return fs.statSync(filePath).mtimeMs;
  } catch {
    return undefined;
  }
}

/** Server configuration comes only from `~/.magenta/options.json` merged with
 * `<cwd>/.magenta/options.json`. Files are re-read when their mtime changes
 * (including appearing or disappearing). */
export class OptionsStore {
  private readonly cache = new Map<Cwd, Cached>();

  constructor(
    private readonly homeDir: HomeDir,
    private readonly logger: Logger,
  ) {}

  getOptions(cwd: Cwd): ServerOptions {
    const userMtime = mtime(
      path.join(this.homeDir, ".magenta", "options.json"),
    );
    const projectMtime = mtime(path.join(cwd, ".magenta", "options.json"));
    const cached = this.cache.get(cwd);
    if (
      cached &&
      cached.userMtime === userMtime &&
      cached.projectMtime === projectMtime
    ) {
      return cached.options;
    }
    const warnLogger = {
      warn: (msg: string) => this.logger.warn(`Settings: ${msg}`),
      error: (msg: string) => this.logger.error(`Settings: ${msg}`),
    };
    const options = mergeOptions(
      loadUserOptions(this.homeDir, warnLogger),
      loadProjectSettings(cwd, warnLogger) ?? {},
    );
    this.cache.set(cwd, { options, userMtime, projectMtime });
    return options;
  }
}
