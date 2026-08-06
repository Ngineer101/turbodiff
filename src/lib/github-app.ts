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
export async function sandboxGitToken(
	installationId: number,
	repoName: string,
	access: 'read' | 'write',
): Promise<string> {
	const data = await mintToken(installationId, {
		repositories: [repoName],
		permissions: { contents: access },
	});
	return data.token;
}

async function mintToken(
	installationId: number,
	scope?: { repositories: string[]; permissions: Record<string, string> },
): Promise<{ token: string; expires_at: string }> {
	const res = await fetch(`${API}/app/installations/${installationId}/access_tokens`, {
		method: 'POST',
		headers: {
			accept: 'application/vnd.github+json',
			authorization: `Bearer ${await appJwt()}`,
			'user-agent': 'turbodiff',
			'x-github-api-version': '2022-11-28',
			...(scope ? { 'content-type': 'application/json' } : {}),
		},
		...(scope ? { body: JSON.stringify(scope) } : {}),
	});
	if (!res.ok) {
		throw new Error(
			`Failed to mint installation token for ${installationId}: ${res.status} ${(await res.text()).slice(0, 300)}`,
		);
	}
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

export async function exchangeOAuthCode(code: string, redirectUri: string): Promise<string> {
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
	const data = (await res.json()) as { access_token?: string; error_description?: string };
	if (!data.access_token) {
		throw new Error(`OAuth exchange failed: ${data.error_description ?? 'no token returned'}`);
	}
	return data.access_token;
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
