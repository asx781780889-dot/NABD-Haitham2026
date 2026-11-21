-- Repair a Gemini row that was saved with another provider's base URL / model (e.g. Grok values).
-- The encrypted API key is left untouched.
UPDATE ai_providers
   SET base_url = NULL, model = 'gemini-3.8-flash', status = 'unconfigured', last_error = NULL
 WHERE id = 'gemini'
   AND (base_url ~* '(x\.ai|openai\.com|anthropic\.com|groq\.com)' OR model ~* '^(grok|gpt|claude|llama)');
