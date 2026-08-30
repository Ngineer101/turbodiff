import { useSuspenseQuery } from '@tanstack/react-query';
import { ArrowRight, RefreshCw } from 'lucide-react';
import { meQuery } from '../lib/queries.ts';
import { Lamp } from '../components/identity.tsx';
import { Card } from '../components/ui/card.tsx';
import { Button, buttonVariants } from '../components/ui/button.tsx';
import { cn } from '../lib/utils.ts';

// lucide-react dropped brand icons; GitHub's mark is inlined.
function GitHubMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 16 16" className={className} fill="currentColor" aria-hidden>
      <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27s1.36.09 2 .27c1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8Z" />
    </svg>
  );
}

// Post-sign-up step for email/password accounts: connect a GitHub account so
// the factory can reach repositories, or skip and run the app empty until
// then (the shell keeps a connect prompt visible). GitHub sign-ins never land
// here — their account is connected by construction. Lives outside the
// AppShell chrome (see main.tsx) so the only ways out are connect or skip.

export function OnboardingPage() {
  const { data: me, refetch, isFetching } = useSuspenseQuery(meQuery);
  // The connect flow round-trips through GitHub; better-auth redirects
  // failures back here with ?error=link_failed.
  const linkFailed = new URLSearchParams(window.location.search).has('error');

  return (
    <div className="mx-auto flex min-h-dvh max-w-md flex-col justify-center px-4 py-10">
      <span className="mb-6 font-mono text-base font-semibold tracking-wide text-ink">
        turbodiff
        <span className="animate-cursor text-accent-bright" aria-hidden>
          _
        </span>
      </span>

      <h1 className="text-lg leading-snug font-medium tracking-wide sm:text-xl">
        Welcome, {me.name}
      </h1>
      <p className="mt-2 text-[0.85rem] text-mute">
        Turbodiff runs your software factory on GitHub — plans, generated PRs, reviews, and
        verification all land on your repositories. Connect a GitHub account to bring them in.
      </p>

      {linkFailed && (
        <p className="mt-4 rounded-xl border border-danger/40 px-4 py-3 text-[0.85rem] text-danger">
          Connecting GitHub didn&rsquo;t work — try again, or skip for now.
        </p>
      )}

      <Card className="mt-6 space-y-4">
        {me.github_status === 'not_connected' ? (
          <>
            <div className="flex items-center gap-2 text-[0.85rem] text-ink-dim">
              <Lamp tone="hold" />
              No GitHub account connected
            </div>
            <a
              href="/auth/connect/github?next=/onboarding"
              className={cn(buttonVariants({ variant: 'default' }), 'w-full')}
            >
              <GitHubMark className="size-4" />
              Connect GitHub
            </a>
            <p className="text-xs text-mute">
              This links a GitHub account to your sign-in. You can also do it later from the banner
              in the app.
            </p>
          </>
        ) : me.github_status === 'reauthorization_required' ? (
          <>
            <div className="flex items-center gap-2 text-[0.85rem] text-ink-dim">
              <Lamp tone="hold" />
              GitHub authorization needs to be renewed
            </div>
            <p className="text-[0.85rem] text-mute">
              Your Turbodiff account is intact, but its GitHub credential is missing or expired.
              Re-authorize to restore repository access.
            </p>
            <a
              href="/auth/connect/github?next=/onboarding"
              className={cn(buttonVariants({ variant: 'default' }), 'w-full')}
            >
              <GitHubMark className="size-4" />
              Re-authorize GitHub
            </a>
          </>
        ) : me.github_status === 'temporarily_unavailable' ? (
          <>
            <div className="flex items-center gap-2 text-[0.85rem] text-ink-dim">
              <Lamp tone="hold" />
              GitHub access could not be verified
            </div>
            <p className="text-[0.85rem] text-mute">
              This is usually temporary. Retry the check, or re-authorize GitHub if it continues.
              Native Turbodiff projects remain available.
            </p>
            <Button
              type="button"
              className="w-full"
              loading={isFetching}
              onClick={() => void refetch()}
            >
              <RefreshCw className="size-4" aria-hidden />
              Try again
            </Button>
            <a
              href="/auth/connect/github?next=/onboarding"
              className={cn(buttonVariants({ variant: 'secondary' }), 'w-full')}
            >
              Re-authorize GitHub
            </a>
          </>
        ) : me.github_status === 'app_not_installed' ? (
          <>
            <div className="flex items-center gap-2 text-[0.85rem] text-ink-dim">
              <Lamp tone="go" />
              GitHub connected as <span className="font-mono text-ink">@{me.login}</span>
            </div>
            <p className="text-[0.85rem] text-mute">
              No GitHub App installation is available to this account yet. Install it on the
              organizations or accounts the factory should use, or ask an organization owner to
              grant you access.
            </p>
            <a
              href={`https://github.com/apps/${me.github_app_slug}/installations/new`}
              className={cn(buttonVariants({ variant: 'default' }), 'w-full')}
            >
              <GitHubMark className="size-4" />
              Install or configure the GitHub App
            </a>
            <p className="text-xs text-mute">
              Or skip GitHub entirely:{' '}
              <a href="/projects/new" className="text-accent-bright hover:underline">
                create a turbodiff-hosted project
              </a>{' '}
              — the factory builds, reviews, and merges it natively.
            </p>
          </>
        ) : me.github_status === 'syncing' ? (
          <>
            <div className="flex items-center gap-2 text-[0.85rem] text-ink-dim">
              <RefreshCw className="size-4 animate-spin text-accent-bright" aria-hidden />
              Restoring GitHub repositories for <span className="font-mono">@{me.login}</span>
            </div>
            <p className="text-[0.85rem] text-mute">
              Turbodiff found your GitHub App installations and is rebuilding the local repository
              mirror. This page will update automatically.
            </p>
          </>
        ) : (
          <>
            <div className="flex items-center gap-2 text-[0.85rem] text-ink-dim">
              <Lamp tone="go" />
              GitHub ready as <span className="font-mono text-ink">@{me.login}</span>
            </div>
            <p className="text-[0.85rem] text-mute">
              Your account and GitHub App installations are connected. The factory is ready to use
              the repositories you selected on GitHub.
            </p>
          </>
        )}
      </Card>

      <a
        href="/"
        className="mt-5 inline-flex items-center gap-1.5 self-start text-[0.85rem] text-mute hover:text-ink"
      >
        {me.github_status === 'not_connected' ? 'Skip for now' : 'Go to the board'}
        <ArrowRight className="size-3.5" aria-hidden />
      </a>
    </div>
  );
}
