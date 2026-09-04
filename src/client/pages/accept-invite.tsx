import { useMutation, useQuery, useSuspenseQuery } from '@tanstack/react-query';
import { useNavigate, useSearch } from '@tanstack/react-router';
import { Loader2, LogOut, UserPlus } from 'lucide-react';
import { toast } from 'sonner';
import type { ApiInvitationAccepted, ApiInvitationPreview } from '../../shared/api-types.ts';
import { api, ApiError } from '../lib/api.ts';
import { invitationQuery, meQuery, queryClient } from '../lib/queries.ts';
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
// reason instead of a retry — and, for the wrong-account case, the way out
// is signing out and back in as the invited address.

function failureMessage(err: Error): string {
  if (err instanceof ApiError && err.status === 403) {
    return 'This invitation was sent to a different email address.';
  }
  return 'This invitation is no longer valid — it may have expired or already been used.';
}

function SignOutForm() {
  return (
    <form method="post" action="/auth/logout" className="mt-4">
      <Button type="submit" variant="secondary" size="sm">
        <LogOut className="size-3.5" aria-hidden /> Sign out and switch account
      </Button>
    </form>
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

  return (
    <>
      <h1 className="text-lg leading-snug font-medium tracking-wide sm:text-xl">
        Join {invitation.org_name} on Turbodiff
      </h1>
      <p className="mt-2 text-[0.85rem] text-mute">
        You were invited as{' '}
        <Pill tone={invitation.role === 'member' ? 'neutral' : 'on'}>{invitation.role}</Pill> of the{' '}
        {invitation.org_name} organization.
      </p>
      <Card className="mt-6 p-4">
        <p className="text-[0.85rem] text-mute">
          Accepting as <span className="text-ink">{me.name}</span> ({invitation.email}).
        </p>
        <Button
          className="mt-4"
          onClick={() => accept.mutate()}
          loading={accept.isPending}
          disabled={accept.isPending}
        >
          <UserPlus className="size-3.5" aria-hidden /> Accept invitation
        </Button>
      </Card>
    </>
  );
}

export function AcceptInvitePage() {
  const { id } = useSearch({ from: '/accept-invite' });
  const { data: me } = useSuspenseQuery(meQuery);
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
    body = (
      <>
        <h1 className="text-lg leading-snug font-medium tracking-wide sm:text-xl">
          Can&rsquo;t open this invitation
        </h1>
        <p className="mt-2 text-[0.85rem] text-mute">{failureMessage(invitation.error)}</p>
        <p className="mt-2 text-[0.85rem] text-mute">
          You are signed in as <span className="text-ink">{me.name}</span>.
        </p>
        <SignOutForm />
      </>
    );
  } else {
    body = <Invitation id={id} invitation={invitation.data} />;
  }

  return (
    <div className="mx-auto flex min-h-dvh max-w-md flex-col justify-center px-4 py-10">
      <span className="mb-6 font-mono text-base font-semibold tracking-wide text-ink">
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
