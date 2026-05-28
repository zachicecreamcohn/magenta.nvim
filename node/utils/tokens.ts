export function estimateTokens(charCount: number): number {
  return Math.ceil(charCount / 4);
}

export function formatTokens(charCount: number): string {
  const tokens = estimateTokens(charCount);
  return tokens >= 1000
    ? `~${(tokens / 1000).toFixed(1)}k tok`
    : `~${tokens} tok`;
}
