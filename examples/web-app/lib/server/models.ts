import 'server-only';

import { createAnthropic } from '@ai-sdk/anthropic';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { createOpenAI } from '@ai-sdk/openai';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import type { LanguageModel } from 'ai';
import { providerNeedsKey, type ModelChoice, type ProviderId } from '../providers';
import { getConfig } from './config';
import { getSession, isSignedIn } from './session';

/** A model request the app refuses before calling anyone. */
export class ModelChoiceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ModelChoiceError';
  }
}

/**
 * Check a base URL for the OpenAI-compatible provider against
 * CUSTOM_MODEL_BASE_URLS, so the app cannot be used to call arbitrary hosts.
 *
 * @param baseUrl - The URL the browser asked for
 * @returns The normalized URL
 * @throws ModelChoiceError when it is not allowed
 */
export function allowedBaseUrl(baseUrl: string | undefined): string {
  const normalized = (baseUrl ?? '').trim().replace(/\/+$/, '');
  const allowed = getConfig().customModelBaseUrls;
  const chosen = normalized || allowed[0];
  if (!chosen || !allowed.includes(chosen)) {
    throw new ModelChoiceError(
      `Base URL ${chosen || '(none)'} is not allowed. Add it to CUSTOM_MODEL_BASE_URLS in the app's environment.`,
    );
  }
  return chosen;
}

/**
 * The key for one request: the user's own key, or else the key set on the
 * server for that provider. The server key is used only for a signed-in
 * session, so nobody can spend it without an IBM i sign-in.
 *
 * @param provider - Provider ID
 * @param userKey - The key the browser sent, possibly empty
 * @returns The key to call the provider with, possibly empty
 * @throws ModelChoiceError when only the server key could be used and the user is not signed in
 */
export async function resolveKey(provider: ProviderId, userKey: string): Promise<string> {
  if (userKey) {
    return userKey;
  }
  const serverKey = getConfig().serverModelKeys[provider];
  if (!serverKey) {
    return '';
  }
  if (!isSignedIn(await getSession())) {
    throw new ModelChoiceError('Sign in to use the model key set on this app.');
  }
  return serverKey;
}

function requireKey(provider: ProviderId, apiKey: string): string {
  if (providerNeedsKey(provider) && !apiKey) {
    throw new ModelChoiceError('Enter an API key for this provider in Settings.');
  }
  return apiKey;
}

/**
 * Build the language model for one request from the user's choice and key.
 * The key is only passed to the provider client; it is never stored or logged.
 *
 * @param choice - Provider, model ID and optional base URL
 * @param apiKey - The key for that provider from resolveKey, possibly empty
 * @returns The model
 * @throws ModelChoiceError when the key or base URL is missing or not allowed
 */
export function createModel(choice: ModelChoice, apiKey: string): LanguageModel {
  const key = requireKey(choice.provider, apiKey);
  switch (choice.provider) {
    case 'anthropic':
      return createAnthropic({ apiKey: key })(choice.model);
    case 'openai':
      return createOpenAI({ apiKey: key })(choice.model);
    case 'google':
      return createGoogleGenerativeAI({ apiKey: key })(choice.model);
    case 'openai-compatible':
      return createOpenAICompatible({
        name: 'custom',
        baseURL: allowedBaseUrl(choice.baseUrl),
        ...(key ? { apiKey: key } : {}),
      })(choice.model);
  }
}

/**
 * List the model IDs the key can use, from the provider's models endpoint.
 *
 * @param provider - Provider ID
 * @param apiKey - The key from resolveKey
 * @param baseUrl - Base URL for the OpenAI-compatible provider
 * @returns Model IDs, sorted
 * @throws ModelChoiceError or a fetch error when the provider refuses
 */
export async function listModels(provider: ProviderId, apiKey: string, baseUrl?: string): Promise<string[]> {
  const key = requireKey(provider, apiKey);
  let url: string;
  const headers: Record<string, string> = {};
  switch (provider) {
    case 'anthropic':
      url = 'https://api.anthropic.com/v1/models?limit=100';
      headers['x-api-key'] = key;
      headers['anthropic-version'] = '2023-06-01';
      break;
    case 'openai':
      url = 'https://api.openai.com/v1/models';
      headers.Authorization = `Bearer ${key}`;
      break;
    case 'google':
      url = 'https://generativelanguage.googleapis.com/v1beta/models?pageSize=200';
      headers['x-goog-api-key'] = key;
      break;
    case 'openai-compatible':
      url = `${allowedBaseUrl(baseUrl)}/models`;
      if (key) {
        headers.Authorization = `Bearer ${key}`;
      }
      break;
  }

  const response = await fetch(url, { headers, signal: AbortSignal.timeout(15_000) });
  if (!response.ok) {
    throw new ModelChoiceError(`The provider refused the request (HTTP ${response.status}). Check the key.`);
  }
  const body = (await response.json()) as {
    data?: Array<{ id?: string }>;
    models?: Array<{ name?: string; supportedGenerationMethods?: string[] }>;
  };
  const ids =
    provider === 'google'
      ? (body.models ?? [])
          .filter((model) => model.supportedGenerationMethods?.includes('generateContent') ?? true)
          .map((model) => model.name?.replace(/^models\//, ''))
      : (body.data ?? []).map((model) => model.id);
  return [...new Set(ids.filter((id): id is string => !!id))].sort();
}
