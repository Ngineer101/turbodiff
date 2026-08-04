import { env } from 'cloudflare:workers';

// AES-256-GCM sealing for per-connection bearer tokens. The key is the
// TOKEN_ENCRYPTION_KEY secret (64 hex chars — generate with
// `openssl rand -hex 32`); sealed values are base64url(iv || ciphertext).
// Tokens are decrypted only inside the MCP auth resolver at request time and
// are never rendered back to the UI or into model context.

function keyBytes(): Uint8Array {
	const hex = (env as { TOKEN_ENCRYPTION_KEY?: string }).TOKEN_ENCRYPTION_KEY;
	if (!hex || !/^[0-9a-fA-F]{64}$/.test(hex)) {
		throw new Error(
			'TOKEN_ENCRYPTION_KEY must be a 64-hex-char secret (openssl rand -hex 32); ' +
				'set it with `wrangler secret put TOKEN_ENCRYPTION_KEY` (or in .dev.vars locally)',
		);
	}
	return Uint8Array.from(hex.match(/../g)!.map((b) => parseInt(b, 16)));
}

export function encryptionConfigured(): boolean {
	try {
		keyBytes();
		return true;
	} catch {
		return false;
	}
}

async function aesKey(usage: 'encrypt' | 'decrypt'): Promise<CryptoKey> {
	return crypto.subtle.importKey('raw', keyBytes(), 'AES-GCM', false, [usage]);
}

function b64url(bytes: Uint8Array): string {
	let bin = '';
	for (const b of bytes) bin += String.fromCharCode(b);
	return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function b64urlDecode(s: string): Uint8Array {
	const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/'));
	return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

export async function sealToken(plain: string): Promise<string> {
	const iv = crypto.getRandomValues(new Uint8Array(12));
	const ct = new Uint8Array(
		await crypto.subtle.encrypt(
			{ name: 'AES-GCM', iv },
			await aesKey('encrypt'),
			new TextEncoder().encode(plain),
		),
	);
	const out = new Uint8Array(iv.length + ct.length);
	out.set(iv);
	out.set(ct, iv.length);
	return b64url(out);
}

export async function openToken(sealed: string): Promise<string> {
	const bytes = b64urlDecode(sealed);
	const plain = await crypto.subtle.decrypt(
		{ name: 'AES-GCM', iv: bytes.slice(0, 12) },
		await aesKey('decrypt'),
		bytes.slice(12),
	);
	return new TextDecoder().decode(plain);
}
