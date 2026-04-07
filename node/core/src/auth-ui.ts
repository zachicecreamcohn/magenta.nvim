export interface AuthUI {
  showOAuthFlow(authUrl: string): Promise<string>;
  showError(message: string): void;
}
