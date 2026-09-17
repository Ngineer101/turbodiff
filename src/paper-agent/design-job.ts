// DesignJob Durable Object — the source of truth for a design request.
//
// The DO owns job state and drives the agent loop one turn per alarm. Between
// turns it persists the conversation and disconnects from Browser Run (leaving
// the session warm), so the job survives Worker termination and resumes by
// reconnecting to the same session by id. Browser Run is an execution
// environment; this object is the record.

import { DurableObject } from 'cloudflare:workers';
import type { BrowserWorker } from '@cloudflare/puppeteer';
import { PaperSession } from './browser.ts';
import {
  MAX_ITERATIONS,
  MAX_SCREENSHOTS,
  liveViewUrl,
  resolveModel,
  resolvePaperUrl,
} from './config.ts';
import { runAgentTurn, seedMessages, type TurnState } from './agent-loop.ts';
import { buildToolCatalog } from './tools.ts';
import type { Message } from './model.ts';
import type { CreateDesignJobInput, DesignJob as DesignJobRecord } from './types.ts';
import { TERMINAL_STATUSES } from './types.ts';

interface Persisted {
  job: DesignJobRecord;
  model: string;
  paperUrl: string;
  messages: Message[];
  screenshotCount: number;
  consecutiveErrors: number;
}

const STATE_KEY = 'state';
const CONTINUE_DELAY_MS = 1_000;
const RETRY_DELAY_MS = 5_000;
const MAX_CONSECUTIVE_ERRORS = 2;

// Cloudflare.Env (not the global Env) carries both the runtime bindings and the
// deployment-managed string vars (AI Gateway coordinates, Paper config) this
// agent reads through the model and config helpers.
export class DesignJob extends DurableObject<Cloudflare.Env> {
  /** Create the job (idempotent) and schedule the first agent turn. */
  async create(input: CreateDesignJobInput): Promise<DesignJobRecord> {
    const existing = await this.load();
    if (existing) return existing.job;

    const now = new Date().toISOString();
    const job: DesignJobRecord = {
      // The DO is addressed by name (see routes), so the public id is that name.
      id: this.ctx.id.name ?? crypto.randomUUID(),
      objective: input.objective,
      status: 'queued',
      iteration: 0,
      artifacts: { screenshots: [] },
      organizationId: input.organizationId,
      createdAt: now,
      updatedAt: now,
      notes: [],
    };
    const state: Persisted = {
      job,
      model: resolveModel(this.env, input.model),
      paperUrl: resolvePaperUrl(this.env, input.paperUrl),
      messages: seedMessages(input.objective),
      screenshotCount: 0,
      consecutiveErrors: 0,
    };
    await this.save(state);
    await this.ctx.storage.setAlarm(Date.now());
    return job;
  }

  /** Current public view of the job. */
  async snapshot(): Promise<DesignJobRecord | null> {
    return (await this.load())?.job ?? null;
  }

  /** Re-queue a paused or failed job (e.g. after Live View authentication). */
  async resume(): Promise<DesignJobRecord | null> {
    const state = await this.load();
    if (!state) return null;
    if (!['needs_user', 'failed'].includes(state.job.status)) return state.job;
    state.job.status = 'queued';
    state.job.needsUserReason = undefined;
    state.job.error = undefined;
    state.consecutiveErrors = 0;
    state.job.updatedAt = new Date().toISOString();
    await this.save(state);
    await this.ctx.storage.setAlarm(Date.now());
    return state.job;
  }

  /** Session id and Live View URL for human-assisted authentication. */
  async liveView(): Promise<{ sessionId?: string; url: string | null }> {
    const state = await this.load();
    const sessionId = state?.job.browserSessionId;
    return { sessionId, url: sessionId ? liveViewUrl(this.env, sessionId) : null };
  }

  /** Alarm handler: run exactly one agent turn, then reschedule if needed. */
  async alarm(): Promise<void> {
    const state = await this.load();
    if (!state || TERMINAL_STATUSES.has(state.job.status)) return;

    if (state.job.iteration >= MAX_ITERATIONS) {
      await this.fail(state, `reached the ${MAX_ITERATIONS}-iteration limit without completing`);
      return;
    }

    let session: PaperSession | null = null;
    try {
      session = await this.openSession(state);
      state.job.browserSessionId = session.sessionId();

      await session.ensureAt(state.paperUrl);

      // Discovering WebMCP tools is both the design surface and the readiness
      // signal: if the surface is absent, Paper is likely unauthenticated and a
      // human must sign in through Live View before the agent can proceed.
      if (!(await session.webMcpAvailable())) {
        await this.pauseForUser(
          state,
          'Paper WebMCP tools are not available. The document may need authentication — open Live View to sign in, then resume the job.',
        );
        return;
      }

      const catalog = buildToolCatalog(await session.listWebMcpTools());
      state.job.status = 'designing';

      const turnState: TurnState = {
        jobId: state.job.id,
        model: state.model,
        iteration: state.job.iteration,
        screenshotCount: state.screenshotCount,
        messages: state.messages.length ? state.messages : seedMessages(state.job.objective),
      };
      const result = await runAgentTurn(this.env, session, catalog, turnState);

      state.messages = result.messages;
      state.screenshotCount += result.newScreenshots.length;
      state.job.iteration += 1;
      state.job.artifacts.screenshots = [
        ...state.job.artifacts.screenshots,
        ...result.newScreenshots,
      ].slice(-MAX_SCREENSHOTS);
      if (result.notes.length) state.job.notes = [...state.job.notes, ...result.notes].slice(-50);
      state.consecutiveErrors = 0;
      state.job.updatedAt = new Date().toISOString();

      if (result.outcome === 'complete') {
        state.job.status = 'complete';
        if (result.detail)
          state.job.notes = [...state.job.notes, `Summary: ${result.detail}`].slice(-50);
        await this.save(state);
      } else if (result.outcome === 'needs_user') {
        await this.pauseForUser(state, result.detail ?? 'user input required');
        return;
      } else {
        state.job.status = 'designing';
        await this.save(state);
        await this.ctx.storage.setAlarm(Date.now() + CONTINUE_DELAY_MS);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'unexpected error';
      await this.handleError(state, message);
    } finally {
      // Leave the Browser Run session warm for the next turn.
      if (session) await session.disconnect().catch(() => {});
    }
  }

  private async openSession(state: Persisted): Promise<PaperSession> {
    const binding: BrowserWorker = this.env.BROWSER;
    const sessionId = state.job.browserSessionId;
    if (!sessionId) return PaperSession.open(binding);
    try {
      return await PaperSession.open(binding, { sessionId });
    } catch {
      // The warm session expired; start a fresh one. Paper will need
      // re-authentication, which the WebMCP readiness check below detects.
      state.job.browserSessionId = undefined;
      return PaperSession.open(binding);
    }
  }

  private async pauseForUser(state: Persisted, reason: string): Promise<void> {
    state.job.status = 'needs_user';
    state.job.needsUserReason = reason;
    state.job.updatedAt = new Date().toISOString();
    await this.save(state);
  }

  private async fail(state: Persisted, message: string): Promise<void> {
    state.job.status = 'failed';
    state.job.error = message;
    state.job.updatedAt = new Date().toISOString();
    await this.save(state);
  }

  private async handleError(state: Persisted, message: string): Promise<void> {
    state.consecutiveErrors += 1;
    state.job.updatedAt = new Date().toISOString();
    if (state.consecutiveErrors > MAX_CONSECUTIVE_ERRORS) {
      await this.fail(state, `agent turn failed repeatedly: ${message}`);
      return;
    }
    // Transient failure (e.g. a browser hiccup): keep the job alive and retry.
    state.job.notes = [...state.job.notes, `retrying after error: ${message}`].slice(-50);
    await this.save(state);
    await this.ctx.storage.setAlarm(Date.now() + RETRY_DELAY_MS);
  }

  private async load(): Promise<Persisted | null> {
    return (await this.ctx.storage.get<Persisted>(STATE_KEY)) ?? null;
  }

  private async save(state: Persisted): Promise<void> {
    await this.ctx.storage.put(STATE_KEY, state);
  }
}
