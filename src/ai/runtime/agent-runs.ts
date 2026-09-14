export function transcriptKey(logKey: string): string {
  return logKey.replace(/\.log$/, '.transcript.jsonl');
}
