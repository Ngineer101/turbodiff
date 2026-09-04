import { useMutation, useQuery, useSuspenseQuery } from '@tanstack/react-query';
import { useNavigate, useSearch } from '@tanstack/react-router';
import { Loader2, LogOut, UserPlus } from 'lucide-react';
import { toast } from 'sonner';
import type { ApiInvitationAccepted, ApiInvitationPreview } from '../../shared/api-types.ts';
import { api, ApiError } from '../lib/api.ts';
import { invitationQuery, meQuery, queryClient } from '../lib/queries.ts';
import { Stamp } from '../components/identity.tsx';
import { Button } from '../components/ui/button.tsx';
import { Card } from '../components/ui/card.tsx';
import { Pill } from '../components/ui/pill.tsx';

// Landing page for the link in an invitation email (/accept-invite?id=…).
// Lives outside the AppShell like /onboarding: the recipient may have
// nothing else to look at yet — an invited password account has no
// installations until it links GitHub, and a GitHub account only reaches
// the organization's pages if GitHub lists them on its installation.
//
// Every failure the invitation lookup can produce is definitive (unknown or
// used-up id, expired, sent to a different address), so the page shows the
// reason instead of a retry. Only the wrong-account case has a way out the
// recipient can take themselves — signing out and back in as the invited
// address; a dead invitation needs an owner to send a new one.
//
// Layout follows the Paper board "11 Accept invite" (design system file):
// wordmark, invited sticker, headline, one card with the account row and
// the action, dashboard link.

// The 403 from the invitation endpoints is better-auth's recipient check:
// the session's email is not the invited address.
function wrongAccount(err: Error): boolean {
  return err instanceof ApiError && err.status === 403;
}

// Initials for the avatar tile: first letters of the first two words of the
// display name ("Nico Botha" → NB, "supermemer-ai" → S).
function initials(name: string): string {
  return name
    .split(/\s+/)
    .filter((word) => word.length > 0)
    .slice(0, 2)
    .map((word) => word[0]?.toUpperCase() ?? '')
    .join('');
}

// Whole days until the invitation expires, floored at zero — better-auth
// treats a past expiresAt as not found, so a rendered invitation is never
// negative.
function daysLeft(expiresAt: string | null): string | null {
  if (expiresAt === null) return null;
  const ms = Date.parse(expiresAt) - Date.now();
  if (Number.isNaN(ms)) return null;
  const days = Math.max(0, Math.ceil(ms / 86_400_000));
  if (days === 0) return 'expires today';
  return days === 1 ? '1 day left' : `${days} days left`;
}

function Headline({ children }: { children: React.ReactNode }) {
  return (
    <h1 className="text-xl leading-8 font-medium tracking-tight text-ink sm:text-2xl">
      {children}
    </h1>
  );
}

function Invitation({ id, invitation }: { id: string; invitation: ApiInvitationPreview }) {
  const navigate = useNavigate();
  const { data: me } = useSuspenseQuery(meQuery);
  const accept = useMutation({
    mutationFn: () =>
      api.post<ApiInvitationAccepted>(`/api/invitations/${encodeURIComponent(id)}/accept`),
    onSuccess: (accepted) => {
      toast.success(`You joined ${accepted.org_name}`);
      void queryClient.invalidateQueries({ queryKey: ['me'] });
      // The members page needs GitHub-side installation access too; land on
      // the board otherwise (an invited password account gets its connect
      // prompt there).
      const installationId = accepted.installation_id;
      if (installationId !== null && me.installation_ids.includes(installationId)) {
        void navigate({
          to: '/settings/members/$installationId',
          params: { installationId: String(installationId) },
        });
      } else {
        void navigate({ to: '/' });
      }
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : 'Request failed'),
  });
  const meta = [invitation.invited_by ? `Invited by ${invitation.invited_by}` : null]
    .concat(daysLeft(invitation.expires_at))
    .filter((part) => part !== null)
    .join(' · ');

  return (
    <>
      <div className="mb-3.5 pl-0.5">
        <Stamp>You&rsquo;re invited</Stamp>
      </div>
      <Headline>Join {invitation.org_name} on Turbodiff</Headline>
      <p className="mt-2 text-[0.85rem] text-mute">
        You were invited as{' '}
        <Pill tone={invitation.role === 'member' ? 'neutral' : 'on'}>{invitation.role}</Pill> of the{' '}
        {invitation.org_name} organization.
      </p>
      <Card className="mt-6 flex flex-col gap-3.5 p-4">
        <div className="flex items-center gap-3">
          <span
            className="flex size-8 shrink-0 items-center justify-center rounded-full bg-accent font-mono text-[11px] font-semibold tracking-[0.08em] text-accent-ink"
            aria-hidden
          >
            {initials(me.name)}
          </span>
          <div className="min-w-0">
            <p className="text-[0.85rem] text-mute">
              Accepting as <span className="text-ink">{me.name}</span>
            </p>
            <p className="truncate font-mono text-xs text-mute">{invitation.email}</p>
          </div>
        </div>
        <hr className="border-line" />
        <div className="flex flex-wrap items-center justify-between gap-3">
          <Button
            onClick={() => accept.mutate()}
            loading={accept.isPending}
            disabled={accept.isPending}
          >
            <UserPlus className="size-3.5" aria-hidden /> Accept invitation
          </Button>
          {meta ? <p className="font-mono text-[11px] tracking-wide text-mute">{meta}</p> : null}
        </div>
      </Card>
    </>
  );
}

function Failure({ error }: { error: Error }) {
  const { data: me } = useSuspenseQuery(meQuery);
  if (wrongAccount(error)) {
    return (
      <>
        <Headline>Can&rsquo;t open this invitation</Headline>
        <p className="mt-2 text-[0.85rem] text-mute">
          This invitation was sent to a different email address.
        </p>
        <p className="mt-2 text-[0.85rem] text-mute">
          You are signed in as <span className="text-ink">{me.name}</span>.
        </p>
        <form method="post" action="/auth/logout" className="mt-4">
          <Button type="submit" variant="secondary" size="sm">
            <LogOut className="size-3.5" aria-hidden /> Sign out and switch account
          </Button>
        </form>
      </>
    );
  }
  return (
    <>
      <Headline>Can&rsquo;t open this invitation</Headline>
      <p className="mt-2 text-[0.85rem] text-mute">
        This invitation is no longer valid — it may have expired or already been used.
      </p>
      <p className="mt-2 text-[0.85rem] text-mute">
        Ask an owner of the organization to send a new one.
      </p>
    </>
  );
}

export function AcceptInvitePage() {
  const { id } = useSearch({ from: '/accept-invite' });
  const invitation = useQuery({ ...invitationQuery(id ?? ''), enabled: id !== undefined });

  let body: React.ReactNode;
  if (id === undefined) {
    body = (
      <p className="text-[0.85rem] text-mute">
        This link is missing its invitation id. Open the link from the invitation email again.
      </p>
    );
  } else if (invitation.isPending) {
    body = (
      <p className="flex items-center gap-2 text-[0.85rem] text-mute" role="status">
        <Loader2 className="size-3.5 animate-spin" aria-hidden /> Checking your invitation…
      </p>
    );
  } else if (invitation.isError) {
    body = <Failure error={invitation.error} />;
  } else {
    body = <Invitation id={id} invitation={invitation.data} />;
  }

  return (
    <div className="mx-auto flex min-h-dvh max-w-md flex-col justify-center px-4 py-10">
      <span className="mb-7 font-mono text-base font-semibold tracking-wide text-ink">
        turbodiff
        <span className="animate-cursor text-accent-bright" aria-hidden>
          _
        </span>
      </span>
      {body}
      <p className="mt-8 text-[0.8rem] text-mute">
        <a href="/" className="text-accent-bright hover:underline">
          Back to the dashboard &rarr;
        </a>
      </p>
    </div>
  );
}
