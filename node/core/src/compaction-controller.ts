import type { AgentMsg, ProviderMessage } from "./providers/provider-types.ts";

export type CompactionStep = {
  chunkIndex: number;
  totalChunks: number;
  messages: ProviderMessage[];
};

export type CompactionRecord = {
  steps: CompactionStep[];
  finalSummary: string | undefined;
};

export type CompactionResult =
  | {
      type: "complete";
      summary: string;
      steps: CompactionStep[];
      nextPrompt: string | undefined;
    }
  | { type: "error"; steps: CompactionStep[] };

export interface CompactionController {
  chunks: string[];
  currentChunkIndex: number;
  steps: CompactionStep[];
  nextPrompt: string | undefined;
  result: CompactionResult | undefined;

  start(messages: ReadonlyArray<ProviderMessage>, nextPrompt?: string): void;
  handleAgentMsg(msg: AgentMsg): void;
}