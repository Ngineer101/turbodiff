INSERT INTO "app"."models"
  ("provider", "model_id", "label", "capabilities", "enabled")
VALUES
  ('anthropic', 'claude-opus-5.5', 'Claude Opus 5.5', ARRAY['text', 'tools', 'reasoning'], true)
ON CONFLICT ("provider", "model_id") DO UPDATE SET
  "label" = EXCLUDED."label",
  "capabilities" = EXCLUDED."capabilities",
  "enabled" = EXCLUDED."enabled";
