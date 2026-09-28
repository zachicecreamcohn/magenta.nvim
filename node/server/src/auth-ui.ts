export interface AuthUI {
  /** May stay pending until a client can prompt; `abortSignal` cancels. */
  showOAuthFlow(authUrl: string, abortSignal?: AbortSignal): Promise<string>;
  showError(message: string): void;
  /** Streams the output of an interactive CLI login (e.g. `codex login`)
   *  verbatim, including the auth URL the user must open. */
  showLoginProgress(chunk: string): void;
}
