-- Git provider seam (docs/artifacts-provider.md): installations and
-- repositories gain a provider discriminator so Cloudflare Artifacts-hosted
-- projects (turbodiff-tenanted, no GitHub App) reuse the installation-scoped
-- access model unchanged. Artifacts rows use negative synthetic ids: GitHub
-- ids are always positive, so the two spaces can never collide.
ALTER TABLE installations ADD COLUMN provider TEXT NOT NULL DEFAULT 'github';
ALTER TABLE repositories ADD COLUMN provider TEXT NOT NULL DEFAULT 'github';

-- Repo name inside turbodiff's Artifacts namespace (wrangler.jsonc binding).
ALTER TABLE repositories ADD COLUMN artifacts_repo TEXT;

-- Stored for Artifacts repos at provisioning; GitHub rows keep NULL (their
-- default branch is fetched live from the API as before).
ALTER TABLE repositories ADD COLUMN default_branch TEXT;

-- Last observed push, maintained by Artifacts event ingestion
-- (src/ai/workflows/artifacts-events.ts).
ALTER TABLE repositories ADD COLUMN last_push_at TEXT;

CREATE UNIQUE INDEX idx_repositories_artifacts_repo
	ON repositories (artifacts_repo)
	WHERE artifacts_repo IS NOT NULL;
