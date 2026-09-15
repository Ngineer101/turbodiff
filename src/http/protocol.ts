import { env } from 'cloudflare:workers';
import { Hono } from 'hono';
import { transcriptKey } from '../ai/runtime/agent-runs.ts';
import { requireUser, type AuthedUser } from '../application/auth/session.ts';
import { getArtifact } from '../data/artifacts.ts';
import { getAgentRun } from '../data/execution.ts';

type ProtocolEnv = { Variables: { user: AuthedUser } };

const TRANSCRIPTION_LIMIT = 15 * 1024 * 1024;

export function createProtocolRoutes(authenticate: typeof requireUser = requireUser) {
  const app = new Hono<ProtocolEnv>();

  app.use('*', async (context, next) => {
    const user = await authenticate(context.req.raw);
    if (!user) return context.json({ error: 'unauthorized' }, 401);

    context.set('user', user);
    const origin = context.req.header('origin');
    if (
      !['GET', 'HEAD', 'OPTIONS'].includes(context.req.method) &&
      origin &&
      origin !== new URL(context.req.url).origin
    ) {
      return context.json({ error: 'cross-origin request rejected' }, 403);
    }

    await next();
  });

  app.get('/organizations/:organizationId/events', async (context) => {
    const organizationId = context.req.param('organizationId');
    const origin = context.req.header('origin');
    if (origin && origin !== new URL(context.req.url).origin) {
      return context.json({ error: 'cross-origin websocket rejected' }, 403);
    }

    if (!organizationId || !context.get('user').organizationIds.includes(organizationId)) {
      return context.json({ error: 'unknown organization' }, 404);
    }

    return env.LIVE_UPDATES.getByName(organizationId).fetch(context.req.raw);
  });

  app.post('/transcriptions', async (context) => {
    if (context.get('user').organizationIds.length === 0) {
      return context.json({ error: 'an organization is required before using dictation' }, 403);
    }

    const body = await context.req.parseBody();
    const file = body.audio;
    if (!(file instanceof File)) {
      return context.json({ error: 'multipart "audio" field is required' }, 400);
    }

    if (!file.type.startsWith('audio/')) {
      return context.json({ error: 'only audio recordings are supported' }, 400);
    }

    if (file.size > TRANSCRIPTION_LIMIT) {
      return context.json({ error: 'recording exceeds 15MB' }, 400);
    }

    if (file.size === 0) return context.json({ text: '' });

    const bytes = new Uint8Array(await file.arrayBuffer());
    let binary = '';
    for (const byte of bytes) binary += String.fromCharCode(byte);
    try {
      const result = await env.AI.run('@cf/openai/whisper-large-v3-turbo', {
        audio: btoa(binary),
      });
      return context.json({ text: (result.text ?? '').trim() });
    } catch (error) {
      console.error('turbodiff: transcription failed', error);
      return context.json({ error: 'transcription failed' }, 502);
    }
  });

  app.get('/agent-runs/:id/log', async (context) => {
    const id = Number(context.req.param('id'));
    const run = await getAgentRun(id);
    if (!run || !context.get('user').organizationIds.includes(run.organization_id)) {
      return context.json({ error: 'unknown agent run' }, 404);
    }

    const artifact = run.log_artifact_id ? await getArtifact(run.log_artifact_id) : null;
    if (!artifact) return context.json({ error: 'log no longer available' }, 404);

    const object = await env.ARTIFACTS.get(artifact.storage_key);
    if (!object) return context.json({ error: 'log no longer available' }, 404);

    return context.body(object.body, 200, { 'content-type': 'text/plain; charset=utf-8' });
  });

  app.get('/agent-runs/:id/transcript', async (context) => {
    const id = Number(context.req.param('id'));
    const run = await getAgentRun(id);
    if (!run || !context.get('user').organizationIds.includes(run.organization_id)) {
      return context.json({ error: 'unknown agent run' }, 404);
    }

    const artifact = run.log_artifact_id ? await getArtifact(run.log_artifact_id) : null;
    if (!artifact) return context.json({ error: 'transcript no longer available' }, 404);

    const object = await env.ARTIFACTS.get(transcriptKey(artifact.storage_key));
    if (!object) return context.json({ error: 'transcript no longer available' }, 404);

    return context.body(object.body, 200, { 'content-type': 'application/x-ndjson' });
  });

  return app;
}
