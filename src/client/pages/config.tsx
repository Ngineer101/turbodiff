import { useSuspenseQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { BarChart2, Settings, Users } from 'lucide-react';
import { settingsQuery } from '../lib/queries.ts';
import { EmptyState, PageTitle, SectionHeading } from '../components/section.tsx';
import { Card } from '../components/ui/card.tsx';

function NavRow({ to, label, icon: Icon }: { to: string; label: string; icon: typeof Settings }) {
  return (
    <Card className="mt-2 p-0">
      <Link to={to} className="flex items-center gap-2.5 px-4 py-3 text-[0.85rem] font-medium">
        <Icon className="size-4 text-mute" aria-hidden />
        {label}
      </Link>
    </Card>
  );
}

export function ConfigPage() {
  const { data } = useSuspenseQuery(settingsQuery);
  const orgs = data.installations.filter((inst) => inst.account_type === 'Organization');

  return (
    <>
      <PageTitle>Config</PageTitle>

      <div className="mt-6">
        <NavRow to="/usage" label="Usage" icon={BarChart2} />
        <NavRow to="/settings" label="Settings" icon={Settings} />
      </div>

      <SectionHeading>Members</SectionHeading>
      {orgs.length === 0 ? (
        <EmptyState>No organizations connected yet.</EmptyState>
      ) : (
        orgs.map((inst) => (
          <Card key={inst.id} className="mt-2 p-0">
            <Link
              to="/settings/members/$installationId"
              params={{ installationId: String(inst.id) }}
              className="flex items-center gap-2.5 px-4 py-3 text-[0.85rem] font-medium"
            >
              <Users className="size-4 text-mute" aria-hidden />
              {inst.account_login}
            </Link>
          </Card>
        ))
      )}
    </>
  );
}
