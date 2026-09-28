import type {
  ClientCapabilities,
  ClientCommandName,
} from "../../capabilities/client.ts";
import type { AgentInput } from "../../providers/provider-types.ts";
import { ABORTED, type Aborted } from "../../thread-api.ts";
import type { Task } from "../../utils/async.ts";
import type { Command } from "./types.ts";

export type AwaitClient = () => Task<ClientCapabilities | Aborted>;

const CLIENT_COMMANDS: Record<ClientCommandName, { label: string }> = {
  buf: { label: "buffers list" },
  buffers: { label: "buffers list" },
  qf: { label: "quickfix list" },
  quickfix: { label: "quickfix list" },
  diag: { label: "diagnostics" },
  diagnostics: { label: "diagnostics" },
};

/** Commands answered by whichever client is attached at delivery time,
 * waiting for one to attach. `abandoned` releases the wait when the
 * submission is aborted. */
export function clientCommands(
  awaitClient: AwaitClient,
  abandoned: Promise<Aborted>,
): Command[] {
  return (
    Object.entries(CLIENT_COMMANDS) as [ClientCommandName, { label: string }][]
  ).map(([name, { label }]) => ({
    name: `@${name}`,
    pattern: new RegExp(`@${name}\\b`, "g"),
    async execute(match, context): Promise<AgentInput[]> {
      const task = awaitClient();
      void abandoned.then(() => task.abort());
      const client = await task.promise;
      if (client === ABORTED) return [];
      try {
        return await client.expandClientCommand(name, match[0]);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        context.logger.error(`Failed to fetch ${label}: ${message}`);
        return [{ type: "text", text: `Error fetching ${label}: ${message}` }];
      }
    },
  }));
}
