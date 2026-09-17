// The agent loop: plan -> execute -> observe -> evaluate -> decide.
//
// One call to `runAgentTurn` performs a single model round-trip and executes
// the tool calls it produced, then returns the updated conversation plus a
// control outcome. The DesignJob Durable Object drives turns one at a time,
// persisting the conversation between them, so a job survives Worker
// termination and can be resumed by reconnecting to the same browser session.

import type { PaperSession } from './browser.ts';
import type { PaperAgentEnv } from './config.ts';
import { MAX_SCREENSHOTS } from './config.ts';
import { pngToBase64, storeScreenshot } from './artifacts.ts';
import {
  callModel,
  toolUsesOf,
  type Message,
  type ToolResultBlock,
  type ImageBlock,
} from './model.ts';
import { isString } from '../shared/json.ts';
import type { JsonValue } from '../shared/json.ts';
import {
  BROWSER_INSPECT,
  BROWSER_NAVIGATE,
  BROWSER_SCREENSHOT,
  JOB_COMPLETE,
  JOB_NOTE,
  JOB_REQUEST_USER_INPUT,
  type ToolCatalog,
} from './tools.ts';

export const SYSTEM_PROMPT = `You are an autonomous product designer operating the Paper design tool inside a headless browser.

Work toward the user's objective by calling the provided tools:
- Prefer the structured paper__* tools (Paper's WebMCP operations) to build and edit the design. Avoid DOM automation unless a paper tool cannot do what you need.
- After making changes, call ${BROWSER_SCREENSHOT} to see the result, then critique it against the objective: layout, hierarchy, spacing, emphasis, and whether it actually satisfies the request.
- Iterate: make a change, observe, evaluate, and refine. Do not stop after a single edit if the design can be clearly improved.
- If you cannot proceed without a human (for example Paper is not authenticated, or the requirement is ambiguous), call ${JOB_REQUEST_USER_INPUT} with a specific reason.
- When the objective is met and you have captured a final screenshot, call ${JOB_COMPLETE} with a short summary.

Be decisive and economical with tool calls. One good change per turn, observed and evaluated, beats many blind edits.`;

export type TurnOutcome = 'continue' | 'complete' | 'needs_user' | 'idle';

export interface TurnState {
  jobId: string;
  model: string;
  iteration: number;
  screenshotCount: number;
  messages: Message[];
}

export interface TurnResult {
  messages: Message[];
  outcome: TurnOutcome;
  newScreenshots: string[];
  notes: string[];
  // Summary (on complete) or reason (on needs_user).
  detail?: string;
}

/** Execute one agent turn against the current Paper session. */
export async function runAgentTurn(
  env: PaperAgentEnv,
  session: PaperSession,
  catalog: ToolCatalog,
  state: TurnState,
): Promise<TurnResult> {
  const response = await callModel(env, {
    model: state.model,
    system: SYSTEM_PROMPT,
    tools: catalog.definitions,
    messages: state.messages,
  });

  const assistantTurn: Message = { role: 'assistant', content: response.content };
  const messages = [...state.messages, assistantTurn];
  const toolUses = toolUsesOf(response.content);

  // The model spoke but issued no tool call. Nudge it to act; the iteration cap
  // guarantees termination if it keeps stalling.
  if (toolUses.length === 0) {
    messages.push({
      role: 'user',
      content: [
        {
          type: 'text',
          text: 'Continue by calling a tool. Make a change with a paper__* tool, capture a screenshot, or call job_complete if the objective is already met.',
        },
      ],
    });
    return { messages, outcome: 'idle', newScreenshots: [], notes: [] };
  }

  const results: ToolResultBlock[] = [];
  const newScreenshots: string[] = [];
  const notes: string[] = [];
  let outcome: TurnOutcome = 'continue';
  let detail: string | undefined;
  let screenshotCount = state.screenshotCount;

  for (const call of toolUses) {
    // Once a terminal control is chosen, acknowledge remaining calls without
    // executing them so every tool_use still has a matching tool_result.
    if (outcome === 'complete' || outcome === 'needs_user') {
      results.push(errorResult(call.id, 'job is ending; tool call skipped'));
      continue;
    }

    if (call.name === BROWSER_SCREENSHOT) {
      const png = await session.screenshot();
      let text = 'Screenshot captured.';
      if (screenshotCount < MAX_SCREENSHOTS) {
        const stored = await storeScreenshot(state.jobId, state.iteration, png);
        newScreenshots.push(stored.url);
        screenshotCount++;
        text = `Screenshot captured and saved to ${stored.url}`;
      }
      results.push({
        tool_use_id: call.id,
        type: 'tool_result',
        content: [imageBlock(png), { type: 'text', text }],
      });
    } else if (call.name === BROWSER_NAVIGATE) {
      const url = str(call.input.url);
      await session.navigate(url);
      results.push(textResult(call.id, `Navigated to ${url}`));
    } else if (call.name === BROWSER_INSPECT) {
      const selector = str(call.input.selector) || undefined;
      const text = await session.inspect(selector);
      results.push(textResult(call.id, text || '(no visible text)'));
    } else if (call.name === JOB_NOTE) {
      const note = str(call.input.note).trim();
      if (note) notes.push(note);
      results.push(textResult(call.id, 'Noted.'));
    } else if (call.name === JOB_REQUEST_USER_INPUT) {
      detail = str(call.input.reason).trim() || 'user input required';
      outcome = 'needs_user';
      results.push(textResult(call.id, 'Job paused for user input.'));
    } else if (call.name === JOB_COMPLETE) {
      detail = str(call.input.summary).trim() || 'objective complete';
      outcome = 'complete';
      results.push(textResult(call.id, 'Job marked complete.'));
    } else {
      const paperName = catalog.paperAlias.get(call.name);
      if (!paperName) {
        results.push(errorResult(call.id, `unknown tool "${call.name}"`));
        continue;
      }
      const result = await session.executeWebMcpTool(paperName, call.input);
      if (result.ok) {
        results.push(textResult(call.id, `Result: ${safeJson(result.value ?? null)}`));
      } else {
        results.push(errorResult(call.id, result.error ?? 'tool failed'));
      }
    }
  }

  messages.push({ role: 'user', content: results });
  return { messages, outcome, newScreenshots, notes, detail };
}

function textResult(id: string, text: string): ToolResultBlock {
  return { tool_use_id: id, type: 'tool_result', content: [{ type: 'text', text }] };
}

function errorResult(id: string, text: string): ToolResultBlock {
  return {
    tool_use_id: id,
    type: 'tool_result',
    is_error: true,
    content: [{ type: 'text', text }],
  };
}

function imageBlock(png: Uint8Array): ImageBlock {
  return {
    type: 'image',
    source: { type: 'base64', media_type: 'image/png', data: pngToBase64(png) },
  };
}

/** Read a tool argument as a string, only when it already is one. */
function str(value: JsonValue): string {
  return isString(value) ? value : '';
}

/** Serialise a tool result compactly for the model, bounding its length. */
function safeJson(value: JsonValue): string {
  const json = JSON.stringify(value) ?? 'null';
  return json.length > 4000 ? `${json.slice(0, 4000)}… (truncated)` : json;
}

/** The initial user message that seeds a job's conversation. */
export function seedMessages(objective: string): Message[] {
  const seed: Message = {
    role: 'user',
    content: [
      {
        type: 'text',
        text: `Objective: ${objective}\n\nPaper is open in the browser. Start by discovering what the design currently looks like (capture a screenshot), then plan and build toward the objective.`,
      },
    ],
  };
  return [seed];
}
