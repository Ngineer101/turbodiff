import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import type { ApiChatList, ApiChatMessage, ApiMe } from '../../shared/api-types.ts';
import { api, ApiError } from '../lib/api.ts';
import { useDictation } from '../lib/dictation.ts';
import { ago } from '../lib/format.ts';
import { applyOptimistic, optimisticId, optimisticNow } from '../lib/optimistic.ts';
import { CHAT_TURN_PENDING, chatQuery } from '../lib/queries.ts';
import { Markdown } from './markdown.tsx';
import { MicButton } from './mic-button.tsx';
import { Muted } from './section.tsx';
import { Button } from './ui/button.tsx';
import { BlockLabel } from './ui/panel.tsx';
import { Textarea } from './ui/input.tsx';
import { Pill } from './ui/pill.tsx';

// The cockpit's agent chat: converse with a coding agent that has the PR
// head branch checked out, for small iterative changes. Each user message is
// one turn — the agent's reply (and its branch outcome) lands as an
// assistant row via the 5s live poll while a turn is in flight.

function onApiError<T>(err: T) {
  toast.error(err instanceof ApiError ? err.message : 'Request failed');
}

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

function ChatMessage({ message }: { message: ApiChatMessage }) {
  if (message.role === 'user') {
    return (
      <div className="ml-auto min-w-0 max-w-[85%] rounded-md border border-line-2 border-r-2 border-r-accent bg-surface px-3 py-2 text-[0.82rem]">
        <div className="mb-1 flex flex-wrap items-center gap-1.5 text-xs text-mute">
          <strong>@{message.author}</strong>
          <span>{ago(message.created_at)}</span>
          {message.status === 'failed' ? <Pill tone="red">Failed</Pill> : null}
        </div>
        <p className="break-words whitespace-pre-wrap">{message.body}</p>
        {message.status === 'failed' && message.error ? (
          <p className="mt-1 text-xs text-danger">{message.error}</p>
        ) : null}
      </div>
    );
  }
  return (
    <div className="min-w-0 max-w-[85%] rounded-md border border-line-2 border-l-2 border-l-accent bg-surface px-3 py-2 text-[0.82rem]">
      <div className="mb-1 flex flex-wrap items-center gap-1.5 text-xs text-mute">
        <strong>Agent</strong>
        <span>{ago(message.created_at)}</span>
        <OutcomePill message={message} />
      </div>
      <Markdown className="markdown-body--compact">{message.body}</Markdown>
    </div>
  );
}

export function ChatPanel({ featureId, canWrite }: { featureId: number; canWrite: boolean }) {
  const queryClient = useQueryClient();
  const { data, isPending: chatLoading } = useQuery(chatQuery(featureId));
  const messages = data?.messages ?? [];
  const pending = messages.some((m) => m.role === 'user' && CHAT_TURN_PENDING.has(m.status));

  // A completed turn may have pushed a new commit — refresh the feature
  // (diff, runs, verification) when the poll flips pending → done, so the
  // new state appears without a manual reload.
  const prevPending = useRef(pending);
  useEffect(() => {
    if (prevPending.current && !pending) {
      void queryClient.invalidateQueries({ queryKey: ['feature', featureId] });
    }
    prevPending.current = pending;
  }, [pending, featureId, queryClient]);

  const [body, setBody] = useState('');
  const dictation = useDictation((text) =>
    setBody((prev) => (prev.trim() ? `${prev}\n\n${text}` : text)),
  );
  const send = useMutation({
    mutationFn: (text: string) =>
      api.post(`/api/factory/features/${featureId}/chat`, { body: text }),
    // The message appears in the transcript (and the box clears) on Send;
    // 'queued' status also flips `pending`, so the working pill and the
    // disabled input react instantly too.
    onMutate: async (text) => {
      setBody('');
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
      if (ctx) setBody(ctx.text);
      onApiError(err);
    },
  });

  // A merged/closed PR with no history has nothing to show; existing
  // history stays visible read-only.
  if (!canWrite && messages.length === 0) return null;

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <BlockLabel className="mb-3 shrink-0">Agent chat</BlockLabel>
      {/* Transcript scrolls inside the rail so the composer stays pinned. */}
      <div className="min-h-0 min-w-0 flex-1 lg:overflow-y-auto">
        {chatLoading ? (
          // History-shaped placeholder — the "ask the agent" empty-state copy
          // must not flash while the real history is still loading.
          <div className="animate-pulse space-y-3" role="status" aria-label="Loading chat">
            <div className="ml-auto h-12 w-3/5 rounded-lg bg-surface" />
            <div className="h-16 w-4/5 rounded-lg bg-surface" />
          </div>
        ) : messages.length === 0 ? (
          <Muted className="block">
            Ask the agent to tweak this PR — small iterative changes, one message at a time. Each
            change is committed as you and pushed to the branch.
          </Muted>
        ) : (
          <div className="flex flex-col gap-3">
            {messages.map((m) => (
              <ChatMessage key={m.id} message={m} />
            ))}
          </div>
        )}
        {pending ? (
          // A full sentence, not a short status chip — let it wrap (the Pill
          // is nowrap by default) so it never stretches the rail on mobile.
          <p className="mt-3">
            <Pill tone="running" className="max-w-full items-start whitespace-normal">
              Agent is working — replies land here, usually within a few minutes
            </Pill>
          </p>
        ) : null}
      </div>
      {canWrite ? (
        <div className="mt-3 shrink-0">
          <Textarea
            className="min-h-20"
            value={
              dictation.recording
                ? body.trim()
                  ? `${body}\n\n${dictation.interim}`
                  : dictation.interim
                : body
            }
            onChange={(e) => setBody(e.target.value)}
            disabled={dictation.recording || pending}
            placeholder="What should the agent change?"
            aria-label="Message to the chat agent"
          />
          <div className="mt-2 flex gap-2">
            <MicButton dictation={dictation} />
            <Button
              size="sm"
              onClick={() => body.trim() && send.mutate(body.trim())}
              disabled={!body.trim() || pending || send.isPending}
              loading={send.isPending}
            >
              {send.isPending ? 'Sending…' : 'Send'}
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
