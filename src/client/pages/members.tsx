import { useMutation, useQueryClient, useSuspenseQuery } from '@tanstack/react-query';
import { useParams } from '@tanstack/react-router';
import { Trash2, UserPlus } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { toast } from 'sonner';
import type { ApiInvitation, ApiMember, ApiRole } from '../../shared/api-types.ts';
import { api, ApiError } from '../lib/api.ts';
import { orgMembersQuery } from '../lib/queries.ts';
import { EmptyState, Muted, PageTitle, SectionHeading } from '../components/section.tsx';
import { Button } from '../components/ui/button.tsx';
import { Card } from '../components/ui/card.tsx';
import { Input, Select } from '../components/ui/input.tsx';
import { Pill } from '../components/ui/pill.tsx';

const ROLES: ApiRole[] = ['member', 'admin', 'owner'];

function onApiError(err: unknown) {
  toast.error(err instanceof ApiError ? err.message : 'Request failed');
}

function roleTone(role: ApiRole): 'on' | 'neutral' {
  return role === 'owner' || role === 'admin' ? 'on' : 'neutral';
}

function MemberRow({
  member,
  installationId,
  canManage,
}: {
  member: ApiMember;
  installationId: number;
  canManage: boolean;
}) {
  const queryClient = useQueryClient();
  const invalidate = () =>
    queryClient.invalidateQueries({ queryKey: ['org-members', installationId] });

  const updateRole = useMutation({
    mutationFn: (role: ApiRole) =>
      api.patch(`/api/organizations/${installationId}/members/${member.id}`, { role }),
    onError: onApiError,
    onSuccess: () => toast.success(`Role updated for ${member.login ?? member.email}`),
    onSettled: invalidate,
  });

  const remove = useMutation({
    mutationFn: () => api.delete(`/api/organizations/${installationId}/members/${member.id}`),
    onError: onApiError,
    onSuccess: () => toast.success(`Removed ${member.login ?? member.email}`),
    onSettled: invalidate,
  });

  return (
    <Card className="mt-2 flex items-center justify-between gap-3">
      <div className="min-w-0">
        <div className="truncate font-mono text-sm">
          {member.login ? `@${member.login}` : member.email}
        </div>
        {member.login ? <Muted className="text-xs">{member.email}</Muted> : null}
      </div>
      <div className="flex shrink-0 items-center gap-2">
        {canManage ? (
          <>
            <Select
              value={member.role}
              onChange={(e) => updateRole.mutate(e.target.value as ApiRole)}
              disabled={updateRole.isPending}
              aria-label={`Role for ${member.login ?? member.email}`}
              className="w-auto py-1 text-xs sm:py-1 sm:text-xs"
            >
              {ROLES.map((role) => (
                <option key={role} value={role}>
                  {role}
                </option>
              ))}
            </Select>
            <Button
              variant="ghost"
              size="icon"
              title={`Remove ${member.login ?? member.email}`}
              onClick={() => remove.mutate()}
              loading={remove.isPending}
            >
              <Trash2 className="size-3.5" aria-hidden />
            </Button>
          </>
        ) : (
          <Pill tone={roleTone(member.role)}>{member.role}</Pill>
        )}
      </div>
    </Card>
  );
}

function InvitationRow({ invitation }: { invitation: ApiInvitation }) {
  return (
    <Card className="mt-2 flex items-center justify-between gap-3">
      <div className="min-w-0 truncate font-mono text-sm">{invitation.email}</div>
      <div className="flex shrink-0 items-center gap-2">
        <Pill>{invitation.role}</Pill>
        <Muted className="text-xs">{invitation.status}</Muted>
      </div>
    </Card>
  );
}

function InviteForm({ installationId }: { installationId: number }) {
  const queryClient = useQueryClient();
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<ApiRole>('member');

  const invite = useMutation({
    mutationFn: () => api.post(`/api/organizations/${installationId}/invitations`, { email, role }),
    onError: onApiError,
    onSuccess: () => {
      toast.success(`Invited ${email}`);
      setEmail('');
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: ['org-members', installationId] }),
  });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!email.trim()) return;
    invite.mutate();
  };

  return (
    <Card className="mt-2">
      <form onSubmit={submit} className="flex flex-wrap items-center gap-2">
        <Input
          type="email"
          required
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="teammate@example.com"
          aria-label="Email to invite"
          className="min-w-0 flex-1"
        />
        <Select
          value={role}
          onChange={(e) => setRole(e.target.value as ApiRole)}
          aria-label="Role to invite as"
          className="w-auto"
        >
          {ROLES.map((r) => (
            <option key={r} value={r}>
              {r}
            </option>
          ))}
        </Select>
        <Button type="submit" size="sm" loading={invite.isPending}>
          <UserPlus className="size-3.5" aria-hidden /> Invite
        </Button>
      </form>
    </Card>
  );
}

export function MembersPage() {
  const { installationId } = useParams({ from: '/settings/members/$installationId' });
  const id = Number(installationId);
  const { data } = useSuspenseQuery(orgMembersQuery(id));
  const canManage = data.my_role !== 'member';

  return (
    <>
      <PageTitle>Members</PageTitle>

      {canManage ? <InviteForm installationId={id} /> : null}

      <SectionHeading>Members</SectionHeading>
      {data.members.length === 0 ? (
        <EmptyState>No members yet.</EmptyState>
      ) : (
        data.members.map((m) => (
          <MemberRow key={m.id} member={m} installationId={id} canManage={canManage} />
        ))
      )}

      {data.invitations.length > 0 ? (
        <>
          <SectionHeading>Pending invitations</SectionHeading>
          {data.invitations.map((i) => (
            <InvitationRow key={i.id} invitation={i} />
          ))}
        </>
      ) : null}
    </>
  );
}
