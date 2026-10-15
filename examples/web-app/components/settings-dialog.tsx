'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { forgetKey, updateSettings, useSettings } from '@/lib/client/settings';
import { MODEL_KEY_HEADER, PROVIDERS, type ProviderId } from '@/lib/providers';
import { useAppState } from './app-state';

/** Model provider, API key and model, kept in this browser only. */
export function SettingsDialog() {
  const { settingsOpen, setSettingsOpen, session } = useAppState();
  const settings = useSettings();
  const [loaded, setLoaded] = useState<{ provider?: ProviderId; models: string[]; error?: string }>({ models: [] });
  const [loading, setLoading] = useState(false);

  const provider = settings.provider;
  const models = loaded.provider === provider ? loaded.models : [];
  const loadError = loaded.provider === provider ? loaded.error : undefined;
  const entry = PROVIDERS.find((item) => item.id === provider) ?? PROVIDERS[0];
  const key = settings.keys[provider] ?? '';
  const model = settings.models[provider] ?? '';
  const baseUrls = session.customModelBaseUrls;

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
    <Dialog open={settingsOpen} onOpenChange={setSettingsOpen}>
      <DialogContent className="sm:max-w-lg">
        <form
          className="flex flex-col gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            setSettingsOpen(false);
          }}
        >
          <DialogHeader>
            <DialogTitle>Model settings</DialogTitle>
            <DialogDescription>
              Your key stays in this browser. It is sent only with your own chat requests to this app, which passes it to the
              provider and does not store or log it.
            </DialogDescription>
          </DialogHeader>

          <div className="flex flex-col gap-2">
            <Label htmlFor="provider">Provider</Label>
            <Select value={provider} onValueChange={(value) => updateSettings({ provider: value as ProviderId })}>
              <SelectTrigger id="provider" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {PROVIDERS.map((item) => (
                  <SelectItem key={item.id} value={item.id}>
                    {item.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {provider === 'openai-compatible' && (
            <div className="flex flex-col gap-2">
              <Label htmlFor="base-url">Base URL</Label>
              <Select value={settings.baseUrl ?? baseUrls[0] ?? ''} onValueChange={(value) => updateSettings({ baseUrl: value })}>
                <SelectTrigger id="base-url" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {baseUrls.map((url) => (
                    <SelectItem key={url} value={url}>
                      {url}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <span className="text-muted-foreground text-xs">CUSTOM_MODEL_BASE_URLS in the environment of this app lists the allowed addresses.</span>
            </div>
          )}

          <div className="flex flex-col gap-2">
            <Label htmlFor="api-key">API key{entry.needsKey ? '' : ' (optional)'}</Label>
            <div className="flex gap-2">
              <Input
                id="api-key"
                type="password"
                autoComplete="off"
                spellCheck={false}
                placeholder={entry.keyHint}
                value={key}
                onChange={(event) =>
                  updateSettings((current) => ({ keys: { ...current.keys, [provider]: event.target.value.trim() } }))
                }
              />
              {key && (
                <Button type="button" variant="outline" onClick={() => forgetKey(provider)}>
                  Forget
                </Button>
              )}
            </div>
          </div>

          <div className="flex flex-col gap-2">
            <Label htmlFor="model">Model</Label>
            <div className="flex gap-2">
              <Input
                id="model"
                list="model-options"
                placeholder="Model ID"
                value={model}
                onChange={(event) =>
                  updateSettings((current) => ({ models: { ...current.models, [provider]: event.target.value.trim() } }))
                }
              />
              <Button type="button" variant="outline" disabled={loading || (entry.needsKey && !key)} onClick={() => void loadModels()}>
                {loading ? 'Loading' : 'Load models'}
              </Button>
            </div>
            <datalist id="model-options">
              {models.map((id) => (
                <option key={id} value={id} />
              ))}
            </datalist>
            {models.length > 0 && <span className="text-muted-foreground text-xs">{models.length} models available. Pick one or type an ID.</span>}
            {loadError && <span className="text-destructive text-xs">{loadError}</span>}
          </div>

          <DialogFooter>
            <Button type="submit">Done</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
