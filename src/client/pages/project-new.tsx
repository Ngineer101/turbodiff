import { useMutation, useQueryClient, useSuspenseQuery } from '@tanstack/react-query';
import { Link, useNavigate } from '@tanstack/react-router';
import { useState } from 'react';
import { toast } from 'sonner';
import { api, ApiError } from '../lib/api.ts';
import { meQuery } from '../lib/queries.ts';
import { Button, buttonVariants } from '../components/ui/button.tsx';
import { Card } from '../components/ui/card.tsx';
import { Field, Input, Textarea } from '../components/ui/input.tsx';
import { Lamp } from '../components/identity.tsx';
import { Muted, PageTitle, SectionHeading } from '../components/section.tsx';
import { cn } from '../lib/utils.ts';
import { cloneCommand, PROJECT_SEGMENT } from '../../shared/projects.ts';

// Create a turbodiff-hosted project (docs/artifacts-provider.md): the repo
// lives on Cloudflare Artifacts in turbodiff's account — no GitHub App, no
// external forge. The factory loop (tasks → change requests → review →
// merge) runs natively against it.

interface CreatedProject {
  repository_id: number;
  repo: string;
  default_branch: string | null;
  remote: string;
}

interface CloneCredential {
  remote: string;
  token: string;
  expiresAt: string;
}

export function ProjectNewPage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { data: me } = useSuspenseQuery(meQuery);
  const [owner, setOwner] = useState(me.login?.toLowerCase() ?? '');
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<CreatedProject | null>(null);

  const create = useMutation({
    mutationFn: () =>
      api.post<CreatedProject, { owner: string; name: string; description?: string }>(
        '/api/projects',
        {
          owner: owner.trim().toLowerCase(),
          name: name.trim(),
          description: description.trim() || undefined,
        },
      ),
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
      <PageTitle>Projects</PageTitle>
      <SectionHeading>New project</SectionHeading>
      <Muted className="mb-4 max-w-prose">
        Hosted by turbodiff on Cloudflare Artifacts — no GitHub repository involved. The factory
        plans, builds, reviews, and merges change requests natively, and you can clone the repo with
        plain git at any time.
      </Muted>
      <Card className="max-w-xl">
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
          {error && <p className="text-[0.85rem] text-danger">{error}</p>}
          <div className="flex gap-2">
            <Button type="submit" loading={create.isPending}>
              Create project
            </Button>
            <Button type="button" variant="ghost" onClick={() => navigate({ to: '/settings' })}>
              Cancel
            </Button>
          </div>
        </form>
      </Card>
    </>
  );
}

function ProjectCreated({ project }: { project: CreatedProject }) {
  const [credential, setCredential] = useState<CloneCredential | null>(null);
  const mint = useMutation({
    mutationFn: () =>
      api.post<CloneCredential, { scope: string }>(
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
