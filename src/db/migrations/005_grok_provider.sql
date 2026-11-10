-- Add Grok (xAI) without touching existing provider rows or encrypted keys.
ALTER TABLE ai_providers DROP CONSTRAINT IF EXISTS ai_providers_id_check;
ALTER TABLE ai_providers ADD CONSTRAINT ai_providers_id_check
  CHECK (id IN ('gemini','openai','anthropic','local','custom','grok'));
INSERT INTO ai_providers (id, model, base_url)
VALUES ('grok','grok-4-fast','https://api.x.ai/v1')
ON CONFLICT DO NOTHING;
