// Artifacts-hosted project identity, shared by server validation and the
// client form so the two can never disagree on the grammar.
export const PROJECT_SEGMENT = /^[\w.-]{1,80}$/;

// The plain-git clone invocation for a minted credential — one template for
// every surface that shows it (project creation, settings, docs).
export function cloneCommand(remote: string, token: string): string {
  return `git -c http.extraHeader="Authorization: Bearer ${token}" clone ${remote}`;
}
