import { afterEach, describe, expect, it } from 'vitest';
import { getConfig, resetConfig } from '@/lib/server/config';

const NAMES = ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'GOOGLE_GENERATIVE_AI_API_KEY', 'DEFAULT_PROVIDER', 'DEFAULT_MODEL'];

function withEnv(values: Record<string, string>) {
  Object.assign(process.env, values);
  resetConfig();
}

describe('server model keys and defaults', () => {
  afterEach(() => {
    for (const name of NAMES) {
      delete process.env[name];
    }
    resetConfig();
  });

  it('reads a key per provider and ignores empty ones', () => {
    withEnv({ ANTHROPIC_API_KEY: 'sk-ant-a', OPENAI_API_KEY: ' ', GOOGLE_GENERATIVE_AI_API_KEY: 'AIza-g' });

    expect(getConfig().serverModelKeys).toEqual({ anthropic: 'sk-ant-a', google: 'AIza-g' });
  });

  it('has no keys and no default model when nothing is set', () => {
    withEnv({});

    expect(getConfig().serverModelKeys).toEqual({});
    expect(getConfig().defaultModel).toBeUndefined();
  });

  it('reads the default provider and model', () => {
    withEnv({ DEFAULT_PROVIDER: 'google', DEFAULT_MODEL: 'gemini-test' });

    expect(getConfig().defaultModel).toEqual({ provider: 'google', model: 'gemini-test' });
  });

  it('refuses an unknown default provider, and a default model without a provider', () => {
    withEnv({ DEFAULT_PROVIDER: 'acme' });
    expect(() => getConfig()).toThrow(/DEFAULT_PROVIDER must be one of/);

    delete process.env.DEFAULT_PROVIDER;
    withEnv({ DEFAULT_MODEL: 'some-model' });
    expect(() => getConfig()).toThrow(/DEFAULT_MODEL needs DEFAULT_PROVIDER/);
  });
});
