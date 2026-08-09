-- Cached launch-detection verdict per repo: null = never checked,
-- 1 = launchable (run_command/app_port hold the recipe), 0 = verified NOT
-- launchable in the sandbox (needs Docker/cloud bindings/etc.) — future
-- verification runs skip discovery instead of rediscovering it every time.
ALTER TABLE repositories ADD COLUMN launchable INTEGER;
