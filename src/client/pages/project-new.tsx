import { useMutation, useQueryClient, useSuspenseQuery } from '@tanstack/react-query';
import { Link, useNavigate } from '@tanstack/react-router';
import { Bot, FolderPlus, GitBranch, Plug, Sparkles, type LucideIcon } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { api, ApiError } from '../lib/api.ts';
import { PROCESS_PROFILES } from '../lib/process-profiles.ts';
import { meQuery } from '../lib/queries.ts';
import { Button, buttonVariants } from '../components/ui/button.tsx';
import { Card } from '../components/ui/card.tsx';
import { IconTile } from '../components/ui/entity-icon.tsx';
import { Field, Input, Select, Textarea } from '../components/ui/input.tsx';
import { Lamp } from '../components/identity.tsx';
import { PageTitle, SectionHeading } from '../components/section.tsx';
import { cn } from '../lib/utils.ts';
import { cloneCommand, PROJECT_SEGMENT } from '../../shared/projects.ts';
import type {
  ApiCloneCredential,
  ApiCreatedProject,
  ApiProcessProfile,
} from '../../shared/api-types.ts';

// Create a turbodiff-hosted project (docs/artifacts-provider.md): the repo
// lives on Cloudflare Artifacts in turbodiff's account — no GitHub App, no
// external forge. The factory loop (tasks → change requests → review →
// merge) runs natively against it.

function RailItem({ icon: Icon, title, text }: { icon: LucideIcon; title: string; text: string }) {
  return (
    <div className="flex items-start gap-3">
      <IconTile icon={Icon} size="sm" />
      <div className="min-w-0">
        <p className="text-[0.85rem] leading-tight font-medium">{title}</p>
        <p className="mt-1 text-xs leading-relaxed text-mute">{text}</p>
      </div>
    </div>
  );
}

export function ProjectNewPage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { data: me } = useSuspenseQuery(meQuery);
  const [owner, setOwner] = useState(me.login?.toLowerCase() ?? '');
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [processProfile, setProcessProfile] = useState<ApiProcessProfile>('review_and_repair');
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<ApiCreatedProject | null>(null);
  const selectedProfile = PROCESS_PROFILES.find((p) => p.value === processProfile);

  const create = useMutation({
    mutationFn: () =>
      api.post<
        ApiCreatedProject,
        { owner: string; name: string; description?: string; process_profile: ApiProcessProfile }
      >('/api/projects', {
        owner: owner.trim().toLowerCase(),
        name: name.trim(),
        description: description.trim() || undefined,
        process_profile: processProfile,
      }),
    onSuccess: (project) => {
      toast.success('Project created');
      setCreated(project);
      void queryClient.invalidateQueries({ queryKey: ['settings'] });
      void queryClient.invalidateQueries({ queryKey: ['board'] });
    },
    onError: (err) => setError(err instanceof ApiError ? err.message : 'Request failed'),
  });

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    if (!PROJECT_SEGMENT.test(owner.trim()) || !PROJECT_SEGMENT.test(name.trim())) {
      setError('Owner and name must be 1-80 letters, digits, dots, dashes, or underscores.');
      return;
    }
    create.mutate();
  };

  if (created) return <ProjectCreated project={created} />;

  return (
    <>
      <div className="flex items-start gap-3">
        <IconTile icon={FolderPlus} size="md" />
        <div>
          <h1 className="text-xl leading-tight font-medium tracking-wide">New project</h1>
          <p className="mt-1 max-w-prose text-[0.85rem] leading-relaxed text-mute">
            Hosted by turbodiff on Cloudflare Artifacts — no GitHub repository involved. The factory
            plans, builds, reviews, and merges change requests natively, and you can clone the repo
            with plain git at any time.
          </p>
        </div>
      </div>
      <div className="mt-6 grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,1fr)_20rem] lg:items-start">
        <Card>
          <form onSubmit={submit} className="space-y-4">
            <Field
              label="Owner"
              hint="Your handle or an organization slug — groups projects in the dashboard."
            >
              <Input
                value={owner}
                onChange={(e) => setOwner(e.target.value)}
                placeholder="acme"
                required
              />
            </Field>
            <Field label="Project name">
              <Input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="pricing-service"
                required
              />
            </Field>
            <Field label="Description" hint="Optional; seeds the repository README.">
              <Textarea
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                rows={3}
                placeholder="What this project is about"
              />
            </Field>
            <Field label="Process" hint="How much of the factory loop runs on its own. Change any time per repo in Settings.">
              <Select
                value={processProfile}
                onChange={(e) => setProcessProfile(e.target.value as ApiProcessProfile)}
              >
                {PROCESS_PROFILES.map((p) => (
                  <option key={p.value} value={p.value}>
                    {p.label}
                  </option>
                ))}
              </Select>
              {selectedProfile ? (
                <p className="mt-1.5 text-xs leading-relaxed text-mute">
                  {selectedProfile.description}
                </p>
              ) : null}
            </Field>
            {error && <p className="text-[0.85rem] text-danger">{error}</p>}
            <div className="flex gap-2 pt-1">
              <Button type="submit" loading={create.isPending}>
                Create project
              </Button>
              <Button type="button" variant="ghost" onClick={() => navigate({ to: '/settings' })}>
                Cancel
              </Button>
            </div>
          </form>
        </Card>
        <aside className="space-y-3 lg:sticky lg:top-6">
          <p className="font-mono text-[10px] font-medium tracking-[0.16em] text-mute uppercase">
            Ready on day one
          </p>
          <Card className="space-y-4 p-4">
            <RailItem
              icon={Bot}
              title="Review agents"
              text="Built-in reviewers inspect every change. Pick which run per repo in Settings."
            />
            <RailItem
              icon={Sparkles}
              title="Skills"
              text="Reusable abilities for planning and repair runs — toggle per repo when you need them."
            />
            <RailItem
              icon={Plug}
              title="Integrations"
              text="Attach MCP servers and external tools from the Integrations page."
            />
            <RailItem
              icon={GitBranch}
              title="Plain git access"
              text="Clone and push with a short-lived token any time — no GitHub App required."
            />
          </Card>
          <p className="text-[11px] leading-relaxed text-mute/70">
            The factory plans, builds, reviews, and merges native change requests on Cloudflare
            Artifacts.
          </p>
        </aside>
      </div>
    </>
  );
}

function ProjectCreated({ project }: { project: ApiCreatedProject }) {
  const [credential, setCredential] = useState<ApiCloneCredential | null>(null);
  const mint = useMutation({
    mutationFn: () =>
      api.post<ApiCloneCredential, { scope: string }>(
        `/api/repos/${project.repository_id}/clone-token`,
        {
          scope: 'read',
        },
      ),
    onSuccess: setCredential,
    onError: (err) =>
      toast.error(err instanceof ApiError ? err.message : 'Could not mint a clone token'),
  });

  const command = credential ? cloneCommand(credential.remote, credential.token) : null;

  return (
    <>
      <PageTitle>Projects</PageTitle>
      <SectionHeading>Project commissioned</SectionHeading>
      <Card className="max-w-2xl space-y-4">
        <div className="flex items-center gap-2 text-[0.85rem] text-ink-dim">
          <Lamp tone="go" />
          <span className="font-mono text-ink">{project.repo}</span>
          <span className="text-mute">
            on Cloudflare Artifacts · default branch {project.default_branch ?? 'main'}
          </span>
        </div>
        <p className="text-[0.85rem] text-mute">
          Remote: <span className="font-mono text-ink-dim break-all">{project.remote}</span>
        </p>
        <div className="space-y-2">
          <p className="text-[0.85rem] text-ink-dim">Work with it using plain git:</p>
          {command ? (
            <div className="space-y-2">
              <pre className="overflow-x-auto rounded-xl bg-surface-2/60 p-3 text-xs text-ink-dim">
                {command}
              </pre>
              <div className="flex items-center gap-3">
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={() => {
                    void navigator.clipboard.writeText(command);
                    toast.success('Clone command copied');
                  }}
                >
                  Copy command
                </Button>
                <span className="text-xs text-mute">
                  Token expires {new Date(credential!.expiresAt).toLocaleString()}
                </span>
              </div>
            </div>
          ) : (
            <Button
              size="sm"
              variant="secondary"
              loading={mint.isPending}
              onClick={() => mint.mutate()}
            >
              Mint a clone token
            </Button>
          )}
        </div>
        <div className="flex flex-wrap gap-2 border-t border-line-2 pt-4">
          <Link to="/" className={cn(buttonVariants({ variant: 'default', size: 'sm' }))}>
            Start a task
          </Link>
          <Link to="/settings" className={cn(buttonVariants({ variant: 'secondary', size: 'sm' }))}>
            Project settings
          </Link>
        </div>
      </Card>
    </>
  );
}
