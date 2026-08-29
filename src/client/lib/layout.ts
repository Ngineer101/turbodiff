// Route predicate for the code browser's full-width, full-height workspace
// treatment (app-shell.tsx). Repository ids are positive bigint values for
// both providers and remain below JavaScript's safe-integer ceiling.
export function codeRoute(pathname: string): boolean {
  return /^\/repos\/\d+\/code/.test(pathname);
}
