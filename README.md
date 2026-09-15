# Turbodiff

<img src="public/logo-small.png" alt="Turbodiff logo" width="64" align="center" />

Turbodiff is an open-source software factory. Give it a task and it
can plan the work, write the code, open a pull request, and review the change.
You decide where automation starts and stops and which steps need human input.

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
   Each step records its result, so a person can take over or let the next step
   continue. Repositories can use the full factory or only the parts they need.

### Pull request reviews

The reviewer also works with pull requests created outside Turbodiff. It can:

- Review automatically or only when asked.
- Request changes for serious problems and approve clean pull requests.
- Run custom review agents for different areas of a codebase.

## Open source and self-hostable

Turbodiff uses:

- **Cloudflare Workers** for the web app and API.
- **Cloudflare Containers** for isolated agent jobs.
- **Cloudflare AI Gateway** to connect to AI models.
- **PostgreSQL** on PlanetScale for organizations, repositories, work, execution state, and configuration, connected through Hyperdrive.
- **Cloudflare R2** for immutable agent inputs, outputs, revisions, and logs.
- **Cloudflare Queues and Workflows** for work that outlives a web request.
- **Cloudflare Artifacts** for repositories created and hosted by Turbodiff.

More detail is available in the [architecture guide](docs/architecture.md).

To get started with the full self-hosted factory you need:

- A Cloudflare account with Workers, Containers, AI Gateway, Hyperdrive, Queues, Workflows, and R2. Cloudflare Artifacts is needed only if Turbodiff will host repositories.
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
more powerful migration account separate. The [architecture guide](docs/architecture.md#data-and-storage)
documents the schema, storage boundaries, and migration workflow.

### 4. Create the queue and artifact bucket

```sh
vp exec wrangler queues create turbodiff-factory
vp exec wrangler r2 bucket create turbodiff-artifacts
```

If you use different names, update `wrangler.jsonc`.

The separate `GIT_ARTIFACTS` binding is only used for repositories hosted by
Turbodiff and requires access to the Cloudflare Artifacts namespace configured
in `wrangler.jsonc`.

### 5. Create a GitHub App

Create a new app in [GitHub App settings](https://github.com/settings/apps)
with these values:

- **Webhook URL:** `https://<your-domain>/webhooks/github`
- **Callback URL:** `https://<your-domain>/auth/callback`
- **Repository permissions:** Contents (read and write), Pull requests (read
  and write), Issues (read and write), and Actions (read)
- **Events:** Installation, Installation repositories, Repository, and Pull request

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
vp check
vp run check:types
vp test --run
vp run test:planning
vp run db:check
vp run test:schema
vp run test:integration
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

Cloudflare bindings such as Hyperdrive, R2, Queues, and Containers
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
Use a limited database account for `HYPERDRIVE_DATABASE_URL`, not the more
powerful account used for migrations.

Use [.dev.vars.example](.dev.vars.example) as the local configuration template.

### Optional

Leave these out unless you use the related feature:

| Name                    | Where         | Used for                                                             |
| ----------------------- | ------------- | -------------------------------------------------------------------- |
| `ARTIFACTS_REMOTE_BASE` | Worker var    | Clone base URL for Turbodiff-hosted repositories.                    |
| `RESEND_FROM_ADDRESS`   | Worker var    | Sender address for organization invitation emails.                   |
| `VAPID_PUBLIC_KEY`      | Worker var    | Enables browser push subscription.                                   |
| `VAPID_SUBJECT`         | Worker var    | Contact URI included in Web Push authorization.                      |
| `TOKEN_ENCRYPTION_KEY`  | Worker secret | Encrypts credentials for connected tools.                            |
| `RESEND_API_KEY`        | Worker secret | Sends organization invitation emails.                                |
| `SKILLS_SH_API_TOKEN`   | Worker secret | Enables skills.sh catalog browsing.                                  |
| `VAPID_PRIVATE_KEY`     | Worker secret | Signs Web Push notifications.                                        |
| `POSTGRES_DATABASE_URL` | CI secret     | Production migration URL used by the GitHub Actions deploy workflow. |
| `CLOUDFLARE_API_TOKEN`  | CI secret     | Lets the GitHub Actions deploy workflow publish to Cloudflare.       |
| `CLOUDFLARE_ACCOUNT_ID` | CI secret     | Selects the Cloudflare account used by the deploy workflow.          |

Generate `TOKEN_ENCRYPTION_KEY` with `openssl rand -hex 32`. It is required before anyone can
save credentials for connected tools.

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
