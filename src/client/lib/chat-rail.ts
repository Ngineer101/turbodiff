import type { ApiChatMessage } from '../../shared/api-types.ts';
import { parseUtc } from '../../shared/time.ts';

// DOM-free helpers behind the cockpit's chat rail (chat-rail.tsx): the
// transcript's unread bookkeeping, the working-turn timeline, the ledger a
// merged PR's chat leaves behind, and the composer's text transforms. Kept
// pure so they run under the plugin-free vitest config.

// Rail preferences persist beside the left sidebar's (`turbodiff.sidebar`).
export const RAIL_OPEN_KEY = 'turbodiff.chat-rail';
export const RAIL_WIDTH_KEY = 'turbodiff.chat-rail.width';
export const RAIL_DEFAULT_WIDTH = 384;
export const RAIL_MIN_WIDTH = 320;
export const RAIL_MAX_WIDTH = 560;

export const draftKey = (featureId: number): string => `turbodiff.chat-draft.${featureId}`;
export const seenKey = (featureId: number): string => `turbodiff.chat-seen.${featureId}`;

// The drag handle and the stored preference both pass through here, so a
// stale or hand-edited value can never produce an unusable rail.
export function clampRailWidth(width: number): number {
  if (!Number.isFinite(width)) return RAIL_DEFAULT_WIDTH;
  return Math.min(RAIL_MAX_WIDTH, Math.max(RAIL_MIN_WIDTH, Math.round(width)));
}

// A user chat message in one of these states has a turn in flight — the
// rail polls and the composer queues instead of sending until the reply
// lands.
export const CHAT_TURN_PENDING = new Set(['queued', 'running']);

export function pendingTurn(messages: ApiChatMessage[]): ApiChatMessage | null {
  return messages.find((m) => m.role === 'user' && CHAT_TURN_PENDING.has(m.status)) ?? null;
}

// Server ids are positive and ascend with time; optimistic rows are negative
// and never count as replies.
export function latestReplyId(messages: ApiChatMessage[]): number {
  let latest = 0;
  for (const m of messages) if (m.role === 'assistant' && m.id > latest) latest = m.id;
  return latest;
}

export function unreadReplies(messages: ApiChatMessage[], lastSeenId: number): number {
  let n = 0;
  for (const m of messages) if (m.role === 'assistant' && m.id > lastSeenId) n += 1;
  return n;
}

export function elapsedSeconds(createdAt: string, now: number): number {
  return Math.max(0, Math.floor((now - parseUtc(createdAt)) / 1000));
}

// m:ss for the working pill, h:mm:ss once a turn runs long.
export function fmtClock(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const pad = (n: number) => String(n).padStart(2, '0');
  if (s >= 3600)
    return `${Math.floor(s / 3600)}:${pad(Math.floor((s % 3600) / 60))}:${pad(s % 60)}`;
  return `${Math.floor(s / 60)}:${pad(s % 60)}`;
}

// Compact relative time for message meta ("14m", not "14m ago" — the
// transcript already reads as a timeline).
export function agoShort(createdAt: string, now: number): string {
  const s = elapsedSeconds(createdAt, now);
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

export interface TurnStep {
  label: string;
  state: 'done' | 'live';
}

// What the turn's status lets us say honestly: queued means no sandbox has
// picked it up yet; running means the branch is checked out and the agent
// is working (the runner sets 'running' right before it starts).
export function turnSteps(status: string): TurnStep[] {
  if (status === 'running') {
    return [
      { label: 'Sandbox ready, branch checked out', state: 'done' },
      { label: 'Working on your change', state: 'live' },
    ];
  }
  return [{ label: 'Queued for a sandbox', state: 'live' }];
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function dayStart(ms: number): number {
  const d = new Date(ms);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

export function dayLabel(createdAt: string, now: number): string {
  const day = dayStart(parseUtc(createdAt));
  const today = dayStart(now);
  const diffDays = Math.round((today - day) / 86_400_000);
  if (diffDays === 0) return 'Today';
  if (diffDays === 1) return 'Yesterday';
  const d = new Date(day);
  const sameYear = d.getFullYear() === new Date(now).getFullYear();
  return `${MONTHS[d.getMonth()]} ${d.getDate()}${sameYear ? '' : `, ${d.getFullYear()}`}`;
}

export interface DayGroup {
  label: string;
  messages: ApiChatMessage[];
}

export function groupByDay(messages: ApiChatMessage[], now: number): DayGroup[] {
  const groups: DayGroup[] = [];
  for (const m of messages) {
    const label = dayLabel(m.created_at, now);
    const last = groups.at(-1);
    if (last && last.label === label) last.messages.push(m);
    else groups.push({ label, messages: [m] });
  }
  return groups;
}

export interface ChatLedger {
  turns: number;
  pushes: number;
  failures: number;
  spanSeconds: number;
}

// The job-ticket line a finished conversation leaves behind. Failures count
// turns that pushed nothing because checks failed plus turns that never ran.
export function chatLedger(messages: ApiChatMessage[]): ChatLedger {
  let turns = 0;
  let pushes = 0;
  let failures = 0;
  for (const m of messages) {
    if (m.role === 'user') {
      turns += 1;
      if (m.status === 'failed') failures += 1;
    } else {
      if (m.outcome === 'changed') pushes += 1;
      if (m.outcome === 'tests_failed') failures += 1;
    }
  }
  const first = messages[0];
  const last = messages.at(-1);
  const spanSeconds =
    first && last
      ? Math.max(0, Math.floor((parseUtc(last.created_at) - parseUtc(first.created_at)) / 1000))
      : 0;
  return { turns, pushes, failures, spanSeconds };
}

export function fmtSpan(seconds: number): string {
  const m = Math.max(1, Math.round(seconds / 60));
  if (m < 60) return `${m} min`;
  return `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, '0')} min`;
}

// The composer's context chip: the file open in the diff pane rides along as
// a first line, so the agent knows what the user is looking at. Transparent
// — the transcript shows exactly what was sent.
export function withFileContext(body: string, file: string | null): string {
  return file ? `(Looking at \`${file}\`)\n\n${body}` : body;
}

// ↑ in an empty composer recalls the sender's last message, ChatGPT-style.
export function previousUserBody(messages: ApiChatMessage[], author: string | null): string | null {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const m = messages[i];
    if (m.role === 'user' && (author === null || m.author === author)) return m.body;
  }
  return null;
}

export function quoteBlock(text: string): string {
  return `${text
    .trim()
    .split('\n')
    .map((line) => `> ${line}`)
    .join('\n')}\n\n`;
}

// Only GitHub-backed PRs have a commit page; native change requests show
// the commit in the diff pane instead.
export function commitUrl(repo: string, provider: string, sha: string | null): string | null {
  return provider === 'github' && sha ? `https://github.com/${repo}/commit/${sha}` : null;
}

export interface SuggestionContext {
  activeFile: string | null;
  checksFailing: boolean;
}

// Empty-state chips: starting points that reflect the PR's state rather
// than generic prompts.
export function suggestions(ctx: SuggestionContext): string[] {
  const out: string[] = [];
  if (ctx.checksFailing) out.push('Fix the failing check');
  if (ctx.activeFile) out.push(`Add tests for ${ctx.activeFile.split('/').at(-1)}`);
  out.push('Explain what this PR changes');
  out.push('Tighten naming and comments without changing behaviour');
  out.push('Check the error handling in this change');
  return out.slice(0, 3);
}

// The rail's resting width from the saved preferences — what the cockpit
// reserves while the rail's chunk loads, so nothing shifts when it mounts.
export function railRestWidth(openPref: string | null, widthPref: string | null): number {
  if (openPref === 'closed') return 48;
  return clampRailWidth(Number(widthPref) || RAIL_DEFAULT_WIDTH);
}
