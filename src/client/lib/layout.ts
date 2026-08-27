// Route predicate for the code browser's full-width, full-height workspace
// treatment (app-shell.tsx). Kept as a pure function because the repo-id
// match has a trap: Artifacts-hosted repos ride synthetic NEGATIVE ids
// (/repos/-1/code), and a bare \d+ silently dropped them into the
// reading-width container.
export function codeRoute(pathname: string): boolean {
  return /^\/repos\/-?\d+\/code/.test(pathname);
}
