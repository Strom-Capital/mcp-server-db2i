import 'server-only';

import { providerIdSchema, type ProviderId } from '../providers';

/** Settings read from the environment. See .env.example. */
export interface AppConfig {
  /** Origin of mcp-server-db2i, without a path. */
  mcpServerUrl: URL;
  /** The MCP endpoint: `<mcpServerUrl>/mcp`. */
  mcpEndpoint: URL;
  /** Origin users reach this app at. */
  appUrl: URL;
  sessionSecret: string;
  /** Base URLs the OpenAI-compatible provider may call. */
  customModelBaseUrls: string[];
  /** Model API keys set on the server, used for signed-in users who have not entered their own. */
  serverModelKeys: Partial<Record<ProviderId, string>>;
  /** Provider, and optionally model, a new user starts with. */
  defaultModel?: { provider: ProviderId; model?: string };
}

/** Environment variables that hold a server-side model key, by provider. */
export const SERVER_KEY_ENV = {
  anthropic: 'ANTHROPIC_API_KEY',
  openai: 'OPENAI_API_KEY',
  google: 'GOOGLE_GENERATIVE_AI_API_KEY',
} as const satisfies Partial<Record<ProviderId, string>>;

const DEFAULT_CUSTOM_BASE_URLS = ['http://localhost:11434/v1'];

let cached: AppConfig | undefined;

function readUrl(name: string, fallback?: string): URL {
  const raw = process.env[name]?.trim() || fallback;
  if (!raw) {
    throw new Error(`${name} is not set. See examples/web-app/.env.example.`);
  }
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`${name} is not a valid URL: ${raw}`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`${name} must be an http or https URL.`);
  }
  return new URL(url.origin);
}

function readDefaultModel(): AppConfig['defaultModel'] {
  const provider = process.env.DEFAULT_PROVIDER?.trim();
  const model = process.env.DEFAULT_MODEL?.trim() || undefined;
  if (!provider) {
    if (model) {
      throw new Error('DEFAULT_MODEL needs DEFAULT_PROVIDER, the provider the model belongs to.');
    }
    return undefined;
  }
  const parsed = providerIdSchema.safeParse(provider);
  if (!parsed.success) {
    throw new Error(`DEFAULT_PROVIDER must be one of ${providerIdSchema.options.join(', ')}.`);
  }
  return { provider: parsed.data, model };
}

/**
 * Read and check the app's settings once.
 *
 * @returns The settings
 * @throws Error when a required setting is missing or invalid
 */
export function getConfig(): AppConfig {
  if (cached) {
    return cached;
  }
  const sessionSecret = process.env.SESSION_SECRET ?? '';
  if (sessionSecret.length < 32) {
    throw new Error('SESSION_SECRET must be at least 32 characters. Generate one with: openssl rand -base64 32');
  }
  const mcpServerUrl = readUrl('MCP_SERVER_URL');
  const customModelBaseUrls = process.env.CUSTOM_MODEL_BASE_URLS
    ? process.env.CUSTOM_MODEL_BASE_URLS.split(',').map((value) => value.trim().replace(/\/+$/, '')).filter(Boolean)
    : DEFAULT_CUSTOM_BASE_URLS;
  const serverModelKeys: Partial<Record<ProviderId, string>> = {};
  for (const [provider, name] of Object.entries(SERVER_KEY_ENV)) {
    const key = process.env[name]?.trim();
    if (key) {
      serverModelKeys[provider as ProviderId] = key;
    }
  }
  cached = {
    mcpServerUrl,
    mcpEndpoint: new URL('/mcp', mcpServerUrl),
    appUrl: readUrl('APP_URL', 'http://localhost:3001'),
    sessionSecret,
    customModelBaseUrls,
    serverModelKeys,
    defaultModel: readDefaultModel(),
  };
  return cached;
}

/** Forget the cached settings. For tests. */
export function resetConfig(): void {
  cached = undefined;
}
