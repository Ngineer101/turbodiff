import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ArrowDown,
  ArrowUp,
  Copy,
  CornerUpLeft,
  ExternalLink,
  MessageSquare,
  PanelRightClose,
  PanelRightOpen,
  RotateCcw,
  X,
} from 'lucide-react';
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type Dispatch,
  type KeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  type RefObject,
  type SetStateAction,
} from 'react';
import { useHotkeys } from 'react-hotkeys-hook';
import { toast } from 'sonner';
import type { ApiChatList, ApiChatMessage, ApiMe } from '../../shared/api-types.ts';
import { api, ApiError } from '../lib/api.ts';
import {
  agoShort,
  chatLedger,
  clampRailWidth,
  commitUrl,
  draftKey,
  elapsedSeconds,
  fmtClock,
  fmtSpan,
  groupByDay,
  latestReplyId,
  pendingTurn,
  previousUserBody,
  quoteBlock,
  RAIL_DEFAULT_WIDTH,
  RAIL_OPEN_KEY,
  RAIL_WIDTH_KEY,
  seenKey,
  suggestions,
  turnSteps,
  unreadReplies,
  withFileContext,
} from '../lib/chat-rail.ts';
import { useDictation } from '../lib/dictation.ts';
import { applyOptimistic, optimisticId, optimisticNow } from '../lib/optimistic.ts';
import { chatQuery } from '../lib/queries.ts';
import { noOverlayOpen } from '../lib/shortcuts.ts';
import { useIsWide } from '../lib/use-is-desktop.ts';
import { cn } from '../lib/utils.ts';
import { Lamp, Ledger, Stamp } from './identity.tsx';
import { Markdown } from './markdown.tsx';
import { MicButton } from './mic-button.tsx';
import { Dialog, DialogClose, DialogTitle, SheetContent } from './ui/dialog.tsx';
import { Kbd } from './ui/kbd.tsx';
import { Pill } from './ui/pill.tsx';
import { Tooltip } from './ui/tooltip.tsx';

// The cockpit's agent chat as a rail: the right-hand twin of the left
// sidebar, only on this page. Full viewport height with the transcript
// scrolling between a pinned header and composer; a 48px icon rail when
// collapsed (⌘J), a bottom sheet below lg. Each user message is one turn —
// the agent's reply (and its branch outcome) lands as an assistant row via
// the live poll while a turn is in flight. Design: Paper boards
// "10 Cockpit · Chat rail".

const EMPTY: ApiChatMessage[] = [];
const COMPOSER_MAX_HEIGHT = 8 * 22 + 12;

function onApiError<T>(err: T) {
  toast.error(err instanceof ApiError ? err.message : 'Request failed');
}

function copyText(text: string) {
  navigator.clipboard.writeText(text).then(
    () => toast.success('Copied'),
    () => toast.error('Copy failed'),
  );
}

// A ticking clock, only while something is live — the working pill and
// timeline read from it; idle transcripts never re-render on a timer.
function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [active]);
  return now;
}

interface ChatState {
  messages: ApiChatMessage[];
  loading: boolean;
  pending: ApiChatMessage | null;
  unread: number;
  // Replies newer than this id sit below the "new replies" divider; null
  // when nothing arrived unseen.
  dividerAfter: number | null;
  markSeen: () => void;
  body: string;
  setBody: Dispatch<SetStateAction<string>>;
  // A follow-up typed while a turn was running: sent the moment it ends.
  queued: string | null;
  unqueue: () => void;
  submit: (text: string) => void;
  sending: boolean;
  me: string | null;
}

// Everything the rail and the sheet share: the transcript query, unread
// bookkeeping (persisted, so a collapsed rail can count replies across
// reloads), the draft (persisted per feature), and the send/queue path.
function useChat(featureId: number, visible: boolean): ChatState {
  const queryClient = useQueryClient();
  const { data, isPending: loading } = useQuery(chatQuery(featureId));
  const messages = data?.messages ?? EMPTY;
  const pending = pendingTurn(messages);
  const inFlight = pending !== null;

  // A completed turn may have pushed a new commit — refresh the feature
  // (diff, runs, verification) when the poll flips pending → done, so the
  // new state appears without a manual reload.
  const prevInFlight = useRef(inFlight);
  useEffect(() => {
    if (prevInFlight.current && !inFlight) {
      void queryClient.invalidateQueries({ queryKey: ['feature', featureId] });
    }
    prevInFlight.current = inFlight;
  }, [inFlight, featureId, queryClient]);

  const latest = latestReplyId(messages);
  const [lastSeen, setLastSeen] = useState(
    () => Number(localStorage.getItem(seenKey(featureId))) || 0,
  );
  const markSeen = useCallback(() => {
    setLastSeen((prev) => {
      if (latest <= prev) return prev;
      localStorage.setItem(seenKey(featureId), String(latest));
      return latest;
    });
  }, [latest, featureId]);
  const unread = unreadReplies(messages, lastSeen);

  // The divider pins where the reader left off. It appears when unseen
  // replies exist (a zero baseline means "never read", not "left off at
  // the top") and clears on the next send or when the transcript hides.
  const [dividerAfter, setDividerAfter] = useState<number | null>(null);
  useEffect(() => {
    if (unread > 0 && lastSeen > 0) setDividerAfter((prev) => prev ?? lastSeen);
  }, [unread, lastSeen]);
  useEffect(() => {
    if (!visible) setDividerAfter(null);
  }, [visible]);

  const [body, setBody] = useState(() => localStorage.getItem(draftKey(featureId)) ?? '');
  useEffect(() => {
    if (body) localStorage.setItem(draftKey(featureId), body);
    else localStorage.removeItem(draftKey(featureId));
  }, [body, featureId]);

  const send = useMutation({
    mutationFn: (text: string) =>
      api.post(`/api/factory/features/${featureId}/chat`, { body: text }),
    // The message appears in the transcript on Send; 'queued' status also
    // flips the in-flight state, so the working pill reacts instantly too.
    onMutate: async (text) => {
      const me = queryClient.getQueryData<ApiMe>(['me']);
      const ctx = await applyOptimistic<ApiChatList>(queryClient, ['chat', featureId], (prev) => ({
        messages: [
          ...prev.messages,
          {
            id: optimisticId(),
            role: 'user',
            body: text,
            author: me?.login ?? null,
            status: 'queued',
            outcome: null,
            commit_sha: null,
            error: null,
            created_at: optimisticNow(),
          },
        ],
      }));
      return { ...ctx, text };
    },
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['chat', featureId] }),
    onError: (err, _v, ctx) => {
      ctx?.rollback();
      // Give the failed message back to the box rather than losing it.
      if (ctx) setBody((prev) => (prev.trim() ? `${ctx.text}\n\n${prev}` : ctx.text));
      onApiError(err);
    },
  });
  const { mutate, isPending: sending } = send;

  const [queued, setQueued] = useState<string | null>(null);
  useEffect(() => {
    if (inFlight || queued === null || sending) return;
    setQueued(null);
    mutate(queued);
  }, [inFlight, queued, sending, mutate]);
  const queuedRef = useRef(queued);
  queuedRef.current = queued;
  // Edit a queued follow-up: it goes back into the box, ahead of any draft.
  const unqueue = useCallback(() => {
    const text = queuedRef.current;
    if (text === null) return;
    setQueued(null);
    setBody((prev) => (prev.trim() ? `${text}\n\n${prev}` : text));
  }, []);
  const submit = useCallback(
    (text: string) => {
      setDividerAfter(null);
      if (inFlight) setQueued(text);
      else mutate(text);
    },
    [inFlight, mutate],
  );

  return {
    messages,
    loading,
    pending,
    unread,
    dividerAfter,
    markSeen,
    body,
    setBody,
    queued,
    unqueue,
    submit,
    sending,
    me: queryClient.getQueryData<ApiMe>(['me'])?.login ?? null,
  };
}

// --- pieces -----------------------------------------------------------------

function OutcomePill({ message }: { message: ApiChatMessage }) {
  if (message.outcome === 'changed') {
    return <Pill tone="on">Pushed {message.commit_sha?.slice(0, 7)}</Pill>;
  }
  if (message.outcome === 'no_changes') return <Pill tone="neutral">No changes</Pill>;
  if (message.outcome === 'tests_failed') {
    return <Pill tone="warn">Checks failed — not pushed</Pill>;
  }
  return null;
}

const ACTION =
  'flex cursor-pointer items-center gap-1 rounded-[5px] px-1.5 py-0.5 font-mono text-[10px] tracking-[0.04em] text-mute transition-colors hover:bg-raised hover:text-ink';

function Meta({ children }: { children: ReactNode }) {
  return (
    <div className="mb-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-mute">
      {children}
    </div>
  );
}

function UserMessage({
  message,
  now,
  canWrite,
  onRetry,
}: {
  message: ApiChatMessage;
  now: number;
  canWrite: boolean;
  onRetry: (text: string) => void;
}) {
  const failed = message.status === 'failed';
  return (
    <div
      className={cn(
        'ml-auto min-w-0 max-w-[85%] rounded-md border bg-surface px-3 py-2 text-[0.85rem]',
        failed ? 'border-danger/40' : 'border-line-2',
      )}
    >
      <Meta>
        <strong className="font-semibold text-ink-dim">@{message.author}</strong>
        <span title={message.created_at}>{agoShort(message.created_at, now)}</span>
        {failed ? <Pill tone="red">Failed</Pill> : null}
      </Meta>
      <p className="break-words whitespace-pre-wrap text-ink">{message.body}</p>
      {failed ? (
        <div className="mt-1.5 flex items-start justify-between gap-3">
          <p className="text-xs text-danger">{message.error ?? 'The turn did not run.'}</p>
          {canWrite ? (
            <button
              type="button"
              onClick={() => onRetry(message.body)}
              className="flex shrink-0 cursor-pointer items-center gap-1 rounded-[5px] border border-line-2 px-2 py-0.5 font-mono text-[10px] text-ink transition-colors hover:border-accent hover:bg-raised"
            >
              <RotateCcw className="size-3" aria-hidden />
              Retry
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function AgentMessage({
  message,
  now,
  repo,
  provider,
  canWrite,
  onQuote,
}: {
  message: ApiChatMessage;
  now: number;
  repo: string;
  provider: string;
  canWrite: boolean;
  onQuote: (text: string) => void;
}) {
  const commit = commitUrl(repo, provider, message.commit_sha);
  return (
    // Flat on the rail with a bone rule — no box, so a long reply reads
    // like a document rather than a speech bubble.
    <div className="group min-w-0 border-l-2 border-ink-dim/70 pl-3 text-[0.85rem]">
      <Meta>
        <strong className="font-semibold text-ink-dim">Agent</strong>
        <span title={message.created_at}>{agoShort(message.created_at, now)}</span>
        <OutcomePill message={message} />
      </Meta>
      <Markdown className="markdown-body--compact">{message.body}</Markdown>
      {/* Hover actions: always visible on touch, revealed on hover/focus
          where there is a pointer. Reserved height, so nothing shifts. */}
      <div className="mt-1 flex items-center gap-0.5 lg:opacity-0 lg:transition-opacity lg:group-focus-within:opacity-100 lg:group-hover:opacity-100">
        <button type="button" className={ACTION} onClick={() => copyText(message.body)}>
          <Copy className="size-3" aria-hidden />
          Copy
        </button>
        {canWrite ? (
          <button type="button" className={ACTION} onClick={() => onQuote(message.body)}>
            <CornerUpLeft className="size-3" aria-hidden />
            Quote
          </button>
        ) : null}
        {commit ? (
          <a href={commit} target="_blank" rel="noopener" className={ACTION}>
            <ExternalLink className="size-3" aria-hidden />
            View commit
          </a>
        ) : null}
      </div>
    </div>
  );
}

// The in-flight turn: not a spinner but the steps the status proves, with
// an elapsed clock. Replies usually land within a few minutes.
function PendingTurn({ message, now }: { message: ApiChatMessage; now: number }) {
  return (
    <div className="min-w-0 border-l-2 border-hold pl-3 text-[0.85rem]" role="status">
      <Meta>
        <strong className="font-semibold text-ink-dim">Agent</strong>
        <Pill tone="running">working · {fmtClock(elapsedSeconds(message.created_at, now))}</Pill>
      </Meta>
      <ol className="flex flex-col gap-1 font-mono text-[11px]">
        {turnSteps(message.status).map((step) => (
          <li
            key={step.label}
            className={cn(
              'flex items-center gap-2',
              step.state === 'live' ? 'text-ink-dim' : 'text-mute',
            )}
          >
            {step.state === 'done' ? (
              <span className="w-2 text-center text-go-bright" aria-hidden>
                ✓
              </span>
            ) : (
              <Lamp tone="hold" pulse />
            )}
            {step.label}
          </li>
        ))}
      </ol>
    </div>
  );
}

function QueuedFollowUp({ text, onEdit }: { text: string; onEdit: () => void }) {
  return (
    <div className="ml-auto min-w-0 max-w-[85%] rounded-md border border-dashed border-line-2 px-3 py-2 text-[0.85rem]">
      <Meta>
        <span className="font-mono text-[10px] tracking-[0.08em] text-hold uppercase">
          Queued · sends when the agent finishes
        </span>
        <button type="button" onClick={onEdit} className={cn(ACTION, 'ml-auto')}>
          Edit
        </button>
      </Meta>
      <p className="break-words whitespace-pre-wrap text-ink-dim">{text}</p>
    </div>
  );
}

function DaySeparator({ label, tone = 'neutral' }: { label: string; tone?: 'neutral' | 'new' }) {
  const line = tone === 'new' ? 'bg-accent/50' : 'bg-line';
  return (
    <div className="flex items-center gap-2.5" aria-hidden={tone === 'neutral'}>
      <span className={cn('h-px flex-1', line)} />
      <span
        className={cn(
          'font-mono text-[10px] tracking-[0.14em] uppercase',
          tone === 'new' ? 'text-accent' : 'text-mute',
        )}
      >
        {label}
      </span>
      <span className={cn('h-px flex-1', line)} />
    </div>
  );
}

function EmptyState({ chips, onPick }: { chips: string[]; onPick: (text: string) => void }) {
  return (
    <div className="flex flex-col gap-3">
      <p className="text-[0.85rem] leading-relaxed text-mute">
        Ask the agent to tweak this PR — small iterative changes, one message at a time. Each change
        is committed as you and pushed to the branch.
      </p>
      <div className="flex flex-wrap gap-1.5">
        {chips.map((chip) => (
          <button
            key={chip}
            type="button"
            onClick={() => onPick(chip)}
            className="cursor-pointer rounded-full border border-line-2 px-2.5 py-1 text-xs text-ink-dim transition-colors hover:border-accent hover:text-ink"
          >
            {chip}
          </button>
        ))}
      </div>
    </div>
  );
}

interface TranscriptProps {
  chat: ChatState;
  visible: boolean;
  canWrite: boolean;
  repo: string;
  provider: string;
  chips: string[];
  onQuote: (text: string) => void;
  onPick: (text: string) => void;
}

function Transcript({
  chat,
  visible,
  canWrite,
  repo,
  provider,
  chips,
  onQuote,
  onPick,
}: TranscriptProps) {
  const { messages, loading, pending, queued, unread, dividerAfter, markSeen } = chat;
  const now = useNow(pending !== null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const innerRef = useRef<HTMLDivElement>(null);
  // Whether the reader is at (or within a few rows of) the bottom. The ref
  // is read in layout effects and observers; the state drives the sticker.
  const atBottomRef = useRef(true);
  const [atBottom, setAtBottom] = useState(true);
  const settle = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const near = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
    atBottomRef.current = near;
    setAtBottom(near);
  }, []);
  const scrollToBottom = useCallback((behavior: ScrollBehavior) => {
    const el = scrollRef.current;
    if (el) el.scrollTo({ top: el.scrollHeight, behavior });
  }, []);

  // Follow the conversation: the first paint lands at the bottom; growth
  // while pinned glides down; a reader who scrolled up is left alone.
  const painted = useRef(false);
  const count = messages.length;
  const pendingStatus = pending?.status ?? null;
  useLayoutEffect(() => {
    if (loading) return;
    if (!painted.current) {
      painted.current = true;
      scrollToBottom('instant');
      return;
    }
    if (atBottomRef.current) scrollToBottom('smooth');
  }, [loading, count, pendingStatus, queued, scrollToBottom]);
  // Markdown chunks and images resize rows after they land — keep pinned.
  useEffect(() => {
    const inner = innerRef.current;
    if (!inner) return;
    const observer = new ResizeObserver(() => {
      if (atBottomRef.current) scrollToBottom('instant');
    });
    observer.observe(inner);
    return () => observer.disconnect();
  }, [scrollToBottom]);
  useEffect(() => {
    if (visible && atBottom && unread > 0) markSeen();
  }, [visible, atBottom, unread, markSeen]);

  const groups = groupByDay(messages, now);
  // The divider's count is what arrived since the reader left off — not the
  // live unread count, which drops to zero the moment the bottom is in view.
  const arrived =
    dividerAfter === null
      ? []
      : messages.filter((m) => m.role === 'assistant' && m.id > dividerAfter);
  const firstUnread = arrived[0]?.id ?? null;

  return (
    <div className="relative min-h-0 flex-1">
      <div
        ref={scrollRef}
        onScroll={settle}
        role="log"
        aria-live="polite"
        aria-label="Conversation"
        className="h-full overflow-y-auto overscroll-contain px-4 pt-4 pb-3"
      >
        <div ref={innerRef} className="flex flex-col gap-3.5">
          {loading ? (
            // History-shaped placeholder — the "ask the agent" empty-state
            // copy must not flash while the real history is still loading.
            <div className="animate-pulse space-y-3" role="status" aria-label="Loading chat">
              <div className="ml-auto h-12 w-3/5 rounded-md bg-surface" />
              <div className="h-16 w-4/5 rounded-md bg-surface" />
              <div className="ml-auto h-10 w-1/2 rounded-md bg-surface" />
            </div>
          ) : messages.length === 0 && canWrite ? (
            <EmptyState chips={chips} onPick={onPick} />
          ) : null}
          {groups.map((group) => (
            <div key={group.label} className="contents">
              <DaySeparator label={group.label} />
              {group.messages.map((m) => (
                <div key={m.id} className="contents">
                  {m.id === firstUnread ? (
                    <DaySeparator
                      tone="new"
                      label={arrived.length > 1 ? `${arrived.length} new replies` : 'new reply'}
                    />
                  ) : null}
                  {m.role === 'user' ? (
                    pending?.id === m.id ? null : (
                      <UserMessage
                        message={m}
                        now={now}
                        canWrite={canWrite}
                        onRetry={chat.submit}
                      />
                    )
                  ) : (
                    <AgentMessage
                      message={m}
                      now={now}
                      repo={repo}
                      provider={provider}
                      canWrite={canWrite}
                      onQuote={onQuote}
                    />
                  )}
                </div>
              ))}
            </div>
          ))}
          {pending ? (
            <>
              <UserMessage message={pending} now={now} canWrite={canWrite} onRetry={chat.submit} />
              <PendingTurn message={pending} now={now} />
            </>
          ) : null}
          {queued !== null ? <QueuedFollowUp text={queued} onEdit={chat.unqueue} /> : null}
        </div>
      </div>
      {/* The way back down: yellow when replies landed while scrolled up,
          plain when the reader simply scrolled. */}
      {!atBottom && !loading ? (
        <button
          type="button"
          onClick={() => scrollToBottom('smooth')}
          aria-label={unread > 0 ? `${unread} new replies — jump to latest` : 'Jump to latest'}
          className={cn(
            'absolute bottom-3 left-1/2 flex -translate-x-1/2 cursor-pointer items-center gap-1.5 rounded-full font-mono text-[11px] font-semibold tracking-[0.04em] transition-transform hover:-translate-y-px active:translate-y-0',
            unread > 0
              ? 'bg-accent py-1.5 pr-3 pl-2.5 text-accent-ink shadow-edge-xs'
              : 'size-7 justify-center border border-line-2 bg-raised text-ink shadow-sticker',
          )}
        >
          <ArrowDown className="size-3" aria-hidden />
          {unread > 0 ? `${unread} new ${unread === 1 ? 'reply' : 'replies'}` : null}
        </button>
      ) : null}
    </div>
  );
}

interface ComposerProps {
  chat: ChatState;
  activeFile: string | null;
  composerRef: RefObject<HTMLTextAreaElement | null>;
  focusTick: number;
}

function Composer({ chat, activeFile, composerRef, focusTick }: ComposerProps) {
  const { body, setBody, pending, sending } = chat;
  const inFlight = pending !== null;
  const now = useNow(inFlight);
  // The file open in the diff pane rides along as context. Detaching lasts
  // for the current file only — a new file is new context.
  const [attach, setAttach] = useState(true);
  useEffect(() => setAttach(true), [activeFile]);
  const [focused, setFocused] = useState(false);
  const dictation = useDictation((text) =>
    setBody((prev) => (prev.trim() ? `${prev}\n\n${text}` : text)),
  );
  const value = dictation.recording
    ? body.trim()
      ? `${body}\n\n${dictation.interim}`
      : dictation.interim
    : body;

  // Auto-grow to eight lines, then scroll inside.
  useLayoutEffect(() => {
    const el = composerRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, COMPOSER_MAX_HEIGHT)}px`;
  }, [value, composerRef]);
  useEffect(() => {
    if (focusTick > 0) {
      const el = composerRef.current;
      el?.focus();
      el?.setSelectionRange(el.value.length, el.value.length);
    }
  }, [focusTick, composerRef]);

  const canSend = body.trim().length > 0 && !dictation.recording && !sending;
  const submit = () => {
    const text = body.trim();
    if (!text || !canSend) return;
    chat.submit(withFileContext(text, attach ? activeFile : null));
    setBody('');
  };
  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.nativeEvent.isComposing) return;
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      submit();
    } else if (e.key === 'ArrowUp' && body === '') {
      const last = previousUserBody(chat.messages, chat.me);
      if (last) {
        e.preventDefault();
        setBody(last);
      }
    } else if (e.key === 'Escape') {
      e.currentTarget.blur();
    }
  };

  return (
    <div className="shrink-0 border-t border-line px-4 pt-3 pb-3.5">
      {activeFile ? (
        <div className="mb-2 flex items-center gap-1.5">
          {attach ? (
            <span className="flex max-w-full items-center gap-1.5 rounded-full border border-line-2 py-0.5 pr-1.5 pl-2.5 font-mono text-[11px] text-ink-dim">
              <span className="text-mute">viewing</span>
              <span className="truncate">{activeFile.split('/').at(-1)}</span>
              <button
                type="button"
                onClick={() => setAttach(false)}
                aria-label="Send without the file context"
                className="cursor-pointer rounded-full p-0.5 text-mute transition-colors hover:bg-raised hover:text-ink"
              >
                <X className="size-3" aria-hidden />
              </button>
            </span>
          ) : (
            <button
              type="button"
              onClick={() => setAttach(true)}
              className="cursor-pointer rounded-full border border-dashed border-line-2 px-2.5 py-0.5 font-mono text-[11px] text-mute transition-colors hover:border-line-2 hover:text-ink"
            >
              + attach {activeFile.split('/').at(-1)}
            </button>
          )}
        </div>
      ) : null}
      <div
        className={cn(
          'rounded-lg border bg-surface transition-colors',
          focused ? 'border-accent/50' : 'border-line-2/70',
          inFlight && !focused && 'opacity-80',
        )}
      >
        <textarea
          ref={composerRef}
          rows={1}
          value={value}
          onChange={(e) => setBody(e.target.value)}
          onKeyDown={onKeyDown}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          disabled={dictation.recording}
          placeholder={
            inFlight
              ? 'Queue a follow-up — it runs after this turn'
              : 'What should the agent change?'
          }
          aria-label="Message to the chat agent"
          className="block w-full resize-none bg-transparent px-3 pt-2.5 pb-1 text-base leading-[22px] text-ink outline-none placeholder:text-mute/70 sm:text-sm"
        />
        <div className="flex items-center justify-between gap-2 px-2 pb-2">
          <div className="flex min-w-0 items-center gap-1.5">
            <MicButton dictation={dictation} compact />
            {inFlight ? (
              <span className="flex items-center gap-1.5 truncate font-mono text-[10px] text-hold">
                <Lamp tone="hold" pulse />
                Agent is working · {fmtClock(elapsedSeconds(pending.created_at, now))}
              </span>
            ) : (
              <span className="hidden font-mono text-[10px] text-mute sm:inline">
                ↵ send · ⇧↵ newline
              </span>
            )}
          </div>
          <Tooltip label={inFlight ? 'Queue (⏎)' : 'Send (⏎)'} side="left">
            <button
              type="button"
              onClick={submit}
              disabled={!canSend}
              aria-label={inFlight ? 'Queue message' : 'Send message'}
              className="flex size-7 cursor-pointer items-center justify-center rounded-md bg-accent text-accent-ink shadow-edge-xs transition-[transform,box-shadow,background-color] duration-100 hover:bg-accent-bright active:translate-x-px active:translate-y-px active:shadow-none disabled:pointer-events-none disabled:opacity-40 max-sm:size-11"
            >
              <ArrowUp className="size-3.5" strokeWidth={2.5} aria-hidden />
            </button>
          </Tooltip>
        </div>
      </div>
    </div>
  );
}

// Job Ticket vocabulary for a finished conversation: the outcome stamp and
// the ledger line of what the chat produced.
function ReadOnlyFloor({ messages, prState }: { messages: ApiChatMessage[]; prState: string }) {
  const ledger = chatLedger(messages);
  return (
    <div className="shrink-0 border-t border-line px-4 pt-3 pb-3.5">
      <div className="flex items-center justify-between gap-3">
        <span className="font-mono text-[10px] font-semibold tracking-[0.18em] text-mute uppercase">
          Ledger
        </span>
        {prState === 'merged' ? <Stamp tone="ok">MERGED</Stamp> : null}
        {prState === 'closed' ? <Stamp tone="red">ABANDONED</Stamp> : null}
      </div>
      <Ledger
        className="mt-2"
        items={[
          { label: 'Turns', value: ledger.turns },
          { label: 'Pushes', value: ledger.pushes, tone: ledger.pushes > 0 ? 'go' : undefined },
          { label: 'Failures', value: ledger.failures },
          { label: 'Span', value: fmtSpan(ledger.spanSeconds) },
        ]}
      />
      <p className="mt-2 text-xs text-mute">
        The chat is history now — the agent no longer has this branch.
      </p>
    </div>
  );
}

function RailHeader({
  chat,
  canWrite,
  prState,
  prNumber,
  trailing,
}: {
  chat: ChatState;
  canWrite: boolean;
  prState: string;
  prNumber: number | null;
  trailing: ReactNode;
}) {
  const { pending } = chat;
  const now = useNow(pending !== null);
  const tone = pending ? 'hold' : prState === 'merged' ? 'go' : 'off';
  const aside = pending
    ? `working ${fmtClock(elapsedSeconds(pending.created_at, now))}`
    : canWrite
      ? prNumber
        ? `PR #${prNumber}`
        : 'open'
      : `${prState} · read only`;
  return (
    <div className="flex h-14 shrink-0 items-center justify-between gap-3 border-b border-line pr-2 pl-4">
      <div className="flex min-w-0 items-center gap-2.5">
        <Lamp tone={tone} pulse={pending !== null} />
        <span className="font-mono text-[10px] font-semibold tracking-[0.18em] text-ink-dim uppercase">
          Agent chat
        </span>
        <span
          className={cn(
            'truncate font-mono text-[10px] tracking-[0.08em]',
            pending ? 'text-hold' : 'text-mute',
          )}
        >
          · {aside}
        </span>
      </div>
      <div className="flex shrink-0 items-center gap-1">{trailing}</div>
    </div>
  );
}

// Collapsed: the 48px icon rail. The chat icon carries the state — a
// tilted yellow count of unread replies, or the lamp while a turn runs.
function CollapsedRail({
  unread,
  working,
  onExpand,
}: {
  unread: number;
  working: boolean;
  onExpand: () => void;
}) {
  const label = unread > 0 ? `Agent chat · ${unread} new (⌘J)` : 'Agent chat (⌘J)';
  return (
    <aside
      aria-label="Agent chat"
      data-state="collapsed"
      className="sticky top-0 flex h-dvh w-12 shrink-0 flex-col items-center gap-3 border-l border-line bg-surface/50 p-2"
    >
      <button
        type="button"
        onClick={onExpand}
        title="Expand agent chat (⌘J)"
        aria-label="Expand agent chat"
        aria-expanded={false}
        className="cursor-pointer rounded-md p-1 text-mute transition-colors hover:bg-raised/60 hover:text-ink"
      >
        <PanelRightOpen className="size-3.5" aria-hidden />
      </button>
      <Tooltip label={label} side="left">
        <button
          type="button"
          onClick={onExpand}
          aria-label={label}
          className="relative flex size-8 cursor-pointer items-center justify-center rounded-md text-ink-dim transition-colors hover:bg-raised hover:text-ink"
        >
          <MessageSquare className="size-[15px]" aria-hidden />
          {unread > 0 ? (
            <span
              aria-hidden
              className="absolute -top-0.5 -right-1 flex h-4 min-w-4 -rotate-6 items-center justify-center rounded-[4px] bg-accent px-1 font-mono text-[10px] font-bold text-accent-ink shadow-edge-sm"
            >
              {unread}
            </span>
          ) : working ? (
            <Lamp tone="hold" pulse className="absolute top-0.5 right-0.5" />
          ) : null}
        </button>
      </Tooltip>
    </aside>
  );
}

// --- the rail ---------------------------------------------------------------

export interface ChatRailProps {
  featureId: number;
  canWrite: boolean;
  prState: string;
  prNumber: number | null;
  repo: string;
  provider: string;
  // The file currently open in the diff pane: the composer's context chip.
  activeFile: string | null;
  checksFailing: boolean;
}

export function ChatRail(props: ChatRailProps) {
  const { featureId, canWrite, prState, prNumber, repo, provider, activeFile, checksFailing } =
    props;
  const isWide = useIsWide();
  // Rail preference (lg+), shadcn-style like the left sidebar: persisted.
  const [open, setOpen] = useState(() => localStorage.getItem(RAIL_OPEN_KEY) !== 'closed');
  const toggleOpen = useCallback(() => {
    setOpen((prev) => {
      localStorage.setItem(RAIL_OPEN_KEY, prev ? 'closed' : 'open');
      return !prev;
    });
  }, []);
  // Below lg the rail is a sheet; opening it is a gesture, never a memory.
  const [sheetOpen, setSheetOpen] = useState(false);
  const visible = isWide ? open : sheetOpen;
  const chat = useChat(featureId, visible);

  // The hairline is a drag handle; the width is remembered with the
  // collapse preference.
  const [width, setWidth] = useState(() =>
    clampRailWidth(Number(localStorage.getItem(RAIL_WIDTH_KEY)) || RAIL_DEFAULT_WIDTH),
  );
  const onHandleDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    const startX = e.clientX;
    const startWidth = width;
    const handle = e.currentTarget;
    handle.setPointerCapture(e.pointerId);
    let next = startWidth;
    const move = (ev: PointerEvent) => {
      next = clampRailWidth(startWidth + (startX - ev.clientX));
      setWidth(next);
    };
    const up = () => {
      handle.removeEventListener('pointermove', move);
      handle.removeEventListener('pointerup', up);
      handle.removeEventListener('pointercancel', up);
      localStorage.setItem(RAIL_WIDTH_KEY, String(next));
    };
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', up);
    handle.addEventListener('pointercancel', up);
  };
  const resetWidth = () => {
    setWidth(RAIL_DEFAULT_WIDTH);
    localStorage.removeItem(RAIL_WIDTH_KEY);
  };

  const composerRef = useRef<HTMLTextAreaElement>(null);
  const [focusTick, setFocusTick] = useState(0);
  const focusComposer = useCallback(() => {
    if (isWide) {
      localStorage.setItem(RAIL_OPEN_KEY, 'open');
      setOpen(true);
    } else {
      setSheetOpen(true);
    }
    setFocusTick((n) => n + 1);
  }, [isWide]);
  const { setBody } = chat;
  const onQuote = useCallback(
    (text: string) => {
      setBody((prev) => (prev.trim() ? `${prev}\n\n${quoteBlock(text)}` : quoteBlock(text)));
      focusComposer();
    },
    [setBody, focusComposer],
  );
  const onPick = useCallback(
    (text: string) => {
      setBody(text);
      focusComposer();
    },
    [setBody, focusComposer],
  );

  // ⌘J toggles the rail (or the sheet) from anywhere on the page, including
  // inside the composer; the sheet is a dialog, so it counts as "no
  // blocking overlay" for its own toggle.
  const sheetOrNone = () => noOverlayOpen() || document.querySelector('[data-chat-sheet]') !== null;
  useHotkeys(
    'mod+j',
    () => (isWide ? toggleOpen() : setSheetOpen((prev) => !prev)),
    { enableOnFormTags: true, preventDefault: true, enabled: sheetOrNone },
    [isWide, toggleOpen],
  );
  useHotkeys(
    'c',
    focusComposer,
    { enabled: () => canWrite && noOverlayOpen(), preventDefault: true },
    [canWrite, focusComposer],
  );

  const chips = suggestions({ activeFile, checksFailing });
  const working = chat.pending !== null;
  const transcript = (
    <Transcript
      chat={chat}
      visible={visible}
      canWrite={canWrite}
      repo={repo}
      provider={provider}
      chips={chips}
      onQuote={onQuote}
      onPick={onPick}
    />
  );
  const floor = canWrite ? (
    <Composer chat={chat} activeFile={activeFile} composerRef={composerRef} focusTick={focusTick} />
  ) : (
    <ReadOnlyFloor messages={chat.messages} prState={prState} />
  );

  if (isWide) {
    if (!open)
      return <CollapsedRail unread={chat.unread} working={working} onExpand={toggleOpen} />;
    return (
      <aside
        aria-label="Agent chat"
        data-state="expanded"
        style={{ width }}
        className="sticky top-0 flex h-dvh shrink-0 flex-col border-l border-line bg-surface/50"
      >
        <div
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize agent chat"
          title="Drag to resize · double-click to reset"
          onPointerDown={onHandleDown}
          onDoubleClick={resetWidth}
          className="absolute inset-y-0 -left-1 z-10 w-2 cursor-col-resize transition-colors hover:bg-accent/30 active:bg-accent/50"
        />
        <RailHeader
          chat={chat}
          canWrite={canWrite}
          prState={prState}
          prNumber={prNumber}
          trailing={
            <>
              <Kbd className="max-lg:hidden">⌘J</Kbd>
              <button
                type="button"
                onClick={toggleOpen}
                title="Collapse agent chat (⌘J)"
                aria-label="Collapse agent chat"
                aria-expanded
                className="cursor-pointer rounded-md p-1 text-mute transition-colors hover:bg-raised/60 hover:text-ink"
              >
                <PanelRightClose className="size-3.5" aria-hidden />
              </button>
            </>
          }
        />
        {transcript}
        {floor}
      </aside>
    );
  }

  return (
    <>
      <button
        type="button"
        onClick={() => setSheetOpen(true)}
        aria-label={chat.unread > 0 ? `Agent chat, ${chat.unread} new replies` : 'Agent chat'}
        className="fixed right-4 bottom-[calc(env(safe-area-inset-bottom)+4.5rem)] z-40 flex cursor-pointer items-center gap-2 rounded-full bg-accent py-2.5 pr-3.5 pl-3 font-mono text-[11px] font-bold tracking-[0.04em] text-accent-ink shadow-edge transition-[transform,box-shadow,background-color] duration-100 hover:bg-accent-bright active:translate-x-0.5 active:translate-y-0.5 active:shadow-edge-sm md:bottom-6"
      >
        <MessageSquare className="size-3.5" strokeWidth={2.2} aria-hidden />
        Agent
        {chat.unread > 0 ? <span>· {chat.unread}</span> : null}
        {working && chat.unread === 0 ? (
          <span aria-hidden className="size-2 animate-pulse-dot rounded-full bg-accent-ink/70" />
        ) : null}
      </button>
      <Dialog open={sheetOpen} onOpenChange={setSheetOpen}>
        <SheetContent data-chat-sheet aria-describedby={undefined}>
          <DialogTitle className="sr-only">Agent chat</DialogTitle>
          <RailHeader
            chat={chat}
            canWrite={canWrite}
            prState={prState}
            prNumber={prNumber}
            trailing={
              <DialogClose asChild>
                <button
                  type="button"
                  aria-label="Close"
                  className="cursor-pointer rounded-md p-2 text-mute transition-colors hover:bg-raised hover:text-ink"
                >
                  <X className="size-4" aria-hidden />
                </button>
              </DialogClose>
            }
          />
          {transcript}
          {floor}
        </SheetContent>
      </Dialog>
    </>
  );
}
