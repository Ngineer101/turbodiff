// Code and unified diffs tokenize more densely than prose. Three characters
// per token is deliberately conservative, while the bounds protect operator
// mistakes from producing unusably tiny or unbounded tool responses.
export function reviewPacketChars(diffTokens: number): number {
  return Math.min(600_000, Math.max(24_000, Math.floor(diffTokens) * 3));
}
