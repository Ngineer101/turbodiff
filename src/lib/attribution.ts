// Attribution of factory commits to the instructing user. The sandbox always
// commits as turbodiff[bot] (the committer — honest: the bot recorded it),
// but when a signed-in human instructed the run, they become the git AUTHOR
// via GIT_AUTHOR_* env on the commit command. GitHub links the
// `<id>+<login>@users.noreply.github.com` form to the account regardless of
// its email-privacy settings, so authored commits show the user's avatar and
// count toward their contribution graph once merged.

export interface GitIdentity {
  login: string;
  id: number;
}

export function noreplyEmail(user: GitIdentity): string {
  return `${user.id}+${user.login}@users.noreply.github.com`;
}

// Env vars for `git commit`. Empty when no human instructed the run — git
// then falls back to the repo-config bot identity for the author too.
export function gitAuthorEnv(user: GitIdentity | null | undefined) {
  if (!user) return {};
  return { GIT_AUTHOR_NAME: user.login, GIT_AUTHOR_EMAIL: noreplyEmail(user) };
}

// Trailer crediting a second instructing user (e.g. the plan creator when a
// different user approved). Must be separated from the subject by a blank
// line to parse as a git trailer.
export function coauthorTrailer(user: GitIdentity | null | undefined): string {
  if (!user) return '';
  return `\n\nCo-authored-by: ${user.login} <${noreplyEmail(user)}>`;
}
