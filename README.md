# Turbodiff

<img src="public/logo-small.png" alt="Turbodiff logo" width="64" align="center" />

Turbodiff is an open-source software factory. Give it a task and it
can plan the work, write the code, open a pull request, review the change, fix
problems, and check the result. You decide where automation starts and stops,
and which steps need a human input.

You can also use the pull request reviewer on its own. Turbodiff works with
your existing repositories and GitHub workflow rather than asking you to move
your code or replace your tools.

This project can be self-hosted and is licensed under the [MIT License](LICENSE.md).

> [!WARNING]
> Turbodiff is under active development. If you find a problem, please
> [open an issue](https://github.com/Ngineer101/turbodiff/issues).

## A software factory, not just a code generator

Turbodiff covers the path from an idea to a finished pull request:

1. **Plan** — read the repository, ask questions, and turn the task into a plan
   with clear success checks.
2. **Build** — write the code in an isolated container, run the repository's
   checks, and open a pull request.
3. **Review** — inspect the whole change and publish clear GitHub reviews.
4. **Repair** — try to fix important review findings, failed checks, and merge
   conflicts.
5. **Verify** — compare the finished work with the approved plan. Turbodiff can
   run the app and attach screenshots when visual proof is useful.
6. **Merge** — leave the pull request ready for a person, or merge it
   automatically when the repository allows that.

Each step records its result, so a person can take over or let the next step
continue. Repositories can use the full factory or only the parts they need.

### Pull request reviews

The reviewer also works with pull requests created outside Turbodiff. It can:

- Review automatically or only when asked.
- Remember earlier findings when new commits are pushed.
- Spend more time on large or sensitive changes and less on small ones.
- Request changes for serious problems and approve clean pull requests.
- Run custom review agents for different areas of a codebase.
- Track whether findings were useful, fixed, or dismissed.

## Open source and self-hostable

Turbodiff uses:

- **Cloudflare Workers** for the web app and API.
- **Cloudflare Containers** for code-writing and verification jobs.
- **Cloudflare AI Gateway** to connect to AI models.
- **PostgreSQL** on Planetscale for users, repositories, tasks, reviews, and settings - connected via Hyperdrive.
- **Cloudflare R2** for logs, screenshots, and other files.
- **Cloudflare Queues and Workflows** for jobs that take longer than a web
  request.

More detail is available in the [architecture guide](docs/architecture.md).

To get started with self-hosting you need:

- A Cloudflare account with Workers, Containers, AI Gateway, Hyperdrive,
  Queues, and R2 available.
- A PostgreSQL database. The project uses PlanetScale in production, but other
  PostgreSQL providers can work.
- A GitHub account that can create a GitHub App.
- Docker for building the container.
- [Vite+](https://viteplus.dev) (`vp`) and the Node.js version in
  [.node-version](.node-version).

### 1. Fork and install

Fork this repository, clone your fork, and install the dependencies:

```sh
vp install
```

### 2. Set up Cloudflare

Create an AI Gateway and enable billing for any third-party models you want to
use. The committed [wrangler.jsonc](wrangler.jsonc) defines shared Worker
infrastructure but intentionally contains no deployment-specific environment
values. Configure those for your Worker in Cloudflare under **Settings →
Variables and Secrets**. Wrangler's `keep_vars` setting preserves them across
future deployments. The complete list is in
[Environment variables](#environment-variables), with local examples in
[.dev.vars.example](.dev.vars.example).

The optional Cloudflare Artifacts binding is for repositories created inside
Turbodiff. It requires access to Cloudflare Artifacts. If you only use GitHub
repositories, remove the `artifacts` binding, its event triggers, and the
`ARTIFACTS_REMOTE_BASE` variable from your Cloudflare Worker.

### 3. Set up PostgreSQL

Create a database, then apply and check the schema using a direct database
connection:

```sh
export DATABASE_URL='postgres://...'
vp run db:migrate
vp run db:verify
```

Create a Hyperdrive connection with query caching disabled, then copy its ID
into `wrangler.jsonc`:

```sh
export HYPERDRIVE_DATABASE_URL='postgres://...'
vp exec wrangler hyperdrive create turbodiff-postgres \
  --connection-string="$HYPERDRIVE_DATABASE_URL" \
  --caching-disabled
```

Use a database account with only read and write access for Hyperdrive. Keep the
more powerful migration account separate. See [the PostgreSQL guide](docs/postgres.md)
for local Docker setup, recommended permissions, and credential rotation.

### 4. Create the queue and file bucket

```sh
vp exec wrangler queues create turbodiff-factory
vp exec wrangler r2 bucket create turbodiff-artifacts
```

If you use different names, update `wrangler.jsonc`.

### 5. Create a GitHub App

Create a new app in [GitHub App settings](https://github.com/settings/apps)
with these values:

- **Webhook URL:** `https://<your-domain>/webhooks/github`
- **Callback URL:** `https://<your-domain>/auth/callback`
- **Repository permissions:** Contents (read and write), Pull requests (read
  and write), Issues (read and write), and Actions (read)
- **Events:** Pull request, Pull request review, Issue comment, Repository, and
  Workflow run

Create a webhook secret, note the app ID and OAuth client details, and generate
a private key. Convert the private key to the format Cloudflare accepts:

```sh
openssl pkcs8 -topk8 -inform PEM -outform PEM -nocrypt \
  -in app.pem -out app.pkcs8.pem
```

Set the `GITHUB_APP_SLUG` Worker variable to the name from the app's GitHub URL.

### 6. Configure the environment

Set the required variables and secrets listed below. For local development,
copy `.dev.vars.example` to `.dev.vars` and fill in your values. For a deployed
Worker, add non-secret values under **Settings → Variables and Secrets** in
Cloudflare, and save each secret with:

```sh
vp exec wrangler secret put <NAME>
```

Never commit `.dev.vars` or any production secret.

### 7. Build and deploy

Check the project before the first deployment:

```sh
vp lint
vp run check:types
vp test
vp run build
```

Deploy the database changes and application:

```sh
export DATABASE_URL='postgres://...'
vp run db:migrate
vp run db:verify
vp run deploy
```

After deployment, update the GitHub App's webhook and callback URLs if your
public address changed. Install the app on the repositories Turbodiff may use,
then sign in at your deployment URL.

## Environment variables

Turbodiff has three kinds of configuration:

- **Worker variables** are non-secret values in Cloudflare's **Variables and
  Secrets** settings. They are preserved by `keep_vars` during Wrangler
  deployments.
- **Worker secrets** go in `.dev.vars` locally and in Cloudflare's secret store
  after deployment.
- **Shell and CI variables** are used by setup and deployment commands. They
  are not read by the running Worker.

Cloudflare bindings such as Hyperdrive, R2, Queues, Containers, and Workflows
are also configured in `wrangler.jsonc`, but they are resources rather than
environment variables.

### Required

These values are required for the full GitHub software factory:

| Name                         | Where         | Purpose                                                      |
| ---------------------------- | ------------- | ------------------------------------------------------------ |
| `AI_GATEWAY_ID`              | Worker var    | Name of the Cloudflare AI Gateway used for model requests.   |
| `AI_GATEWAY_ACCOUNT_ID`      | Worker var    | Cloudflare account that owns the AI Gateway.                 |
| `PUBLIC_BASE_URL`            | Worker var    | Public address of your deployment, with no trailing slash.   |
| `GITHUB_APP_SLUG`            | Worker var    | Name at the end of your GitHub App URL.                      |
| `GITHUB_APP_ID`              | Worker secret | Numeric ID shown in the GitHub App settings.                 |
| `GITHUB_APP_PRIVATE_KEY`     | Worker secret | Complete PKCS#8 private key for the GitHub App.              |
| `GITHUB_WEBHOOK_SECRET`      | Worker secret | Checks that webhook calls came from GitHub.                  |
| `GITHUB_OAUTH_CLIENT_ID`     | Worker secret | Client ID used for GitHub sign-in.                           |
| `GITHUB_OAUTH_CLIENT_SECRET` | Worker secret | Client secret used for GitHub sign-in.                       |
| `SESSION_SECRET`             | Worker secret | Signs login state and short-lived access links.              |
| `AI_GATEWAY_API_TOKEN`       | Worker secret | Cloudflare token used by code-writing agents to call models. |
| `DATABASE_URL`               | Shell or CI   | Direct PostgreSQL URL used for migrations and schema checks. |
| `HYPERDRIVE_DATABASE_URL`    | Shell         | PostgreSQL URL used when creating or updating Hyperdrive.    |

Generate `SESSION_SECRET` with `openssl rand -hex 32`.
`AI_GATEWAY_API_TOKEN` needs Cloudflare's **Account / Workers AI / Read**
permission. Use a limited database account for `HYPERDRIVE_DATABASE_URL`, not
the more powerful account used for migrations.

Use [.dev.vars.example](.dev.vars.example) as the local configuration template.

### Optional

Leave these out unless you use the related feature:

| Name                    | Where         | Used for                                                                 |
| ----------------------- | ------------- | ------------------------------------------------------------------------ |
| `ARTIFACTS_REMOTE_BASE` | Worker var    | Git address for repositories stored in Cloudflare Artifacts.             |
| `RESEND_FROM_ADDRESS`   | Worker var    | Sender address for organization invitation emails.                       |
| `REVIEW_DAILY_LIMIT`    | Worker var    | Maximum automatic reviews per installation in 24 hours; defaults to 50.  |
| `TRIVIAL_MODEL`         | Worker var    | Cheaper model for very small pull requests; empty disables it.           |
| `REVIEW_SECRET`         | Worker secret | Protects operator-only HTTP endpoints.                                   |
| `TOKEN_ENCRYPTION_KEY`  | Worker secret | Encrypts credentials for connected tools.                                |
| `RESEND_API_KEY`        | Worker secret | Sends organization invitation emails.                                    |
| `SKILLS_SH_API_TOKEN`   | Worker secret | Enables browsing the skills.sh catalog.                                  |
| `VAPID_PUBLIC_KEY`      | Worker secret | Enables browser notifications; set all three `VAPID_*` values.           |
| `VAPID_PRIVATE_KEY`     | Worker secret | Enables browser notifications; set all three `VAPID_*` values.           |
| `VAPID_SUBJECT`         | Worker secret | Contact URI for browser notifications, such as `mailto:you@example.com`. |
| `POSTGRES_DATABASE_URL` | CI secret     | Production migration URL used by the GitHub Actions deploy workflow.     |
| `CLOUDFLARE_API_TOKEN`  | CI secret     | Lets the GitHub Actions deploy workflow publish to Cloudflare.           |
| `CLOUDFLARE_ACCOUNT_ID` | CI secret     | Selects the Cloudflare account used by the deploy workflow.              |

Generate `REVIEW_SECRET` and `TOKEN_ENCRYPTION_KEY` with
`openssl rand -hex 32`. `TOKEN_ENCRYPTION_KEY` is required before anyone can
save credentials for connected tools.

The three `VAPID_*` values must be configured together. If they are absent,
only browser notifications are disabled.

`.dev.vars` is local-only and is never a source for production Worker values.
Use the address printed by the development server for its `PUBLIC_BASE_URL`.

Variables such as `GIT_TOKEN`, `GIT_REMOTE`, `TURBODIFF_*`, `NODE_PATH`, and
`PUPPETEER_EXECUTABLE_PATH` are created inside Turbodiff's containers. Do not
set them yourself.

## Local development

Start PostgreSQL and apply the schema:

```sh
docker compose -f compose.postgres.yml up -d
export DATABASE_URL='postgres://turbodiff:turbodiff@localhost:5432/turbodiff'
vp run db:migrate
vp run db:verify
```

With Docker running, start the app:

```sh
vp run dev
```

For GitHub webhooks, point a tunnel such as Cloudflare Tunnel or smee.io at
`/webhooks/github`.

Useful commands are listed in [AGENTS.md](AGENTS.md). Pull requests run lint,
type checks, tests, a build, database checks, and a Cloudflare deployment
check.

## Learn more

- [Architecture](docs/architecture.md)

## Contributing

Bug reports, ideas, documentation fixes, and code changes are welcome. For a
large change, please open an issue first so the approach can be discussed.

## License

[MIT](LICENSE.md) © 2026 Nico Botha
