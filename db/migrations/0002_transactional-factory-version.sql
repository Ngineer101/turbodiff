CREATE TABLE "app"."factory_version" (
	"id" integer PRIMARY KEY NOT NULL,
	"version" bigint DEFAULT 1 NOT NULL,
	CONSTRAINT "factory_version_singleton_check" CHECK (id = 1),
	CONSTRAINT "factory_version_positive_check" CHECK (version > 0)
);
--> statement-breakpoint
INSERT INTO app.factory_version (id, version) VALUES (1, 1);
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.bump_factory_version()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, app, pg_temp
AS $function$
BEGIN
  UPDATE app.factory_version SET version = version + 1 WHERE id = 1;
  RETURN NULL;
END
$function$;
--> statement-breakpoint
DROP SEQUENCE "app"."factory_version_seq";
--> statement-breakpoint
COMMENT ON TABLE app.factory_version IS
  'Transactional cache-invalidation signal; updates become visible atomically with their source writes';
