'use client';

import { useEffect, useRef, useState } from 'react';
import { forgetKey, updateSettings, useSettings } from '@/lib/client/settings';
import { MODEL_KEY_HEADER, PROVIDERS, type ProviderId } from '@/lib/providers';
import { useAppState } from './app-state';

const inputClass = 'h-9 w-full rounded-sm border border-line bg-surface px-2 outline-none focus:border-accent';

/** Model provider, API key and model, kept in this browser only. */
export function SettingsDialog() {
  const { settingsOpen, setSettingsOpen, session } = useAppState();
  const settings = useSettings();
  const dialog = useRef<HTMLDialogElement>(null);
  const [loaded, setLoaded] = useState<{ provider?: ProviderId; models: string[]; error?: string }>({ models: [] });
  const [loading, setLoading] = useState(false);

  const provider = settings.provider;
  const models = loaded.provider === provider ? loaded.models : [];
  const loadError = loaded.provider === provider ? loaded.error : undefined;
  const entry = PROVIDERS.find((item) => item.id === provider) ?? PROVIDERS[0];
  const key = settings.keys[provider] ?? '';
  const model = settings.models[provider] ?? '';
  const baseUrls = session.customModelBaseUrls;

  useEffect(() => {
    const element = dialog.current;
    if (!element) {
      return;
    }
    if (settingsOpen && !element.open) {
      element.showModal();
    } else if (!settingsOpen && element.open) {
      element.close();
    }
  }, [settingsOpen]);

  async function loadModels() {
    setLoading(true);
    setLoaded({ provider, models: [] });
    try {
      const response = await fetch('/api/models', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', [MODEL_KEY_HEADER]: key },
        body: JSON.stringify({ provider, baseUrl: settings.baseUrl }),
      });
      const body = (await response.json()) as { models?: string[]; error?: string };
      if (!response.ok) {
        throw new Error(body.error ?? 'Could not list models.');
      }
      setLoaded({ provider, models: body.models ?? [] });
      if (!model && body.models?.[0]) {
        updateSettings((current) => ({ models: { ...current.models, [provider]: body.models?.[0] } }));
      }
    } catch (error) {
      setLoaded({ provider, models: [], error: error instanceof Error ? error.message : 'Could not list models.' });
    } finally {
      setLoading(false);
    }
  }

  return (
    <dialog
      ref={dialog}
      onClose={() => setSettingsOpen(false)}
      className="m-auto w-full max-w-lg rounded-sm border border-line bg-bg p-0 text-fg backdrop:bg-black/40"
    >
      <form
        method="dialog"
        className="flex flex-col gap-4 p-5"
        onSubmit={() => setSettingsOpen(false)}
      >
        <div>
          <h2 className="text-lg font-semibold">Model settings</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Your key stays in this browser. It is sent only with your own chat requests to this app, which passes it to the
            provider and does not store or log it.
          </p>
        </div>

        <label className="flex flex-col gap-1 text-sm">
          Provider
          <select
            className={inputClass}
            value={provider}
            onChange={(event) => updateSettings({ provider: event.target.value as ProviderId })}
          >
            {PROVIDERS.map((item) => (
              <option key={item.id} value={item.id}>
                {item.label}
              </option>
            ))}
          </select>
        </label>

        {provider === 'openai-compatible' && (
          <label className="flex flex-col gap-1 text-sm">
            Base URL
            <select
              className={inputClass}
              value={settings.baseUrl ?? baseUrls[0] ?? ''}
              onChange={(event) => updateSettings({ baseUrl: event.target.value })}
            >
              {baseUrls.map((url) => (
                <option key={url} value={url}>
                  {url}
                </option>
              ))}
            </select>
            <span className="text-xs text-muted-foreground">CUSTOM_MODEL_BASE_URLS in the environment of this app lists the allowed addresses.</span>
          </label>
        )}

        <label className="flex flex-col gap-1 text-sm">
          API key{entry.needsKey ? '' : ' (optional)'}
          <div className="flex gap-2">
            <input
              type="password"
              autoComplete="off"
              spellCheck={false}
              className={inputClass}
              placeholder={entry.keyHint}
              value={key}
              onChange={(event) =>
                updateSettings((current) => ({ keys: { ...current.keys, [provider]: event.target.value.trim() } }))
              }
            />
            {key && (
              <button type="button" className="shrink-0 rounded-sm border border-line px-2 hover:border-fg" onClick={() => forgetKey(provider)}>
                Forget
              </button>
            )}
          </div>
        </label>

        <label className="flex flex-col gap-1 text-sm">
          Model
          <div className="flex gap-2">
            <input
              list="model-options"
              className={inputClass}
              placeholder="Model ID"
              value={model}
              onChange={(event) =>
                updateSettings((current) => ({ models: { ...current.models, [provider]: event.target.value.trim() } }))
              }
            />
            <button
              type="button"
              disabled={loading || (entry.needsKey && !key)}
              className="shrink-0 rounded-sm border border-line px-2 hover:border-fg disabled:opacity-50"
              onClick={() => void loadModels()}
            >
              {loading ? 'Loading' : 'Load models'}
            </button>
          </div>
          <datalist id="model-options">
            {models.map((id) => (
              <option key={id} value={id} />
            ))}
          </datalist>
          {models.length > 0 && <span className="text-xs text-muted-foreground">{models.length} models available. Pick one or type an ID.</span>}
          {loadError && <span className="text-xs text-error">{loadError}</span>}
        </label>

        <div className="flex justify-end gap-2">
          <button type="submit" className="rounded-sm bg-accent px-4 py-2 font-medium text-on-accent hover:bg-accent-strong">
            Done
          </button>
        </div>
      </form>
    </dialog>
  );
}
