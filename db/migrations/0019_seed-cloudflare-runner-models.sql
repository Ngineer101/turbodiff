-- Seed the non-deprecated, tool-capable text-generation catalog exposed by
-- Cloudflare AI as of 2026-09-09. Third-party entries come from the AI model
-- catalog's Text Generation surface; Workers AI entries additionally require
-- the catalog's Function calling capability. Provider groups and model
-- families are ordered newest/most capable first. GPT-5.6 Sol is the normal
-- planning/task fallback and Opus 4.8 owns the secondary runner role; Fable
-- 5.1 and Haiku 4.5 remain selectable but are no longer fallback roles.
WITH seeded (provider, model_id, label, sort_order) AS (
  VALUES
    -- Anthropic
    ('anthropic', 'claude-fable-5.1', 'Fable 5.1', 0),
    ('anthropic', 'claude-fable-5', 'Fable 5', 1),
    ('anthropic', 'claude-opus-5', 'Opus 5', 2),
    ('anthropic', 'claude-sonnet-5', 'Sonnet 5', 3),
    ('anthropic', 'claude-haiku-4.5', 'Haiku 4.5', 4),
    ('anthropic', 'claude-opus-4.8', 'Opus 4.8', 5),
    ('anthropic', 'claude-opus-4.7', 'Opus 4.7', 6),
    ('anthropic', 'claude-opus-4.6', 'Opus 4.6', 7),
    ('anthropic', 'claude-opus-4.5', 'Opus 4.5', 8),
    ('anthropic', 'claude-sonnet-4.6', 'Sonnet 4.6', 9),
    ('anthropic', 'claude-sonnet-4.5', 'Sonnet 4.5', 10),

    -- OpenAI
    ('openai', 'gpt-5.6-sol', 'GPT-5.6 Sol', 100),
    ('openai', 'gpt-5.6-terra', 'GPT-5.6 Terra', 101),
    ('openai', 'gpt-5.6-luna', 'GPT-5.6 Luna', 102),
    ('openai', 'gpt-5.5-pro', 'GPT-5.5 Pro', 103),
    ('openai', 'gpt-5.5', 'GPT-5.5', 104),
    ('openai', 'gpt-5.4-pro', 'GPT-5.4 Pro', 105),
    ('openai', 'gpt-5.4', 'GPT-5.4', 106),
    ('openai', 'gpt-5.4-mini', 'GPT-5.4 Mini', 107),
    ('openai', 'gpt-5.4-nano', 'GPT-5.4 Nano', 108),
    ('openai', 'gpt-5.1', 'GPT-5.1', 109),
    ('openai', 'gpt-5', 'GPT-5', 110),
    ('openai', 'gpt-5-mini', 'GPT-5 Mini', 111),
    ('openai', 'gpt-5-nano', 'GPT-5 Nano', 112),
    ('openai', 'o4-mini', 'o4-mini', 113),
    ('openai', 'o3', 'o3', 114),
    ('openai', 'o3-mini', 'o3-mini', 115),
    ('openai', 'gpt-4.1', 'GPT-4.1', 116),
    ('openai', 'gpt-4.1-mini', 'GPT-4.1 Mini', 117),
    ('openai', 'gpt-4.1-nano', 'GPT-4.1 Nano', 118),
    ('openai', 'gpt-4o', 'GPT-4o', 119),
    ('openai', 'gpt-4o-mini', 'GPT-4o Mini', 120),

    -- Google
    ('google', 'gemini-3.7-flash', 'Gemini 3.7 Flash', 200),
    ('google', 'gemini-3.6-flash', 'Gemini 3.6 Flash', 201),
    ('google', 'gemini-3.5-flash', 'Gemini 3.5 Flash', 202),
    ('google', 'gemini-3.5-flash-lite', 'Gemini 3.5 Flash-Lite', 203),
    ('google', 'gemini-3.1-pro', 'Gemini 3.1 Pro', 204),
    ('google', 'gemini-3.1-flash-lite', 'Gemini 3.1 Flash-Lite', 205),
    ('google', 'gemini-3-flash', 'Gemini 3 Flash', 206),
    ('google', 'gemini-2.5-pro', 'Gemini 2.5 Pro', 207),
    ('google', 'gemini-2.5-flash', 'Gemini 2.5 Flash', 208),
    ('google', 'gemini-2.5-flash-lite', 'Gemini 2.5 Flash-Lite', 209),

    -- Alibaba
    ('alibaba', 'qwen3.8-max', 'Qwen 3.8 Max', 300),
    ('alibaba', 'qwen3.7-max', 'Qwen 3.7 Max', 301),
    ('alibaba', 'qwen3.7-plus', 'Qwen 3.7 Plus', 302),
    ('alibaba', 'qwen3.5-397b-a17b', 'Qwen 3.5 397B A17B', 303),
    ('alibaba', 'qwen3-max', 'Qwen 3 Max', 304),

    -- xAI
    ('xai', 'grok-4.6', 'Grok 4.6', 400),
    ('xai', 'grok-4.5', 'Grok 4.5', 401),
    ('xai', 'grok-4.3', 'Grok 4.3', 402),
    ('xai', 'grok-4.20-multi-agent-0309', 'Grok 4.20 Multi-Agent', 403),
    ('xai', 'grok-4.20-0309-reasoning', 'Grok 4.20 Reasoning', 404),
    ('xai', 'grok-4.20-0309-non-reasoning', 'Grok 4.20 Non-Reasoning', 405),

    -- Other third-party providers
    ('deepseek', 'deepseek-v4-pro', 'DeepSeek V4 Pro', 500),
    ('minimax', 'm3', 'MiniMax M3', 510),
    ('minimax', 'm2.7', 'MiniMax M2.7', 511),
    ('moonshotai', 'kimi-k3', 'Kimi K3', 520),
    ('thinkingmachines', 'inkling-256k', 'Inkling 256K', 530),
    ('thinkingmachines', 'inkling', 'Inkling', 531),

    -- Cloudflare-hosted Workers AI models with Function calling.
    ('workers-ai', '@cf/moonshotai/kimi-k2.7-code', 'Kimi K2.7 Code', 1000),
    ('workers-ai', '@cf/zai-org/glm-5.3', 'GLM-5.3', 1001),
    ('workers-ai', '@cf/zai-org/glm-5.3-flash', 'GLM-5.3 Flash', 1002),
    ('workers-ai', '@cf/deepseek-ai/deepseek-v4-pro-0813', 'DeepSeek V4 Pro 0813', 1003),
    ('workers-ai', '@cf/deepseek-ai/deepseek-v4-flash-0731', 'DeepSeek V4 Flash 0731', 1004),
    ('workers-ai', '@cf/moonshotai/kimi-k2.6', 'Kimi K2.6', 1005),
    ('workers-ai', '@cf/zai-org/glm-5.2', 'GLM-5.2', 1006),
    ('workers-ai', '@cf/openai/gpt-oss-120b', 'GPT-OSS 120B', 1007),
    ('workers-ai', '@cf/openai/gpt-oss-20b', 'GPT-OSS 20B', 1008),
    ('workers-ai', '@cf/nvidia/nemotron-3-120b-a12b', 'Nemotron 3 120B A12B', 1009),
    ('workers-ai', '@cf/qwen/qwen3.8-27b', 'Qwen 3.8 27B', 1010),
    ('workers-ai', '@cf/google/gemma-4-26b-a4b-it', 'Gemma 4 26B A4B', 1011),
    ('workers-ai', '@cf/qwen/qwen3-30b-a3b-fp8', 'Qwen3 30B A3B FP8', 1012),
    ('workers-ai', '@cf/meta/llama-4-scout-17b-16e-instruct', 'Llama 4 Scout 17B 16E', 1013),
    ('workers-ai', '@cf/meta/llama-3.3-70b-instruct-fp8-fast', 'Llama 3.3 70B FP8 Fast', 1014),
    ('workers-ai', '@cf/mistralai/mistral-small-3.1-24b-instruct', 'Mistral Small 3.1 24B', 1015),
    ('workers-ai', '@cf/ibm-granite/granite-4.0-h-micro', 'Granite 4.0 H Micro', 1016),
    ('workers-ai', '@cf/zai-org/glm-4.7-flash', 'GLM-4.7 Flash', 1017)
)
INSERT INTO "app"."models"
  (provider, model_id, label, for_runner, for_reviewer, sort_order)
SELECT provider, model_id, label, true, true, sort_order
FROM seeded
ON CONFLICT (provider, model_id) DO UPDATE SET
  label = excluded.label,
  for_runner = true,
  for_reviewer = true,
  sort_order = excluded.sort_order;
--> statement-breakpoint
-- Clear the old roles first because their partial unique indexes are
-- non-deferrable. The target rows are guaranteed by the seed above.
UPDATE "app"."models"
SET runner_default = false,
    runner_fast_default = false
WHERE runner_default OR runner_fast_default;
--> statement-breakpoint
UPDATE "app"."models"
SET runner_default = true,
    enabled = true
WHERE provider = 'openai' AND model_id = 'gpt-5.6-sol';
--> statement-breakpoint
UPDATE "app"."models"
SET runner_fast_default = true,
    enabled = true
WHERE provider = 'anthropic' AND model_id = 'claude-opus-4.8';
