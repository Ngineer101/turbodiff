export function redactSecrets(text: string, secrets: Iterable<string>): string {
  let redacted = text;
  for (const secret of secrets) {
    if (secret) redacted = redacted.replaceAll(secret, '***');
  }
  return redacted;
}
