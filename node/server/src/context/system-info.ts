import { platform } from "node:os";
import type { SystemInfo } from "../providers/system-prompt.ts";
import type { Cwd } from "../utils/files.ts";

export function buildSystemInfo(ctx: {
  cwd: Cwd;
  neovimVersion: string;
  overrides?: Partial<SystemInfo>;
}): SystemInfo {
  return {
    timestamp: new Date().toString(),
    platform: platform(),
    neovimVersion: ctx.neovimVersion,
    cwd: ctx.cwd,
    ...ctx.overrides,
  };
}
