# PostgreSQL and Hyperdrive

Turbodiff uses PostgreSQL as its relational store. Worker traffic reaches it through the
`HYPERDRIVE` binding; schema migrations use a direct PostgreSQL connection because migration
transactions and advisory locks must not pass through a transaction pooler.
The concrete PostgreSQL version used for local development and CI is pinned in
`compose.postgres.yml` and the GitHub workflow service definitions; do not duplicate that version
here.

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
integration suite. The reset command refuses any `DATABASE_URL` whose host is not a loopback
address (`localhost`, `127.0.0.1`, or `::1`).

## Deploy the schema

Create a dedicated PlanetScale role for migrations and grant it the `postgres` permission. This is
PlanetScale's near-superuser permission (not PostgreSQL `SUPERUSER`). Turbodiff's migrations create
and alter schemas, tables, sequences, indexes, functions, and triggers; `pg_read_all_data` and
`pg_write_all_data` do not grant those DDL privileges. A custom DDL role is possible, but the
documented deployment uses PlanetScale's managed `postgres` permission.

Set `DATABASE_URL` to that role's direct PostgreSQL URL on port `5432`, not the PgBouncer URL on
port `6432`, then run:

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

See PlanetScale's [role documentation](https://planetscale.com/docs/postgres/connecting/roles) for
the current definitions of these managed permissions.

The predefined data roles apply to all data in the PlanetScale branch, so use a database dedicated
to Turbodiff. If unrelated applications share the database, replace them with explicit grants
limited to the `app` and `auth` schemas.

## Create or rotate Hyperdrive

Use a cache-disabled Hyperdrive configuration. Turbodiff requires fresh reads after writes, and
Hyperdrive does not invalidate cached reads after writes. See Cloudflare's
[query-caching documentation](https://developers.cloudflare.com/hyperdrive/concepts/query-caching/)
for the current behavior.

Create a separate PlanetScale runtime role with only `pg_read_all_data` and
`pg_write_all_data`, then use that role's direct port-`5432` URL here—not the migration URL or
PlanetScale's port-`6432` PgBouncer URL. Hyperdrive provides the application connection pool. See
Cloudflare's [PlanetScale guide](https://developers.cloudflare.com/hyperdrive/examples/connect-to-postgres/postgres-database-providers/planetscale-postgres/)
and PlanetScale's [connection documentation](https://planetscale.com/docs/postgres/connecting/).

```sh
export HYPERDRIVE_DATABASE_URL='postgres://...'
vp exec wrangler hyperdrive create turbodiff-postgres \
  --connection-string="$HYPERDRIVE_DATABASE_URL" \
  --caching-disabled
```

Copy the resulting ID into `wrangler.jsonc`. To rotate the runtime role or its password without
changing that ID, update the existing configuration:

```sh
vp exec wrangler hyperdrive update <HYPERDRIVE_ID> \
  --connection-string="$HYPERDRIVE_DATABASE_URL" \
  --caching-disabled
vp exec wrangler hyperdrive get <HYPERDRIVE_ID>
```

Do not put database credentials in Wrangler config; Cloudflare stores them in the Hyperdrive
configuration. After changing the binding, regenerate types with `vp exec wrangler types`.

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

The application sets `search_path=app,auth,public` on database clients. Better Auth receives
explicit mappings to the tables in the `auth` schema, so it does not depend on a different
`search_path`.
