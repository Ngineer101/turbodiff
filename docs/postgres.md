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

Create a dedicated PlanetScale role for migrations and grant it the `postgres` permission. This is
PlanetScale's near-superuser permission (not PostgreSQL `SUPERUSER`) and is required because the
migrations create and alter schemas, tables, sequences, indexes, functions, and triggers.
`pg_read_all_data` and `pg_write_all_data` alone cannot apply the schema.

Set `DATABASE_URL` to that role's direct (non-pooled) PostgreSQL URL, then run:

```sh
vp run db:status
vp run db:migrate
vp run db:verify
```

On a new database, `db:migrate` creates the `app` and `auth` schemas and the
`public.schema_migrations` ledger. On an existing deployment, it applies only migrations that are
not already recorded in that ledger. Drizzle applies all pending migrations in one transaction,
and the deployment wrapper serializes migration runs with a PostgreSQL advisory lock. It refuses
to continue if the checksum of an applied migration has changed, so never edit a migration after
it has been deployed.

The production deployment workflow runs `db:migrate` and `db:verify` against the existing
PlanetScale database using the `POSTGRES_DATABASE_URL` repository secret before it deploys the
Worker. These steps only evolve the schema; neither PlanetScale nor Hyperdrive is provisioned by
the pipeline. Store only the migration role's URL in `POSTGRES_DATABASE_URL`; never configure
Hyperdrive with this privileged credential.

## Database roles

Use two separate PlanetScale roles:

| Purpose             | PlanetScale permissions                 | Used by                                          |
| ------------------- | --------------------------------------- | ------------------------------------------------ |
| Schema migrations   | `postgres`                              | GitHub `POSTGRES_DATABASE_URL` repository secret |
| Application runtime | `pg_read_all_data`, `pg_write_all_data` | Cloudflare Hyperdrive                            |

The runtime role needs both predefined data permissions: the application reads and writes tables
and uses sequences in the `app` and `auth` schemas. These roles also supply schema access and cover
objects created by future migrations. Do not grant the runtime role `postgres`, monitoring,
maintenance, replication, checkpoint, backend-signalling, or reserved-connection permissions.

The predefined data roles apply to all data in the PlanetScale branch, so use a database dedicated
to Turbodiff. If unrelated applications share the database, replace them with explicit grants
limited to the `app` and `auth` schemas.

## Create or rotate Hyperdrive

Use read-cache-disabled mode initially. Turbodiff performs read-after-write operations and
Hyperdrive does not invalidate cached reads after writes.

Create a separate PlanetScale runtime role with only `pg_read_all_data` and
`pg_write_all_data`, then use that role's URL here—not the migration URL:

```sh
export HYPERDRIVE_DATABASE_URL='postgres://...'
vp exec wrangler hyperdrive create turbodiff-postgres \
  --connection-string="$HYPERDRIVE_DATABASE_URL" \
  --caching-disabled
```

Copy the resulting ID into `wrangler.jsonc`. Do not put database credentials in Wrangler config;
Cloudflare stores them in the Hyperdrive configuration. After changing the binding, regenerate
types with `vp exec wrangler types`.

## Schema layout

- `auth`: Better Auth users, sessions, accounts, organizations, invitations, and MCP OAuth data.
- `app`: installations, repositories, configuration, factory tasks, reviews, runs, usage, and
  collaboration data.
- `public.schema_migrations`: Drizzle's immutable migration ledger only.

`src/data/schema.ts` is the schema source of truth. Generate a new migration after changing it:

```sh
vp exec drizzle-kit generate --name=<short_description>
```

Do not edit a migration after it has been applied. Database functions and triggers that Drizzle
cannot express declaratively belong in a named custom migration generated with
`vp exec drizzle-kit generate --custom --name=<short_description>`.

The application sets `search_path=app,auth,public` on database clients. Better Auth reverses the
first two entries so its own tables resolve from `auth` first.
