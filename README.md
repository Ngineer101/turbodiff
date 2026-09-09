# Turbodiff

<img src="public/logo-small.png" alt="Turbodiff logo" width="64" align="right" />

Turbodiff is an open-source GitHub app that uses AI to review pull requests
and turn tasks into code. You can use the hosted version at
[turbodiff.dev](https://turbodiff.dev) or run it in your own Cloudflare
account.

Turbodiff is licensed under the [MIT License](LICENSE.md). You can use, change,
and share it, including as part of a commercial product.

> [!WARNING]
> Turbodiff is under active development. Expect bugs and breaking changes. If
> you find a problem, please [open an issue](https://github.com/Ngineer101/turbodiff/issues).

## What it does

- Reviews new and updated pull requests.
- Turns a written task into a plan for you to approve.
- Writes the code in an isolated container and opens a pull request.
- Tries to fix review findings and failed checks.
- Checks the finished work against the approved plan.
- Lets you choose which steps run automatically and which need approval.

## Why self-host

Self-hosting gives you control over where Turbodiff runs, which repositories it
can access, and which AI models it uses. Your GitHub App keys, database, model
credentials, and usage data stay in services you manage.

The application code is all in this repository. A deployment uses Cloudflare
Workers and Containers, with PostgreSQL for stored data.

## Self-hosting

Turbodiff is built for Cloudflare. Before you start, you need:

- A Cloudflare account with Workers, Containers, AI Gateway, Hyperdrive,
  Queues, and R2 available.
- A PostgreSQL database. The production setup uses PlanetScale, but another
  PostgreSQL provider can work.
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
use. In [wrangler.jsonc](wrangler.jsonc), replace the existing deployment
values with your own:

- `AI_GATEWAY_ID`
- `AI_GATEWAY_ACCOUNT_ID`
- `PUBLIC_BASE_URL`
- the Hyperdrive configuration ID
- R2 bucket and queue names, if you changed them

The optional Artifacts binding hosts repositories created inside Turbodiff and
requires access to Cloudflare Artifacts. Remove that binding and its event
triggers if you only plan to use GitHub repositories.

### 3. Set up PostgreSQL

Create a database, then apply and check the schema using a direct database
connection:

```sh
export DATABASE_URL='postgres://...'
vp run db:migrate
vp run db:verify
```

Create a Hyperdrive connection to the database with query caching disabled,
then copy its ID into `wrangler.jsonc`:

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

Set `GITHUB_APP_SLUG` in `wrangler.jsonc` to the name from the app's GitHub URL.

### 6. Add secrets

Add these values to `.dev.vars` for local work. For production, save each one
with `vp exec wrangler secret put <NAME>`.

```dotenv
GITHUB_APP_ID=""
GITHUB_APP_PRIVATE_KEY=""
GITHUB_WEBHOOK_SECRET=""
GITHUB_OAUTH_CLIENT_ID=""
GITHUB_OAUTH_CLIENT_SECRET=""
SESSION_SECRET=""
REVIEW_SECRET=""
AI_GATEWAY_API_TOKEN=""
```

Generate `SESSION_SECRET` and `REVIEW_SECRET` with `openssl rand -hex 32`.
`AI_GATEWAY_API_TOKEN` needs Cloudflare's **Account / Workers AI / Read**
permission. It stays in the Worker and is not passed into the code-writing
container.

Optional features use these additional settings:

| Feature               | Settings                                                     |
| --------------------- | ------------------------------------------------------------ |
| Connected tools       | `TOKEN_ENCRYPTION_KEY`                                       |
| Email invitations     | `RESEND_API_KEY` and `RESEND_FROM_ADDRESS`                   |
| Skills catalog        | `SKILLS_SH_API_TOKEN`                                        |
| Browser notifications | `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, and `VAPID_SUBJECT` |

Use `openssl rand -hex 32` for `TOKEN_ENCRYPTION_KEY`. Browser notifications
need all three `VAPID_*` values; without them, only notifications are disabled.

Never commit `.dev.vars` or any production secret.

### 7. Build and deploy

Check the project before the first deployment:

```sh
vp check
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
type checks, tests, a build, and a Cloudflare deployment check.

## Learn more

- [Architecture](docs/architecture.md)
- [PostgreSQL setup](docs/postgres.md)
- [How code-writing agents run](docs/coding-harness.md)
- [How pull request reviews work](docs/review-quality.md)
- [Software factory plans](docs/software-factory-lifecycle.md)

## Contributing

Bug reports, ideas, documentation fixes, and code changes are welcome. For a
large change, please open an issue first so the approach can be discussed.

## License

[MIT](LICENSE.md) © 2026 Nico Botha
