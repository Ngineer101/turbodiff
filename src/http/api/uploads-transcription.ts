import type { Hono } from 'hono';
import { env } from 'cloudflare:workers';
import { type ApiEnv } from '../api-support.ts';

export function registerUploadTranscriptionRoutes(app: Hono<ApiEnv>) {
  // Context-file upload for planning (pdf/images). Stored in the ARTIFACTS
  // bucket under a harness-generated key; the planner downloads them into
  // the sandbox via the same signed /artifacts URLs verification uses.
  const UPLOAD_TYPES = new Set([
    'application/pdf',
    'image/png',
    'image/jpeg',
    'image/webp',
    'image/gif',
  ]);
  const UPLOAD_MAX_BYTES = 10 * 1024 * 1024;

  app.post('/uploads', async (c) => {
    // Signed-in is not enough: any GitHub account authenticates even with
    // zero installations. Attachments exist to feed planning runs, so
    // require at least one installation before accepting bytes into R2.
    if (c.get('user').installationIds.length === 0) {
      return c.json({ error: 'install the GitHub App before uploading attachments' }, 403);
    }
    const body = await c.req.parseBody();
    const file = body.file;
    if (!(file instanceof File))
      return c.json({ error: 'multipart "file" field is required' }, 400);
    if (!UPLOAD_TYPES.has(file.type)) {
      return c.json({ error: 'only PDF and image attachments are supported' }, 400);
    }
    if (file.size > UPLOAD_MAX_BYTES) return c.json({ error: 'attachment exceeds 10MB' }, 400);
    const safeName = file.name.replace(/[^\w.-]/g, '_').slice(-80) || 'attachment';
    const key = `plan-uploads/${crypto.randomUUID()}/${safeName}`;
    await env.ARTIFACTS.put(key, await file.arrayBuffer(), {
      httpMetadata: { contentType: file.type },
    });
    return c.json({ ok: true, key, name: file.name.slice(-120), content_type: file.type });
  });

  // Speech-to-text for dictation into requirement/feedback/comment fields.
  // Transient: the recording is transcribed and discarded, never written to
  // R2 (contrast with /uploads, which persists planning attachments).
  const TRANSCRIBE_MAX_BYTES = 15 * 1024 * 1024;

  app.post('/transcribe', async (c) => {
    // Same cost-control gate as /uploads: dictation is only reachable from
    // screens that already require an installation (todo start, plan
    // feedback, feature comments), so this only blocks the zero-installation
    // edge case from spending Workers AI inference.
    if (c.get('user').installationIds.length === 0) {
      return c.json({ error: 'install the GitHub App before using dictation' }, 403);
    }
    const body = await c.req.parseBody();
    const file = body.audio;
    if (!(file instanceof File)) {
      return c.json({ error: 'multipart "audio" field is required' }, 400);
    }
    if (!file.type.startsWith('audio/')) {
      return c.json({ error: 'only audio recordings are supported' }, 400);
    }
    if (file.size > TRANSCRIBE_MAX_BYTES) {
      return c.json({ error: 'recording exceeds 15MB' }, 400);
    }
    if (file.size === 0) return c.json({ ok: true, text: '' });

    // Same byte->base64 idiom as src/integrations/github/app.ts's base64url() — a
    // fromCharCode loop instead of a spread, so it doesn't blow the call
    // stack on a multi-MB buffer.
    const bytes = new Uint8Array(await file.arrayBuffer());
    let bin = '';
    for (const b of bytes) bin += String.fromCharCode(b);
    const audio = btoa(bin);

    try {
      const result = await env.AI.run('@cf/openai/whisper-large-v3-turbo', { audio });
      return c.json({ ok: true, text: (result.text ?? '').trim() });
    } catch (err) {
      console.error('turbodiff: transcription failed:', err);
      return c.json({ error: 'transcription failed' }, 502);
    }
  });
}
