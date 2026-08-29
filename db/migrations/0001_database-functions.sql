CREATE FUNCTION app.next_change_request_number(target_repository_id bigint)
RETURNS integer
LANGUAGE sql
SET search_path = pg_catalog, app, pg_temp
AS $function$
  INSERT INTO app.change_request_counters (repository_id, last_number)
  VALUES (target_repository_id, 1)
  ON CONFLICT (repository_id)
  DO UPDATE SET last_number = app.change_request_counters.last_number + 1
  RETURNING last_number
$function$;
--> statement-breakpoint
CREATE FUNCTION app.bump_factory_version()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, app, pg_temp
AS $function$
BEGIN
  PERFORM nextval('app.factory_version_seq');
  RETURN NULL;
END
$function$;
--> statement-breakpoint
DO $block$
DECLARE
  relation_name text;
BEGIN
  FOREACH relation_name IN ARRAY ARRAY[
    'installations',
    'repositories',
    'todos',
    'todo_repositories',
    'plans',
    'plan_repositories',
    'features',
    'verifications',
    'chat_messages',
    'cockpit_comments',
    'change_requests',
    'cr_checks',
    'cr_comments',
    'fix_attempts',
    'automations',
    'automation_runs',
    'agent_runs',
    'reviews'
  ]
  LOOP
    EXECUTE format(
      'CREATE TRIGGER %I_factory_version AFTER INSERT OR UPDATE OR DELETE ON app.%I '
      'FOR EACH STATEMENT EXECUTE FUNCTION app.bump_factory_version()',
      relation_name,
      relation_name
    );
  END LOOP;
END
$block$;
--> statement-breakpoint
CREATE FUNCTION app.touch_updated_at()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, app, pg_temp
AS $function$
BEGIN
  NEW.updated_at = CURRENT_TIMESTAMP;
  RETURN NEW;
END
$function$;
--> statement-breakpoint
CREATE TRIGGER change_requests_touch_updated_at
BEFORE UPDATE ON app.change_requests
FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();
--> statement-breakpoint
CREATE TRIGGER cr_checks_touch_updated_at
BEFORE UPDATE ON app.cr_checks
FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();
--> statement-breakpoint
COMMENT ON SEQUENCE app.native_entity_id_seq IS
  'Collision-free IDs for Artifacts-native installations and repositories; GitHub provider IDs remain explicit';
--> statement-breakpoint
COMMENT ON SEQUENCE app.factory_version_seq IS
  'Monotonic cache-invalidation signal without a globally contended singleton UPDATE';
