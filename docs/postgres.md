# PostgreSQL and Hyperdrive

Turbodiff uses PostgreSQL 17 as its relational store. Worker traffic reaches it through the
`HYPERDRIVE` binding; schema migrations use a direct PostgreSQL connection because migration
transactions and advisory locks must not pass through a transaction pooler.

## Local database

```sh
docker compose -f compose.postgres.yml up -d
export DATABASE_URL=postgres://turbodiff:turbodiff@localhost:5432/turbodiff
vp run db:migrate
vp run db:verify
```

Wrangler uses the same local instance through `localConnectionString` in `wrangler.jsonc`.
The committed credentials are local-only Docker defaults, not deployment credentials.

`vp run test:worker` migrates and then clears this local database before running the Worker
integration suite. The reset command refuses any `DATABASE_URL` whose host is not localhost.

## Deploy the schema

Set `DATABASE_URL` to the provider's direct (non-pooled) PostgreSQL URL, then run:

```sh
vp run db:status
vp run db:migrate
vp run db:verify
```

Every migration runs in its own transaction. The runner serializes deploys with a PostgreSQL
advisory lock and refuses to continue if an already-applied migration's checksum changed.

The production deployment workflow runs `db:migrate` and `db:verify` against the existing
PlanetScale database using the `POSTGRES_DATABASE_URL` repository secret before it deploys the
Worker. These steps only evolve the schema; neither PlanetScale nor Hyperdrive is provisioned by
the pipeline.

The database user used by Hyperdrive needs `USAGE` on the `app` and `auth` schemas and normal
`SELECT`, `INSERT`, `UPDATE`, and `DELETE` privileges on their tables and sequences. It should not
be a superuser or own the database. Run migrations with a separate owner role.

After migrating as the owner, provision the least-privilege runtime role (substitute the role name
used by your Hyperdrive connection):

```sql
GRANT CONNECT ON DATABASE turbodiff TO turbodiff_app;
GRANT USAGE ON SCHEMA app, auth TO turbodiff_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA app, auth TO turbodiff_app;
GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA app, auth TO turbodiff_app;

ALTER DEFAULT PRIVILEGES IN SCHEMA app, auth
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO turbodiff_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA app, auth
  GRANT USAGE, SELECT, UPDATE ON SEQUENCES TO turbodiff_app;
```

`ALTER DEFAULT PRIVILEGES` must be run as the same owner role that applies future migrations.

## Create or rotate Hyperdrive

Use read-cache-disabled mode initially. Turbodiff performs read-after-write operations and
Hyperdrive does not invalidate cached reads after writes.

```sh
vp exec wrangler hyperdrive create turbodiff-postgres \
  --connection-string="$DATABASE_URL" \
  --caching-disabled
```

Copy the resulting ID into `wrangler.jsonc`. Do not put database credentials in Wrangler config;
Cloudflare stores them in the Hyperdrive configuration. After changing the binding, regenerate
types with `vp exec wrangler types`.

## Schema layout

- `auth`: Better Auth users, sessions, accounts, organizations, invitations, and MCP OAuth data.
- `app`: installations, repositories, configuration, factory tasks, reviews, runs, usage, and
  collaboration data.
- `public.schema_migrations`: immutable migration ledger only.

The application sets `search_path=app,auth,public` on database clients. Better Auth reverses the
first two entries so its own tables resolve from `auth` first.
