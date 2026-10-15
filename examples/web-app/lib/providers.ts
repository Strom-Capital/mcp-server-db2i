import { z } from 'zod';

/** Model providers the app can call with the user's own key. */
export const PROVIDERS = [
  { id: 'anthropic', label: 'Anthropic', keyHint: 'sk-ant-...', needsKey: true },
  { id: 'openai', label: 'OpenAI', keyHint: 'sk-...', needsKey: true },
  { id: 'google', label: 'Google Gemini', keyHint: 'AIza...', needsKey: true },
  { id: 'openai-compatible', label: 'OpenAI-compatible (Ollama, LM Studio, ...)', keyHint: 'Optional', needsKey: false },
] as const;

export type ProviderId = (typeof PROVIDERS)[number]['id'];

export const providerIdSchema = z.enum(['anthropic', 'openai', 'google', 'openai-compatible']);

/** Header that carries the model API key from the browser to the app's own routes. */
export const MODEL_KEY_HEADER = 'x-model-api-key';

/**
 * Reasoning effort levels, as AI SDK's `reasoning` call option takes them. Each
 * provider maps them to its own setting (Anthropic thinking and effort, OpenAI
 * reasoning effort, Gemini thinking level); a model without reasoning ignores them.
 */
export const EFFORTS = [
  { id: 'provider-default', label: 'Default' },
  { id: 'none', label: 'Off' },
  { id: 'low', label: 'Low' },
  { id: 'medium', label: 'Medium' },
  { id: 'high', label: 'High' },
  { id: 'xhigh', label: 'Extra high' },
  { id: 'max', label: 'Max' },
] as const;

export type Effort = (typeof EFFORTS)[number]['id'];

export const effortSchema = z.enum(['provider-default', 'none', 'low', 'medium', 'high', 'xhigh', 'max']);

/** Model choice sent with each chat request. The key travels in MODEL_KEY_HEADER, not here. */
export const modelChoiceSchema = z.object({
  provider: providerIdSchema,
  model: z.string().trim().min(1).max(200),
  baseUrl: z.string().trim().max(500).optional(),
  effort: effortSchema.optional(),
});

export type ModelChoice = z.infer<typeof modelChoiceSchema>;

/**
 * Whether a provider needs an API key.
 *
 * @param provider - Provider ID
 * @returns True unless it is the OpenAI-compatible provider
 */
export function providerNeedsKey(provider: ProviderId): boolean {
  return PROVIDERS.find((entry) => entry.id === provider)?.needsKey ?? true;
}
