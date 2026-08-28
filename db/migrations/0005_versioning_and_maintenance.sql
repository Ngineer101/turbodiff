CREATE SEQUENCE app.factory_version_seq AS bigint START WITH 1 INCREMENT BY 1 NO CYCLE;

CREATE FUNCTION app.bump_factory_version()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = app, pg_temp
AS $function$
BEGIN
  PERFORM nextval('app.factory_version_seq');
  RETURN NULL;
END
$function$;

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

CREATE FUNCTION app.touch_updated_at()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  NEW.updated_at = CURRENT_TIMESTAMP;
  RETURN NEW;
END
$function$;

CREATE TRIGGER change_requests_touch_updated_at
BEFORE UPDATE ON app.change_requests
FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();

CREATE TRIGGER cr_checks_touch_updated_at
BEFORE UPDATE ON app.cr_checks
FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();

COMMENT ON SEQUENCE app.native_entity_id_seq IS
  'Collision-free IDs for Artifacts-native installations and repositories; GitHub provider IDs remain explicit';
COMMENT ON SEQUENCE app.factory_version_seq IS
  'Monotonic cache-invalidation signal without a globally contended singleton UPDATE';
