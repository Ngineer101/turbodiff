// Pure half of the git-provider seam (docs/artifacts-provider.md): remote
// shapes and builders with no Workers runtime dependency. Credential minting
// and provider dispatch live in ./provider.ts.

export type GitProviderKind = 'github' | 'artifacts';

// Must match the `artifacts` binding namespace in wrangler.jsonc (and its
// triggers.events filters) — the binding does not expose its configured
// namespace at runtime.
export const ARTIFACTS_NAMESPACE = 'turbodiff-repos';

export interface WorkspaceRemote {
  provider: GitProviderKind;
  // Shell-embeddable authenticated URL for clone/fetch/push commands. It
  // only ever references env vars ($GIT_TOKEN / $GIT_REMOTE), so no secret
  // enters a command string.
  authUrl: string;
  // Credential-free URL — the only form allowed in .git/config origins.
  cleanUrl: string;
  // Per-command `git -c ...` flags, placed before the subcommand.
  configFlags: string;
  // env entries every command using authUrl/configFlags must receive.
  env: Record<string, string>;
  // The minted credential, for redaction lists.
  token: string;
}

// GitHub keeps its exact historical command shape: token inside the URL as
// x-access-token basic auth, no config flags.
export function githubWorkspaceRemote(repository: string, token: string): WorkspaceRemote {
  return {
    provider: 'github',
    authUrl: `https://x-access-token:$GIT_TOKEN@github.com/${repository}.git`,
    cleanUrl: `https://github.com/${repository}.git`,
    configFlags: '',
    env: { GIT_TOKEN: token },
    token,
  };
}

// Artifacts authenticates via an Authorization header because its tokens can
// carry URL-hostile characters (`?expires=` suffix).
export function artifactsWorkspaceRemote(remoteUrl: string, token: string): WorkspaceRemote {
  return {
    provider: 'artifacts',
    authUrl: '$GIT_REMOTE',
    cleanUrl: remoteUrl,
    configFlags: '-c http.extraHeader="Authorization: Bearer $GIT_TOKEN"',
    env: { GIT_TOKEN: token, GIT_REMOTE: remoteUrl },
    token,
  };
}

// Factory flows that end in a GitHub pull request (generation, plans,
// automations, PR fix/verify loops) still assume GitHub. Native change
// requests for Artifacts repos land in Phase 2; until then intake rejects
// up front instead of stranding a run at the PR step.
export function factoryUnsupportedReason(repo: {
  provider: string;
  owner: string;
  name: string;
}): string | null {
  if (repo.provider === 'github') return null;
  return (
    `${repo.owner}/${repo.name} is hosted on Cloudflare Artifacts; factory runs need the ` +
    'native change-request layer (Phase 2) and are not yet available for Artifacts repos'
  );
}

// Artifacts repo names allow [A-Za-z0-9._-] after an alphanumeric, max 64
// chars. Project identity is `<owner>--<name>`, sanitized; the caller
// appends a numeric suffix on collision (attempt 1 → "-2", etc.).
export function deriveArtifactsRepoName(owner: string, name: string, attempt = 0): string {
  const sanitize = (part: string) =>
    part
      .replaceAll(/[^A-Za-z0-9._-]+/g, '-')
      .replaceAll(/^[._-]+/g, '')
      .replaceAll(/-{3,}/g, '--');
  const suffix = attempt > 0 ? `-${attempt + 1}` : '';
  const base = `${sanitize(owner)}--${sanitize(name)}`.slice(0, 64 - suffix.length);
  const trimmed = base.replaceAll(/[._-]+$/g, '');
  return `${trimmed}${suffix}`;
}
