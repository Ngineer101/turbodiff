import { env } from 'cloudflare:workers';

// GitHub App plumbing: App JWTs, per-installation access tokens, webhook
// signature verification, and the user-facing OAuth flow for the settings UI.

const API = 'https://api.github.com';
const encoder = new TextEncoder();

function base64url(bytes: ArrayBuffer | Uint8Array): string {
  const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let bin = '';
  for (const b of arr) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

let cachedSigningKey: CryptoKey | null = null;

async function appSigningKey(): Promise<CryptoKey> {
  if (cachedSigningKey) return cachedSigningKey;
  const pem = env.GITHUB_APP_PRIVATE_KEY;
  if (pem.includes('BEGIN RSA PRIVATE KEY')) {
    throw new Error(
      'GITHUB_APP_PRIVATE_KEY is PKCS#1; WebCrypto needs PKCS#8. Convert with: ' +
        'openssl pkcs8 -topk8 -inform PEM -outform PEM -nocrypt -in app.pem -out app.pkcs8.pem',
    );
  }
  const der = atob(pem.replace(/-----[^-]+-----/g, '').replace(/\s+/g, ''));
  const bytes = Uint8Array.from(der, (c) => c.charCodeAt(0));
  cachedSigningKey = await crypto.subtle.importKey(
    'pkcs8',
    bytes,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  return cachedSigningKey;
}

// Short-lived App JWT (authenticates as the App itself, not an installation).
async function appJwt(): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const header = base64url(encoder.encode(JSON.stringify({ alg: 'RS256', typ: 'JWT' })));
  const payload = base64url(
    encoder.encode(JSON.stringify({ iat: now - 60, exp: now + 9 * 60, iss: env.GITHUB_APP_ID })),
  );
  const sig = await crypto.subtle.sign(
    'RSASSA-PKCS1-v1_5',
    await appSigningKey(),
    encoder.encode(`${header}.${payload}`),
  );
  return `${header}.${payload}.${base64url(sig)}`;
}

// Installation tokens live ~1h; cache per isolate with a 5-minute safety margin.
const tokenCache = new Map<number, { token: string; expiresAt: number }>();

export async function installationToken(installationId: number): Promise<string> {
  const cached = tokenCache.get(installationId);
  if (cached && cached.expiresAt > Date.now() + 5 * 60_000) return cached.token;

  const data = await mintToken(installationId);
  tokenCache.set(installationId, {
    token: data.token,
    expiresAt: new Date(data.expires_at).getTime(),
  });
  return data.token;
}

// Least-privilege token for code that runs inside a sandbox next to untrusted
// content: scoped to ONE repository and the given permissions (typically just
// contents), so a compromised or prompt-injected agent run cannot touch other
// repos in the installation or use any other App permission. Deliberately
// uncached — each run gets its own token.
//
// opts.workflows widens the token with the App's `workflows` permission,
// without which GitHub rejects any push that creates or updates a file under
// .github/workflows/. Workflow-write is a real escalation (CI runs with repo
// secrets), so callers must only pass it when the run's human-approved input
// authorizes workflow changes — see authorizesWorkflowFiles.
export async function sandboxGitToken(
  installationId: number,
  repoName: string,
  access: 'read' | 'write',
  opts?: { workflows?: boolean },
): Promise<string> {
  const workflows = Boolean(opts?.workflows) && access === 'write';
  try {
    const data = await mintToken(installationId, {
      repositories: [repoName],
      permissions: workflows ? { contents: access, workflows: 'write' } : { contents: access },
    });
    return data.token;
  } catch (err) {
    if (workflows) {
      // Most likely the App lacks the permission or the installation hasn't
      // re-accepted it — say so, since the raw 422 body doesn't.
      throw new Error(
        'this run touches .github/workflows/ and needs the GitHub App\'s "Workflows: Read and ' +
          'write" permission, but minting a token with it failed — grant the permission in the ' +
          'App settings, accept the updated permissions on this installation, then retry. ' +
          `(${err instanceof Error ? err.message : String(err)})`,
      );
    }
    throw err;
  }
}

// Whether a run's human-approved input (feature spec, automation prompt)
// declares intent to change GitHub Actions workflow files. The gate is
// deliberately the *approved text*, not the agent's output: an agent that
// writes a workflow file nobody asked for should fail at push, not get the
// permission handed to it.
export function authorizesWorkflowFiles(text: string | null | undefined): boolean {
  return Boolean(text?.includes('.github/workflows'));
}

// Translate GitHub's cryptic workflow-permission push rejection into an
// actionable dashboard error; everything else stays raw. Callers pass stderr
// already scrubbed of tokens.
export function describePushFailure(stderrScrubbed: string): string {
  if (stderrScrubbed.includes('without `workflows` permission')) {
    return (
      'git push rejected: the commit creates or updates a GitHub Actions workflow file under ' +
      '.github/workflows/, but this run was not authorized for workflow changes — the sandbox ' +
      'token only carries the workflows permission when the approved plan or prompt explicitly ' +
      'mentions .github/workflows (or, for fix runs, when the PR already touches it). If the ' +
      'workflow change is intended, mention the .github/workflows path in the plan and re-run; ' +
      'otherwise the agent went off-spec.'
    );
  }
  return `git push failed: ${stderrScrubbed}`;
}

async function mintToken(
  installationId: number,
  scope?: { repositories: string[]; permissions: Record<string, string> },
): Promise<{ token: string; expires_at: string }> {
  const headers = new Headers({
    accept: 'application/vnd.github+json',
    authorization: `Bearer ${await appJwt()}`,
    'user-agent': 'turbodiff',
    'x-github-api-version': '2022-11-28',
  });
  const init: RequestInit = { method: 'POST', headers };
  if (scope) {
    headers.set('content-type', 'application/json');
    init.body = JSON.stringify(scope);
  }
  const res = await fetch(`${API}/app/installations/${installationId}/access_tokens`, init);
  if (!res.ok) {
    throw new Error(
      `Failed to mint installation token for ${installationId}: ${res.status} ${(await res.text()).slice(0, 300)}`,
    );
  }
  // SAFETY: GitHub's create-installation-access-token endpoint documents
  // token and expires_at on every 2xx response, and res.ok is checked above.
  return res.json() as Promise<{ token: string; expires_at: string }>;
}

// Webhook payloads are authenticated solely by this HMAC — never skip it.
export async function verifyWebhookSignature(
  rawBody: ArrayBuffer,
  signatureHeader: string | undefined,
): Promise<boolean> {
  if (!signatureHeader?.startsWith('sha256=')) return false;
  const hex = signatureHeader.slice('sha256='.length);
  if (!/^[0-9a-f]{64}$/.test(hex)) return false;
  const sigBytes = Uint8Array.from(hex.match(/../g)!, (h) => parseInt(h, 16));
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(env.GITHUB_WEBHOOK_SECRET),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['verify'],
  );
  return crypto.subtle.verify('HMAC', key, sigBytes, rawBody);
}

// --- OAuth (settings UI sign-in; uses the App's built-in OAuth credentials) ---

export function oauthAuthorizeUrl(redirectUri: string, state: string): string {
  const params = new URLSearchParams({
    client_id: env.GITHUB_OAUTH_CLIENT_ID,
    redirect_uri: redirectUri,
    state,
  });
  return `https://github.com/login/oauth/authorize?${params}`;
}

export interface OAuthTokens {
  token: string;
  // Present when the App has expiring user tokens enabled (it does — the 8h
  // session TTL mirrors it). Valid ~6 months, rotated on every use.
  refreshToken: string | null;
}

export async function exchangeOAuthCode(code: string, redirectUri: string): Promise<OAuthTokens> {
  const res = await fetch('https://github.com/login/oauth/access_token', {
    method: 'POST',
    headers: { accept: 'application/json', 'content-type': 'application/json' },
    body: JSON.stringify({
      client_id: env.GITHUB_OAUTH_CLIENT_ID,
      client_secret: env.GITHUB_OAUTH_CLIENT_SECRET,
      code,
      redirect_uri: redirectUri,
    }),
  });
  // SAFETY: every asserted field is optional, and access_token is checked
  // before use — GitHub's OAuth token endpoint documents exactly these keys.
  const data = (await res.json()) as {
    access_token?: string;
    refresh_token?: string;
    error_description?: string;
  };
  if (!data.access_token) {
    throw new Error(`OAuth exchange failed: ${data.error_description ?? 'no token returned'}`);
  }
  return { token: data.access_token, refreshToken: data.refresh_token ?? null };
}

// Exchange a stored refresh token for a fresh user access token. Null on any
// failure (revoked, expired, or rotated elsewhere) — callers fall back to
// the installation token and drop the stored credential.
export async function refreshUserToken(refreshToken: string): Promise<OAuthTokens | null> {
  const res = await fetch('https://github.com/login/oauth/access_token', {
    method: 'POST',
    headers: { accept: 'application/json', 'content-type': 'application/json' },
    body: JSON.stringify({
      client_id: env.GITHUB_OAUTH_CLIENT_ID,
      client_secret: env.GITHUB_OAUTH_CLIENT_SECRET,
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
    }),
  });
  // SAFETY: both asserted fields are optional, and access_token is checked
  // before use — GitHub's OAuth refresh endpoint documents exactly these keys.
  const data = (await res.json()) as { access_token?: string; refresh_token?: string };
  if (!data.access_token) return null;
  return { token: data.access_token, refreshToken: data.refresh_token ?? null };
}

async function userApi<T>(token: string, path: string): Promise<T> {
  const res = await fetch(`${API}${path}`, {
    headers: {
      accept: 'application/vnd.github+json',
      authorization: `Bearer ${token}`,
      'user-agent': 'turbodiff',
      'x-github-api-version': '2022-11-28',
    },
  });
  if (!res.ok) throw new Error(`GitHub ${res.status} on ${path}`);
  // SAFETY: T is the caller-declared shape of this documented GitHub
  // endpoint's success response, and res.ok is checked above.
  return res.json() as Promise<T>;
}

export function fetchUser(token: string) {
  return userApi<{ id: number; login: string; avatar_url: string }>(token, '/user');
}

// Installations of THIS app that the signed-in user can access — this is the
// authorization boundary for the settings UI (a user may only manage repos
// under installations GitHub says they belong to).
export async function fetchUserInstallationIds(token: string): Promise<number[]> {
  const data = await userApi<{ installations: { id: number }[] }>(
    token,
    '/user/installations?per_page=100',
  );
  return data.installations.map((i) => i.id);
}

// The caller's own permission on one repository: GET /repos/:owner/:repo with
// a user token includes a `permissions` block for the authenticated user.
// Push (write) is the bar for factory write actions — the same bar GitHub
// itself applies to merging PRs and pushing branches.
export async function fetchUserCanPush(
  token: string,
  owner: string,
  repo: string,
): Promise<boolean> {
  const data = await userApi<{
    permissions?: { admin?: boolean; maintain?: boolean; push?: boolean };
  }>(token, `/repos/${owner}/${repo}`);
  return (
    data.permissions?.push === true ||
    data.permissions?.maintain === true ||
    data.permissions?.admin === true
  );
}

// Acknowledge a comment-triggered review with an emoji reaction (👀 while
// dispatching). Requires the App's Issues permission to be read & write.
export async function reactToIssueComment(
  installationId: number,
  repoFullName: string,
  commentId: number,
  content: 'eyes' | 'confused' | '+1' | 'rocket',
): Promise<void> {
  const token = await installationToken(installationId);
  const res = await fetch(`${API}/repos/${repoFullName}/issues/comments/${commentId}/reactions`, {
    method: 'POST',
    headers: {
      accept: 'application/vnd.github+json',
      authorization: `Bearer ${token}`,
      'user-agent': 'turbodiff-pr-reviewer',
      'x-github-api-version': '2022-11-28',
      'content-type': 'application/json',
    },
    body: JSON.stringify({ content }),
  });
  if (!res.ok) {
    throw new Error(`GitHub reaction API ${res.status}: ${(await res.text()).slice(0, 200)}`);
  }
}
