import type { ProviderMessageContent } from "./providers/provider-types.ts";

export type SupervisorAction =
  | { type: "send-message"; text: string }
  | { type: "accept"; resultPrefix?: string }
  | { type: "reject"; message: string }
  | { type: "none" };

export type EndTurnContext = {
  stopReason: string;
  lastAssistantMessage: ReadonlyArray<ProviderMessageContent> | undefined;
};

export interface ThreadSupervisor {
  onEndTurnWithoutYield(context: EndTurnContext): SupervisorAction;
  onYield(result: string): Promise<SupervisorAction>;
  onAbort(): SupervisorAction;
}

function containsYieldTag(
  content: ReadonlyArray<ProviderMessageContent> | undefined,
): boolean {
  if (!content) return false;
  for (const block of content) {
    if (block.type === "text" && /<yield[\w_]*[\s/>]/i.test(block.text)) {
      return true;
    }
  }
  return false;
}

/** For regular subagents. Only intervenes when the agent writes a
 *  `<yield>` XML tag instead of calling the tool. Otherwise allows
 *  the agent to stop normally. */
export class SubagentSupervisor implements ThreadSupervisor {
  onEndTurnWithoutYield(context: EndTurnContext): SupervisorAction {
    if (containsYieldTag(context.lastAssistantMessage)) {
      return {
        type: "send-message",
        text: "You wrote a <yield> XML tag in your text, but that does nothing. You must call the yield_to_parent tool to return results to the parent agent.",
      };
    }
    return { type: "none" };
  }

  async onYield(_result: string): Promise<SupervisorAction> {
    return { type: "none" };
  }

  onAbort(): SupervisorAction {
    return { type: "none" };
  }
}

/** For unsupervised threads (e.g. docker_unsupervised). Always prompts
 *  the agent to resume work when it stops without yielding. */
export class UnsupervisedSupervisor implements ThreadSupervisor {
  private restartCount = 0;
  private readonly maxRestarts: number;

  constructor(opts?: { maxRestarts?: number }) {
    this.maxRestarts = opts?.maxRestarts ?? 5;
  }

  onEndTurnWithoutYield(context: EndTurnContext): SupervisorAction {
    if (
      context.stopReason === "aborted" ||
      this.restartCount >= this.maxRestarts
    ) {
      return { type: "none" };
    }
    this.restartCount++;

    if (containsYieldTag(context.lastAssistantMessage)) {
      return {
        type: "send-message",
        text: "You wrote a <yield> XML tag in your text, but that does nothing. You must call the yield_to_parent tool to return results to the parent agent.",
      };
    }

    return {
      type: "send-message",
      text: `You stopped without yielding. You must complete your task and call yield_to_parent when done. (auto-restart ${this.restartCount}/${this.maxRestarts})`,
    };
  }

  async onYield(_result: string): Promise<SupervisorAction> {
    return { type: "none" };
  }

  onAbort(): SupervisorAction {
    return { type: "none" };
  }
}
