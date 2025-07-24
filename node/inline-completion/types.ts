export type InlineCompletionMsg =
  | {
      type: "trigger-completion";
      bufnr: number;
      line: number;
      col: number;
    }
  | {
      type: "accept-completion";
      bufnr: number;
    }
  | {
      type: "reject-completion";
      bufnr: number;
    }
  | {
      type: "completion-received";
      bufnr: number;
      completion: string;
    }
  | {
      type: "completion-error";
      bufnr: number;
      error: string;
    }
  | {
      type: "buffer-changed";
      bufnr: number;
      line: number;
      col: number;
      text: string;
    }
  | {
      type: "cursor-moved";
      bufnr: number;
      line: number;
      col: number;
    };

export type CacheEntry = {
  completion: string;
  timestamp: number;
  context: string;
};

export type InlineCompletionState = {
  request?: { cancel: () => void };
  suggestion?: {
    text: string;
    line: number;
    col: number;
    extmarkId?: number;
  };
  accumulatedText?: string;
  debounceTimer?: NodeJS.Timeout;
  lastTriggerPosition?: {
    line: number;
    col: number;
  };
  cache?: Map<string, CacheEntry>;
};
