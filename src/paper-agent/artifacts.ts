// Screenshot persistence for the Paper design agent.
//
// Screenshots are the job's durable visual record. They are written straight to
// the R2 evidence bucket and referenced by the same signed capability URLs the
// verification screenshots use (served by GET /artifacts/*), so they need no
// database rows and can be shown in any client that has the URL.

import { env } from 'cloudflare:workers';
import { signArtifactKey } from '../integrations/security/crypto.ts';

export interface StoredArtifact {
  key: string;
  url: string;
}

/** Store a PNG screenshot for a job iteration and return its signed URL. */
export async function storeScreenshot(
  jobId: string,
  iteration: number,
  png: Uint8Array,
): Promise<StoredArtifact> {
  const key = `paper-jobs/${jobId}/${String(iteration).padStart(3, '0')}-${crypto.randomUUID()}.png`;
  await env.ARTIFACTS.put(key, png, { httpMetadata: { contentType: 'image/png' } });
  const sig = await signArtifactKey(key);
  const path = `/artifacts/${key}?sig=${sig}`;
  const base = env.PUBLIC_BASE_URL.trim();
  const url = base ? new URL(path, base).toString() : path;
  return { key, url };
}

/** Store extracted design text for a job iteration and return its signed URL. */
export async function storeText(
  jobId: string,
  iteration: number,
  text: string,
): Promise<StoredArtifact> {
  const key = `paper-jobs/${jobId}/${String(iteration).padStart(3, '0')}-${crypto.randomUUID()}.txt`;
  await env.ARTIFACTS.put(key, text, {
    httpMetadata: { contentType: 'text/plain; charset=utf-8' },
  });
  const sig = await signArtifactKey(key);
  const path = `/artifacts/${key}?sig=${sig}`;
  const base = env.PUBLIC_BASE_URL.trim();
  const url = base ? new URL(path, base).toString() : path;
  return { key, url };
}

/** Encode raw PNG bytes as base64 for inclusion in a model image block. */
export function pngToBase64(png: Uint8Array): string {
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < png.length; i += chunk) {
    binary += String.fromCharCode(...png.subarray(i, i + chunk));
  }
  return btoa(binary);
}
