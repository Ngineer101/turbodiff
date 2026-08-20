import { Hono } from 'hono';
import { verifyWebhookSignature } from '../integrations/github/app.ts';
import {
  createGithubWebhookService,
  type GithubWebhookDependencies,
  type ReviewDispatcher,
} from '../services/github-webhooks.ts';
import { parseJson } from '../shared/json.ts';

export type WebhookRouteDependencies = GithubWebhookDependencies;
export type { ReviewDispatcher } from '../services/github-webhooks.ts';

// GitHub HTTP transport: authenticate and decode the delivery, then hand the
// application event to the webhook service. Business policy never depends on
// Hono request/response objects.
export function createWebhookRoutes(
  dispatch: ReviewDispatcher,
  dependencies: WebhookRouteDependencies = {},
) {
  const app = new Hono();
  const service = createGithubWebhookService(dispatch, dependencies);

  app.post('/github', async (context) => {
    const rawBody = await context.req.arrayBuffer();
    const valid = await verifyWebhookSignature(rawBody, context.req.header('x-hub-signature-256'));
    if (!valid) return context.json({ error: 'invalid signature' }, 401);

    const event = context.req.header('x-github-event') ?? '';
    const payload = parseJson(new TextDecoder().decode(rawBody));
    const result = await service.handle(event, payload);
    return context.json(result.body, result.status ?? 200);
  });

  return app;
}
