export type SupervisorAction =
  | { type: "send-message"; text: string }
  | { type: "accept" }
  | { type: "reject"; message: string }
  | { type: "none" };

export interface ThreadSupervisor {
  onEndTurnWithoutYield(stopReason: string): SupervisorAction;
  onYield(result: string): Promise<SupervisorAction>;
  onAbort(): SupervisorAction;
}