// as in a debate, moderator keeps track of tool state and manages turn taking in the conversation

import { ToolResultBlockParam } from "@anthropic-ai/sdk/resources";
import { ToolRequest } from "./tools";
import { ToolProcess } from "./tools/types";
import { Context } from "./types";

export class Moderator {
  private toolProcesses: {
    [tool_use_id: string]: {
      process: ToolProcess;
      unsubscribe: () => void;
    };
  } = {};

  private hasPendingAutorespond = false;

  constructor(
    private context: Context,
    private onToolResult: (
      request: ToolRequest,
      result: ToolResultBlockParam,
    ) => void,
    private autoRespond: () => void,
  ) {}

  registerProcess(process: ToolProcess) {
    this.toolProcesses[process.request.id] = {
      process,
      unsubscribe: process.subscribe(() =>
        this.onToolUpdate(process.request.id),
      ),
    };
  }

  onToolUpdate(id: string) {
    const entry = this.toolProcesses[id];
    const { process, unsubscribe } = entry;
    if (!entry) {
      this.context.logger.error(
        `got tool update notification for unregistered tool ${id}`,
      );
      return;
    }

    if (process.state.state == "done") {
      unsubscribe();
      delete this.toolProcesses[id];
      const result = process.state.result;
      this.onToolResult(process.request, result);

      if (process.autoRespond) {
        this.hasPendingAutorespond = true;
      }

      if (this.hasPendingAutorespond) {
        this.maybeAutorespond();
      }
    }
  }

  maybeAutorespond() {
    for (const { process } of Object.values(this.toolProcesses)) {
      if (process.state.state == "processing") {
        return;
      }
    }

    this.autoRespond();
  }
}
